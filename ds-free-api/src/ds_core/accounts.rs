//! 账号池管理 —— 多账号负载均衡
//!
//! 1 account = 1 session = 1 concurrency。多并发需横向扩展账号数。

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU8, AtomicU64, Ordering};
use std::time::SystemTime;

use dashmap::DashMap;
use futures::TryStreamExt;
use log::{debug, error, info, warn};
use tokio::sync::RwLock;

use crate::config::Account as AccountConfig;
use crate::ds_core::client::{ClientError, CompletionPayload, DsClient, LoginPayload};
use crate::ds_core::pow::{PowError, PowSolver};

/// 账号状态枚举
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountState {
    Idle = 0,
    Busy = 1,
    Error = 2,
    Invalid = 3,
}

impl AccountState {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Idle,
            1 => Self::Busy,
            2 => Self::Error,
            3 => Self::Invalid,
            _ => Self::Invalid,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Busy => "busy",
            Self::Error => "error",
            Self::Invalid => "invalid",
        }
    }
}

/// 账号状态信息
#[derive(serde::Serialize)]
pub struct AccountStatus {
    pub email: String,
    pub mobile: String,
    pub state: String,
    /// 最后释放时间戳（ms），0 表示从未使用
    pub last_released_ms: i64,
    /// 连续登录失败次数
    pub error_count: u8,
    /// 当前配额窗口内已用请求数
    pub used_this_hour: u64,
    /// 本窗口是否已用尽配额（0 配额 = 不限制，恒为 false）
    pub quota_exhausted: bool,
}

pub struct Account {
    token: std::sync::RwLock<Arc<str>>,
    email: String,
    mobile: String,
    state: AtomicU8,
    /// 账号最近一次释放的时间戳（ms），用于冷却判断
    last_released: AtomicI64,
    /// 连续登录失败次数
    error_count: AtomicU8,
    /// 禁言到期 Unix 秒（0=未知）；登录响应 chat.mute_until 实测值
    mute_until: AtomicI64,
    /// 原始凭据（用于重新登录）
    creds: AccountConfig,
    /// 滑动窗口内的请求计数（用于每小时配额）
    window: RequestWindow,
}

/// 连续登录失败上限，达到后标记为 Invalid
const MAX_ERROR_COUNT: u8 = 3;

/// 一小时窗口请求计数器
///
/// 上游实测同一账号累计约 215 次请求后会被禁言（biz_code=5），且禁言是
/// **延迟判定**的（跑完才封）。实现为「固定起点 + 一小时」的简单窗口：
/// 达到上限后该账号本窗口内不可用，窗口过期自动恢复。精度足够且纯原子
/// 操作、不加锁。
struct RequestWindow {
    /// 窗口起点（Unix 秒）
    started_at: AtomicI64,
    /// 窗口内累计请求数
    count: AtomicU64,
}

/// 配额窗口长度：1 小时
const WINDOW_SECS: i64 = 3600;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl RequestWindow {
    fn new() -> Self {
        Self {
            started_at: AtomicI64::new(now_secs()),
            count: AtomicU64::new(0),
        }
    }

    /// 记一次请求并返回窗口内的累计值；跨窗口时自动重置
    fn record(&self) -> u64 {
        let now = now_secs();
        let start = self.started_at.load(Ordering::Relaxed);
        if now - start >= WINDOW_SECS
            && self
                .started_at
                .compare_exchange(start, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            self.count.store(0, Ordering::Relaxed);
        }
        self.count.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 当前窗口内已用请求数（不修改状态；过期窗口视作 0）
    fn used(&self) -> u64 {
        if now_secs() - self.started_at.load(Ordering::Relaxed) >= WINDOW_SECS {
            0
        } else {
            self.count.load(Ordering::Relaxed)
        }
    }
}

impl Account {
    pub fn token(&self) -> Arc<str> {
        self.token.read().unwrap().clone()
    }

    pub fn display_id(&self) -> &str {
        if !self.email.is_empty() {
            &self.email
        } else {
            &self.mobile
        }
    }

    pub fn state(&self) -> AccountState {
        AccountState::from_u8(self.state.load(Ordering::Relaxed))
    }

    #[allow(dead_code)]
    pub fn is_busy(&self) -> bool {
        self.state() == AccountState::Busy
    }

    pub fn is_available(&self) -> bool {
        self.state() == AccountState::Idle
    }

    /// 禁言到期 Unix 秒（0=未知）
    pub fn mute_until(&self) -> i64 {
        self.mute_until.load(Ordering::Relaxed)
    }

    pub fn set_mute_until(&self, secs: i64) {
        self.mute_until.store(secs, Ordering::Relaxed);
    }

    /// 该账号在本配额窗口内是否还能继续使用（`limit == 0` 表示不限制）
    fn within_quota(&self, limit: u64) -> bool {
        limit == 0 || self.window.used() < limit
    }

    /// 记一次请求用量；达到配额时打一次告警
    fn record_request(&self, limit: u64) {
        let used = self.window.record();
        if limit > 0 && used == limit {
            warn!(
                target: "ds_core::accounts",
                "账号 {} 已达到每小时请求配额（{}），本窗口内不再分配；上游在账号累计数百次请求后会禁言，请增加账号数而不是抬高配额",
                self.display_id(), limit
            );
        }
    }
}

/// 禁言到期时间格式化（本地时区）
pub(crate) fn format_mute_time(secs: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_opt(secs, 0).single() {
        Some(t) => t.format("%Y-%m-%d %H:%M").to_string(),
        None => secs.to_string(),
    }
}

/// 持有期间账号标记为 busy，Drop 时自动释放
pub struct AccountGuard {
    account: Arc<Account>,
}

impl AccountGuard {
    pub fn account(&self) -> &Account {
        &self.account
    }
}

impl Drop for AccountGuard {
    fn drop(&mut self) {
        // 只有 Busy 状态才释放回 Idle（避免覆盖 Error/Invalid）
        self.account
            .state
            .compare_exchange(
                AccountState::Busy as u8,
                AccountState::Idle as u8,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .ok();
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        self.account.last_released.store(now_ms, Ordering::Relaxed);
    }
}

pub struct AccountPool {
    /// 每账号每小时请求上限（0 = 不限制）
    hourly_quota: u64,
    /// key = display_id (email or mobile), value = Account
    accounts: DashMap<String, Arc<Account>>,
    client: RwLock<Option<DsClient>>,
    solver: RwLock<Option<PowSolver>>,
}

#[derive(Debug, thiserror::Error)]
pub enum PoolError {
    /// 所有账号初始化失败（没有可用账号）
    #[error("所有账号初始化失败")]
    AllAccountsFailed,

    /// 登录被设备风控拒绝：device_id 无效/伪造（biz_code 11, RISK_DEVICE_DETECTED）
    #[error("设备风控拦截: {message}")]
    RiskDeviceDetected {
        #[allow(dead_code)]
        code: i64,
        message: String,
    },

    /// 下游客户端错误（网络、API 错误等）
    #[error("客户端错误: {0}")]
    Client(#[from] ClientError),

    /// PoW 计算失败（WASM 执行错误）
    #[error("PoW 计算失败: {0}")]
    Pow(#[from] PowError),

    /// 账号配置验证失败
    #[error("账号配置错误: {0}")]
    Validation(String),

    /// 账号已存在
    #[error("账号已存在: {0}")]
    AlreadyExists(String),

    /// 账号不存在
    #[error("账号不存在: {0}")]
    NotFound(String),

    /// 账号正在使用中，无法删除
    #[error("账号正在使用中: {0}")]
    AccountBusy(String),
}

impl AccountPool {
    pub fn new(hourly_quota: u64) -> Self {
        Self {
            hourly_quota,
            accounts: DashMap::new(),
            client: RwLock::new(None),
            solver: RwLock::new(None),
        }
    }

    /// 账号池是否为空（一个账号都没配置）
    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }

    pub async fn init(
        &self,
        creds: Vec<AccountConfig>,
        client: &DsClient,
        solver: &PowSolver,
    ) -> Result<(), PoolError> {
        if creds.is_empty() {
            return Ok(());
        }

        warn_on_shared_device_ids(&creds);

        use futures::future::join_all;
        use std::sync::Arc;
        use tokio::sync::Semaphore;

        // 限制并发初始化数，避免对 DeepSeek 端和本地连接池造成压力
        let semaphore = Arc::new(Semaphore::new(13));
        let futures: Vec<_> = creds
            .into_iter()
            .map(|creds| {
                let client = client.clone();
                let solver = solver.clone();
                let sem = semaphore.clone();
                async move {
                    let _permit = sem.acquire().await.expect("信号量未关闭");
                    let display_id = if creds.mobile.is_empty() {
                        creds.email.clone()
                    } else {
                        creds.mobile.clone()
                    };
                    match init_account(&creds, &client, &solver).await {
                        Ok(account) => {
                            info!(target: "ds_core::accounts", "账号 {} 初始化成功", display_id);
                            Some((display_id, Arc::new(account)))
                        }
                        Err(e) => {
                            warn!(target: "ds_core::accounts", "账号 {} 初始化失败: {}", display_id, e);
                            None
                        }
                    }
                }
            })
            .collect();

        let results = join_all(futures).await;
        let initialized: Vec<(String, Arc<Account>)> = results.into_iter().flatten().collect();

        if initialized.is_empty() {
            warn!(target: "ds_core::accounts", "所有账号初始化失败，服务将以降级模式运行（可通过管理面板动态添加账号）");
            // 不再返回错误，允许服务继续运行
        } else {
            info!(target: "ds_core::accounts", "成功初始化 {} 个账号", initialized.len());
            for (id, account) in initialized {
                self.accounts.insert(id, account);
            }
        }
        Ok(())
    }

    /// 动态添加账号（运行时初始化）
    pub async fn add_account(
        &self,
        creds: &AccountConfig,
        client: &DsClient,
        solver: &PowSolver,
    ) -> Result<String, PoolError> {
        let display_id = if creds.mobile.is_empty() {
            creds.email.clone()
        } else {
            creds.mobile.clone()
        };

        // 检查是否已存在（DashMap O(1) 查找）
        if self.accounts.contains_key(&display_id) {
            return Err(PoolError::AlreadyExists(display_id));
        }

        let account = init_account(creds, client, solver).await?;
        let _id = account.display_id().to_string();
        self.accounts.insert(display_id.clone(), Arc::new(account));
        info!(target: "ds_core::accounts", "动态添加账号 {} 成功", display_id);
        Ok(display_id)
    }

    /// 动态移除账号（仅空闲账号可移除）
    pub async fn remove_account(&self, email_or_mobile: &str) -> Result<String, PoolError> {
        let account = self
            .accounts
            .get(email_or_mobile)
            .ok_or_else(|| PoolError::NotFound(email_or_mobile.to_string()))?;

        if account.is_busy() {
            return Err(PoolError::AccountBusy(email_or_mobile.to_string()));
        }

        // 也允许移除 Error/Invalid 状态的账号
        drop(account);
        let (_, removed) = self
            .accounts
            .remove(email_or_mobile)
            .ok_or_else(|| PoolError::NotFound(email_or_mobile.to_string()))?;
        let id = removed.display_id().to_string();
        info!(target: "ds_core::accounts", "动态移除账号 {}", id);
        Ok(id)
    }

    /// 获取空闲最久的可用账号，带等待：无可用账号时最多等待 `timeout_ms` 毫秒
    pub async fn get_account_with_wait(&self, timeout_ms: u64) -> Option<AccountGuard> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            if let Some(g) = self.get_account() {
                return Some(g);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }

    /// 获取空闲最久的可用账号（不等待，立即返回）
    ///
    /// 遍历所有账号，选冷却已过、配额未用尽且空闲时间最长的那个，
    /// 最大化每次使用间隔。DashMap 无锁读，不阻塞并发请求。
    pub fn get_account(&self) -> Option<AccountGuard> {
        if self.accounts.is_empty() {
            return None;
        }

        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let mut best: Option<Arc<Account>> = None;
        let mut best_idle = i64::MIN;

        for entry in self.accounts.iter() {
            let account = entry.value();
            if !account.is_available() {
                continue;
            }
            // 超出每小时配额的账号本窗口内不再分配（0 = 不限制）
            if !account.within_quota(self.hourly_quota) {
                continue;
            }
            let idle = now_ms - account.last_released.load(Ordering::Relaxed);
            if idle > best_idle {
                best_idle = idle;
                best = Some(Arc::clone(account));
            }
        }

        let account = best?;
        account
            .state
            .compare_exchange(
                AccountState::Idle as u8,
                AccountState::Busy as u8,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .ok()?;
        account.record_request(self.hourly_quota);
        Some(AccountGuard { account })
    }

    /// 获取指定账号（会话复用：续聊/重答必须用创建会话的同一账号），空闲时立即返回
    ///
    /// 会话亲和优先于配额：续聊中的请求即使账号配额已满也放行（否则对话中断），
    /// 但用量照常计数。
    pub fn get_account_by_id(&self, email_or_mobile: &str) -> Option<AccountGuard> {
        let entry = self.accounts.get(email_or_mobile)?;
        let account = entry.value();
        if !account.is_available() {
            return None;
        }
        account
            .state
            .compare_exchange(
                AccountState::Idle as u8,
                AccountState::Busy as u8,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .ok()?;
        account.record_request(self.hourly_quota);
        Some(AccountGuard {
            account: Arc::clone(account),
        })
    }

    /// 只读获取账号当前 token（不改变可用状态）；用于会话缓存淘汰时清理持久会话
    pub fn token_of(&self, email_or_mobile: &str) -> Option<String> {
        let entry = self.accounts.get(email_or_mobile)?;
        Some(entry.value().token().to_string())
    }

    /// 获取所有账号的详细状态
    pub fn account_statuses(&self) -> Vec<AccountStatus> {
        self.accounts
            .iter()
            .map(|entry| {
                let a = entry.value();
                AccountStatus {
                    email: a.email.clone(),
                    mobile: a.mobile.clone(),
                    state: a.state().as_str().to_string(),
                    last_released_ms: a.last_released.load(Ordering::Relaxed),
                    error_count: a.error_count.load(Ordering::Relaxed),
                    used_this_hour: a.window.used(),
                    quota_exhausted: !a.within_quota(self.hourly_quota),
                }
            })
            .collect()
    }

    /// 优雅关闭（新流程无持久 session，无需清理）
    pub async fn shutdown(&self, _client: &DsClient) {}

    /// 存储 client 和 solver 供恢复任务使用
    pub async fn set_client_solver(&self, client: DsClient, solver: PowSolver) {
        *self.client.write().await = Some(client);
        *self.solver.write().await = Some(solver);
    }

    /// 标记账号为 Error 状态（请求失败时调用）
    pub fn mark_error(&self, email_or_mobile: &str) {
        if let Some(entry) = self.accounts.get(email_or_mobile) {
            let account = entry.value();
            // 只从 Busy 转到 Error（避免覆盖 Invalid）
            account
                .state
                .compare_exchange(
                    AccountState::Busy as u8,
                    AccountState::Error as u8,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .ok();
            warn!(target: "ds_core::accounts", "账号 {} 标记为 Error", account.display_id());
        }
    }

    /// 手动重新登录指定账号（管理员触发）
    /// 成功 → Idle，失败 → error_count++，≥3 则 Invalid
    pub async fn re_login_single(&self, email_or_mobile: &str) -> Result<(), String> {
        let client_opt = self.client.read().await.clone();
        let solver_opt = self.solver.read().await.clone();
        let (client, solver) = match (client_opt, solver_opt) {
            (Some(c), Some(s)) => (c, s),
            _ => return Err("client/solver 未初始化".to_string()),
        };

        let account = self
            .accounts
            .get(email_or_mobile)
            .ok_or_else(|| format!("账号 {} 不存在", email_or_mobile))?;
        let account = account.value();

        // 只允许 Error/Invalid 状态的账号重登
        let state = account.state();
        if state != AccountState::Error && state != AccountState::Invalid {
            return Err(format!(
                "账号状态为 {}，仅 Error/Invalid 可重登",
                state.as_str()
            ));
        }

        Self::re_login_account(account, &client, &solver).await;

        // 检查重登后状态
        let new_state = account.state();
        if new_state == AccountState::Idle {
            Ok(())
        } else {
            Err(format!("重登失败，当前状态: {}", new_state.as_str()))
        }
    }

    /// 尝试重新登录 Error 状态的账号
    /// 成功 → Idle，失败 → error_count++，≥3 则 Invalid
    async fn re_login_account(account: &Account, client: &DsClient, solver: &PowSolver) {
        let display_id = account.display_id().to_string();
        // 重登不做完整 health_check（do_health_check=false），仅验证登录+create_session 成功，
        // 避免恢复流程每次发真实 completion 加重风控压力
        match try_init_account(&account.creds, client, solver, false).await {
            Ok(new_account) => {
                // 更新 token 与禁言状态
                *account.token.write().unwrap() = new_account.token.read().unwrap().clone();
                account.set_mute_until(new_account.mute_until());
                account
                    .state
                    .store(AccountState::Idle as u8, Ordering::Relaxed);
                account.error_count.store(0, Ordering::Relaxed);
                info!(target: "ds_core::accounts", "账号 {} 重新登录成功", display_id);
            }
            Err(e) => {
                let count = account.error_count.fetch_add(1, Ordering::Relaxed) + 1;
                if count >= MAX_ERROR_COUNT {
                    account
                        .state
                        .store(AccountState::Invalid as u8, Ordering::Relaxed);
                    error!(target: "ds_core::accounts", "账号 {} 连续 {} 次重登失败，标记为 Invalid: {}", display_id, count, e);
                } else {
                    warn!(target: "ds_core::accounts", "账号 {} 重登失败 ({}次): {}", display_id, count, e);
                }
            }
        }
    }

    /// 启动后台恢复任务：每 5 分钟扫描 Error 账号并尝试重新登录。
    /// 旧版每 60 秒扫描一次，且每次重登都发真实 completion（health_check），
    /// 多个 Error 账号会周期性放大请求量，是触发风控/禁言的重要来源。改为 5 分钟 + 轻量验证。
    pub fn start_recovery_task(self: &Arc<Self>) {
        const RECOVERY_INTERVAL_SECS: u64 = 300;
        let pool = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(RECOVERY_INTERVAL_SECS)).await;

                let client_opt = pool.client.read().await.clone();
                let solver_opt = pool.solver.read().await.clone();
                let (client, solver) = match (client_opt, solver_opt) {
                    (Some(c), Some(s)) => (c, s),
                    _ => continue,
                };

                for entry in pool.accounts.iter() {
                    let account = entry.value();
                    if account.state() == AccountState::Error {
                        Self::re_login_account(account, &client, &solver).await;
                    }
                }
            }
        });
    }

    /// 获取账号池状态统计
    pub async fn get_pool_status(&self) -> crate::openai_adapter::AccountPoolStatus {
        let mut idle = 0;
        let mut busy = 0;
        let total = self.accounts.len();

        for entry in self.accounts.iter() {
            let account = entry.value();
            match account.state() {
                AccountState::Idle => idle += 1,
                AccountState::Busy => busy += 1,
                _ => {}
            }
        }

        crate::openai_adapter::AccountPoolStatus { total, idle, busy }
    }
}

async fn init_account(
    creds: &AccountConfig,
    client: &DsClient,
    solver: &PowSolver,
) -> Result<Account, PoolError> {
    let mut last_error = None;

    for attempt in 1..=3 {
        // 首次登录做完整 health_check（发一次 test completion 验证账号可用）；
        // 后续重试跳过，避免登录阶段反复发 completion
        match try_init_account(creds, client, solver, attempt == 1).await {
            Ok(account) => return Ok(account),
            // 设备风控拒绝（伪造/无效 device_id）：重试无意义，直接返回明确指引
            Err(e @ PoolError::RiskDeviceDetected { .. }) => return Err(e),
            Err(e) => {
                last_error = Some(e);
                if attempt < 3 {
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                }
            }
        }
    }

    Err(last_error.expect("循环至少执行一次"))
}

/// 检测多个账号共用同一个 `device_id` 并告警（不阻止启动，只让用户看到风险）
///
/// 设备指纹是**设备级**的，上游用它做关联与画像。上游实测：同一个 device_id
/// 下挂多个账号、累计数百次请求后，这些账号会被禁言（biz_code=5）。
fn warn_on_shared_device_ids(creds: &[AccountConfig]) {
    let mut by_device: std::collections::HashMap<&str, Vec<&str>> =
        std::collections::HashMap::new();
    for c in creds {
        let device = c.device_id.trim();
        if device.is_empty() {
            continue;
        }
        let id = if c.email.is_empty() {
            c.mobile.as_str()
        } else {
            c.email.as_str()
        };
        by_device.entry(device).or_default().push(id);
    }

    for (device, accounts) in by_device {
        if accounts.len() > 1 {
            let prefix: String = device.chars().take(12).collect();
            warn!(
                target: "ds_core::accounts",
                "{} 个账号共用同一个 device_id（{}…）：{}。设备指纹被上游用于关联与画像，共用会显著提升连坐禁言风险；建议每个账号用独立浏览器配置文件各抓取一个 device_id",
                accounts.len(), prefix, accounts.join(", ")
            );
        }
    }
}

async fn try_init_account(
    creds: &AccountConfig,
    client: &DsClient,
    solver: &PowSolver,
    do_health_check: bool,
) -> Result<Account, PoolError> {
    // 验证：email 和 mobile 至少一个非空
    if creds.email.is_empty() && creds.mobile.is_empty() {
        return Err(PoolError::Validation(
            "email 和 mobile 不能同时为空".to_string(),
        ));
    }

    // 设备凭据兜底（用户无感）：缺有效 device_id 时即时 mint。
    // 启动路径已由 device_bootstrap 批量补齐；此处覆盖运行时新增账号
    // （管理面板/应用添加）与历史配置的漏网情况。
    let (device_id, _smid) = crate::device_bootstrap::ensure_one(
        &client.user_agent(),
        &creds.device_id,
        &creds.smid,
    )
    .await;

    let login_payload = LoginPayload {
        email: if creds.email.is_empty() {
            None
        } else {
            Some(creds.email.clone())
        },
        mobile: if creds.mobile.is_empty() {
            None
        } else {
            Some(creds.mobile.clone())
        },
        password: creds.password.clone(),
        area_code: if creds.area_code.is_empty() {
            None
        } else {
            Some(creds.area_code.clone())
        },
        device_id,
        os: "web".to_string(),
    };

    let login_data = match client.login(&login_payload).await {
        Ok(v) => v,
        Err(ClientError::CaptchaRequired { body }) => {
            // 透传数美验证码：生成会话页面，等待用户手动完成验证后重试一次。
            let detail: serde_json::Value =
                serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body.clone()));
            let (id, rx) = crate::server::captcha_bridge::global().create(detail);
            warn!(
                target: "ds_core::accounts",
                "登录触发人机验证，请打开 http://127.0.0.1:22217/captcha/{} 完成验证，超时 10 分钟",
                id
            );
            let _result = crate::server::captcha_bridge::wait_for_solution(rx, 600).await;
            // 用户完成验证后重试登录（若 DeepSeek 需要把验证结果带回，可在此扩展登录参数）
            client.login(&login_payload).await?
        }
        Err(ClientError::Business { code, msg })
            if code == 11 || msg.to_uppercase().contains("RISK_DEVICE") =>
        {
            // 数美设备风控拒绝：device_id 无效/伪造。重试无意义，返回带
            // 抓取指引的错误（device_id 无法在服务端伪造，必须真机抓取）。
            warn!(
                target: "ds_core::accounts",
                "登录被设备风控拒绝（biz_code={} {}）：当前 device_id 无效。请用 Chrome 登录一次 \
                 chat.deepseek.com，在 Network 面板 users/login 请求体中复制真实 device_id 填入账号配置",
                code, msg
            );
            return Err(PoolError::RiskDeviceDetected {
                code,
                message: format!(
                    "登录被设备风控拒绝（{}）：device_id 无效或缺失。请在浏览器登录 \
                     chat.deepseek.com 一次，从 users/login 请求体抓取真实 device_id 填入该账号配置（每个账号独立一个）",
                    msg
                ),
            });
        }
        Err(e) => return Err(e.into()),
    };
    debug!(
        target: "ds_core::client",
        "登录响应: code={}, msg={}, user_id={:?}, email={:?}, mobile={:?}",
        login_data.code,
        login_data.msg,
        login_data.user.id,
        login_data.user.email,
        login_data.user.mobile_number
    );
    let token = login_data.user.token;

    let display_id = if creds.mobile.is_empty() {
        &creds.email
    } else {
        &creds.mobile
    };

    // 禁言状态（登录响应实测字段）：登录不受禁言影响，但 completion 会被拒
    let mute_until = login_data
        .user
        .chat
        .as_ref()
        .map(|c| c.mute_until as i64)
        .unwrap_or(0);
    if login_data.user.chat.as_ref().is_some_and(|c| c.is_muted != 0) {
        warn!(
            target: "ds_core::accounts",
            "账号 {} 已被禁言至 {}（登录正常，completion 将被拒绝，user_is_muted）",
            display_id,
            format_mute_time(mute_until)
        );
    }

    // 健康检查：创建临时 session → 发送 test completion → 删除 session。
    // 仅首次登录执行完整 health_check；重登/恢复只验证 create_session 成功即返回，
    // 避免每次重登都发一次真实 completion，加重风控压力（禁言根因之一）。
    let session_id = client.create_session(&token).await?;
    if do_health_check {
        if let Err(e) = health_check(&token, &session_id, client, solver, "default", display_id).await {
            // 即使健康检查失败也要清理 session
            let _ = client.delete_session(&token, &session_id).await;
            return Err(e);
        }
    }
    let _ = client.delete_session(&token, &session_id).await;

    Ok(Account {
        token: std::sync::RwLock::new(token.into()),
        email: creds.email.clone(),
        mobile: creds.mobile.clone(),
        state: AtomicU8::new(AccountState::Idle as u8),
        last_released: AtomicI64::new(0),
        error_count: AtomicU8::new(0),
        mute_until: AtomicI64::new(mute_until),
        creds: creds.clone(),
        window: RequestWindow::new(),
    })
}

async fn health_check(
    token: &str,
    session_id: &str,
    client: &DsClient,
    solver: &PowSolver,
    model_type: &str,
    display_id: &str,
) -> Result<(), PoolError> {
    let start = std::time::Instant::now();
    let challenge = client
        .create_pow_challenge(token, "/api/v0/chat/completion")
        .await?;

    let result = solver.solve(&challenge)?;
    let pow_header = result.to_header();

    let payload = CompletionPayload {
        chat_session_id: session_id.to_string(),
        parent_message_id: None,
        model_type: model_type.to_string(),
        prompt: "只回复`Hello, world!`".to_string(),
        ref_file_ids: vec![],
        thinking_enabled: false,
        search_enabled: false,
        preempt: false,
    };

    let mut stream = client.completion(token, &pow_header, &payload).await?;
    // 消费流确保消息写入
    while let Some(chunk) = stream.try_next().await? {
        let _ = chunk;
    }

    debug!(
        target: "ds_core::accounts",
        "health_check 完成 model_type={} account={} elapsed={:?}",
        model_type, display_id, start.elapsed()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(email: &str, device_id: &str) -> AccountConfig {
        AccountConfig {
            email: email.to_string(),
            mobile: String::new(),
            area_code: String::new(),
            password: "pw".to_string(),
            device_id: device_id.to_string(),
            smid: String::new(),
        }
    }

    fn idle_account(email: &str) -> Arc<Account> {
        Arc::new(Account {
            token: std::sync::RwLock::new("t".into()),
            email: email.to_string(),
            mobile: String::new(),
            state: AtomicU8::new(AccountState::Idle as u8),
            last_released: AtomicI64::new(0),
            error_count: AtomicU8::new(0),
            mute_until: AtomicI64::new(0),
            creds: account(email, "dev"),
            window: RequestWindow::new(),
        })
    }

    #[test]
    fn window_counts_and_reports_usage() {
        let w = RequestWindow::new();
        assert_eq!(w.used(), 0);
        assert_eq!(w.record(), 1);
        assert_eq!(w.record(), 2);
        assert_eq!(w.used(), 2);
    }

    #[test]
    fn quota_of_zero_means_unlimited() {
        let a = idle_account("a@example.com");
        for _ in 0..500 {
            a.record_request(0);
        }
        assert!(a.within_quota(0), "0 必须表示不限制");
    }

    #[test]
    fn account_is_blocked_after_reaching_quota() {
        let a = idle_account("a@example.com");
        let limit = 3;
        assert!(a.within_quota(limit));
        a.record_request(limit);
        a.record_request(limit);
        assert!(a.within_quota(limit), "达到上限前仍可用");
        a.record_request(limit);
        assert!(!a.within_quota(limit), "达到上限后该窗口内不应再被分配");
    }

    #[test]
    fn expired_window_resets_usage() {
        let w = RequestWindow::new();
        for _ in 0..5 {
            w.record();
        }
        assert_eq!(w.used(), 5);
        // 把窗口起点拨回过去，模拟窗口过期
        w.started_at
            .store(now_secs() - WINDOW_SECS - 1, Ordering::Relaxed);
        assert_eq!(w.used(), 0, "窗口过期后用量应视作 0");
        assert_eq!(w.record(), 1, "过期后重新计数应从 1 开始");
    }

    #[test]
    fn shared_device_ids_are_detected() {
        let creds = vec![
            account("a@example.com", "same-device"),
            account("b@example.com", "same-device"),
            account("c@example.com", "own-device"),
        ];
        let mut by_device: std::collections::HashMap<&str, Vec<&str>> =
            std::collections::HashMap::new();
        for c in &creds {
            if !c.device_id.trim().is_empty() {
                by_device
                    .entry(c.device_id.as_str())
                    .or_default()
                    .push(c.email.as_str());
            }
        }
        let shared: Vec<_> = by_device.iter().filter(|(_, v)| v.len() > 1).collect();
        assert_eq!(shared.len(), 1, "应只检出一组共用指纹");
        assert_eq!(shared[0].1.len(), 2);
    }

    #[test]
    fn pool_skips_accounts_that_exhausted_their_quota() {
        let pool = AccountPool::new(2);
        pool.accounts
            .insert("a@example.com".to_string(), idle_account("a@example.com"));

        // 配额 2：第一次可分配；手动释放（模拟 Guard Drop）后第二次仍可；
        // 用尽后（配额 2 计满）不再分配
        let g1 = pool.get_account();
        assert!(g1.is_some(), "第 1 次应可分配");
        drop(g1); // Guard Drop 释放回 Idle，但已计入 1 次用量
        let g2 = pool.get_account();
        assert!(g2.is_some(), "第 2 次应可分配");
        drop(g2);
        assert!(
            pool.get_account().is_none(),
            "配额用尽后不应再分配该账号（调用方据此返回 429）"
        );
    }

    #[test]
    fn pool_with_unlimited_quota_never_blocks() {
        let pool = AccountPool::new(0);
        pool.accounts
            .insert("a@example.com".to_string(), idle_account("a@example.com"));
        for i in 0..50 {
            let guard = pool.get_account();
            assert!(guard.is_some(), "配额 0 时第 {i} 次也应可分配");
            drop(guard);
        }
    }

    #[test]
    fn exhausted_account_does_not_block_other_accounts() {
        let pool = AccountPool::new(1);
        pool.accounts
            .insert("a@example.com".to_string(), idle_account("a@example.com"));
        pool.accounts
            .insert("b@example.com".to_string(), idle_account("b@example.com"));

        // 两个账号各能用 1 次（顺序取决于「空闲最久」策略）
        let g1 = pool.get_account();
        assert!(g1.is_some());
        drop(g1);
        let g2 = pool.get_account();
        assert!(g2.is_some());
        drop(g2);
        assert!(pool.get_account().is_none(), "两个账号都用尽后应返回 None");
    }
}
