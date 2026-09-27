//! HTTP 服务器层 —— 薄路由壳，暴露 OpenAIAdapter 与 AnthropicCompat 为 HTTP 接口
//!
//! 本模块负责将 adapter / compat 层包装为 axum HTTP 服务。

pub(crate) mod captcha_bridge;
mod admin;
mod auth;
mod device_capture;
mod error;
mod handlers;
pub mod net_capture;
pub mod runtime_log;
mod stats;
mod store;
mod stream;

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::Request,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use bytes::Bytes;
use std::time::Duration;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::config::Config;
use crate::openai_adapter::OpenAIAdapter;

use handlers::AppState;

/// Extension to carry the API key through the request
#[derive(Clone)]
pub(crate) struct ApiKeyExt(pub(crate) String);

/// 按字符脱敏：保留前 `keep` 个字符 + "***"，不足则整体 "***"。
/// 账号 id / API key 都是用户可控输入，按字节切片（&s[..8]）在
/// 多字节字符中间会 panic，必须走 char_indices。
pub(crate) fn mask_prefix(s: &str, keep: usize) -> String {
    match s.char_indices().nth(keep) {
        Some((idx, _)) => format!("{}***", &s[..idx]),
        None => "***".to_string(),
    }
}

#[cfg(test)]
mod mask_tests {
    use super::mask_prefix;

    #[test]
    fn mask_prefix_is_char_boundary_safe() {
        assert_eq!(mask_prefix("user@example.com", 3), "use***");
        // 按字节切 [..3] 会 panic 的输入（"小"占 3 字节，[..3] 恰好切完"小"，
        // 但 [..8] 会切在"红"中间）
        assert_eq!(mask_prefix("小红@example.com", 3), "小红@***");
        assert_eq!(mask_prefix("小红@example.com", 8), "小红@examp***");
        assert_eq!(mask_prefix("ab", 3), "***");
        assert_eq!(mask_prefix("", 8), "***");
        assert_eq!(mask_prefix("abcdefgh", 8), "***", "恰为 keep 个字符时按原语义整体脱敏");
        assert_eq!(mask_prefix("abcdefghij", 8), "abcdefgh***");
    }
}

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
///
/// 启动时序（应用侧依赖 /health 的 ready 字段等待"完全启动"，bug 5）：
/// 1. 端口绑定与路由立即就绪 —— /health 从进程启动几毫秒后即可访问；
/// 2. 重活（wasm 下载+PoW 编译、账号登录）在后台任务进行，
///    完成后 /health 的 ready 才变 true；
/// 3. 设备凭据 mint 很快且落盘 config，仍在绑定前同步执行（它影响登录）。
pub async fn run(mut config: Config, config_path: PathBuf) -> anyhow::Result<()> {
    let cors_origins = config.server.cors_origins.clone();
    let host = config.server.host.clone();
    let port = config.server.port;

    // 设备凭据补齐（用户无感）：账号缺数美签发的 device_id 时自动 mint 并持久化。
    // 详见 docs/deepseek-verification-analysis.md §5f。
    // 先记录配置路径：运行时 mint（新增账号/重登补漏）回写凭据需要它。
    crate::device_bootstrap::init_config_path(&config_path);
    crate::device_bootstrap::ensure_device_credentials(&mut config, &config_path).await;

    let config = Arc::new(tokio::sync::RwLock::new(config));
    // 就绪门闩：OpenAIAdapter 构造（含 wasm 下载 + 全账号登录）在后台完成后置位。
    let ready = Arc::new(tokio::sync::RwLock::new(false));
    let ready_flag = ready.clone();

    // 后台构造 adapter（重活）：wasm 下载、PoW 编译、全部账号登录都在这里。
    let boot_config = config.clone();
    let adapter_slot: Arc<tokio::sync::RwLock<Option<Arc<OpenAIAdapter>>>> =
        Arc::new(tokio::sync::RwLock::new(None));
    let adapter_slot_writer = adapter_slot.clone();
    let boot_handle = tokio::spawn(async move {
        // 先把配置克隆出来再放掉读锁：若把 .read().await 写在 match 表达式里，
        // 读锁会存活到整个 match 结束——即横跨 wasm 下载、PoW 编译、全账号登录
        // 的整个初始化过程，期间任何 config.write()（管理面板改配置、set_jwt_issued_at、
        // 设备验证提交等）都会被阻塞数分钟。
        let boot_cfg = boot_config.read().await.clone();
        match OpenAIAdapter::new(&boot_cfg).await {
            Ok(a) => {
                *adapter_slot_writer.write().await = Some(Arc::new(a));
                *ready_flag.write().await = true;
                log::info!(target: "http::server", "后端初始化完成，/health ready=true");
            }
            Err(e) => {
                // 初始化失败：服务仍监听（/health ready=false + last_error 可查），
                // 应用侧会显示启动失败而不是无限等待。
                log::error!(target: "http::server", "后端初始化失败: {e}");
                *ready_flag.write().await = false;
            }
        }
    });

    let data_dir = std::env::var("DS_DATA_DIR").unwrap_or_else(|_| ".".to_string());
    let store = Arc::new(store::StoreManager::new(
        std::path::Path::new(&data_dir),
        &config_path,
        config.clone(),
    ));
    let stats = Arc::new(stats::Stats::new_with_store(Some(store.clone())));
    let login_limiter = Arc::new(auth::LoginLimiter::new());
    let state = AppState {
        adapter_slot,
        ready,
        boot_handle: Some(Arc::new(boot_handle)),
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
    log::info!(target: "http::server", "HTTP 已监听（账号登录转后台，/health ready 判定就绪）");

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
    if let Some(h) = state.boot_handle {
        h.abort();
    }
    if let Some(a) = state.adapter_slot.read().await.clone() {
        a.shutdown().await;
    }
    log::info!(target: "http::server", "清理完成");

    Ok(())
}

// ========== 调试网络抓取（入站方向；出站在 ds_core::client 等，见 net_capture 模块） ==========

/// 入站响应体抓取包装：全量透传（截断只影响记录，不影响转发内容），累计前
/// MAX_BODY_BYTES 字节落盘；流结束/出错/被丢弃（客户端提前断开）都会记录
/// 已收到的部分——禁言等业务失败常在 SSE 首帧 biz_code 里。
struct InboundCaptureStream<B> {
    inner: Pin<Box<B>>,
    cid: u64,
    buf: Vec<u8>,
    truncated: bool,
    done: bool,
}

impl<B> InboundCaptureStream<B> {
    fn finish(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        net_capture::body(self.cid, &self.buf, self.truncated);
    }
}

impl<B> futures::Stream for InboundCaptureStream<B>
where
    B: futures::Stream<Item = Result<Bytes, axum::Error>>,
{
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.done {
            return std::task::Poll::Ready(None);
        }
        match self.inner.as_mut().poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(bytes))) => {
                if self.buf.len() < net_capture::MAX_BODY_BYTES {
                    let take = (net_capture::MAX_BODY_BYTES - self.buf.len()).min(bytes.len());
                    self.buf.extend_from_slice(&bytes[..take]);
                    if take < bytes.len() {
                        self.truncated = true;
                    }
                } else if !bytes.is_empty() {
                    self.truncated = true;
                }
                std::task::Poll::Ready(Some(Ok(bytes)))
            }
            std::task::Poll::Ready(Some(Err(e))) => {
                self.finish();
                std::task::Poll::Ready(Some(Err(e)))
            }
            std::task::Poll::Ready(None) => {
                self.finish();
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

impl<B> Drop for InboundCaptureStream<B> {
    fn drop(&mut self) {
        self.finish();
    }
}

/// 响应体是否二进制（决定 tee 记原文还是记说明）
fn resp_body_is_binary(headers: &axum::http::HeaderMap) -> bool {
    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    !(ct.is_empty()
        || ct.contains("json")
        || ct.contains("text")
        || ct.contains("xml")
        || ct.contains("x-www-form-urlencoded")
        || ct.contains("javascript")
        || ct.contains("event-stream"))
}

/// 入站抓取中间件（挂在最外层：被 auth 拒掉的 401、限流的 503 同样是证据）。
/// /admin 静态资源（面板 HTML/JS/CSS）跳过——与风控取证无关且体积大，刷一次
/// 面板几十个 chunk 会淹没真实流量；/admin/api/* 与其余全部路由照抓。
/// 请求体全量缓冲后透传（本服务只面向本机/局域网自用客户端），读取上限
/// MAX_READ_BYTES（超出 413）；记录超 MAX_BODY_BYTES 打 truncated 标记。
async fn net_capture_middleware(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path == "/admin" || (path.starts_with("/admin/") && !path.starts_with("/admin/api")) {
        return next.run(req).await;
    }
    if !net_capture::enabled() {
        return next.run(req).await;
    }
    let cid = net_capture::begin();
    let (parts, body) = req.into_parts();
    let method = parts.method.as_str().to_owned();
    let uri = parts.uri.to_string();
    let headers = parts.headers.clone();
    let content_type = parts
        .headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_owned());

    let body_bytes = match axum::body::to_bytes(body, net_capture::MAX_READ_BYTES).await {
        Ok(b) => b,
        Err(e) => {
            net_capture::err(
                cid,
                &format!("request body 读取失败（超 {} 上限？）: {e}", net_capture::MAX_READ_BYTES),
            );
            return axum::http::StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
    };
    net_capture::req(
        cid,
        "in",
        &method,
        &uri,
        &headers,
        Some(net_capture::body_record(&body_bytes, content_type.as_deref())),
    );

    let req = Request::from_parts(parts, Body::from(body_bytes));
    let resp = next.run(req).await;
    let binary = resp_body_is_binary(resp.headers());
    net_capture::resp(cid, resp.status().as_u16(), resp.headers(), !binary);

    let (parts, body) = resp.into_parts();
    if binary {
        // 二进制响应体（PNG 验证码等）不落内容，记说明闭环；body 原样透传
        net_capture::body_note(cid, "二进制响应体不落盘");
        return Response::from_parts(parts, body);
    }
    let tee = InboundCaptureStream {
        inner: Box::pin(body.into_data_stream()),
        cid,
        buf: Vec::new(),
        truncated: false,
        done: false,
    };
    Response::from_parts(parts, Body::from_stream(tee))
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
        // 删除云端会话（应用侧删除本地对话时同步调用，bug 3）。
        // 同时挂 DELETE 与 POST：笔端 Falcon http 模块不支持 DELETE 方法
        // （请求被拒/降级成 GET → 405），应用侧已改用 POST；DELETE 保留给
        // 标准 OpenAI 风格调用方。
        .route(
            "/v1/cloud-sessions/{id}",
            delete(handlers::delete_cloud_session).post(handlers::delete_cloud_session),
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
        // 入站抓取挂最外层：CORS 拒绝、auth 401 等全部可见（抓取未启用时零成本直通）
        .layer(middleware::from_fn(net_capture_middleware))
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
///
/// `ready`：后台初始化（wasm 下载 + 全账号登录）完成才为 true ——
/// 应用侧（词典笔启动页）以它为"完全启动"信号（bug 5）。
async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let ready = *state.ready.read().await;
    let (total, idle, busy) = match state.adapter_slot.read().await.clone() {
        Some(a) => {
            let s = a.get_account_pool_status().await;
            (s.total, s.idle, s.busy)
        }
        None => (0, 0, 0),
    };
    Json(serde_json::json!({
        "status": "ok",
        "ready": ready,
        "accounts": {
            "total": total,
            "idle": idle,
            "busy": busy,
            "available": total > 0
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
