//! HTTP 服务器层 —— 薄路由壳，暴露 OpenAIAdapter 与 AnthropicCompat 为 HTTP 接口
//!
//! 本模块负责将 adapter / compat 层包装为 axum HTTP 服务。

pub(crate) mod captcha_bridge;
mod admin;
mod auth;
mod device_capture;
mod error;
mod handlers;
pub mod runtime_log;
mod stats;
mod store;
mod stream;

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::Request,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use std::time::Duration;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::anthropic_compat::AnthropicCompat;
use crate::config::Config;
use crate::openai_adapter::OpenAIAdapter;

use handlers::AppState;

/// Extension to carry the API key through the request
#[derive(Clone)]
pub(crate) struct ApiKeyExt(pub(crate) String);

/// 绑定端口，带退避重试。debug=true 时监听 0.0.0.0。
async fn bind_with_retry(addr: &str, debug: bool) -> Result<(TcpListener, String), std::io::Error> {
    let bind_addr = if debug {
        let (_, port) = addr.rsplit_once(':').unwrap_or((addr, "0"));
        format!("0.0.0.0:{}", port)
    } else {
        addr.to_string()
    };

    let max_attempts = 5;
    let mut last_error = None;

    for attempt in 0..max_attempts {
        match TcpListener::bind(&bind_addr).await {
            Ok(listener) => {
                log::info!(target: "http::server", "成功绑定到 {}", bind_addr);
                return Ok((listener, bind_addr.clone()));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last_error = Some(e);
                if attempt == max_attempts - 1 {
                    // 最后一次尝试，换端口
                    let base_port: u16 = bind_addr.rsplit_once(':')
                        .and_then(|(_, p)| p.parse().ok())
                        .unwrap_or(22217);
                    let new_port = base_port + 1;
                    let new_addr = if debug {
                        format!("0.0.0.0:{}", new_port)
                    } else {
                        format!("127.0.0.1:{}", new_port)
                    };
                    log::warn!(target: "http::server", "端口 {} 持续被占用，尝试切换到 {}", bind_addr, new_addr);
                    let listener = TcpListener::bind(&new_addr).await?;
                    return Ok((listener, new_addr));
                }

                let delay_ms = 500 * (2_u64.saturating_pow(attempt));
                let delay = Duration::from_millis(delay_ms.min(8_000));
                log::warn!(target: "http::server", "端口 {} 被占用 (第 {}/{} 次)，{}ms 后重试", bind_addr, attempt + 1, max_attempts, delay.as_millis());
                tokio::time::sleep(delay).await;
            }
            Err(e) => return Err(e),
        }
    }

    Err(last_error.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrInUse, "unknown")))
}

/// 启动 HTTP 服务器
pub async fn run(mut config: Config, config_path: PathBuf) -> anyhow::Result<()> {
    let cors_origins = config.server.cors_origins.clone();
    let host = config.server.host.clone();
    let port = config.server.port;

    // 设备凭据补齐：账号的 device_id 不是数美签发格式（'B'/'D' 前缀）时，
    // 通过纯 Rust 注册请求伪造向 deviceprofile/v4 取得真实凭据并持久化。
    // 失败不阻断启动（沿用旧凭据重试登录，行为与升级前一致）。
    {
        let ua = config.deepseek.user_agent.clone();
        for acct in config.accounts.iter_mut() {
            let looks_issued =
                acct.device_id.starts_with('B') || acct.device_id.starts_with('D');
            if looks_issued {
                continue;
            }
            log::info!(
                target: "device_mint",
                "账号 {} 缺少数美签发的 device_id，正在通过注册协议生成…",
                if acct.email.is_empty() { acct.mobile.as_str() } else { acct.email.as_str() }
            );
            match crate::ds_core::mint_device_id(&ua).await {
                Ok(id) => {
                    log::info!(target: "device_mint", "device_id 生成成功（{} 字符）", id.len());
                    acct.device_id = id;
                    if !acct.smid.is_empty() {
                        // smid 由注册流程同步生成，无需变更
                    }
                }
                Err(e) => {
                    log::warn!(target: "device_mint", "device_id 生成失败（登录可能被设备风控拒绝）: {e}");
                }
            }
        }
        if config.accounts.iter().any(|a| a.device_id.starts_with('B')) {
            if let Err(e) = config.save(&config_path) {
                log::warn!(target: "device_mint", "凭据持久化失败: {e}");
            }
        }
    }

    let adapter = Arc::new(OpenAIAdapter::new(&config).await?);
    let config = Arc::new(tokio::sync::RwLock::new(config));
    let anthropic_compat = Arc::new(AnthropicCompat::new(Arc::clone(&adapter)));
    let data_dir = std::env::var("DS_DATA_DIR").unwrap_or_else(|_| ".".to_string());
    let store = Arc::new(store::StoreManager::new(
        std::path::Path::new(&data_dir),
        &config_path,
        config.clone(),
    ));
    let stats = Arc::new(stats::Stats::new_with_store(Some(store.clone())));
    let login_limiter = Arc::new(auth::LoginLimiter::new());
    let state = AppState {
        adapter: adapter.clone(),
        anthropic_compat,
        stats: stats.clone(),
        config: config.clone(),
        config_path: config_path.clone(),
        store: store.clone(),
        login_limiter: login_limiter.clone(),
        captcha: captcha_bridge::global().clone(),
    };
    let router = build_router(state.clone(), cors_origins);

    let addr = format!("{}:{}", host, port);
    let (listener, bound_addr) = bind_with_retry(&addr, config.read().await.server.debug)
        .await
        .map_err(|e| anyhow::anyhow!("无法绑定地址 {}: {}", addr, e))?;
    log::info!(target: "http::server", "openai兼容base_url: http://{}", bound_addr);
    log::info!(target: "http::server", "anthropic兼容base_url: http://{}/anthropic", bound_addr);
    log::info!(target: "http::server", "管理面板: http://{}/admin", bound_addr);

    // 设备验证 LAN 监听器（0.0.0.0:22230，仅 /device* 路由，key 校验）：
    // 供无浏览器 miniapp 的笔用手机扫码访问辅助页（见 device_capture.rs）。
    // 独立于主端口段，主服务的 chat/admin 端点不对 LAN 暴露。
    {
        let capture_router = device_capture::router(state.clone());
        let capture_addr = format!("0.0.0.0:{}", device_capture::CAPTURE_PORT);
        match TcpListener::bind(&capture_addr).await {
            Ok(l) => {
                log::info!(
                    target: "http::server",
                    "设备验证辅助页(局域网): http://<本机IP>:{}/device",
                    device_capture::CAPTURE_PORT
                );
                tokio::spawn(async move {
                    if let Err(e) = axum::serve(l, capture_router)
                        .with_graceful_shutdown(shutdown_signal())
                        .await
                    {
                        log::warn!(target: "http::server", "设备验证监听器退出: {e}");
                    }
                });
            }
            Err(e) => {
                log::warn!(
                    target: "http::server",
                    "设备验证监听器({})绑定失败（扫码验证不可用，笔内浏览器流程不受影响）: {e}",
                    capture_addr
                );
            }
        }
    }

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    log::info!(target: "http::server", "HTTP 服务已停止，正在清理资源");
    stats.persist_now();
    state.adapter.shutdown().await;
    log::info!(target: "http::server", "清理完成");

    Ok(())
}

/// 构建路由器
fn build_router(state: AppState, cors_origins: Vec<String>) -> Router {
    let store = state.store.clone();

    let public = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        // 数美验证码透传页面（无需登录，用户手动完成验证）
        .route("/captcha/{id}", get(captcha_bridge::page))
        .route("/captcha/{id}/sdk.js", get(captcha_bridge::sdk_js))
        .route("/captcha/{id}/callback", post(captcha_bridge::callback))
        // 设备验证辅助页：笔上 WPE 浏览器（miniapp 1779591038449）打开本地页，
        // 在真实浏览器环境里运行官方 fp.min.js 生成 device_id 并回写配置。
        // key 校验；服务默认绑 127.0.0.1，仅本机浏览器可达。
        .route("/device", get(device_capture::page))
        .route("/device/qr", get(device_capture::qr))
        .route("/device/fp-patched.js", get(device_capture::fp_patched_js))
        .route("/device-id-capture/accounts", get(device_capture::accounts))
        .route("/device-id-capture/debug", post(device_capture::debug_capture))
        .route("/device-id-capture/submit", post(device_capture::submit))
        // Admin auth (no JWT required)
        .route("/admin/api/setup", post(admin::admin_setup))
        .route("/admin/api/login", post(admin::admin_login));

    // API routes: Bearer token from api_keys.json
    let api_routes = Router::new()
        // OpenAI
        .route("/v1/chat/completions", post(handlers::chat_completions))
        .route("/v1/models", get(handlers::list_models))
        .route("/v1/models/{id}", get(handlers::get_model))
        // 云端会话列表（#10 同步已有对话）
        .route("/v1/cloud-sessions", get(handlers::cloud_sessions))
        .route(
            "/v1/cloud-sessions/{id}/messages",
            get(handlers::cloud_session_messages),
        )
        // Anthropic
        .route("/anthropic/v1/messages", post(handlers::anthropic_messages))
        .route("/anthropic/v1/models", get(handlers::anthropic_list_models))
        .route(
            "/anthropic/v1/models/{id}",
            get(handlers::anthropic_get_model),
        )
        .layer(middleware::from_fn(move |req, next| {
            let store = store.clone();
            async move { api_key_middleware(req, next, store).await }
        }));

    // Admin routes: JWT auth
    let admin_store = state.store.clone();
    let admin_routes = Router::new()
        .route("/admin/api/status", get(admin::admin_status))
        .route("/admin/api/stats", get(admin::admin_stats))
        .route("/admin/api/models", get(admin::admin_models))
        .route("/admin/api/config", get(admin::admin_config))
        // Config
        .route("/admin/api/config", put(admin::admin_put_config))
        // Request logs
        .route("/admin/api/logs", get(admin::admin_logs))
        // Runtime logs
        .route("/admin/api/runtime-logs", get(admin::admin_runtime_logs))
        .layer(middleware::from_fn(move |req, next| {
            let store = admin_store.clone();
            async move { jwt_middleware(req, next, store).await }
        }));

    let router = public.merge(api_routes).merge(admin_routes);

    // 静态文件服务：/admin → web/dist/
    // 优先从文件系统读取（开发模式），回退到编译时嵌入的资源（release 二进制）
    let web_dist = std::path::Path::new("web/dist");
    let router = if web_dist.exists() {
        router.nest_service(
            "/admin",
            tower_http::services::ServeDir::new(web_dist)
                .fallback(tower_http::services::ServeFile::new("web/dist/index.html")),
        )
    } else {
        // 编译时嵌入：fallback 模式，不注册具体路由，无冲突风险
        router.fallback(serve_embedded_fallback)
    };

    router
        .with_state(state)
        .layer(build_cors_layer(&cors_origins))
}

fn build_cors_layer(origins: &[String]) -> CorsLayer {
    use axum::http::Method;
    use axum::http::header;

    if origins.len() == 1 && origins[0] == "*" {
        return CorsLayer::permissive();
    }

    let allowed: Vec<axum::http::HeaderValue> = origins
        .iter()
        .filter_map(|o| o.parse::<axum::http::HeaderValue>().ok())
        .collect();

    if allowed.is_empty() {
        return CorsLayer::permissive();
    }

    CorsLayer::new()
        .allow_origin(allowed)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-request-id"),
        ])
}

/// 编译时嵌入 web/dist/ 目录，release 二进制无需额外文件即可提供管理面板
#[derive(rust_embed::Embed)]
#[folder = "web/dist/"]
struct WebAssets;

/// 编译时嵌入资源 fallback：仅处理 /admin 及 /admin/* 路径，其余返回 404
async fn serve_embedded_fallback(uri: axum::http::Uri) -> Response {
    use axum::http::{StatusCode, header};

    let path = uri.path();
    if path == "/admin" || path.starts_with("/admin/") {
        let key = path
            .strip_prefix("/admin/")
            .unwrap_or("")
            .trim_start_matches('/');
        if !key.is_empty()
            && let Some(content) = WebAssets::get(key)
        {
            let mime = mime_guess::from_path(key).first_or_octet_stream();
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.as_ref())],
                content.data,
            )
                .into_response();
        }
        // SPA fallback
        if let Some(content) = WebAssets::get("index.html") {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                content.data,
            )
                .into_response();
        }
    }

    StatusCode::NOT_FOUND.into_response()
}

async fn root() -> axum::response::Redirect {
    axum::response::Redirect::to("/admin")
}

/// Health check endpoint
async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let account_status = state.adapter.get_account_pool_status().await;
    Json(serde_json::json!({
        "status": "ok",
        "accounts": {
            "total": account_status.total,
            "idle": account_status.idle,
            "busy": account_status.busy,
            "available": account_status.total > 0
        }
    }))
}

/// API Key 鉴权中间件（从 api_keys.json 校验 Bearer token）
async fn api_key_middleware(req: Request, next: Next, store: Arc<store::StoreManager>) -> Response {
    let token = extract_bearer_token(&req);

    // 未配置 API Key 时，直接放行，不强制要求鉴权
    if !store.has_api_keys().await {
        let key_ext = token.map(|t| ApiKeyExt(t.to_string()));
        let mut req = req;
        if let Some(ext) = key_ext {
            req.extensions_mut().insert(ext);
        }
        return next.run(req).await;
    }

    let valid = match token {
        Some(t) => store.is_valid_api_key(t).await,
        None => false,
    };

    if !valid {
        log::debug!(target: "http::response", "401 unauthorized API request");
        return error::ServerError::Unauthorized.into_response();
    }

    // Inject the API key into request extensions for downstream handlers
    let key_ext = token.map(|t| ApiKeyExt(t.to_string()));
    let mut req = req;
    if let Some(ext) = key_ext {
        req.extensions_mut().insert(ext);
    }

    next.run(req).await
}

/// JWT 鉴权中间件（管理面板路由）
async fn jwt_middleware(req: Request, next: Next, store: Arc<store::StoreManager>) -> Response {
    let token = extract_bearer_token(&req);
    let valid = match token {
        Some(t) => auth::verify_jwt(&store, t).await,
        None => false,
    };

    if !valid {
        log::debug!(target: "http::response", "401 unauthorized admin request");
        return error::ServerError::Unauthorized.into_response();
    }

    next.run(req).await
}

/// 从 Authorization 头提取 Bearer token
fn extract_bearer_token(req: &Request) -> Option<&str> {
    req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
}

/// 优雅关闭信号
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    log::info!(target: "http::server", "收到关闭信号，开始优雅关闭");
}
