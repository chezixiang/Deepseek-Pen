//! DeepSeek 核心模块 —— OpenAI API 到 DeepSeek 的适配层
//!
//! 对外暴露最小接口：DeepSeekCore, CoreError, ChatRequest

mod accounts;
mod client;
mod completions;
mod hif;
mod mint;
mod pow;
mod fingerprint;

pub use accounts::AccountStatus;
pub use accounts::PoolError;
pub use fingerprint::{default_user_agent, DeviceFingerprint, submit_fingerprint};
pub use mint::mint_device_id;
pub use client::{CloudMessage, CloudSession};
pub use completions::{
    CachedConversation, ChatRequest, ChatResponse, ConversationPlan, FilePayload, ReuseTarget,
};

use crate::config::Config;
use accounts::AccountPool;
use client::{ClientError, DsClient};
use pow::{PowError, PowSolver};

/// 内核层错误类型
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// 账号池为空：尚未配置任何账号
    #[error("no accounts configured")]
    NoAccounts,

    /// 服务过载：所有账号都在忙或不健康
    #[error("no available account")]
    Overloaded,

    /// 上游限流：账号已进入退避窗口，短期内的重试只会加重风控（bug 1）。
    ///
    /// 与 Overloaded 分开是必须的：Overloaded 是"当前没有空闲账号，等一会再来"，
    /// 而这里是"上游明确在限这条链路"——继续重试（尤其换号重试、反复新建 session）
    /// 会被判定为异常客户端并**升级为禁言**。适配层据此返回 429 且不做任何重试。
    #[error("upstream rate limited: {0}")]
    RateLimited(String),

    /// 上游对**本次请求**的确定性拒绝：输入超长、账号禁言等。
    ///
    /// 必须与 ProviderError 分开，因为重试语义不同：这些错误的成因不会因为重试而
    /// 改变（同一份输入还是超长、同一个账号还是禁言），但每一次重试都要新建一个
    /// session、再传一遍文件、再撞一次上游——把 1 次用户操作放大成 3 次上游请求，
    /// 与"重试把限流升级成禁言"是同一类问题（bug 1）。
    #[error("upstream rejected: {0}")]
    Rejected(String),

    /// PoW 计算失败
    #[error("proof of work failed: {0}")]
    ProofOfWorkFailed(#[from] PowError),

    /// 提供商错误：网络、业务错误、Token 失效等
    #[error("provider: {0}")]
    ProviderError(String),

    /// 流处理错误：连接中断等
    #[error("stream error: {0}")]
    Stream(String),
}

impl From<ClientError> for CoreError {
    fn from(e: ClientError) -> Self {
        CoreError::ProviderError(e.to_string())
    }
}

/// 返回不超过 max 字节的最近 UTF-8 字符边界，供错误信息截断使用。
/// 上游文本大量是中文（3 字节/字符），直接 `&s[..len.min(N)]` 切在
/// 多字节字符中间会 panic（panic=abort 下等于杀掉整个进程）。
pub(crate) fn floor_utf8_end(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod utf8_tests {
    use super::floor_utf8_end;

    #[test]
    fn floor_utf8_end_lands_on_char_boundary() {
        let s = "你好ab"; // 你=3B 好=3B a=1B b=1B
        assert_eq!(floor_utf8_end(s, 2), 0, "落在'你'中间 → 回退到串首");
        assert_eq!(floor_utf8_end(s, 3), 3, "恰好在边界不回退");
        assert_eq!(floor_utf8_end(s, 4), 3, "落在'好'中间 → 回退到 3");
        assert_eq!(floor_utf8_end(s, 5), 3);
        assert_eq!(floor_utf8_end(s, 6), 6);
        assert_eq!(floor_utf8_end(s, 100), s.len(), "超长 → 串尾");
        assert_eq!(floor_utf8_end("abc", 2), 2, "ASCII 不回退");
        assert_eq!(floor_utf8_end("", 10), 0);
    }
}

pub struct DeepSeekCore {
    completions: crate::ds_core::completions::Completions,
}

impl DeepSeekCore {
    pub async fn new(config: &Config) -> Result<Self, CoreError> {
        let client = DsClient::new(
            config.deepseek.api_base.clone(),
            config.deepseek.wasm_url.clone(),
            config.deepseek.user_agent.clone(),
            config.deepseek.client_version.clone(),
            config.deepseek.client_platform.clone(),
            config.deepseek.client_locale.clone(),
            config.deepseek.client_bundle_id.clone(),
            config.deepseek.client_timezone_offset,
            config.proxy.url.as_deref(),
            client::preloaded_cookies_from_accounts(&config.accounts),
            config.deepseek.hif_leim.clone(),
            config.deepseek.hif_dliq.clone(),
            config.deepseek.hif_auto_fetch,
        );

        let wasm_bytes = client.get_wasm().await?;
        let solver = PowSolver::new(&wasm_bytes)?;

        // 启动时动态采集一次设备指纹并记录（Linux aarch64 Chrome 身份 + 真实
        // 硬件特征）。用于核对 UA/平台一致性与排查风控问题。
        let fp = fingerprint::DeviceFingerprint::from_config(config.deepseek.fingerprint.as_ref());
        log::info!(
            target: "ds_core::fingerprint",
            "设备指纹（动态采集）: platform={}, ua={}, screen={}, cores={}, memGB={}, tz={}min, webgl={}",
            fp.platform, fp.user_agent, fp.screen, fp.hardware_concurrency,
            fp.device_memory, fp.timezone_offset, fp.webgl_fingerprint
        );

        let pool = AccountPool::new(config.deepseek.hourly_request_quota);
        pool.init(config.accounts.clone(), &client, &solver)
            .await
            .map_err(|e| match e {
                accounts::PoolError::AllAccountsFailed => {
                    CoreError::ProviderError("所有账号初始化失败".to_string())
                }
                accounts::PoolError::Client(e) => CoreError::ProviderError(e.to_string()),
                accounts::PoolError::Pow(e) => CoreError::ProofOfWorkFailed(e),
                accounts::PoolError::RiskDeviceDetected { message, .. } => {
                    CoreError::ProviderError(message)
                }
                accounts::PoolError::Validation(msg) => {
                    CoreError::ProviderError(format!("配置错误: {}", msg))
                }
                other => CoreError::ProviderError(other.to_string()),
            })?;

        let completions = crate::ds_core::completions::Completions::new(client, solver, pool).await;

        Ok(Self { completions })
    }

    /// 发起对话请求，返回 SSE 字节流 + 账号标识
    ///
    /// 流结束或丢弃时自动释放账号
    pub async fn v0_chat(
        &self,
        req: ChatRequest,
        request_id: &str,
    ) -> Result<ChatResponse, CoreError> {
        self.completions.v0_chat(req, request_id).await
    }

    pub fn account_statuses(&self) -> Vec<AccountStatus> {
        self.completions.account_statuses()
    }

    /// 动态添加账号
    pub async fn add_account(&self, creds: &crate::config::Account) -> Result<String, PoolError> {
        self.completions.add_account(creds).await
    }

    /// 动态移除账号
    pub async fn remove_account(&self, email_or_mobile: &str) -> Result<String, PoolError> {
        self.completions.remove_account(email_or_mobile).await
    }

    /// 标记账号为 Error 状态
    pub fn mark_error(&self, email_or_mobile: &str) {
        self.completions.mark_error(email_or_mobile)
    }

    /// 手动重新登录指定账号
    pub async fn re_login_single(&self, email_or_mobile: &str) -> Result<(), String> {
        self.completions.re_login_single(email_or_mobile).await
    }

    /// 优雅关闭：清理所有账号的 session
    pub async fn shutdown(&self) {
        self.completions.shutdown().await;
    }

    pub async fn reload_config(&self, config: &Config) -> Result<(), CoreError> {
        self.completions.reload_config(config).await
    }

    /// 获取账号池状态信息
    pub async fn get_account_pool_status(&self) -> crate::openai_adapter::AccountPoolStatus {
        self.completions.get_pool_status().await
    }

    /// 拉取云端会话列表（#10 同步已有对话）
    pub async fn list_cloud_sessions(&self) -> Result<Vec<CloudSession>, CoreError> {
        self.completions.list_cloud_sessions().await
    }

    /// 拉取云端会话的消息内容（#10 完整同步）
    pub async fn list_cloud_session_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<crate::ds_core::client::CloudMessage>, CoreError> {
        self.completions.list_cloud_session_messages(session_id).await
    }

    /// 删除云端会话（本地删除对话时同步调用，bug 3）
    pub async fn delete_cloud_session(&self, session_id: &str) -> Result<String, CoreError> {
        self.completions.delete_cloud_session(session_id).await
    }

    /// 查询会话复用缓存（持久 DeepSeek 会话；None = 冷启动）
    pub fn lookup_conversation(&self, key: &str) -> Option<CachedConversation> {
        self.completions.lookup_conversation(key)
    }

    /// 移除失效的会话缓存条目
    pub fn remove_conversation(&self, key: &str) {
        self.completions.remove_conversation(key)
    }
}
