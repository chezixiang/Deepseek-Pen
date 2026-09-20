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

// API 端点常量
const ENDPOINT_USERS_LOGIN: &str = "/users/login";
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
#[derive(Debug, Deserialize)]
pub struct ChatMute {
    #[serde(default)]
    pub is_muted: i64,
    #[serde(default)]
    pub mute_until: f64,
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
    #[allow(dead_code)]
    pub status: String,
    #[allow(dead_code)]
    pub file_name: String,
    #[allow(dead_code)]
    pub file_size: i64,
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

/// 云端消息条目（history_messages 解析结果，fragments 已拼接）
#[derive(Debug, Clone, Serialize)]
pub struct CloudMessage {
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    /// THINK fragment 内容（assistant 消息可能有）
    pub reasoning: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<i64>,
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

/// Print a hint when WAF challenge is detected
fn print_waf_hint() {
    warn!(target: "ds_core::client", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
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
        let mut builder = wreq::Client::builder()
            .emulation(Emulation::Chrome136)
            // 客户端级 UA：覆盖 emulation 的默认值（其 profile 默认 OS 为 macOS，
            // 会发 "Macintosh; Intel Mac OS X" UA）。HIF token 拉取、wasm 下载等
            // 未逐请求覆盖 UA 的请求也必须与身份一致（Linux aarch64 Chrome 136）。
            .user_agent(user_agent.clone())
            .redirect(wreq::redirect::Policy::limited(10))
            // 浏览器行为对齐（new.jsonl 抓包实证）：真实客户端带 Cookie 头——
            // HWWAFSESID/HWWAFSESTIME（华为云 WAF）、ds_session_id、smidV2（数美）
            // 均随响应 Set-Cookie 累积并在后续请求回传。此前未启用 cookie store，
            // 请求链上完全无 cookie 是一个可识别的自动化特征。
            .cookie_provider(std::sync::Arc::new(build_cookie_jar(
                &api_base,
                preloaded_cookies,
            )));
        if let Some(url) = proxy_url.and_then(|u| wreq::Proxy::all(u).ok()) {
            builder = builder.proxy(url);
        }
        let web_origin = origin_of(&api_base);
        let http = builder.build().expect("构建 HTTP 客户端失败");

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

    async fn parse_envelope<T: serde::de::DeserializeOwned>(
        resp: wreq::Response,
    ) -> Result<T, ClientError> {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let envelope: Envelope<T> = resp.json().await?;
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
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_USERS_LOGIN))
            .headers(h)
            .json(payload)
            .send()
            .await?;

        if is_waf_challenge(&resp) {
            print_waf_hint();
            return Err(ClientError::Status {
                status: 202,
                body: "WAF Challenge: use a non-US proxy".into(),
            });
        }

        Self::parse_envelope::<LoginData>(resp).await
    }

    pub async fn create_session(&self, token: &str) -> Result<String, ClientError> {
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_CHAT_SESSION_CREATE))
            .headers(self.auth_headers(token)?)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        let wrapper: CreateSessionWrapper = Self::parse_envelope(resp).await?;
        let session_id = wrapper.chat_session.id;
        if session_id.is_empty() {
            return Err(ClientError::Validation(
                "会话 ID 为空，上游未返回 chat_session.id".to_string(),
            ));
        }
        Ok(session_id)
    }

    pub async fn delete_session(&self, token: &str, session_id: &str) -> Result<(), ClientError> {
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_CHAT_SESSION_DELETE))
            .headers(self.auth_headers(token)?)
            .json(&serde_json::json!({ "chat_session_id": session_id }))
            .send()
            .await?;
        Self::parse_envelope::<Option<()>>(resp).await?;
        Ok(())
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
        let url = format!(
            "{}{}",
            self.api_base, ENDPOINT_CHAT_SESSION_FETCH_PAGE
        );
        let mut req = self
            .http
            .get(url)
            .headers(self.auth_headers(token)?)
            .query(&[("lte_cursor.pinned", "false")]);
        if let Some(ts) = before_updated_at {
            req = req.query(&[("lte_cursor.updated_at", format!("{:.3}", ts))]);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let envelope: serde_json::Value = resp.json().await?;
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
        let resp = self
            .http
            .get(format!(
                "{}{}",
                self.api_base, ENDPOINT_CHAT_HISTORY_MESSAGES
            ))
            .headers(self.auth_headers(token)?)
            .query(&[("chat_session_id", session_id)])
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let envelope: serde_json::Value = resp.json().await?;
        let mut out = Vec::new();
        if let Some(arr) = envelope.pointer("/data/biz_data/chat_messages").and_then(|v| v.as_array()) {
            for m in arr {
                let role_raw = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
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
                if content.is_empty() && reasoning.is_empty() {
                    continue;
                }
                out.push(CloudMessage {
                    role: if is_user { "user".into() } else { "assistant".into() },
                    content,
                    reasoning,
                });
            }
        }
        Ok(out)
    }

    pub async fn create_pow_challenge(
        &self,
        token: &str,
        target_path: &str,
    ) -> Result<ChallengeData, ClientError> {
        let resp = self
            .http
            .post(format!(
                "{}{}",
                self.api_base, ENDPOINT_CHAT_CREATE_POW_CHALLENGE
            ))
            .headers(self.auth_headers(token)?)
            .json(&serde_json::json!({ "target_path": target_path }))
            .send()
            .await?;
        let wrapper: ChallengeWrapper = Self::parse_envelope(resp).await?;
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
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_CHAT_COMPLETION))
            .headers(h)
            .json(payload)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }

        Ok(Box::pin(resp.bytes_stream().map_err(ClientError::Http)))
    }

    #[allow(dead_code)]
    pub async fn edit_message(
        &self,
        token: &str,
        pow_response: &str,
        payload: &EditMessagePayload,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Bytes, ClientError>> + Send>>, ClientError> {
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_CHAT_EDIT_MESSAGE))
            .headers(self.auth_headers_with_pow(token, pow_response)?)
            .json(payload)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }

        Ok(Box::pin(resp.bytes_stream().map_err(ClientError::Http)))
    }

    #[allow(dead_code)]
    pub async fn update_title(
        &self,
        token: &str,
        payload: &UpdateTitlePayload,
    ) -> Result<(), ClientError> {
        let resp = self
            .http
            .post(format!(
                "{}{}",
                self.api_base, ENDPOINT_CHAT_SESSION_UPDATE_TITLE
            ))
            .headers(self.auth_headers(token)?)
            .json(payload)
            .send()
            .await?;
        Self::parse_envelope::<serde::de::IgnoredAny>(resp).await?;
        Ok(())
    }

    /// 取消正在进行的流式输出，不需要 PoW
    pub async fn stop_stream(
        &self,
        token: &str,
        payload: &StopStreamPayload,
    ) -> Result<(), ClientError> {
        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_CHAT_STOP_STREAM))
            .headers(self.auth_headers(token)?)
            .json(payload)
            .send()
            .await?;
        Self::parse_envelope::<Option<()>>(resp).await?;
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

        let resp = self
            .http
            .post(format!("{}{}", self.api_base, ENDPOINT_FILE_UPLOAD))
            .headers(h)
            .multipart(form)
            .send()
            .await?;
        Self::parse_envelope::<UploadFileData>(resp).await
    }

    /// 查询文件状态，返回文件列表（含 status: PENDING/SUCCESS/FAILED）
    pub async fn fetch_files(
        &self,
        token: &str,
        file_ids: &[String],
    ) -> Result<FetchFilesData, ClientError> {
        let ids = file_ids.join(",");
        let resp = self
            .http
            .get(format!("{}{}", self.api_base, ENDPOINT_FILE_FETCH))
            .headers(self.auth_headers(token)?)
            .query(&[("file_ids", &ids)])
            .send()
            .await?;
        Self::parse_envelope::<FetchFilesData>(resp).await
    }

    pub async fn get_wasm(&self) -> Result<Bytes, ClientError> {
        let resp = self.http.get(&self.wasm_url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                status: status.as_u16(),
                body,
            });
        }
        Ok(resp.bytes().await?)
    }
}

#[cfg(test)]
mod tests {
    use super::{origin_of, CreateSessionWrapper, Envelope};

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
}
