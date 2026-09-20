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

    /// 查询会话复用缓存（持久 DeepSeek 会话；None = 冷启动）
    pub fn lookup_conversation(&self, key: &str) -> Option<CachedConversation> {
        self.completions.lookup_conversation(key)
    }

    /// 移除失效的会话缓存条目
    pub fn remove_conversation(&self, key: &str) {
        self.completions.remove_conversation(key)
    }
}
