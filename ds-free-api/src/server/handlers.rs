//! HTTP 路由处理器 —— 薄路由层，委托给 OpenAIAdapter / AnthropicCompat
//!
//! 所有业务逻辑在 adapter 中，handler 只做参数提取和响应格式化。

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    body::Body,
    extract::{FromRequestParts, Path, State},
    http::{StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::Stream;
use pin_project_lite::pin_project;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::anthropic_compat::{
    AnthropicCompat, AnthropicCompatError, AnthropicOutput, MessagesRequest,
};
use crate::config::Config;
use crate::openai_adapter::{
    ChatCompletionsRequest, ChatOutput, OpenAIAdapter, OpenAIAdapterError,
};

use super::auth::LoginLimiter;
use super::error::ServerError;
use super::stats::Stats;
use super::store::StoreManager;
use super::stream::SseBody;

/// Extract the API key from request extensions (injected by api_key_middleware)
pub(crate) struct ApiKey(pub(crate) Option<String>);

impl<S> FromRequestParts<S> for ApiKey
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let key = parts
            .extensions
            .get::<super::ApiKeyExt>()
            .map(|e| e.0.clone());
        Ok(ApiKey(key))
    }
}

/// Guard that records token usage to Stats on Drop
struct TokenGuard {
    stats: Arc<Stats>,
    prompt_tokens: u64,
    completion_tokens: Arc<std::sync::atomic::AtomicU64>,
    model: String,
    api_key: Option<String>,
    request_id: String,
    latency_ms: u64,
    success: bool,
}

impl Drop for TokenGuard {
    fn drop(&mut self) {
        let ct = self
            .completion_tokens
            .load(std::sync::atomic::Ordering::Relaxed);
        self.stats.record_tokens_for_model_and_key(
            &self.model,
            self.api_key.as_deref(),
            self.prompt_tokens,
            ct,
        );
        // Append request log asynchronously
        let stats = self.stats.clone();
        let log = super::stats::RequestLog {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            request_id: self.request_id.clone(),
            model: self.model.clone(),
            api_key: self
                .api_key
                .as_deref()
                .map(|k| super::mask_prefix(k, 8))
                .unwrap_or_default(),
            prompt_tokens: self.prompt_tokens,
            completion_tokens: ct,
            latency_ms: self.latency_ms,
            success: self.success,
        };
        tokio::spawn(async move {
            stats.append_log(log);
        });
    }
}

pin_project! {
    /// Stream wrapper that holds a TokenGuard; guard fires on Drop (stream end)
    struct TokenGuardStream<S> {
        #[pin]
        inner: S,
        _guard: TokenGuard,
    }
}

impl<S, E> Stream for TokenGuardStream<S>
where
    S: Stream<Item = Result<Bytes, E>>,
{
    type Item = Result<Bytes, E>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.project().inner.poll_next(cx)
    }
}

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_request_id() -> String {
    format!("req-{:x}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed))
}

const X_DS_ACCOUNT: &str = "x-ds-account";

/// 脱敏账号 ID：邮箱/手机号只保留前 3 字符 + ***
fn mask_account_id(id: &str) -> String {
    super::mask_prefix(id, 3)
}

/// 应用状态
///
/// `adapter_slot` + `ready`：后端"早绑定"启动（bug 5）——端口先服务，wasm
/// 下载 / PoW 编译 / 全账号登录在后台进行；就绪前业务 handler 统一返回
/// 503 initializing，/health 的 ready 字段供应用侧等待"完全启动"。
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) adapter_slot: Arc<tokio::sync::RwLock<Option<Arc<OpenAIAdapter>>>>,
    pub(crate) ready: Arc<tokio::sync::RwLock<bool>>,
    /// 后台初始化任务句柄（优雅关闭时 abort）
    pub(crate) boot_handle: Option<Arc<tokio::task::JoinHandle<()>>>,
    pub(crate) stats: Arc<Stats>,
    pub(crate) config: Arc<tokio::sync::RwLock<Config>>,
    pub(crate) store: Arc<StoreManager>,
    pub(crate) login_limiter: Arc<LoginLimiter>,
    pub(crate) config_path: PathBuf,
    pub(crate) captcha: super::captcha_bridge::CaptchaStore,
}

impl AppState {
    /// 取已就绪的 adapter；未就绪返回 503（应用侧轮询 /health ready 后才会
    /// 发业务请求，这里只是防御）。
    pub(crate) async fn adapter(&self) -> Result<Arc<OpenAIAdapter>, ServerError> {
        self.adapter_slot
            .read()
            .await
            .clone()
            .ok_or(ServerError::Initializing)
    }
}
/// Record a completed request — logs tokens and appends RequestLog via Stats
impl AppState {
    #[allow(clippy::too_many_arguments)]
    fn record_request(
        &self,
        request_id: &str,
        model: &str,
        api_key: &Option<String>,
        prompt_tokens: u64,
        completion_tokens: u64,
        latency_ms: u64,
        success: bool,
    ) {
        self.stats.record_tokens_for_model_and_key(
            model,
            api_key.as_deref(),
            prompt_tokens,
            completion_tokens,
        );
        let api_key_masked = api_key
            .as_deref()
            .map(|k| super::mask_prefix(k, 8))
            .unwrap_or_default();
        let log = super::stats::RequestLog {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            request_id: request_id.to_string(),
            model: model.to_string(),
            api_key: api_key_masked,
            prompt_tokens,
            completion_tokens,
            latency_ms,
            success,
        };
        let stats = self.stats.clone();
        tokio::spawn(async move {
            stats.append_log(log);
        });
    }
}

/// POST /v1/chat/completions
pub(crate) async fn chat_completions(
    State(state): State<AppState>,
    ApiKey(api_key): ApiKey,
    body: Bytes,
) -> Result<Response, ServerError> {
    let request_id = next_request_id();
    let timer = super::stats::RequestTimer::new(&state.stats);
    let timer_start = std::time::Instant::now();
    let req: ChatCompletionsRequest = serde_json::from_slice(&body)
        .map_err(|e| OpenAIAdapterError::BadRequest(format!("bad request: {}", e)))?;
    log::debug!(target: "http::request", "req={} POST /v1/chat/completions stream={}", request_id, req.stream);
    let model = req.model.clone();

    let adapter = state.adapter().await?;
    let result = adapter.chat_completions(req, &request_id).await;
    match &result {
        Ok(_) => timer.mark_success(),
        Err(_) => timer.mark_failure(),
    };
    let result = result?;
    match result.data {
        ChatOutput::Stream(stream) => {
            let prompt_tokens = result.prompt_tokens as u64;
            use futures::StreamExt;
            let completion_tokens = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let ct_ref = completion_tokens.clone();
            let latency_ms = timer_start.elapsed().as_millis() as u64;
            let sse = stream
                .inspect(move |chunk| {
                    if let Ok(c) = chunk
                        && let Some(u) = &c.usage
                    {
                        ct_ref.store(
                            u.completion_tokens as u64,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                    }
                })
                .map(|chunk| match chunk {
                    Ok(c) => crate::openai_adapter::response::sse_serialize(&c),
                    Err(e) => Err(e),
                });
            let guarded = TokenGuardStream {
                inner: sse,
                _guard: TokenGuard {
                    stats: state.stats.clone(),
                    prompt_tokens,
                    completion_tokens,
                    model: model.clone(),
                    api_key: api_key.clone(),
                    request_id: request_id.clone(),
                    latency_ms,
                    success: true,
                },
            };
            log::debug!(target: "http::response", "req={} 200 SSE stream started", request_id);
            Ok(SseBody::new(guarded)
                .with_header(X_DS_ACCOUNT, &mask_account_id(&result.account_id))
                .into_response())
        }
        ChatOutput::Json(json) => {
            let pt = result.prompt_tokens as u64;
            let ct = json
                .usage
                .as_ref()
                .map(|u| u.completion_tokens as u64)
                .unwrap_or(0);
            let latency_ms = timer_start.elapsed().as_millis() as u64;
            state.record_request(&request_id, &model, &api_key, pt, ct, latency_ms, true);
            let bytes = serde_json::to_vec(&json).unwrap();
            log::debug!(target: "http::response", "req={} 200 JSON response {} bytes", request_id, bytes.len());
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .header(X_DS_ACCOUNT, &mask_account_id(&result.account_id))
                .body(Body::from(bytes))
                .unwrap()
                .into_response())
        }
    }
}

/// GET /v1/models
pub(crate) async fn list_models(State(state): State<AppState>) -> Result<Response, ServerError> {
    log::debug!(target: "http::request", "GET /v1/models");
    let adapter = state.adapter().await?;
    let bytes = serde_json::to_vec(&adapter.list_models().await).unwrap();
    log::debug!(target: "http::response", "200 JSON response {} bytes", bytes.len());
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        Body::from(bytes),
    )
        .into_response())
}

/// GET /v1/cloud-sessions —— 云端会话列表（#10 同步已有对话）
pub(crate) async fn cloud_sessions(State(state): State<AppState>) -> Response {
    log::debug!(target: "http::request", "GET /v1/cloud-sessions");
    let Ok(adapter) = state.adapter().await else {
        return ServerError::Initializing.into_response();
    };
    match adapter.list_cloud_sessions().await {
        Ok(sessions) => {
            let body = serde_json::json!({
                "object": "list",
                "data": sessions,
            });
            let bytes = serde_json::to_vec(&body).unwrap();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response()
        }
        Err(e) => {
            let (status, code, msg) = match &e {
                crate::ds_core::CoreError::NoAccounts => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "no_accounts_configured",
                    "未配置 DeepSeek 账号，无法同步云端会话".to_string(),
                ),
                crate::ds_core::CoreError::Overloaded => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limit_error",
                    "当前没有空闲账号，请稍后再试".to_string(),
                ),
                other => (
                    StatusCode::BAD_GATEWAY,
                    "provider_error",
                    format!("同步云端会话失败: {other}"),
                ),
            };
            log::warn!(target: "http::response", "GET /v1/cloud-sessions 失败: {e}");
            let body = serde_json::json!({
                "error": { "code": code, "message": msg }
            });
            let bytes = serde_json::to_vec(&body).unwrap();
            (
                status,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response()
        }
    }
}

/// GET /v1/cloud-sessions/{id}/messages —— 云端会话消息内容（#10 完整同步）
pub(crate) async fn cloud_session_messages(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    log::debug!(target: "http::request", "GET /v1/cloud-sessions/{}/messages", id);
    let Ok(adapter) = state.adapter().await else {
        return ServerError::Initializing.into_response();
    };
    match adapter.list_cloud_session_messages(&id).await {
        Ok(messages) => {
            let body = serde_json::json!({
                "object": "list",
                "data": messages,
            });
            let bytes = serde_json::to_vec(&body).unwrap();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response()
        }
        Err(e) => {
            let (status, code, msg) = match &e {
                crate::ds_core::CoreError::NoAccounts => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "no_accounts_configured",
                    "未配置 DeepSeek 账号，无法同步云端会话".to_string(),
                ),
                crate::ds_core::CoreError::Overloaded => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limit_error",
                    "当前没有空闲账号，请稍后再试".to_string(),
                ),
                other => (
                    StatusCode::BAD_GATEWAY,
                    "provider_error",
                    format!("拉取云端会话内容失败: {other}"),
                ),
            };
            log::warn!(target: "http::response", "GET /v1/cloud-sessions/{}/messages 失败: {e}", id);
            let body = serde_json::json!({
                "error": { "code": code, "message": msg }
            });
            let bytes = serde_json::to_vec(&body).unwrap();
            (
                status,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response()
        }
    }
}

/// DELETE /v1/cloud-sessions/{id} —— 删除云端会话（应用侧删除本地对话时同步调用，bug 3）
///
/// 本地删除必须连带云端删除：否则下次「同步」会把这条会话再导回来
/// （用户看到"删了又回来"）。逐个账号尝试，见 ds_core::delete_cloud_session。
pub(crate) async fn delete_cloud_session(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    log::info!(target: "http::request", "DELETE /v1/cloud-sessions/{}", id);
    let Ok(adapter) = state.adapter().await else {
        return ServerError::Initializing.into_response();
    };
    match adapter.delete_cloud_session(&id).await {
        Ok(account) => {
            let body = serde_json::json!({
                "object": "cloud_session.deleted",
                "id": id,
                "account": account,
            });
            let bytes = serde_json::to_vec(&body).unwrap();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response()
        }
        Err(e) => {
            let (status, code, msg) = match &e {
                crate::ds_core::CoreError::NoAccounts => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "no_accounts_configured",
                    "未配置 DeepSeek 账号，无法删除云端会话".to_string(),
                ),
                crate::ds_core::CoreError::Overloaded => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limit_error",
                    "当前没有空闲账号，请稍后再试".to_string(),
                ),
                crate::ds_core::CoreError::RateLimited(m) => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "upstream_rate_limited",
                    m.clone(),
                ),
                other => (
                    StatusCode::BAD_GATEWAY,
                    "provider_error",
                    format!("删除云端会话失败: {other}"),
                ),
            };
            log::warn!(target: "http::response", "DELETE /v1/cloud-sessions/{} 失败: {e}", id);
            let body = serde_json::json!({ "error": { "code": code, "message": msg } });
            let bytes = serde_json::to_vec(&body).unwrap();
            (
                status,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response()
        }
    }
}

/// GET /v1/models/{id}
pub(crate) async fn get_model(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Response, ServerError> {
    log::debug!(target: "http::request", "GET /v1/models/{}", id);

    match state.adapter().await?.get_model(&id).await {
        Some(model) => {
            let bytes = serde_json::to_vec(&model).unwrap();
            log::debug!(target: "http::response", "200 JSON response {} bytes", bytes.len());
            Ok((
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response())
        }
        None => Err(ServerError::NotFound(id)),
    }
}

// ============================================================================
// Anthropic 兼容路由
// ============================================================================

/// POST /anthropic/v1/messages
pub(crate) async fn anthropic_messages(
    State(state): State<AppState>,
    ApiKey(api_key): ApiKey,
    body: Bytes,
) -> Result<Response, ServerError> {
    let request_id = next_request_id();
    let timer = super::stats::RequestTimer::new(&state.stats);
    let timer_start = std::time::Instant::now();

    let req: MessagesRequest = serde_json::from_slice(&body)
        .map_err(|e| AnthropicCompatError::BadRequest(format!("bad request: {}", e)))?;
    log::debug!(target: "http::request", "req={} POST /anthropic/v1/messages stream={}", request_id, req.stream);
    let model = req.model.clone();

    let result = AnthropicCompat::new(state.adapter().await?)
        .messages(req, &request_id)
        .await;
    match &result {
        Ok(_) => timer.mark_success(),
        Err(_) => timer.mark_failure(),
    };
    let result = result?;
    match result.data {
        AnthropicOutput::Stream(stream) => {
            let prompt_tokens = result.prompt_tokens as u64;
            let stats = state.stats.clone();
            let completion_tokens = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let ct_ref = completion_tokens.clone();
            use futures::StreamExt;
            let sse = stream
                .inspect(move |chunk| {
                    if let Ok(c) = chunk
                        && let Some(ot) = c.output_tokens()
                    {
                        ct_ref.fetch_add(ot as u64, std::sync::atomic::Ordering::Relaxed);
                    }
                })
                .map(|chunk| match chunk {
                    Ok(c) => c
                        .to_sse_bytes()
                        .map_err(|e| AnthropicCompatError::Internal(e.to_string())),
                    Err(e) => Err(e),
                });
            // Attach guard as a stream wrapper so it drops when the stream is consumed/dropped
            let latency = timer_start.elapsed().as_millis() as u64;
            let guarded = TokenGuardStream {
                inner: sse,
                _guard: TokenGuard {
                    stats: stats.clone(),
                    prompt_tokens,
                    completion_tokens,
                    model: model.clone(),
                    api_key: api_key.clone(),
                    request_id: request_id.clone(),
                    latency_ms: latency,
                    success: true,
                },
            };
            log::debug!(target: "http::response", "req={} 200 SSE stream started", request_id);
            Ok(SseBody::new(guarded)
                .with_header(X_DS_ACCOUNT, &mask_account_id(&result.account_id))
                .into_response())
        }
        AnthropicOutput::Json(json) => {
            let pt = result.prompt_tokens as u64;
            let ct = json.usage.output_tokens as u64;
            let latency_ms = timer_start.elapsed().as_millis() as u64;
            state.record_request(&request_id, &model, &api_key, pt, ct, latency_ms, true);
            let bytes = serde_json::to_vec(&json).unwrap();
            log::debug!(target: "http::response", "req={} 200 JSON response {} bytes", request_id, bytes.len());
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .header(X_DS_ACCOUNT, &mask_account_id(&result.account_id))
                .body(Body::from(bytes))
                .unwrap()
                .into_response())
        }
    }
}

/// GET /anthropic/v1/models
pub(crate) async fn anthropic_list_models(
    State(state): State<AppState>,
) -> Result<Response, ServerError> {
    log::debug!(target: "http::request", "GET /anthropic/v1/models");
    let bytes = serde_json::to_vec(&AnthropicCompat::new(state.adapter().await?).list_models().await)
        .unwrap();
    log::debug!(target: "http::response", "200 JSON response {} bytes", bytes.len());
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        Body::from(bytes),
    )
        .into_response())
}

/// GET /anthropic/v1/models/{id}
pub(crate) async fn anthropic_get_model(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Response, ServerError> {
    log::debug!(target: "http::request", "GET /anthropic/v1/models/{}", id);

    match AnthropicCompat::new(state.adapter().await?).get_model(&id).await {
        Some(model) => {
            let bytes = serde_json::to_vec(&model).unwrap();
            log::debug!(target: "http::response", "200 JSON response {} bytes", bytes.len());
            Ok((
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                Body::from(bytes),
            )
                .into_response())
        }
        None => Err(ServerError::NotFound(id)),
    }
}
