//! DeepSeek HTTP 客户端 —— 原始 API 调用层
//!
//! 无状态管理：无缓存、无重试、无会话状态。
//! 每个方法对应一个 REST 端点（详见 docs/ds-api-reference.md）。
//! 流方法（completion/edit_message）返回原始字节流，由上层解析 SSE。
//!
//! 仅包含最小业务逻辑：HTTP 错误码和业务错误码解析（into_result）。

use bytes::Bytes;
use futures::{Stream, TryStreamExt};
use log::warn;
use wreq::multipart::{Form, Part};
use wreq_util::Emulation;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use thiserror::Error;
use crate::ds_core::floor_utf8_end;
use crate::server::net_capture;

// API 端点常量
const ENDPOINT_USERS_LOGIN: &str = "/users/login";
const ENDPOINT_CLIENT_SETTINGS: &str = "/client/settings";
const ENDPOINT_CHAT_SESSION_CREATE: &str = "/chat_session/create";
const ENDPOINT_CHAT_SESSION_DELETE: &str = "/chat_session/delete";
const ENDPOINT_CHAT_SESSION_FETCH_PAGE: &str = "/chat_session/fetch_page";
const ENDPOINT_CHAT_HISTORY_MESSAGES: &str = "/chat/history_messages";#[allow(dead_code)]
const ENDPOINT_CHAT_SESSION_UPDATE_TITLE: &str = "/chat_session/update_title";
const ENDPOINT_CHAT_CREATE_POW_CHALLENGE: &str = "/chat/create_pow_challenge";
const ENDPOINT_CHAT_COMPLETION: &str = "/chat/completion";
#[allow(dead_code)]
const ENDPOINT_CHAT_EDIT_MESSAGE: &str = "/chat/edit_message";
const ENDPOINT_CHAT_STOP_STREAM: &str = "/chat/stop_stream";
const ENDPOINT_FILE_UPLOAD: &str = "/file/upload_file";
const ENDPOINT_FILE_FETCH: &str = "/file/fetch_files";

#[derive(Debug, Error)]
pub enum ClientError {
    /// HTTP 层错误（网络、超时、DNS 等）
    #[error("HTTP error: {0}")]
    Http(#[from] wreq::Error),

    /// HTTP 状态码非 2xx
    #[error("HTTP status {status}: {body}")]
    Status { status: u16, body: String },

    /// 业务错误：API 返回 HTTP 200 但 biz_code 非 0
    #[error("Business error: code={code}, msg={msg}")]
    Business { code: i64, msg: String },

    /// 登录触发数美/人机验证，需要用户透传完成
    #[error("Captcha required: {body}")]
    CaptchaRequired { body: String },

    /// JSON 解析失败
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),

    /// Header 值包含非法字符
    #[error("Invalid header value: {0}")]
    InvalidHeader(String),

    /// 数据验证失败
    #[error("Validation error: {0}")]
    Validation(String),
}

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    pub code: i64,
    pub msg: String,
    pub data: Option<EnvelopeData<T>>,
}

#[derive(Debug, Deserialize)]
struct EnvelopeData<T> {
    pub biz_code: i64,
    pub biz_msg: String,
    pub biz_data: Option<T>,
}

impl<T: serde::de::DeserializeOwned> Envelope<T> {
    fn into_result(self) -> Result<T, ClientError> {
        if self.code != 0 {
            return Err(ClientError::Business {
                code: self.code,
                msg: self.msg,
            });
        }
        let data = self.data.ok_or_else(|| ClientError::Business {
            code: -1,
            msg: "missing data".into(),
        })?;
        if data.biz_code != 0 {
            return Err(ClientError::Business {
                code: data.biz_code,
                msg: data.biz_msg,
            });
        }
        match data.biz_data {
            Some(t) => Ok(t),
            None => {
                // 允许 biz_data 为 null，尝试从 null 构造 T（仅当 T 是 Option 时成功）
                serde_json::from_value(serde_json::Value::Null).map_err(|_| ClientError::Business {
                    code: -1,
                    msg: "missing biz_data".into(),
                })
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LoginPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mobile: Option<String>,
    pub password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area_code: Option<String>,
    pub device_id: String,
    pub os: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginData {
    pub code: i64,
    pub msg: String,
    pub user: UserInfo,
}

#[derive(Debug, Deserialize)]
pub struct UserInfo {
    #[serde(default)]
    pub id: Option<String>,
    pub token: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub mobile_number: Option<String>,
    /// 禁言状态（登录响应实测：chat.is_muted=1, chat.mute_until=Unix 秒）
    #[serde(default)]
    pub chat: Option<ChatMute>,
}

/// 禁言状态（users/current 与登录响应的 biz_data.chat）
///
/// 注意：上游未禁言时 `mute_until` 会显式返回 `null`（而不是省略字段或给 0）。
/// `#[serde(default)]` 只在该字段**缺失**时生效，遇到 `null` 会让整个登录响应
/// 反序列化失败（"invalid type: null, expected f64"）→ 账号登录不了、账号池恒为 0。
/// 这里改成 null 也走默认值，保证最常见的「未禁言」正常登录。
#[derive(Debug, Deserialize)]
pub struct ChatMute {
    #[serde(default, deserialize_with = "null_to_default")]
    pub is_muted: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    pub mute_until: f64,
}

/// 把 JSON `null` 当作「字段缺失」，回落到该类型的默认值。
fn null_to_default<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(de)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct CreateSessionData {
    pub id: String,
}

// biz_data 里面嵌套 chat_session 对象
#[derive(Debug, Deserialize)]
struct CreateSessionWrapper {
    pub chat_session: CreateSessionData,
}

#[derive(Debug, Deserialize)]
pub struct UploadFileData {
    pub id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub status: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub file_name: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub file_size: i64,
}

/// 从任意 JSON 值里宽容提取文件上传结果（老格式结构漂移时的兜底）：
/// 先按老信封的已知路径找，找不到再深度优先搜第一个带字符串 "id" 的对象。
fn extract_upload_loose(v: &serde_json::Value) -> Option<UploadFileData> {
    fn from_obj(v: &serde_json::Value) -> Option<UploadFileData> {
        let obj = v.as_object()?;
        let id = match obj.get("id") {
            Some(serde_json::Value::String(s)) if !s.is_empty() => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => return None,
        };
        let s = |k: &str| {
            obj.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        };
        Some(UploadFileData {
            id,
            status: s("status"),
            file_name: s("file_name"),
            file_size: obj.get("file_size").and_then(|x| x.as_i64()).unwrap_or(0),
        })
    }
    fn walk(v: &serde_json::Value) -> Option<UploadFileData> {
        if let Some(found) = from_obj(v) {
            return Some(found);
        }
        if let serde_json::Value::Object(map) = v {
            for (_, child) in map {
                if let Some(found) = walk(child) {
                    return Some(found);
                }
            }
        } else if let serde_json::Value::Array(items) = v {
            for item in items {
                if let Some(found) = walk(item) {
                    return Some(found);
                }
            }
        }
        None
    }
    for p in [
        "/data/biz_data",
        "/data/biz_data/file",
        "/data/biz_data/attachment",
        "/data",
        "",
    ] {
        if let Some(node) = v.pointer(p) {
            if let Some(found) = from_obj(node) {
                return Some(found);
            }
        }
    }
    walk(v)
}

#[derive(Debug, Deserialize)]
pub struct FetchFilesData {
    pub files: Vec<FileInfo>,
}

#[derive(Debug, Deserialize)]
pub struct FileInfo {
    #[allow(dead_code)]
    pub id: String,
    pub status: String,
    pub file_name: String,
    #[allow(dead_code)]
    pub file_size: i64,
    #[serde(default)]
    pub token_usage: Option<i64>,
}

/// 云端会话列表分页结果
#[derive(Debug, Clone, Serialize)]
pub struct CloudSessionPage {
    pub sessions: Vec<CloudSession>,
    pub has_more: bool,
}

/// 云端会话条目（fetch_page 解析结果；仅保留应用侧需要的字段）
#[derive(Debug, Clone, Serialize)]
pub struct CloudSession {
    pub id: String,
    pub title: String,
    /// 秒级 Unix 时间戳（解析不出为 0）
    pub updated_at: f64,
    pub pinned: bool,
    /// 该会话使用的模型类型（default/expert/vision），应用侧映射回模式
    #[serde(rename = "modelType")]
    pub model_type: String,
}

/// 云端消息条目（history_messages 解析结果，fragments 已拼接）。
///
/// 云端的编辑/重试构成一棵消息树：每个节点带 parent_id，同一父节点下有多个
/// 子节点时，**数组顺序的最后一个**是当前活跃版本（官方前端只显示它）。
/// 本结构只下发活跃链；被替换的兄弟版本放在 alt_texts（用户消息=编辑历史，
/// assistant 消息=重试历史，按时间升序），应用侧映射为版本切换 UI。
#[derive(Debug, Clone, Serialize)]
pub struct CloudMessage {
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    /// THINK fragment 内容（assistant 消息可能有）
    pub reasoning: String,
    /// 同层被替换的兄弟版本文本（升序，不含当前 content）
    #[serde(default)]
    pub alt_texts: Vec<String>,
}

/// 把 JSON 标量（数字/字符串）统一成 String：上游 message_id 是数字，
/// parent_id 也是数字，实测字段类型不稳定，统一宽容处理。
fn scalar_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// history_messages 的单个消息节点（剪枝前的原始形态）
pub(crate) struct TreeNode {
    pub role_raw: String,
    pub content: String,
    pub reasoning: String,
    pub parent: Option<String>,
    pub is_empty: bool,
}

/// 从 fetch_page 响应中宽容提取会话数组。
///
/// 已知信封为 `{code, data: {biz_data: ...}}`，但 biz_data 内部字段名未留痕
/// （HAR 未导出响应体）。策略：优先尝试常见路径（chat_sessions / sessions /
/// chat_session_list），失败则递归搜索"元素为含 id+title(或 title 字段等价物)
/// 的对象数组"，最大化兼容服务端字段演进。
fn extract_cloud_sessions(envelope: &serde_json::Value) -> Vec<CloudSession> {
    fn parse_session(v: &serde_json::Value) -> Option<CloudSession> {
        let id = v
            .get("id")
            .or_else(|| v.get("chat_session_id"))
            .or_else(|| v.get("session_id"))
            .and_then(|x| x.as_str())?
            .to_string();
        if id.is_empty() {
            return None;
        }
        let title = v
            .get("title")
            .or_else(|| v.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let updated_at = v
            .get("updated_at")
            .or_else(|| v.get("update_time"))
            .or_else(|| v.get("last_message_at"))
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0);
        let pinned = v.get("pinned").and_then(|x| x.as_bool()).unwrap_or(false);
        let model_type = v
            .get("model_type")
            .and_then(|x| x.as_str())
            .unwrap_or("default")
            .to_string();
        Some(CloudSession {
            id,
            title,
            updated_at,
            pinned,
            model_type,
        })
    }

    fn try_array(v: &serde_json::Value) -> Option<Vec<CloudSession>> {
        let arr = v.as_array()?;
        let mut out = Vec::new();
        for item in arr {
            // 数组元素必须是"长得像会话"的对象：有 id 且有 title 类字段
            let has_title = item.get("title").is_some() || item.get("name").is_some();
            if !has_title {
                return None;
            }
            out.push(parse_session(item)?);
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    // 1) 常见字段路径优先
    let biz = envelope
        .get("data")
        .and_then(|d| d.get("biz_data"))
        .unwrap_or(&serde_json::Value::Null);
    for key in ["chat_sessions", "sessions", "chat_session_list", "list"] {
        if let Some(v) = biz.get(key) {
            if let Some(list) = try_array(v) {
                return list;
            }
        }
    }
    // 2) 兜底：全树递归搜索第一个"会话形态"的数组
    fn walk(v: &serde_json::Value) -> Option<Vec<CloudSession>> {
        if let Some(list) = try_array(v) {
            return Some(list);
        }
        if let Some(obj) = v.as_object() {
            for (_k, child) in obj {
                if let Some(found) = walk(child) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(envelope).unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct ChallengeData {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub signature: String,
    pub difficulty: i64,
    #[allow(dead_code)]
    pub expire_after: i64,
    pub expire_at: i64,
    pub target_path: String,
}

// 包装类型：biz_data 里面嵌套了 challenge 对象
#[derive(Debug, Deserialize)]
struct ChallengeWrapper {
    challenge: ChallengeData,
}

#[derive(Debug, Serialize)]
pub struct CompletionPayload {
    pub chat_session_id: String,
    /// 官方 payload 里该键显式存在（首条消息为 null）；旧实现 skip 掉 None
    /// 会少一个键，与官方 JSON 形状不一致（风控差异分析 #5）。
    pub parent_message_id: Option<i64>,
    /// 官方 payload 恒有 "action": null。
    #[serde(default)]
    pub action: Option<()>,
    pub model_type: String,
    pub prompt: String,
    pub ref_file_ids: Vec<String>,
    pub thinking_enabled: bool,
    pub search_enabled: bool,
    pub preempt: bool,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct EditMessagePayload {
    pub chat_session_id: String,
    pub message_id: i64,
    pub prompt: String,
    pub search_enabled: bool,
    pub thinking_enabled: bool,
    /// 协议文档：model_type 不在 edit_message payload 中（首次 completion 传入后由
    /// session 级别记忆）。保留字段但永不序列化，避免服务端拒收未知字段。
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub model_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct UpdateTitlePayload {
    pub chat_session_id: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct StopStreamPayload {
    pub chat_session_id: String,
    pub message_id: i64,
}

/// Check if a response is an AWS WAF Challenge (US IP restriction)
fn is_waf_challenge(resp: &wreq::Response) -> bool {
    resp.status().as_u16() == 202 && resp.headers().get("x-amzn-waf-action").is_some()
}

/// 粗略判断登录响应是否包含数美/人机验证信息。
fn is_captcha_body(body: &str) -> bool {
    let lower = body.to_lowercase();
    (lower.contains("captcha")
        || lower.contains("verify")
        || lower.contains("risk")
        || lower.contains("shumei")
        || lower.contains("数美"))
        && (lower.contains("organization")
            || lower.contains("appid")
            || lower.contains("rid")
            || lower.contains("register")
            || lower.contains("captchauuid"))
}

/// SSE 流抓取包装：透传上游字节流的同时，把累计前 MAX_STREAM_BYTES 字节缓存，
/// 流正常结束/出错/被丢弃时作为 response_body 事件落盘。禁言等业务失败常在
/// SSE 的首帧 biz_code 里，即使上层提前断流（drop）也能留下已收到的部分。
struct CaptureStream<S> {
    inner: Pin<Box<S>>,
    cid: u64,
    buf: Vec<u8>,
    truncated: bool,
    done: bool,
}

impl<S> CaptureStream<S> {
    fn finish(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        net_capture::body(self.cid, &self.buf, self.truncated);
    }
}

impl<S: Stream<Item = Result<Bytes, ClientError>>> Stream for CaptureStream<S> {
    type Item = Result<Bytes, ClientError>;

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
                } else {
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

impl<S> Drop for CaptureStream<S> {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Print a hint when WAF challenge is detected
fn print_waf_hint() {
    warn!(target: "ds_core::client", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    warn!(target: "ds_core::client", "  AWS WAF Challenge detected.");
    warn!(target: "ds_core::client", "  DeepSeek CloudFront WAF blocks US-based IPs.");
    warn!(target: "ds_core::client", "  Rust HTTP clients can't execute the JS challenge.");
    warn!(target: "ds_core::client", "");
    warn!(target: "ds_core::client", "  To fix this, configure a non-US proxy in config.toml:");
    warn!(target: "ds_core::client", "    [proxy]");
    warn!(target: "ds_core::client", "    url = \"http://127.0.0.1:7890\"");
    warn!(target: "ds_core::client", "");
    warn!(target: "ds_core::client", "  https://github.com/niyue/ds-free-api");
    warn!(target: "ds_core::client", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

#[derive(Clone)]
pub struct DsClient {
    http: wreq::Client,
    api_base: String,
    wasm_url: String,
    user_agent: String,
    client_version: String,
    client_platform: String,
    client_locale: String,
    client_bundle_id: String,
    client_timezone_offset: i32,
    /// HIF token 动态获取管理器（x-hif-leim / x-hif-dliq）
    hif: crate::ds_core::hif::HifManager,
    /// 静态覆盖值（配置 hif_leim / hif_dliq；非空时优先于动态值）
    hif_static_leim: String,
    hif_static_dliq: String,
    /// Origin/Referer 用的站点根（由 api_base 去掉 `/api/v0` 推导）
    web_origin: String,
    /// 共享 cookie jar 句柄（运行时补写 smidV2 用）
    jar: std::sync::Arc<wreq::cookie::Jar>,
    /// 主客户端代理（mint 等附属链路对齐出口用）
    proxy_url: Option<String>,
    /// jar 里是否已绑定 smidV2（设备级 cookie，单 jar 只绑一个设备身份；
    /// Arc 使克隆的 DsClient 与本体共享同一状态，与共享 jar 一致）
    smid_in_jar: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// 从 api_base（如 `https://chat.deepseek.com/api/v0`）推导站点 Origin。
fn origin_of(api_base: &str) -> String {
    let s = api_base.trim_end_matches('/');
    // 找到 scheme://host 之后的第一个 '/'
    if let Some(scheme_end) = s.find("://") {
        let rest = &s[scheme_end + 3..];
        if let Some(slash) = rest.find('/') {
            return s[..scheme_end + 3 + slash].to_string();
        }
    }
    s.to_string()
}

/// 构建共享 cookie jar，并预置从浏览器抓取的身份 cookie（可选）。
///
/// 抓包（.probe/new.jsonl）实证：登录请求同时携带 body 里的 device_id 和
/// Cookie 里的 smidV2（数美 SDK 写入），两者是同一设备身份的两半。
/// 服务端看到"device_id 有而 smidV2 无"的组合与真实浏览器不符。
/// 预置值来自账号配置的抓取结果（见 Account.smid），非伪造。
fn build_cookie_jar(api_base: &str, preloaded: Vec<String>) -> wreq::cookie::Jar {
    let jar = wreq::cookie::Jar::default();
    if !preloaded.is_empty() {
        let origin = origin_of(api_base) + "/";
        if let Ok(url) = wreq::Url::parse(&origin) {
            for cookie in preloaded {
                jar.add_cookie_str(&cookie, &url);
            }
        }
    }
    jar
}

/// 从账号配置推导预置身份 cookie（smidV2，取第一个非空值）。
///
/// smidV2 是设备级 cookie（不是账号级）：同一台设备上的多个账号共用同一个
/// 值才是与真实浏览器一致的行为。若配置了多个**不同** smid，说明用户按账号
/// 分别抓取了——但共享客户端只有一个 jar，无法按账号区分，告警并采用第一个。
pub fn preloaded_cookies_from_accounts(accounts: &[crate::config::Account]) -> Vec<String> {
    let distinct: std::collections::HashSet<&str> = accounts
        .iter()
        .map(|a| a.smid.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let mut it = distinct.iter();
    match it.next() {
        Some(&v) => {
            if distinct.len() > 1 {
                log::warn!(
                    target: "ds_core::client",
                    "配置了 {} 个不同的 smidV2，但客户端共享一个 cookie jar（设备级身份）；已采用其中一个，建议同设备的账号统一填写同一个值",
                    distinct.len()
                );
            }
            vec![format!("smidV2={}", v)]
        }
        None => Vec::new(),
    }
}

/// 共享 HTTP 底座：浏览器 TLS/HTTP2 仿真 + 统一 UA + 可选代理 + 连接超时。
///
/// DsClient（业务链路）与 mint（设备注册链路）必须同源：同一 device_id 身份的
/// 注册与登录若呈不同 TLS 指纹或不同出口（代理），即是风控可交叉校验的层间矛盾。
pub(crate) fn base_http_builder(
    user_agent: &str,
    proxy_url: Option<&str>,
) -> wreq::ClientBuilder {
    let mut builder = wreq::Client::builder()
        .emulation(Emulation::Chrome136)
        // 客户端级 UA：覆盖 emulation 的默认值（其 profile 默认 OS 为 macOS，
        // 会发 "Macintosh; Intel Mac OS X" UA）。所有链路必须与身份一致
        // （Linux aarch64 Chrome 136）。
        .user_agent(user_agent.to_string())
        // 连接阶段超时：wreq 默认不设超时，上游 IP 黑洞/半开连接会让
        // 请求永不返回。只限 connect 阶段，不影响 SSE 长流式读
        // （读空闲由 completions 的 IdleTimeoutStream 兜底）。
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(wreq::redirect::Policy::limited(10));
    if let Some(url) = proxy_url.and_then(|u| wreq::Proxy::all(u).ok()) {
        builder = builder.proxy(url);
    }
    builder
}

impl DsClient {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        api_base: String,
        wasm_url: String,
        user_agent: String,
        client_version: String,
        client_platform: String,
        client_locale: String,
        client_bundle_id: String,
        client_timezone_offset: i32,
        proxy_url: Option<&str>,
        preloaded_cookies: Vec<String>,
        hif_static_leim: String,
        hif_static_dliq: String,
        hif_auto_fetch: bool,
    ) -> Self {
        // 浏览器行为对齐（new.jsonl 抓包实证）：真实客户端带 Cookie 头——
        // HWWAFSESID/HWWAFSESTIME（华为云 WAF）、ds_session_id、smidV2（数美）
        // 均随响应 Set-Cookie 累积并在后续请求回传。此前未启用 cookie store，
        // 请求链上完全无 cookie 是一个可识别的自动化特征。
        let had_preloaded_smid = !preloaded_cookies.is_empty();
        let jar = std::sync::Arc::new(build_cookie_jar(&api_base, preloaded_cookies));
        let http = base_http_builder(&user_agent, proxy_url)
            .cookie_provider(jar.clone())
            .build()
            .expect("构建 HTTP 客户端失败");

        let web_origin = origin_of(&api_base);

        // HIF token 动态获取（x-hif-leim / x-hif-dliq）：bundle 逆向证实这是
        // DeepSeek 分发服务下发的公开凭据（非本地生成），用后台任务定期拉取。
        let hif = crate::ds_core::hif::HifManager::default();
        if hif_auto_fetch {
            hif.spawn_refresh(http.clone(), web_origin.clone());
        }

        Self {
            http,
            api_base,
            wasm_url,
            user_agent,
            client_version,
            client_platform,
            client_locale,
            client_bundle_id,
            client_timezone_offset,
            hif,
            hif_static_leim,
            hif_static_dliq,
            web_origin,
            jar,
            proxy_url: proxy_url.map(str::to_string),
            smid_in_jar: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                had_preloaded_smid,
            )),
        }
    }

    /// Web 端 XHR 请求头基线。
    ///
    /// `wreq_util::Emulation` 的默认头是**页面导航**语义
    /// （`sec-fetch-site: none` / `mode: navigate` / `dest: document` /
    /// `upgrade-insecure-requests: 1` / `accept: text/html…` / `accept-language: en-US`），
    /// 用它发 JSON API POST 在服务端是不存在的组合——浏览器 fetch 永远发
    /// `same-origin` + `cors` + `empty` + `accept: */*`，且带 `origin`/`referer`。
    /// 必须逐个覆盖，否则整条请求链都能被一眼识别为自动化客户端（封号主因）。
    fn web_base_headers(&self) -> Result<wreq::header::HeaderMap, ClientError> {
        use wreq::header::{HeaderValue, ACCEPT, ACCEPT_LANGUAGE, ORIGIN, REFERER, USER_AGENT};

        let mut h = wreq::header::HeaderMap::new();
        let hv = |name: &str, s: &str| -> Result<HeaderValue, ClientError> {
            HeaderValue::from_str(s)
                .map_err(|e| ClientError::InvalidHeader(format!("{name}: {e}")))
        };

        h.insert(USER_AGENT, hv("User-Agent", &self.user_agent)?);
        h.insert(ACCEPT, HeaderValue::from_static("*/*"));
        // 站点语言与 x-client-locale 保持一致（zh_CN → zh-CN,zh;q=0.9,en;q=0.8）
        h.insert(
            ACCEPT_LANGUAGE,
            HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
        );
        h.insert(ORIGIN, hv("Origin", &self.web_origin)?);
        h.insert(REFERER, hv("Referer", &format!("{}/", self.web_origin))?);
        h.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        h.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        h.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
        // Client Hints 平台修正：wreq 的 Chrome136 emulation 默认发
        // `sec-ch-ua-platform: "macOS"`（其 profile 默认 OS），与我们的
        // `X11; Linux aarch64` UA 自相矛盾——风控引擎会做 UA↔client-hints
        // 交叉校验（httpbin 实测确认）。真实 Linux Chrome 发送 "Linux"。
        // sec-ch-ua / sec-ch-ua-mobile 由 emulation 提供（版本号与 Chrome136 一致）。
        h.insert(
            "sec-ch-ua-platform",
            HeaderValue::from_static("\"Linux\""),
        );
        // 导航专用头必须显式清除，emulation 默认会带上
        h.remove(wreq::header::UPGRADE_INSECURE_REQUESTS);
        h.insert("priority", HeaderValue::from_static("u=1, i"));

        h.insert(
            "X-Client-Version",
            hv("X-Client-Version", &self.client_version)?,
        );
        h.insert(
            "X-Client-Platform",
            hv("X-Client-Platform", &self.client_platform)?,
        );
        h.insert(
            "X-Client-Locale",
            hv("X-Client-Locale", &self.client_locale)?,
        );
        h.insert(
            "X-Client-Bundle-Id",
            hv("X-Client-Bundle-Id", &self.client_bundle_id)?,
        );
        h.insert(
            "X-Client-Timezone-Offset",
            hv(
                "X-Client-Timezone-Offset",
                &self.client_timezone_offset.to_string(),
            )?,
        );
        Ok(h)
    }

    /// 当前 User-Agent（设备凭据自动生成时复用同一身份）
    #[must_use]
    pub fn user_agent(&self) -> String {
        self.user_agent.clone()
    }

    /// 主客户端代理配置（mint 等附属链路对齐出口用）
    pub fn proxy_url(&self) -> Option<&str> {
        self.proxy_url.as_deref()
    }

    /// 运行时 mint 出新设备身份后，把配对的 smidV2 补进共享 cookie jar。
    ///
    /// device_id（登录 body）与 smidV2（Cookie）是同一设备身份的两半，真实浏览器
    /// 两者同源。smidV2 是设备级 cookie：单 jar 只绑一个身份，已有值（构造时预置
    /// 或已补写过）时拒绝再次绑定，与 `preloaded_cookies_from_accounts` 的
    /// "取第一个非空"策略一致。返回是否实际写入。
    pub fn set_smid_cookie(&self, smid: &str) -> bool {
        use std::sync::atomic::Ordering;
        if smid.is_empty() || self.smid_in_jar.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(url) = wreq::Url::parse(&format!("{}/", self.web_origin)) else {
            return false;
        };
        self.jar
            .add_cookie_str(&format!("smidV2={smid}"), &url);
        self.smid_in_jar.store(true, Ordering::SeqCst);
        true
    }

    fn auth_headers(&self, token: &str) -> Result<wreq::header::HeaderMap, ClientError> {
        let mut h = self.web_base_headers()?;
        h.insert(
            wreq::header::AUTHORIZATION,
            wreq::header::HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|e| ClientError::InvalidHeader(format!("Authorization: {e}")))?,
        );
        Ok(h)
    }

    fn auth_headers_with_pow(
        &self,
        token: &str,
        pow_response: &str,
    ) -> Result<wreq::header::HeaderMap, ClientError> {
        let mut h = self.auth_headers(token)?;
        h.insert(
            "X-Ds-Pow-Response",
            wreq::header::HeaderValue::from_str(pow_response)
                .map_err(|e| ClientError::InvalidHeader(format!("X-Ds-Pow-Response: {e}")))?,
        );
        Ok(h)
    }

    /// 当前 leim 值：静态配置优先，否则取后台拉取的动态值
    async fn current_hif_leim(&self) -> Option<String> {
        if !self.hif_static_leim.is_empty() {
            return Some(self.hif_static_leim.clone());
        }
        self.hif.leim().await
    }

    /// 当前 dliq 值：静态配置优先，否则取后台拉取的动态值
    async fn current_hif_dliq(&self) -> Option<String> {
        if !self.hif_static_dliq.is_empty() {
            return Some(self.hif_static_dliq.clone());
        }
        self.hif.dliq().await
    }

    /// 统一出站发送入口：net_capture 开启时把请求/响应头落盘 JSONL（请求体
    /// 序列化产物原样记录）。`cid` 由调用方 `net_capture::begin()` 分配（未启用
    /// 时为 0，内部全部 no-op）；响应体由调用方读取后用 `net_capture::body` 记录。
    ///
    /// 注意保持 `.headers(h)` 在 `.json(v)` 之前：RequestBuilder::headers 会整表
    /// 替换，先 json 后 headers 会把 json() 补的 Content-Type 丢掉。
    async fn send_traced(
        &self,
        cid: u64,
        method: &str,
        url: &str,
        headers: wreq::header::HeaderMap,
        body: Option<serde_json::Value>,
        resp_stream: bool,
    ) -> Result<wreq::Response, ClientError> {
        let mut rec_headers = headers.clone();
        if body.is_some() {
            rec_headers.insert(
                wreq::header::CONTENT_TYPE,
                wreq::header::HeaderValue::from_static("application/json"),
            );
        }
        net_capture::req(
            cid,
            "out",
            method,
            url,
            &rec_headers,
            body.as_ref().map(|v| serde_json::Value::String(v.to_string())),
        );
        let rb = if method == "GET" {
            self.http.get(url)
        } else {
            self.http.post(url)
        };
        let rb = rb.headers(headers);
        let rb = match &body {
            Some(v) => rb.json(v),
            None => rb,
        };
        let resp = rb.send().await;
        match &resp {
            Ok(r) => net_capture::resp(cid, r.status().as_u16(), r.headers(), resp_stream),
            Err(e) => net_capture::err(cid, &e.to_string()),
        }
        resp.map_err(ClientError::from)
    }

    async fn parse_envelope<T: serde::de::DeserializeOwned>(
        cid: u64,
        resp: wreq::Response,
    ) -> Result<T, ClientError> {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let body = resp.text().await?;
        net_capture::body(cid, body.as_bytes(), false);
        let envelope: Envelope<T> = serde_json::from_str(&body).map_err(|e| {
            // 信封/载荷结构漂移时把原始体打进日志（截断），否则线上只有
            // 一句 "missing field `id`" 无法定位服务端实际返回了什么
            warn!(
                target: "ds_core::client",
                "响应信封解析失败（{}）: {}",
                e,
                &body[..body.len().min(1200)]
            );
            e
        })?;
        envelope.into_result()
    }

    pub async fn login(&self, payload: &LoginPayload) -> Result<LoginData, ClientError> {
        // 登录前无 token，但其余 web 头必须齐全；referer 指向登录页（实抓一致）
        let mut h = self.web_base_headers()?;
        h.insert(
            wreq::header::REFERER,
            wreq::header::HeaderValue::from_str(&format!("{}/sign_in", self.web_origin))
                .map_err(|e| ClientError::InvalidHeader(format!("Referer: {e}")))?,
        );
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!("{}{}", self.api_base, ENDPOINT_USERS_LOGIN),
                h,
                Some(serde_json::to_value(payload)?),
                false,
            )
            .await?;

        if is_waf_challenge(&resp) {
            print_waf_hint();
            // WAF 挑战页本身是重要证据（JS challenge 形态与版本），一并落盘
            let waf_body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, waf_body.as_bytes(), false);
            return Err(ClientError::Status {
                status: 202,
                body: "WAF Challenge: use a non-US proxy".into(),
            });
        }

        Self::parse_envelope::<LoginData>(cid, resp).await
    }

    pub async fn create_session(&self, token: &str) -> Result<String, ClientError> {
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!("{}{}", self.api_base, ENDPOINT_CHAT_SESSION_CREATE),
                self.auth_headers(token)?,
                Some(serde_json::json!({})),
                false,
            )
            .await?;
        let wrapper: CreateSessionWrapper = Self::parse_envelope(cid, resp).await?;
        let session_id = wrapper.chat_session.id;
        if session_id.is_empty() {
            return Err(ClientError::Validation(
                "会话 ID 为空，上游未返回 chat_session.id".to_string(),
            ));
        }
        Ok(session_id)
    }

    pub async fn delete_session(&self, token: &str, session_id: &str) -> Result<(), ClientError> {
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!("{}{}", self.api_base, ENDPOINT_CHAT_SESSION_DELETE),
                self.auth_headers(token)?,
                Some(serde_json::json!({ "chat_session_id": session_id })),
                false,
            )
            .await?;
        Self::parse_envelope::<Option<()>>(cid, resp).await?;
        Ok(())
    }

    /// 拉取客户端设置（官方 web 开屏必发序列之一：FULL.har login → settings×3）。
    /// GET /client/settings?did=<uuid>&scope=main/model/web_upgrade —— 仅鉴权。
    /// 结果调用方忽略（拟真行为流用），错误也吞掉。
    pub async fn fetch_client_settings(&self, token: &str, did: &str) {
        let headers = match self.auth_headers(token) {
            Ok(h) => h,
            Err(_) => return,
        };
        let url = format!("{}{}", self.api_base, ENDPOINT_CLIENT_SETTINGS);
        let cid = net_capture::begin();
        // 抓取记录的 URL 手工补 query（实际发送仍走 .query()，行为不变）
        net_capture::req(
            cid,
            "out",
            "GET",
            &format!(
                "{}{}?did={}&scope=main/model/web_upgrade",
                self.api_base, ENDPOINT_CLIENT_SETTINGS, did
            ),
            &headers,
            None,
        );
        let resp = self
            .http
            .get(url)
            .headers(headers)
            .query(&[("did", did), ("scope", "main/model/web_upgrade")])
            .send()
            .await;
        match &resp {
            Ok(r) => net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
            Err(e) => net_capture::err(cid, &e.to_string()),
        }
        // 拟真流量：结果调用方忽略（响应体照旧不读取），抓取侧记说明闭环
        net_capture::body_note(cid, "响应体未读取（拟真开屏流量，结果忽略）");
    }

    /// 拉取云端会话列表（Web 端"历史会话"侧栏数据源，full.har entry#53 实证）。
    ///
    /// GET /chat_session/fetch_page?lte_cursor.pinned=false —— 无需 PoW，仅需鉴权。
    /// `before_updated_at`：游标翻页（响应含 has_more，按最后一条 updated_at 续拉）。
    /// 响应结构已在 net-export jsonl 中实证（data.biz_data.chat_sessions），保留宽容兜底。
    pub async fn fetch_session_page(
        &self,
        token: &str,
        before_updated_at: Option<f64>,
    ) -> Result<CloudSessionPage, ClientError> {
        let base = format!(
            "{}{}",
            self.api_base, ENDPOINT_CHAT_SESSION_FETCH_PAGE
        );
        let cid = net_capture::begin();
        let headers = self.auth_headers(token)?;
        let mut url_cap = format!("{}?lte_cursor.pinned=false", base);
        if let Some(ts) = before_updated_at {
            url_cap.push_str(&format!("&lte_cursor.updated_at={:.3}", ts));
        }
        net_capture::req(cid, "out", "GET", &url_cap, &headers, None);
        let mut rb = self
            .http
            .get(base)
            .headers(headers)
            .query(&[("lte_cursor.pinned", "false")]);
        if let Some(ts) = before_updated_at {
            rb = rb.query(&[("lte_cursor.updated_at", format!("{:.3}", ts))]);
        }
        let resp = rb.send().await;
        match &resp {
            Ok(r) => net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
            Err(e) => net_capture::err(cid, &e.to_string()),
        }
        let resp = resp?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        // resp.json() 内部读体不可观测，改 text+parse 以落盘响应体
        let text = resp.text().await?;
        net_capture::body(cid, text.as_bytes(), false);
        let envelope: serde_json::Value = serde_json::from_str(&text)?;
        let sessions = extract_cloud_sessions(&envelope);
        let has_more = envelope
            .pointer("/data/biz_data/has_more")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Ok(CloudSessionPage { sessions, has_more })
    }

    /// 拉取云端会话的消息内容（full.har + net-export jsonl 实证协议）。
    /// GET /chat/history_messages?chat_session_id=<id> —— 无需 PoW，仅需鉴权。
    /// 响应：data.biz_data.chat_messages[]，每条消息的 fragments 中
    /// REQUEST→用户文本、RESPONSE→回复、THINK→思考。
    pub async fn fetch_session_messages(
        &self,
        token: &str,
        session_id: &str,
    ) -> Result<Vec<CloudMessage>, ClientError> {
        let cid = net_capture::begin();
        let headers = self.auth_headers(token)?;
        net_capture::req(
            cid,
            "out",
            "GET",
            &format!(
                "{}{}?chat_session_id={}",
                self.api_base, ENDPOINT_CHAT_HISTORY_MESSAGES, session_id
            ),
            &headers,
            None,
        );
        let resp = self
            .http
            .get(format!(
                "{}{}",
                self.api_base, ENDPOINT_CHAT_HISTORY_MESSAGES
            ))
            .headers(headers)
            .query(&[("chat_session_id", session_id)])
            .send()
            .await;
        match &resp {
            Ok(r) => net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
            Err(e) => net_capture::err(cid, &e.to_string()),
        }
        let resp = resp?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        // resp.json() 内部读体不可观测，改 text+parse 以落盘响应体
        let text = resp.text().await?;
        net_capture::body(cid, text.as_bytes(), false);
        let envelope: serde_json::Value = serde_json::from_str(&text)?;
        let mut out = Vec::new();
        if let Some(arr) = envelope.pointer("/data/biz_data/chat_messages").and_then(|v| v.as_array()) {
            // 云端把编辑/重试存成树：节点带 id + parent_id（根节点 parent_id
            // 为 "0"/null）。同一父下多个子 = 多个版本，数组最后一个为活跃版。
            // 老协议（无 parent_id 字段）则平铺，行为不变。
            // 节点结构见模块级 TreeNode（prune_message_tree 用）

            let mut nodes: Vec<(String, TreeNode)> = Vec::new();
            let mut has_tree = false;
            for m in arr {
                // 实测字段是 message_id（数值）+ parent_id（数值）；兼容旧猜测的 id/字符串形态
                let id = m
                    .get("message_id")
                    .or_else(|| m.get("id"))
                    .map(scalar_to_string)
                    .unwrap_or_default();
                let parent = m
                    .get("parent_id")
                    .or_else(|| m.get("parent_message_id"))
                    .map(scalar_to_string);
                if parent.is_some() {
                    has_tree = true;
                }
                let role_raw = m.get("role").and_then(|r| r.as_str()).unwrap_or("").to_string();
                let is_user = role_raw.eq_ignore_ascii_case("user");
                let mut content = String::new();
                let mut reasoning = String::new();
                if let Some(frags) = m.get("fragments").and_then(|f| f.as_array()) {
                    for f in frags {
                        let ty = f.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let c = f.get("content").and_then(|c| c.as_str()).unwrap_or("");
                        match ty {
                            "REQUEST" => {
                                if is_user {
                                    content.push_str(c);
                                }
                            }
                            "RESPONSE" => content.push_str(c),
                            "THINK" => reasoning.push_str(c),
                            _ => {}
                        }
                    }
                }
                let is_empty = content.is_empty() && reasoning.is_empty();
                nodes.push((id, TreeNode { role_raw, content, reasoning, parent, is_empty }));
            }

            out = prune_message_tree(nodes, has_tree);
        }
        Ok(out)
    }

    pub async fn create_pow_challenge(
        &self,
        token: &str,
        target_path: &str,
    ) -> Result<ChallengeData, ClientError> {
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!(
                    "{}{}",
                    self.api_base, ENDPOINT_CHAT_CREATE_POW_CHALLENGE
                ),
                self.auth_headers(token)?,
                Some(serde_json::json!({ "target_path": target_path })),
                false,
            )
            .await?;
        let wrapper: ChallengeWrapper = Self::parse_envelope(cid, resp).await?;
        let challenge = wrapper.challenge;
        Ok(challenge)
    }

    pub async fn completion(
        &self,
        token: &str,
        pow_response: &str,
        payload: &CompletionPayload,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Bytes, ClientError>> + Send>>, ClientError> {
        let mut h = self.auth_headers_with_pow(token, pow_response)?;
        // Referer 按会话定制（风控差异 #6）：官方在会话页发 completion，
        // Referer 为 {origin}/a/chat/s/{session_id}；旧实现一律是 {origin}/。
        if !payload.chat_session_id.is_empty() {
            let referer = format!("{}/a/chat/s/{}", self.web_origin, payload.chat_session_id);
            if let Ok(v) = wreq::header::HeaderValue::from_str(&referer) {
                h.insert(wreq::header::REFERER, v);
            }
        }
        // HIF 头：new.jsonl 实测仅 /chat/completion 携带（login、create_session、
        // create_pow_challenge、upload_file 均无）。值为分发服务下发的动态凭据
        // （见 hif.rs），静态配置值优先，否则用后台拉取的当前值；都没有则不发
        // （等价于前端冷启动首个请求在 poller 成功前的形态）。
        if let Some(v) = self.current_hif_leim().await {
            h.insert(
                "x-hif-leim",
                wreq::header::HeaderValue::from_str(&v)
                    .map_err(|e| ClientError::InvalidHeader(format!("x-hif-leim: {e}")))?,
            );
        }
        if let Some(v) = self.current_hif_dliq().await {
            h.insert(
                "x-hif-dliq",
                wreq::header::HeaderValue::from_str(&v)
                    .map_err(|e| ClientError::InvalidHeader(format!("x-hif-dliq: {e}")))?,
            );
        }
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!("{}{}", self.api_base, ENDPOINT_CHAT_COMPLETION),
                h,
                Some(serde_json::to_value(payload)?),
                true,
            )
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }

        let stream = resp.bytes_stream().map_err(ClientError::Http);
        if net_capture::enabled() {
            // 流内容累计落盘：禁言等业务失败常在 SSE 首帧 biz_code 里，
            // 即使上层提前断流（CaptureStream drop）也能留下已收到的部分
            Ok(Box::pin(CaptureStream {
                inner: Box::pin(stream),
                cid,
                buf: Vec::new(),
                truncated: false,
                done: false,
            }))
        } else {
            Ok(Box::pin(stream))
        }
    }

    #[allow(dead_code)]
    pub async fn edit_message(
        &self,
        token: &str,
        pow_response: &str,
        payload: &EditMessagePayload,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Bytes, ClientError>> + Send>>, ClientError> {
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!("{}{}", self.api_base, ENDPOINT_CHAT_EDIT_MESSAGE),
                self.auth_headers_with_pow(token, pow_response)?,
                Some(serde_json::to_value(payload)?),
                true,
            )
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }

        let stream = resp.bytes_stream().map_err(ClientError::Http);
        if net_capture::enabled() {
            Ok(Box::pin(CaptureStream {
                inner: Box::pin(stream),
                cid,
                buf: Vec::new(),
                truncated: false,
                done: false,
            }))
        } else {
            Ok(Box::pin(stream))
        }
    }

    #[allow(dead_code)]
    pub async fn update_title(
        &self,
        token: &str,
        payload: &UpdateTitlePayload,
    ) -> Result<(), ClientError> {
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!(
                    "{}{}",
                    self.api_base, ENDPOINT_CHAT_SESSION_UPDATE_TITLE
                ),
                self.auth_headers(token)?,
                Some(serde_json::to_value(payload)?),
                false,
            )
            .await?;
        Self::parse_envelope::<serde::de::IgnoredAny>(cid, resp).await?;
        Ok(())
    }

    /// 取消正在进行的流式输出，不需要 PoW
    pub async fn stop_stream(
        &self,
        token: &str,
        payload: &StopStreamPayload,
    ) -> Result<(), ClientError> {
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "POST",
                &format!("{}{}", self.api_base, ENDPOINT_CHAT_STOP_STREAM),
                self.auth_headers(token)?,
                Some(serde_json::to_value(payload)?),
                false,
            )
            .await?;
        Self::parse_envelope::<Option<()>>(cid, resp).await?;
        Ok(())
    }

    /// 上传文件，返回文件元数据（id, status 等）
    /// 上传文件。web 端实抓（new.jsonl entry#0117）除鉴权/PoW 外还带
    /// `x-file-size`、`x-model-type`、`x-thinking-enabled` 三个业务头，缺失即为指纹差异。
    pub async fn upload_file(
        &self,
        token: &str,
        pow_response: &str,
        filename: &str,
        content_type: &str,
        bytes: Vec<u8>,
        model_type: &str,
        thinking_enabled: bool,
    ) -> Result<UploadFileData, ClientError> {
        let file_size = bytes.len();
        let part = Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str(content_type)?;
        let form = Form::new().part("file", part);

        let mut h = self.auth_headers_with_pow(token, pow_response)?;
        h.insert(
            "X-File-Size",
            wreq::header::HeaderValue::from_str(&file_size.to_string())
                .map_err(|e| ClientError::InvalidHeader(format!("X-File-Size: {e}")))?,
        );
        h.insert(
            "X-Model-Type",
            wreq::header::HeaderValue::from_str(model_type)
                .map_err(|e| ClientError::InvalidHeader(format!("X-Model-Type: {e}")))?,
        );
        h.insert(
            "X-Thinking-Enabled",
            wreq::header::HeaderValue::from_static(if thinking_enabled { "1" } else { "0" }),
        );

        let cid = net_capture::begin();
        net_capture::req(
            cid,
            "out",
            "POST",
            &format!("{}{}", self.api_base, ENDPOINT_FILE_UPLOAD),
            &h,
            Some(serde_json::json!({
                "_multipart": {
                    "filename": filename,
                    "content_type": content_type,
                    "size": file_size,
                    "note": "multipart 表单体不落盘",
                }
            })),
        );
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_FILE_UPLOAD))
            .headers(h)
            .multipart(form)
            .send()
            .await;
        match &resp {
            Ok(r) => net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
            Err(e) => net_capture::err(cid, &e.to_string()),
        }
        let resp = resp?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let body = resp.text().await?;
        net_capture::body(cid, body.as_bytes(), false);
        match serde_json::from_str::<Envelope<UploadFileData>>(&body) {
            Ok(env) => env.into_result(),
            Err(primary) => {
                // 信封反序列化失败有两种可能，必须区分（2026-09-25 真机实证）：
                // 1) 业务错误（如 biz_code=14 "user is muted"）：biz_data 是 mute
                //    信息而非文件对象 → Envelope<UploadFileData> 反序列化必然失败，
                //    但这不该走"格式漂移"兜底，应原样上报业务错误（上层换号）。
                // 2) 服务端真改了 biz_data 结构 → 宽容搜索含 id 的对象。
                let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
                    ClientError::Business {
                        code: -1,
                        msg: format!("upload_file 响应非 JSON（{}）: {}", e, &body[..body.len().min(400)]),
                    }
                })?;
                let top_code = v.get("code").and_then(|x| x.as_i64());
                let data = v.get("data");
                let biz_code = data
                    .and_then(|d| d.get("biz_code"))
                    .and_then(|x| x.as_i64());
                let biz_msg = data
                    .and_then(|d| d.get("biz_msg"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if top_code.unwrap_or(0) != 0 || biz_code.unwrap_or(0) != 0 {
                    warn!(
                        target: "ds_core::client",
                        "upload_file 业务错误（code={:?}, biz_code={:?}, msg={}）",
                        top_code, biz_code, biz_msg
                    );
                    // msg 带原始体（禁言响应里 biz_data.is_muted/mute_until 可被
                    // 上层 parse_mute_response 解析出到期时间）
                    return Err(ClientError::Business {
                        code: top_code.filter(|c| *c != 0).or(biz_code).unwrap_or(-1),
                        msg: body[..floor_utf8_end(&body, 600)].to_string(),
                    });
                }
                warn!(
                    target: "ds_core::client",
                    "upload_file 响应解析失败（{}），尝试宽容解析: {}",
                    primary,
                    &body[..body.len().min(1200)]
                );
                extract_upload_loose(&v).ok_or(ClientError::Business {
                    code: -1,
                    msg: format!("upload_file 响应中未找到文件 id: {}", &body[..body.len().min(400)]),
                })
            }
        }
    }

    /// 查询文件状态，返回文件列表（含 status: PENDING/SUCCESS/FAILED）
    pub async fn fetch_files(
        &self,
        token: &str,
        file_ids: &[String],
    ) -> Result<FetchFilesData, ClientError> {
        let ids = file_ids.join(",");
        let cid = net_capture::begin();
        let resp = self
            .send_traced(
                cid,
                "GET",
                &format!(
                    "{}{}?file_ids={}",
                    self.api_base, ENDPOINT_FILE_FETCH, ids
                ),
                self.auth_headers(token)?,
                None,
                false,
            )
            .await?;
        Self::parse_envelope::<FetchFilesData>(cid, resp).await
    }

    pub async fn get_wasm(&self) -> Result<Bytes, ClientError> {
        let cid = net_capture::begin();
        net_capture::req(
            cid,
            "out",
            "GET",
            &self.wasm_url,
            &wreq::header::HeaderMap::new(),
            None,
        );
        let resp = self.http.get(&self.wasm_url).send().await;
        match &resp {
            Ok(r) => net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
            Err(e) => net_capture::err(cid, &e.to_string()),
        }
        let resp = resp?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            net_capture::body(cid, body.as_bytes(), false);
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let bytes = resp.bytes().await?;
        net_capture::body_note(
            cid,
            &format!("二进制 wasm {} 字节，内容不落盘", bytes.len()),
        );
        Ok(bytes)
    }

}
/// 云端消息树剪枝：返回活跃链（每层"数组顺序最后一个子节点"），
/// 同层被替换的兄弟版本作为 alt_texts（升序，不含当前）。
/// has_tree=false（老协议无 parent_id）或无法定位根时退化为平铺，不丢数据。
fn prune_message_tree(nodes: Vec<(String, TreeNode)>, has_tree: bool) -> Vec<CloudMessage> {
    let mut out = Vec::new();
    if !has_tree {
        for (_, n) in &nodes {
            if n.is_empty {
                continue;
            }
            out.push(CloudMessage {
                role: if n.role_raw.eq_ignore_ascii_case("user") { "user".into() } else { "assistant".into() },
                content: n.content.clone(),
                reasoning: n.reasoning.clone(),
                alt_texts: Vec::new(),
            });
        }
        return out;
    }

    use std::collections::HashMap;
    let mut children_of: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, (_, n)) in nodes.iter().enumerate() {
        if let Some(p) = n.parent.as_deref() {
            children_of.entry(p.to_string()).or_default().push(idx);
        }
    }

    // 根的 parent_id 约定 "0"（或空串）；找不到时退化为"parent 指向不存在节点"的组。
    let known_ids: std::collections::HashSet<&str> =
        nodes.iter().map(|(id, _)| id.as_str()).collect();
    let root_key: Option<String> = ["0", ""]
        .iter()
        .find(|k| children_of.contains_key(**k))
        .map(|k| (*k).to_string())
        .or_else(|| {
            children_of
                .keys()
                .find(|k| !known_ids.contains(k.as_str()))
                .cloned()
        });

    let Some(root) = root_key else {
        // 无法定位根：平铺兜底
        for (_, n) in &nodes {
            if n.is_empty {
                continue;
            }
            out.push(CloudMessage {
                role: if n.role_raw.eq_ignore_ascii_case("user") { "user".into() } else { "assistant".into() },
                content: n.content.clone(),
                reasoning: n.reasoning.clone(),
                alt_texts: Vec::new(),
            });
        }
        return out;
    };

    // 活跃链：从根开始每层取数组里最后一个子节点
    let mut cur: Option<String> = Some(root);
    // 已访问节点集合：畸形数据（如 parent_id 指向自己）会让链成环，
    // 没有它这里会无限循环、无限消耗内存并挂死请求。
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(key) = cur {
        if !visited.insert(key.clone()) {
            // 成环：剩余节点全部按平铺兜底，不丢数据
            for (_, n) in &nodes {
                if n.is_empty {
                    continue;
                }
                out.push(CloudMessage {
                    role: if n.role_raw.eq_ignore_ascii_case("user") { "user".into() } else { "assistant".into() },
                    content: n.content.clone(),
                    reasoning: n.reasoning.clone(),
                    alt_texts: Vec::new(),
                });
            }
            break;
        }
        let kids = match children_of.get(&key) {
            Some(k) if !k.is_empty() => k.clone(),
            _ => break,
        };
        let last = *kids.last().unwrap();
        let (last_id, n) = &nodes[last];
        if !n.is_empty {
            let is_user = n.role_raw.eq_ignore_ascii_case("user");
            let alt_texts: Vec<String> = kids[..kids.len() - 1]
                .iter()
                .filter_map(|&i| {
                    let (_, s) = &nodes[i];
                    if s.is_empty { None } else { Some(s.content.clone()) }
                })
                .collect();
            out.push(CloudMessage {
                role: if is_user { "user".into() } else { "assistant".into() },
                content: n.content.clone(),
                reasoning: n.reasoning.clone(),
                alt_texts,
            });
        }
        cur = if last_id.is_empty() { None } else { Some(last_id.clone()) };
    }
    out
}



#[cfg(test)]
mod tests {
    use super::{
        origin_of, prune_message_tree, ChatMute, CloudMessage, CreateSessionWrapper, DsClient,
        Envelope, LoginData, LoginPayload, TreeNode, UserInfo,
    };

    fn node(id: &str, parent: Option<&str>, role: &str, content: &str) -> (String, TreeNode) {
        (
            id.to_string(),
            TreeNode {
                role_raw: role.to_string(),
                content: content.to_string(),
                reasoning: String::new(),
                parent: parent.map(|p| p.to_string()),
                is_empty: content.is_empty(),
            },
        )
    }

    fn texts(msgs: &[CloudMessage]) -> Vec<&str> {
        msgs.iter().map(|m| m.content.as_str()).collect()
    }

    /// bug 4 回归：编辑产生的兄弟版本不堆叠——活跃链只含最新版本，
    /// 旧版本进 alt_texts（升序，不含当前）。
    /// 实测协议：message_id/parent_id 均为数字（scalar_to_string 统一），
    /// 编辑 = 同一 parent 下的多个兄弟，数组最后一个（最新 inserted_at）为活跃版。
    #[test]
    fn message_tree_keeps_active_branch_with_alts() {
        // 用户消息被编辑两次：三版用户消息是同一 parent("0") 下的兄弟节点，
        // v3 是数组最后一个（活跃）；v3 下有两版回复（r1 历史，r2 活跃）。
        let nodes = vec![
            node("1", Some("0"), "user", "v1"),
            node("2", Some("0"), "user", "v2"),
            node("3", Some("0"), "user", "v3"),
            node("4", Some("3"), "assistant", "r1"),
            node("5", Some("3"), "assistant", "r2"),
        ];
        let out = prune_message_tree(nodes, true);
        assert_eq!(texts(&out), vec!["v3", "r2"]);
        assert_eq!(out[0].alt_texts, vec!["v1", "v2"]);
        assert_eq!(out[1].alt_texts, vec!["r1"]);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[1].role, "assistant");
    }

    /// 老协议（无 parent_id）平铺不丢数据
    #[test]
    fn flat_messages_pass_through() {
        let nodes = vec![
            node("a", None, "user", "q"),
            node("b", None, "assistant", "ans"),
        ];
        let out = prune_message_tree(nodes, false);
        assert_eq!(texts(&out), vec!["q", "ans"]);
        assert!(out.iter().all(|m| m.alt_texts.is_empty()));
    }

    /// 空内容节点（如仅含已删 fragment）不进活跃链
    #[test]
    fn empty_nodes_skipped() {
        let nodes = vec![
            node("1", Some("0"), "user", "q"),
            node("2", Some("1"), "assistant", ""),
            node("3", Some("1"), "assistant", "ans"),
        ];
        let out = prune_message_tree(nodes, true);
        assert_eq!(texts(&out), vec!["q", "ans"]);
        // r1 非空才进 alt_texts；空节点被过滤
        assert!(out[1].alt_texts.is_empty());
    }

    /// 回归：未禁言的账号，上游登录响应里 `mute_until` 是显式 null。
    /// 旧实现（裸 #[serde(default)]）会整体反序列化失败，账号永远登录不了。
    #[test]
    fn login_response_with_null_mute_until_parses() {
        let json = r#"{
            "code": 0,
            "msg": "",
            "user": {
                "id": "u-1",
                "token": "tok",
                "email": "a@b.com",
                "mobile_number": null,
                "chat": {
                    "is_muted": null,
                    "mute_until": null
                }
            }
        }"#;
        let data: LoginData =
            serde_json::from_str(json).expect("null mute_until 必须能解析（未禁言的常见情况）");
        let chat = data.user.chat.expect("chat 字段应存在");
        assert_eq!(chat.is_muted, 0);
        assert_eq!(chat.mute_until, 0.0);
    }

    /// 禁言账号仍要正确读出到期时间（回归保护：宽容解析不能把真实值吃掉）
    #[test]
    fn login_response_with_real_mute_until_keeps_value() {
        let json = r#"{
            "code": 0,
            "msg": "",
            "user": {
                "id": "u-1",
                "token": "tok",
                "chat": { "is_muted": 1, "mute_until": 1790000000 }
            }
        }"#;
        let data: LoginData = serde_json::from_str(json).expect("禁言响应应能解析");
        let chat = data.user.chat.expect("chat 字段应存在");
        assert_eq!(chat.is_muted, 1);
        assert_eq!(chat.mute_until, 1790000000.0);
    }

    /// chat 缺字段时也应回落为默认值（老响应/字段演进的兼容性）
    #[test]
    fn chat_mute_missing_fields_default() {
        let chat: ChatMute =
            serde_json::from_str(r#"{}"#).expect("空 chat 对象应回落默认值");
        assert_eq!(chat.is_muted, 0);
        assert_eq!(chat.mute_until, 0.0);
    }

    /// 防止 UserInfo 意外变严：没有 chat 字段的旧响应也能解析
    #[test]
    fn user_info_without_chat_parses() {
        let user: UserInfo = serde_json::from_str(
            r#"{"id":"u-1","token":"tok","email":"a@b.com"}"#,
        )
        .expect("没有 chat 字段的响应应能解析");
        assert!(user.chat.is_none());
    }

    #[test]
    fn derives_web_origin_from_api_base() {
        assert_eq!(
            origin_of("https://chat.deepseek.com/api/v0"),
            "https://chat.deepseek.com"
        );
        // 尾斜杠、自定义端口、无路径都要能正确取到 scheme://host[:port]
        assert_eq!(
            origin_of("https://chat.deepseek.com/api/v0/"),
            "https://chat.deepseek.com"
        );
        assert_eq!(
            origin_of("http://127.0.0.1:8080/api/v0"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(origin_of("https://example.com"), "https://example.com");
    }

    #[test]
    fn parses_nested_chat_session_id() {
        let envelope: Envelope<CreateSessionWrapper> = serde_json::from_str(
            r#"{
                "code": 0,
                "msg": "",
                "data": {
                    "biz_code": 0,
                    "biz_msg": "",
                    "biz_data": {
                        "chat_session": {
                            "id": "01234567-89ab-cdef-0123-456789abcdef"
                        }
                    }
                }
            }"#,
        )
        .expect("nested chat_session response should deserialize");

        let wrapper = envelope.into_result().expect("envelope should be successful");
        assert_eq!(wrapper.chat_session.id, "01234567-89ab-cdef-0123-456789abcdef");
    }
    /// 回归：畸形消息树曾让活跃链 while 循环无限执行（cur 永远停在同一个
    /// id 上）、out 无限增长并挂死请求。触发形状是「重复 id + 其中一份的
    /// parent_id 指向同名 id」：走到 "X" 时最后一个子节点又是 id="X" 的
    /// 节点，cur 永远回到 "X"。现在 visited 集合会截断成环，剩余节点
    /// 平铺兜底，不丢数据。
    #[test]
    fn self_referential_parent_does_not_hang() {
        let nodes = vec![
            node("X", Some("0"), "user", "q"),
            node("Y", Some("X"), "assistant", "a"),
            // 同名 id 且 parent 指向同名 id：children_of["X"] 的最后一项
            // 的 id 还是 "X"
            node("X", Some("X"), "assistant", "loop"),
        ];
        let out = prune_message_tree(nodes, true);
        let t = texts(&out);
        assert!(t.contains(&"q"), "user msg kept, got {t:?}");
        assert!(t.contains(&"a"), "mid msg kept, got {t:?}");
        assert!(t.contains(&"loop"), "cyclic node kept via fallback, got {t:?}");
    }

    /// 深链不成环时仍走正常活跃链语义（visited 集合不影响正常数据）
    #[test]
    fn deep_chain_still_walks_active_branch() {
        let nodes = vec![
            node("1", Some("0"), "user", "q1"),
            node("2", Some("1"), "assistant", "a1"),
            node("3", Some("2"), "user", "q2"),
            node("4", Some("3"), "assistant", "a2"),
        ];
        let out = prune_message_tree(nodes, true);
        assert_eq!(texts(&out), vec!["q1", "a1", "q2", "a2"]);
    }

    /// 修复②回归：运行时 mint 出新设备身份后补写的 smidV2 必须真的随请求发出，
    /// 且设备级 cookie 只允许绑定一次。登录响应解析失败没关系，只验证请求头。
    #[tokio::test]
    async fn set_smid_cookie_flows_into_outgoing_requests() {
        let (addr, captured) = crate::ds_core::mock_http::spawn(200, r#"{"code":-1}"#);
        let client = DsClient::new(
            format!("http://{addr}/api/v0"),
            format!("http://{addr}/wasm"),
            crate::ds_core::default_user_agent(),
            "1.0.0".to_string(),
            "Linux aarch64".to_string(),
            "zh_CN".to_string(),
            "test.bundle".to_string(),
            480,
            None,
            vec![],
            String::new(),
            String::new(),
            false,
        );
        assert!(client.set_smid_cookie("smid-test-123"), "首次写入应成功");
        assert!(
            !client.set_smid_cookie("smid-other"),
            "设备级 cookie 二次写入必须被拒绝（单 jar 只绑一个设备身份）"
        );

        let payload = LoginPayload {
            email: Some("a@b.c".to_string()),
            mobile: None,
            password: "pw".to_string(),
            area_code: None,
            device_id: "Bdevice".to_string(),
            os: "web".to_string(),
        };
        let _ = client.login(&payload).await;

        let req = tokio::time::timeout(std::time::Duration::from_secs(5), captured)
            .await
            .expect("mock 未收到登录请求（超时）")
            .expect("mock 任务失败");
        let cookie = req.header("cookie").unwrap_or_default();
        assert!(
            cookie.contains("smidV2=smid-test-123"),
            "smidV2 必须随登录请求发送，实际 cookie: {cookie}"
        );
        assert!(!cookie.contains("smid-other"), "二次写入的值不得出现");
    }
}
