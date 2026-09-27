//! HIF token 动态获取（x-hif-leim / x-hif-dliq）
//!
//! new.jsonl 抓包 + 前端 bundle（main.7d19d7e901.js）逆向结论：这两个头**不是
//! 本地 JS 生成的**，而是浏览器页面内的 poller 从 DeepSeek 自家的 token 分发
//! 服务定期拉取的公开凭据：
//!
//! - GET https://hif-leim.deepseek.com/query  → x-hif-leim
//! - GET https://hif-dliq.deepseek.com/query  → x-hif-dliq
//!
//! 无需鉴权（前端 `withToken: false`），响应 envelope 的
//! `data.biz_data.value` 即头值，响应头 `x-hif-ttl`（秒）为刷新周期（默认 600）。
//! 失败时按 1s 起指数退避（封顶 600s）重试，成功后按 TTL 重新拉取——与前端
//! poller（初始间隔 1s、倍增、maxBackoffMs=600s）行为一致。
//!
//! 因此**无需嵌入 JS 执行器**：这是一个纯 HTTP 动态凭据，Rust 原生实现即可，
//! 且取到的是真实有效的 token（而非伪造）。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

const LEIM_URL: &str = "https://hif-leim.deepseek.com/query";
const DLIQ_URL: &str = "https://hif-dliq.deepseek.com/query";
/// 前端 maxBackoffMs = max(配置, 60000ms)，取常量 600s
const MAX_BACKOFF_SECS: u64 = 600;
/// 响应未携带 x-hif-ttl 时的默认刷新周期（与前端 parseInt 失败时的 600 一致）
const DEFAULT_TTL_SECS: u64 = 600;
/// 首次拉取失败的重试起点（前端 initialInterval = 1s）
const INITIAL_BACKOFF_SECS: u64 = 1;

/// 当前持有的 HIF token（None = 尚未获取到，对应前端 getValue() 的空串）
#[derive(Default)]
struct HifState {
    leim: RwLock<Option<CachedToken>>,
    dliq: RwLock<Option<CachedToken>>,
}

struct CachedToken {
    value: String,
    expires_at: Instant,
}

/// 任务不能持有自身生命周期的强引用；最后一个客户端释放时停止旧轮询。
#[derive(Default)]
struct RefreshTasks(Mutex<Vec<tokio::task::AbortHandle>>);

impl Drop for RefreshTasks {
    fn drop(&mut self) {
        for task in self.0.get_mut().unwrap().drain(..) {
            task.abort();
        }
    }
}

async fn current_token(slot: &RwLock<Option<CachedToken>>) -> Option<String> {
    slot.read().await.as_ref()
        .filter(|token| token.expires_at > Instant::now())
        .map(|token| token.value.clone())
}

/// 共享的 HIF token 管理器
#[derive(Clone, Default)]
pub struct HifManager {
    state: Arc<HifState>,
    tasks: Arc<RefreshTasks>,
}

impl HifManager {
    /// 读取当前 leim 值（可能为 None）
    pub async fn leim(&self) -> Option<String> {
        current_token(&self.state.leim).await
    }

    /// 读取当前 dliq 值（可能为 None）
    pub async fn dliq(&self) -> Option<String> {
        current_token(&self.state.dliq).await
    }

    /// 启动后台刷新任务：leim 与 dliq 各自独立轮询（与前端两个 poller 一致）。
    ///
    /// `http`：复用 DsClient 的 wreq 客户端（带 cookie jar / 代理 / 仿真头）；
    /// `origin`：请求附带 chat.deepseek.com 的 Origin/Referer（与页面内
    /// fetch 的跨域上下文一致）。
    pub fn spawn_refresh(&self, http: wreq::Client, origin: String) {
        // DsClient::new 可能在运行时之外被调用（测试）；此时跳过后台任务
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            log::warn!(target: "ds_core::hif", "无 tokio 运行时，HIF token 动态获取未启动");
            return;
        };
        let mut tasks = self.tasks.0.lock().unwrap();
        if !tasks.is_empty() {
            return;
        }
        for (name, url) in [("leim", LEIM_URL), ("dliq", DLIQ_URL)] {
            let state = Arc::clone(&self.state);
            let http = http.clone();
            let origin = origin.clone();
            let task = handle.spawn(async move {
                poll_loop(&state, &http, &origin, name, url).await;
            });
            tasks.push(task.abort_handle());
        }
    }
}

/// 单端点轮询：成功后按 TTL 重新拉取，失败按 1s 倍增退避（封顶 600s）
async fn poll_loop(state: &HifState, http: &wreq::Client, origin: &str, name: &str, url: &str) {
    let mut backoff = INITIAL_BACKOFF_SECS;
    loop {
        let wait = match fetch_token(http, origin, url).await {
            Ok((value, ttl)) => {
                let store = if name == "leim" {
                    &state.leim
                } else {
                    &state.dliq
                };
                *store.write().await = Some(CachedToken {
                    value,
                    expires_at: Instant::now() + Duration::from_secs(ttl),
                });
                backoff = INITIAL_BACKOFF_SECS;
                log::debug!(target: "ds_core::hif", "HIF {} token 已刷新，{}s 后重新拉取", name, ttl);
                ttl
            }
            Err(e) => {
                log::warn!(target: "ds_core::hif", "HIF {} 拉取失败（{}s 后重试）: {}", name, backoff, e);
                let w = backoff;
                backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
                w
            }
        };
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
    }
}

/// 拉取单个 HIF 端点，返回 (token, ttl_secs)。
///
/// 响应：`{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"value":"…"}}}`
/// 头 `x-hif-ttl: <secs>`；biz_code != 0 或 value 为空均视为失败。
async fn fetch_token(
    http: &wreq::Client,
    origin: &str,
    url: &str,
) -> Result<(String, u64), String> {
    use wreq::header::{HeaderMap, HeaderValue};

    let mut headers = HeaderMap::new();
    headers.insert("Origin", HeaderValue::from_str(origin).map_err(|e| format!("Origin: {e}"))?);
    headers.insert(
        "Referer",
        HeaderValue::from_str(&format!("{origin}/")).map_err(|e| format!("Referer: {e}"))?,
    );
    headers.insert("Accept", HeaderValue::from_static("*/*"));

    let cid = crate::server::net_capture::begin();
    crate::server::net_capture::req(cid, "out", "GET", url, &headers, None);
    let resp = http
        .get(url)
        .headers(headers)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    match &resp {
        Ok(r) => crate::server::net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
        Err(e) => crate::server::net_capture::err(cid, &e.to_string()),
    }
    let resp = resp.map_err(|e| format!("HTTP: {e}"))?;

    let status = resp.status();
    // x-hif-ttl 在响应头上，必须在消费 resp（读体）之前取出
    let ttl = resp
        .headers()
        .get("x-hif-ttl")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_TTL_SECS);
    // resp.json() 内部读体不可观测，改 text+parse 以落盘响应体（HIF 拉取失败
    // 常伴随 completion 缺头被风控，失败响应同样要留痕）
    let text = resp.text().await.map_err(|e| format!("读取响应: {e}"))?;
    crate::server::net_capture::body(cid, text.as_bytes(), false);
    if !status.is_success() {
        return Err(format!("HTTP status {}", status.as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(default)]
        code: i64,
        data: Option<EnvelopeData>,
    }
    #[derive(serde::Deserialize)]
    struct EnvelopeData {
        #[serde(default)]
        biz_code: i64,
        #[serde(default)]
        biz_msg: String,
        biz_data: Option<BizData>,
    }
    #[derive(serde::Deserialize)]
    struct BizData {
        #[serde(default)]
        value: String,
    }

    let env: Envelope = serde_json::from_str(&text).map_err(|e| format!("JSON: {e}"))?;
    if env.code != 0 {
        return Err(format!("code {}", env.code));
    }
    let data = env.data.ok_or_else(|| "missing data".to_string())?;
    if data.biz_code != 0 {
        return Err(format!("biz_code {} {}", data.biz_code, data.biz_msg));
    }
    let value = data
        .biz_data
        .map(|b| b.value)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "empty value".to_string())?;
    Ok((value, ttl))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manager_stores_and_reads_tokens() {
        let m = HifManager::default();
        assert!(m.leim().await.is_none());
        *m.state.leim.write().await = Some(CachedToken {
            value: "tok1".into(), expires_at: Instant::now() + Duration::from_secs(60),
        });
        *m.state.dliq.write().await = Some(CachedToken {
            value: "tok2".into(), expires_at: Instant::now() + Duration::from_secs(60),
        });
        assert_eq!(m.leim().await.as_deref(), Some("tok1"));
        assert_eq!(m.dliq().await.as_deref(), Some("tok2"));
    }

    #[tokio::test]
    async fn expired_token_is_not_sent_during_refresh_failure() {
        let m = HifManager::default();
        *m.state.leim.write().await = Some(CachedToken {
            value: "expired".into(), expires_at: Instant::now(),
        });
        assert!(m.leim().await.is_none());
    }

    #[tokio::test]
    async fn last_manager_drop_cancels_refresh_tasks() {
        let m = HifManager::default();
        let other_client = m.clone();
        let task = tokio::spawn(std::future::pending::<()>());
        m.tasks.0.lock().unwrap().push(task.abort_handle());
        drop(m);
        assert!(!task.is_finished());
        drop(other_client);
        assert!(task.await.unwrap_err().is_cancelled());
    }

    #[test]
    fn constants_match_frontend_bundle() {
        // 前端 bundle 中的端点与默认 TTL（main.7d19d7e901.js）
        assert_eq!(LEIM_URL, "https://hif-leim.deepseek.com/query");
        assert_eq!(DLIQ_URL, "https://hif-dliq.deepseek.com/query");
        assert_eq!(DEFAULT_TTL_SECS, 600);
        assert_eq!(MAX_BACKOFF_SECS, 600);
        assert_eq!(INITIAL_BACKOFF_SECS, 1);
    }
}
