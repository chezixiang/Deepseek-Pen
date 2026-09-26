//! 账号池管理 —— 多账号负载均衡
//!
//! 1 account = 1 session = 1 concurrency。多并发需横向扩展账号数。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
use std::time::{Duration, Instant, SystemTime};

use dashmap::DashMap;
use log::{debug, error, info, warn};
use tokio::sync::RwLock;

use crate::config::Account as AccountConfig;
use crate::ds_core::client::{ClientError, DsClient, LoginPayload};
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
    /// 上游已确认的禁言状态；与普通登录/网络错误分开呈现。
    pub is_muted: bool,
    /// 已知解禁时间（Unix 秒）；未知时为 null，不臆测三天期限。
    pub mute_until: Option<i64>,
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
    /// 禁言到期 Unix 秒：0=未记录，-1=已确认禁言但到期时间未知。
    mute_until: AtomicI64,
    /// 上游限流冷却到期 Unix 秒（0=未限流）。
    ///
    /// 与 mute_until 的区别：mute_until 是上游判定的禁言（账号级，等它自己到期）；
    /// 这里是**本服务主动退避**——收到 rate_limit/reached 之类的信号后，在一段时间内
    /// 不再拿这个账号发任何上游请求。没有它的话，客户端每重试一次就新建一个 session
    /// 再撞一次限流，放大无效请求；它是否导致后续禁言仍需上游证据。
    cooldown_until: AtomicI64,
    /// 连续被限流的次数（阶梯退避的档位），成功一次即清零
    cooldown_level: AtomicU8,
    /// 原始凭据（用于重新登录）
    creds: AccountConfig,
    /// 滑动窗口内的请求计数（用于每小时配额）
    window: RequestWindow,
}

/// 连续登录失败上限，达到后标记为 Invalid
const MAX_ERROR_COUNT: u8 = 3;

/// 限流退避阶梯（秒）：连续被限流时逐级加长，最长 30 分钟。
/// 取指数增长是为了让"用户一直点重试"这种情形快速把请求量压下来——
/// 这里约束本地重试频率，不代表已知的上游风控阈值。
const COOLDOWN_LADDER_SECS: [i64; 5] = [60, 180, 600, 1200, 1800];

/// 最近一小时的分配记录。固定窗口允许边界两侧突发两倍配额，不能兑现
/// 「每小时上限」。这是本地流量约束，并不代表任何已知的上游免封阈值。
struct RequestWindow {
    requests: Mutex<VecDeque<Instant>>,
}

/// 配额窗口长度：1 小时
const WINDOW_SECS: u64 = 3600;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl RequestWindow {
    fn new() -> Self {
        Self {
            requests: Mutex::new(VecDeque::new()),
        }
    }

    fn record(&self, limit: u64) -> Option<u64> {
        let mut requests = self.requests.lock().unwrap();
        let now = Instant::now();
        Self::prune(&mut requests, now);
        if limit > 0 && requests.len() as u64 >= limit {
            return None;
        }
        requests.push_back(now);
        Some(requests.len() as u64)
    }

    fn used(&self) -> u64 {
        self.count_at(Instant::now(), false)
    }

    fn count_at(&self, now: Instant, record: bool) -> u64 {
        let mut requests = self.requests.lock().unwrap();
        Self::prune(&mut requests, now);
        if record {
            requests.push_back(now);
        }
        requests.len() as u64
    }

    fn prune(requests: &mut VecDeque<Instant>, now: Instant) {
        while requests.front().is_some_and(|t| now.saturating_duration_since(*t)
            >= Duration::from_secs(WINDOW_SECS)) {
            requests.pop_front();
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
        self.state() == AccountState::Idle && !self.is_muted()
    }

    pub fn is_muted(&self) -> bool {
        let until = self.mute_until();
        until < 0 || until > now_secs()
    }

    /// 禁言到期 Unix 秒：0=未记录，-1=已确认但期限未知。
    pub fn mute_until(&self) -> i64 {
        self.mute_until.load(Ordering::Relaxed)
    }

    pub fn set_mute_until(&self, secs: i64) {
        self.mute_until.store(secs, Ordering::Relaxed);
    }

    /// 登录成功只更新身份，不代表聊天权限恢复。
    fn apply_login(&self, new_account: &Account) {
        *self.token.write().unwrap() = new_account.token.read().unwrap().clone();
        self.set_mute_until(new_account.mute_until());
        self.clear_cooldown();
        self.state.store(new_account.state() as u8, Ordering::Relaxed);
        self.error_count.store(0, Ordering::Relaxed);
    }

    /// 限流冷却到期 Unix 秒（0=未限流）
    pub fn cooldown_until(&self) -> i64 {
        self.cooldown_until.load(Ordering::Relaxed)
    }

    /// 剩下的冷却秒数（0=不在冷却中）
    pub fn cooldown_remaining(&self) -> i64 {
        (self.cooldown_until() - now_secs()).max(0)
    }

    /// 是否正处于限流退避窗口内
    pub fn in_cooldown(&self) -> bool {
        self.cooldown_remaining() > 0
    }

    /// 进入限流退避。`level` 为连续被限流的次数（从 1 开始），按阶梯取退避时长。
    /// 返回实际设置的剩余秒数。
    pub fn enter_cooldown(&self, level: usize) -> i64 {
        let idx = level.clamp(1, COOLDOWN_LADDER_SECS.len()) - 1;
        let secs = COOLDOWN_LADDER_SECS[idx];
        self.cooldown_until.store(now_secs() + secs, Ordering::Relaxed);
        secs
    }

    /// 清空限流退避（重登成功 / 手动恢复时调用）
    pub fn clear_cooldown(&self) {
        self.cooldown_until.store(0, Ordering::Relaxed);
        self.cooldown_level.store(0, Ordering::Relaxed);
    }

    /// 该账号在本配额窗口内是否还能继续使用（`limit == 0` 表示不限制）
    fn within_quota(&self, limit: u64) -> bool {
        limit == 0 || self.window.used() < limit
    }

    /// 记一次请求用量；达到配额时打一次告警
    fn record_request(&self, limit: u64) -> bool {
        let Some(used) = self.window.record(limit) else { return false };
        if limit > 0 && used == limit {
            warn!(
                target: "ds_core::accounts",
                "账号 {} 已达到最近一小时请求配额（{}），等待窗口释放后再试",
                self.display_id(), limit
            );
        }
        true
    }
}

/// 禁言到期时间格式化（本地时区）
pub(crate) fn format_mute_time(secs: i64) -> String {
    if secs <= 0 {
        return "未知（上游未返回）".into();
    }
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

    /// 账号数量（用于"逐个账号尝试"这类有限轮询的循环上界）
    pub fn account_count(&self) -> usize {
        self.accounts.len()
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

        // 串行初始化 + 账号间随机抖动（风控差异 #3）：旧实现 13 账号并发登录，
        // "同一 IP 同一分钟出现 N 个新设备注册 + N 次登录"是典型批量特征。
        // 词典笔场景账号数少（1-3），串行总耗时可控；多账号池每账号间隔 5-15s。
        let mut initialized: Vec<(String, Arc<Account>)> = Vec::new();
        let total = creds.len();
        for (idx, creds) in creds.into_iter().enumerate() {
            if idx > 0 {
                let gap = rand_ms(5000, 15000);
                info!(target: "ds_core::accounts", "账号初始化间隔抖动 {}ms ({}/{})", gap, idx + 1, total);
                tokio::time::sleep(tokio::time::Duration::from_millis(gap)).await;
            }
            let display_id = if creds.mobile.is_empty() {
                creds.email.clone()
            } else {
                creds.mobile.clone()
            };
            match init_account(&creds, client, solver).await {
                Ok(account) => {
                    info!(target: "ds_core::accounts", "账号 {} 初始化成功", display_id);
                    initialized.push((display_id, Arc::new(account)));
                }
                Err(e) => {
                    warn!(target: "ds_core::accounts", "账号 {} 初始化失败: {}", display_id, e);
                }
            }
        }

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
            // 全部账号都在限流退避中：等待没有意义（退避最短 60s > 这里的等待窗口），
            // 提前返回让调用方尽快把"上游限流"告诉用户，而不是白等 30 秒（bug 1）
            if self.all_in_cooldown() {
                return None;
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

        // CAS 失败说明并发请求恰好抢走了同一个"最空闲"账号：重新选下一个，
        // 而不是直接返回 None（明明有空闲账号却报 Overloaded）。有限次重试即可，
        // 打满重试次数说明竞争极端激烈，返回 None 触发上层限流更合适。
        for _ in 0..4 {
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
                // 限流退避中的账号不分配：继续拿它发请求只会把请求洪峰续上，
                // 上游正是据此判定"异常客户端"并禁言（bug 1）
                if account.in_cooldown() {
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
            if account
                .state
                .compare_exchange(
                    AccountState::Idle as u8,
                    AccountState::Busy as u8,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .is_ok()
            {
                if !account.record_request(self.hourly_quota) {
                    drop(AccountGuard { account });
                    return None;
                }
                return Some(AccountGuard { account });
            }
        }
        None
    }

    /// 获取指定账号（会话复用：续聊/重答必须用创建会话的同一账号），空闲时立即返回
    ///
    /// 续聊同样遵守配额，不能用会话亲和绕过本地请求上限。
    pub fn get_account_by_id(&self, email_or_mobile: &str) -> Option<AccountGuard> {
        let entry = self.accounts.get(email_or_mobile)?;
        let account = entry.value();
        if !account.is_available() {
            return None;
        }
        // 限流退避优先级高于会话亲和：命中退避时**不能**放行，否则"用户一直点
        // 重试"会沿同一条会话持续冲击上游（bug 1）。复用路径拿到 None 会退化为
        // 冷启动/换号，最终以"服务繁忙"结束，不会变成禁言。
        if account.in_cooldown() {
            return None;
        }
        if !account.within_quota(self.hourly_quota) {
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
        if !account.record_request(self.hourly_quota) {
            drop(AccountGuard { account: Arc::clone(account) });
            return None;
        }
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
                    is_muted: a.is_muted(),
                    mute_until: (a.mute_until() > 0).then(|| a.mute_until()),
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

    /// 记录明确的上游禁言；未知期限暂停自动恢复，不猜测服务端封禁时长。
    pub fn mark_muted(&self, email_or_mobile: &str, until: Option<i64>) {
        if let Some(entry) = self.accounts.get(email_or_mobile) {
            let a = entry.value();
            let until = until.filter(|t| *t > now_secs())
                .or_else(|| (a.mute_until() > now_secs()).then(|| a.mute_until()))
                .unwrap_or(-1);
            a.set_mute_until(until);
            a.state.store(AccountState::Error as u8, Ordering::Relaxed);
            warn!(target: "ds_core::accounts",
                "账号 {} 上游确认禁言，mute_until={}，暂停请求与自动重登", a.display_id(), until);
        }
    }

    pub fn account_mute_notice(&self, id: &str) -> Option<String> {
        let entry = self.accounts.get(id)?;
        let account = entry.value();
        if !account.is_muted() {
            return None;
        }
        Some(if account.mute_until() > 0 {
            format!("账号已被禁言至 {}，请等待解禁", format_mute_time(account.mute_until()))
        } else {
            "账号已被禁言，服务端未返回解禁时间；自动恢复已暂停，可在确认解禁后手动重登".into()
        })
    }

    pub fn all_muted_notice(&self) -> Option<String> {
        if self.accounts.is_empty() || self.accounts.iter().any(|e| !e.value().is_muted()) {
            return None;
        }
        let id = self.accounts.iter().next()?.key().clone();
        self.account_mute_notice(&id)
    }

    pub fn account_quota_exhausted(&self, id: &str) -> bool {
        self.accounts.get(id).is_some_and(|a| !a.within_quota(self.hourly_quota))
    }

    /// 记录一次上游限流并让该账号进入退避窗口（**不**标记 Error）。
    ///
    /// 为什么不能复用 mark_error：Error 会触发后台恢复任务去**重新登录**，
    /// 而登录本身也是一次上游请求。被限流时反复重登 + 每次用户重试都新建 session，
    /// 会在短时间内堆出额外请求；当前证据不能认定这是首次禁言的原因。
    /// 退避只是等，不产生任何新请求。
    /// 返回退避秒数；账号不存在时返回 0。
    pub fn mark_rate_limited(&self, email_or_mobile: &str) -> i64 {
        let Some(entry) = self.accounts.get(email_or_mobile) else {
            return 0;
        };
        let account = entry.value();
        let level = account
            .cooldown_level
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1) as usize;
        let secs = account.enter_cooldown(level);
        warn!(
            target: "ds_core::accounts",
            "账号 {} 触发上游限流，进入退避 {}s（档位 {}，不重登以避免请求洪峰）",
            account.display_id(), secs, level
        );
        secs
    }

    /// 是否所有账号都在限流退避中（用于给出"稍后再试"而非"没有账号"的提示）
    pub fn all_in_cooldown(&self) -> bool {
        if self.accounts.is_empty() {
            return false;
        }
        let mut any_cooling = false;
        for entry in self.accounts.iter() {
            let account = entry.value();
            // 有账号此刻就能用 → 不算"全在限流"
            if account.is_available() && !account.in_cooldown() {
                return false;
            }
            if account.in_cooldown() {
                any_cooling = true;
            }
        }
        any_cooling
    }

    /// 全池最长的剩余退避秒数（0=没有任何账号在退避）
    pub fn max_cooldown_remaining(&self) -> i64 {
        self.accounts
            .iter()
            .map(|e| e.value().cooldown_remaining())
            .max()
            .unwrap_or(0)
    }

    /// 指定账号的剩余退避秒数（0 = 不在退避中或账号不存在）。
    ///
    /// 会话复用路径用它区分两种"拿不到目标账号"：
    ///   - 正在退避（> 0）：上游在限这条链路，**必须直接以限流返回**——
    ///     换号重建会话等于把上一次的洪峰续上（bug 1）；
    ///   - 其它原因（账号已失效/被移除）：允许调用方降级冷启动。
    pub fn account_cooldown_remaining(&self, email_or_mobile: &str) -> i64 {
        self.accounts
            .get(email_or_mobile)
            .map(|e| e.value().cooldown_remaining())
            .unwrap_or(0)
    }

    /// 手动重新登录指定账号（管理员触发）
    /// 登录成功后保留上游聊天状态；登录失败 → error_count++，≥3 则 Invalid。
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

        Self::re_login_account(account, &client, &solver, true).await;

        // 检查重登后状态
        let new_state = account.state();
        if new_state == AccountState::Idle {
            Ok(())
        } else {
            Err(format!("重登失败，当前状态: {}", new_state.as_str()))
        }
    }

    /// 尝试重新登录 Error 状态的账号
    /// 登录成功后保留上游聊天状态；登录失败 → error_count++，≥3 则 Invalid。
    async fn re_login_account(account: &Account, client: &DsClient, solver: &PowSolver, manual: bool) {
        let display_id = account.display_id().to_string();
        // 禁言未到期的账号跳过重登（风控差异 #4）：禁言 → mark_error → 每 5 分钟
        // 恢复任务 re_login 会形成无效登录循环。
        // 禁言是独立的账号状态，登录成功不代表聊天限制解除。
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if account.mute_until() > now || (!manual && account.mute_until() < 0) {
            debug!(
                target: "ds_core::accounts",
                "账号 {} 禁言至 {}，跳过本轮重登",
                display_id,
                format_mute_time(account.mute_until())
            );
            return;
        }
        match try_init_account(&account.creds, client, solver).await {
            Ok(new_account) => {
                account.apply_login(&new_account);
                info!(target: "ds_core::accounts", "账号 {} 登录响应已更新，聊天状态={}",
                    display_id, account.state().as_str());
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
    /// 多个 Error 账号会周期性放大请求量。当前使用 5 分钟间隔及轻量验证。
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

                // 先收集再处理：DashMap 的 iter() 持有分片读锁，直接在循环里
                // await 网络重登会让 get_account/add_account 在这些分片上阻塞数秒
                let error_accounts: Vec<Arc<Account>> = pool
                    .accounts
                    .iter()
                    .filter(|e| e.value().state() == AccountState::Error)
                    .map(|e| Arc::clone(e.value()))
                    .collect();
                for account in error_accounts {
                    Self::re_login_account(&account, &client, &solver, false).await;
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
        // 不再发"健康检查 completion"（bug 2 延迟封号缓解）：每次冷启动对每个
        // 账号发一次真实对话请求，是纯增量的上游暴露面——登录响应里已带禁言
        // 状态（mute_until），账号可用性由首次真实请求自然验证，失败走既有的
        // Error→重登路径。create_session/delete_session 保留（验证 token 有效）。
        match try_init_account(creds, client, solver).await {
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
    // 登录不再做 completion 健康检查（bug 2），solver 仅为保持调用链形状，
    // 将来若需恢复可选校验可直接使用。
    _solver: &PowSolver,
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
            let captcha_store = crate::server::captcha_bridge::global();
            let (id, rx) = captcha_store.create(detail);
            warn!(
                target: "ds_core::accounts",
                "登录触发人机验证，请打开 http://127.0.0.1:22217/captcha/{} 完成验证，超时 10 分钟",
                id
            );
            let _result = crate::server::captcha_bridge::wait_for_solution(rx, 600).await;
            // 无论成败都清理会话条目（成功路径 submit 里已清，这里兜底超时/放弃）
            captcha_store.remove(&id);
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
    let (initial_state, mute_until) = login_chat_state(login_data.user.chat.as_ref(), now_secs());
    if initial_state == AccountState::Error {
        warn!(
            target: "ds_core::accounts",
            "账号 {} 已被禁言至 {}（登录正常，completion 将被拒绝，user_is_muted）",
            display_id,
            format_mute_time(mute_until)
        );
    }

    // 不做 create/delete 会话验证（风控差异 #1）：官方 79MB 抓包里 delete
    // 只出现 1 次（用户手动删会话），"登录后立刻 create+delete 一对孤儿会话"
    // 是最容易聚类的自动化签名。账号可用性由登录响应的 mute 状态与首次真实
    // 请求自然验证，坏 token 走既有 Error→重登路径。
    // 拟真开屏（风控差异 #2）：官方 web 登录后是 settings → 会话列表的浏览
    // 行为，我们补发同构的开屏序列（结果忽略），消除"登录即对话"指纹。
    if initial_state == AccountState::Idle {
        mimic_opening_sequence(client, &token, &login_payload.device_id).await;
    }

    Ok(Account {
        token: std::sync::RwLock::new(token.into()),
        email: creds.email.clone(),
        mobile: creds.mobile.clone(),
        state: AtomicU8::new(initial_state as u8),
        last_released: AtomicI64::new(0),
        error_count: AtomicU8::new(0),
        mute_until: AtomicI64::new(mute_until),
        cooldown_until: AtomicI64::new(0),
        cooldown_level: AtomicU8::new(0),
        creds: creds.clone(),
        window: RequestWindow::new(),
    })
}

/// is_muted 与未来的 mute_until 都能说明当前受限；不将登录成功当成解禁。
fn login_chat_state(chat: Option<&crate::ds_core::client::ChatMute>, now: i64) -> (AccountState, i64) {
    let Some(chat) = chat else { return (AccountState::Idle, 0) };
    let until = if chat.mute_until.is_finite() { chat.mute_until.ceil() as i64 } else { 0 };
    if chat.is_muted != 0 || until > now {
        (AccountState::Error, if until > now { until } else { -1 })
    } else {
        (AccountState::Idle, 0)
    }
}

/// 拟真开屏序列（风控差异 #2）：官方 web 登录成功后是
/// settings（带持久 did）→（间隔秒级）→ 会话列表 fetch_page 的浏览行为；
/// 旧实现登录后 0 静默请求直奔 completion，"登录即对话"是非人指纹。
/// 这里登录成功后串行补发 settings → fetch_page（结果忽略），间隔随机 1-3s。
/// did 由账号 device_id 派生（稳定，每账号不同，形状与浏览器 localStorage UUID 一致）。
async fn mimic_opening_sequence(client: &DsClient, token: &str, device_id: &str) {
    let did = stable_did_from(device_id);
    // 登录响应本身已间隔了网络往返；这里再歇 1-3s 模拟开屏渲染时间
    tokio::time::sleep(tokio::time::Duration::from_millis(rand_ms(1000, 3000))).await;
    client.fetch_client_settings(token, &did).await;
    tokio::time::sleep(tokio::time::Duration::from_millis(rand_ms(800, 2000))).await;
    let _ = client.fetch_session_page(token, None).await;
}

/// 从 device_id 派生稳定的 UUID v4 形状字符串（作 client/settings 的 did）。
/// 官方 did 是浏览器 localStorage 的持久 UUID；用 device_id 哈希保证
/// "每账号稳定且不同"，避免每次登录换 did（又一种不稳定指纹）。
fn stable_did_from(device_id: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    // 两个不同 salt 的哈希拼 32 hex（Fowler 风格足够分散，无需引入 md5 依赖）
    let mut h1 = DefaultHasher::new();
    device_id.hash(&mut h1);
    let a = h1.finish();
    let mut h2 = DefaultHasher::new();
    format!("{}|did-salt", device_id).hash(&mut h2);
    let b = h2.finish();
    format!(
        "{:016x}{:016x}",
        a.swap_bytes(), b
    )
    .chars()
    .enumerate()
    .fold(String::with_capacity(36), |mut acc, (i, c)| {
        if i == 8 || i == 12 || i == 16 || i == 20 {
            acc.push('-');
        }
        acc.push(c);
        acc
    })
}

/// [lo, hi) 毫秒随机数（std 库内实现，避免引 rand 到此模块）
fn rand_ms(lo: u64, hi: u64) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    lo + nanos % (hi - lo).max(1)
}

/// completion 链路步骤间的人速间隔（300-1200ms），pub(crate) 供编排层使用
pub(crate) fn human_delay_ms() -> u64 {
    rand_ms(300, 1200)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// did 派生：UUID 形状 + 同输入稳定 + 不同输入分散
    #[test]
    fn stable_did_is_uuid_shaped_and_deterministic() {
        let d1 = stable_did_from("BjrONyKUq74lx67PbD6L2lvsbT3");
        let d2 = stable_did_from("BjrONyKUq74lx67PbD6L2lvsbT3");
        let d3 = stable_did_from("other-device");
        assert_eq!(d1, d2, "同 device_id 派生的 did 必须稳定");
        assert_ne!(d1, d3);
        assert_eq!(d1.len(), 36, "UUID 形状: {}", d1);
        for (i, c) in d1.chars().enumerate() {
            if i == 8 || i == 13 || i == 18 || i == 23 {
                assert_eq!(c, '-', "位置 {} 应为连字符", i);
            } else {
                assert!(c.is_ascii_hexdigit(), "位置 {} 应为 hex: {}", i, c);
            }
        }
    }

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
            cooldown_until: AtomicI64::new(0),
            cooldown_level: AtomicU8::new(0),
            creds: account(email, "dev"),
            window: RequestWindow::new(),
        })
    }

    #[test]
    fn window_counts_and_reports_usage() {
        let w = RequestWindow::new();
        assert_eq!(w.used(), 0);
        assert_eq!(w.record(0), Some(1));
        assert_eq!(w.record(0), Some(2));
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
    fn cooldown_ladder_escalates_and_clears() {
        // 限流退避：连续触发时逐级加长（bug 1 —— 退避不够长等于没退避）
        let a = idle_account("a@example.com");
        assert!(!a.in_cooldown(), "初始不在退避中");
        assert_eq!(a.cooldown_remaining(), 0);

        assert_eq!(a.enter_cooldown(1), COOLDOWN_LADDER_SECS[0]);
        assert!(a.in_cooldown());
        assert!(a.cooldown_remaining() > 0 && a.cooldown_remaining() <= COOLDOWN_LADDER_SECS[0]);

        assert_eq!(a.enter_cooldown(3), COOLDOWN_LADDER_SECS[2]);
        // 档位超出阶梯长度时取最后一档，不越界
        assert_eq!(
            a.enter_cooldown(99),
            COOLDOWN_LADDER_SECS[COOLDOWN_LADDER_SECS.len() - 1]
        );

        a.clear_cooldown();
        assert!(!a.in_cooldown(), "重登成功后必须清掉退避");
        assert_eq!(a.cooldown_remaining(), 0);
    }

    #[test]
    fn cooldown_account_is_not_allocated() {
        // 退避中的账号不得被分配：否则用户连点发送会持续冲击上游
        let pool = AccountPool::new(0);
        let a = idle_account("a@example.com");
        pool.accounts.insert("a@example.com".to_string(), a.clone());

        assert!(pool.get_account().is_some(), "未退避时可分配");
        a.enter_cooldown(1);
        assert!(pool.get_account().is_none(), "退避中不应被分配");
        // 会话亲和（get_account_by_id）同样不得绕过退避
        assert!(
            pool.get_account_by_id("a@example.com").is_none(),
            "退避优先级高于会话亲和"
        );
        assert!(pool.max_cooldown_remaining() > 0);
    }

    #[test]
    fn account_cooldown_remaining_targets_one_account() {
        // 会话复用路径拿不到目标账号时，用它区分"在退避"（必须直接报限流，
        // 不能降级冷启动换号）与"账号已失效"（允许降级）。
        let pool = AccountPool::new(0);
        let a = idle_account("a@example.com");
        let b = idle_account("b@example.com");
        pool.accounts.insert("a@example.com".to_string(), a.clone());
        pool.accounts.insert("b@example.com".to_string(), b.clone());

        assert_eq!(pool.account_cooldown_remaining("a@example.com"), 0);
        a.enter_cooldown(1);
        assert!(
            pool.account_cooldown_remaining("a@example.com") > 0,
            "退避中的账号应报出剩余秒数"
        );
        assert_eq!(
            pool.account_cooldown_remaining("b@example.com"),
            0,
            "未退避的账号不应被牵连"
        );
        assert_eq!(
            pool.account_cooldown_remaining("missing@example.com"),
            0,
            "账号不存在时按 0 处理（调用方走冷启动）"
        );
    }

    #[test]
    fn expired_window_resets_usage() {
        let w = RequestWindow::new();
        let start = Instant::now();
        assert_eq!(w.count_at(start, true), 1);
        assert_eq!(w.count_at(start + Duration::from_secs(3599), true), 2);
        // 只淘汰最早的请求，窗口边界前一秒的请求仍需计数。
        assert_eq!(w.count_at(start + Duration::from_secs(3600), false), 1);
        assert_eq!(w.count_at(start + Duration::from_secs(3600), true), 2);
        assert_eq!(w.count_at(start + Duration::from_secs(7200), false), 0);
    }

    #[test]
    fn quota_applies_to_reused_conversations() {
        let pool = AccountPool::new(1);
        let a = idle_account("a@example.com");
        pool.accounts.insert("a@example.com".into(), a.clone());
        let guard = pool.get_account_by_id("a@example.com").unwrap();
        drop(guard);
        assert!(pool.account_quota_exhausted("a@example.com"));
        assert!(pool.get_account_by_id("a@example.com").is_none());
        assert!(pool.get_account().is_none());
        assert_eq!(a.window.used(), 1);
    }

    #[test]
    fn quota_reservation_is_atomic() {
        let window = Arc::new(RequestWindow::new());
        let workers: Vec<_> = (0..16).map(|_| {
            let window = window.clone();
            std::thread::spawn(move || window.record(3).is_some())
        }).collect();
        let accepted = workers.into_iter().filter_map(|t| t.join().ok()).filter(|v| *v).count();
        assert_eq!(accepted, 3);
        assert_eq!(window.used(), 3);
    }

    #[test]
    fn muted_login_is_not_a_healthy_account() {
        use crate::ds_core::client::ChatMute;
        let chat = ChatMute { is_muted: 1, mute_until: 2000.25 };
        assert_eq!(login_chat_state(Some(&chat), 1000), (AccountState::Error, 2001));
        let unknown = ChatMute { is_muted: 1, mute_until: 0.0 };
        assert_eq!(login_chat_state(Some(&unknown), 1000), (AccountState::Error, -1));
        let clear = ChatMute { is_muted: 0, mute_until: 999.0 };
        assert_eq!(login_chat_state(Some(&clear), 1000), (AccountState::Idle, 0));
    }

    #[test]
    fn relogin_does_not_clear_a_confirmed_mute() {
        let account = idle_account("a@example.com");
        let fresh_login = idle_account("a@example.com");
        fresh_login.set_mute_until(now_secs() + 3600);
        fresh_login.state.store(AccountState::Error as u8, Ordering::Relaxed);
        account.apply_login(&fresh_login);
        assert_eq!(account.state(), AccountState::Error);
        assert!(!account.is_available());
        assert!(account.is_muted());
    }

    #[test]
    fn confirmed_mute_survives_guard_release() {
        let pool = AccountPool::new(0);
        let a = idle_account("a@example.com");
        pool.accounts.insert("a@example.com".into(), a.clone());
        let guard = pool.get_account().unwrap();
        pool.mark_muted("a@example.com", None);
        drop(guard);
        assert_eq!(a.state(), AccountState::Error);
        assert_eq!(a.mute_until(), -1);
        assert!(pool.get_account().is_none());
        assert!(pool.get_account_by_id("a@example.com").is_none());
        assert!(pool.all_muted_notice().is_some());
        let status = pool.account_statuses();
        assert!(status[0].is_muted);
        assert_eq!(status[0].mute_until, None);
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
