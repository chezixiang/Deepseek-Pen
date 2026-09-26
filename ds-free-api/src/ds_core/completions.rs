//! 对话请求编排 —— create_session → upload → PoW → completion → delete_session
//!
//! 每次请求创建新 session，结束后立即清理。历史对话通过文件上传传递。

use crate::config::Config;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time::Sleep;

use bytes::Bytes;
use futures::{Stream, StreamExt};
use pin_project_lite::pin_project;

use crate::ds_core::CoreError;
use crate::ds_core::accounts::{AccountGuard, AccountPool};
use crate::ds_core::accounts::format_mute_time;
use crate::ds_core::accounts::human_delay_ms;
use crate::ds_core::client::{CompletionPayload, DsClient, EditMessagePayload, StopStreamPayload};
use crate::ds_core::pow::PowSolver;
use super::floor_utf8_end;

pub(crate) struct ActiveSession {
    pub(crate) token: String,
    pub(crate) session_id: String,
    pub(crate) message_id: i64,
}

/// session 生命周期守卫：RAII 保证任何错误路径都执行 delete_session。
/// 创建 session 后立即构造；成功把流移交 GuardedStream 时调用 `disarm()` 避免重复清理；
/// 其余路径（上传失败/PoW 失败/completion 失败/空 SSE 流/hint 错误等）在作用域结束时自动清理，
/// 修复此前多条错误路径不删除临时 session 导致的服务端 session 泄漏（触发风控/禁言）。
struct SessionGuard {
    client: DsClient,
    token: String,
    session_id: String,
    armed: bool,
}

impl SessionGuard {
    fn new(client: DsClient, token: String, session_id: String) -> Self {
        Self {
            client,
            token,
            session_id,
            armed: true,
        }
    }

    /// 成功移交流后解除清理责任（由 GuardedStream 负责收尾）
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let client = self.client.clone();
        let token = self.token.clone();
        let session_id = self.session_id.clone();
        tokio::spawn(async move {
            if let Err(e) = client.delete_session(&token, &session_id).await {
                log::warn!(
                    target: "ds_core::accounts",
                    "SessionGuard 清理 session {} 失败: {}", session_id, e
                );
            } else {
                log::debug!(
                    target: "ds_core::accounts",
                    "SessionGuard 清理 session: id={}", session_id
                );
            }
        });
    }
}

const TAG_START: &str = "<｜";
const TAG_END: &str = "｜>";
const SESSION_HISTORY_FILE: &str = "EMPTY.txt";
const UPLOAD_POLL_INTERVAL_MS: u64 = 2000;
const UPLOAD_POLL_MAX_RETRIES: usize = 30; // 60s 总超时

#[derive(Debug, Clone)]
pub struct FilePayload {
    pub filename: String,
    pub content: Vec<u8>,
    pub content_type: String,
}

/// 会话复用：续聊目标（Web 端对话形态——持久会话，历史由服务端持有）
#[derive(Debug, Clone)]
pub struct ReuseTarget {
    /// 必须用创建该会话的同一账号（会话是账号作用域的）
    pub account_id: String,
    pub session_id: String,
    /// 最近一次请求消息 id（edit_message 重答锚点）
    pub last_request_msg_id: i64,
    /// 最近一次响应消息 id（Append 的 parent_message_id 锚点）
    pub last_response_msg_id: i64,
}

/// 会话复用计划（adapter 依据消息上下文计算，v0_chat 据此选择路径）
#[derive(Debug, Clone)]
pub struct ConversationPlan {
    /// 本轮查找键（上下文哈希）；复用失败时清理
    pub cache_key: String,
    /// 下一轮的预期查找键（上下文+本轮 user）；请求成功后与新会话信息一起写入，
    /// 下一轮请求即可命中复用（两个键指向同一缓存条目）
    pub next_key: String,
    /// 本轮用户消息纯文本（缓存 last_user_text，用于区分"新轮次"与"编辑重答"）
    pub user_text: String,
    /// None = 冷启动新建会话并缓存；Some = 复用现有持久会话
    pub reuse: Option<ReuseTarget>,
    /// true = 编辑重答（edit_message，服务端截断旧分支）；false = 追加新轮次
    pub regenerate: bool,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub prompt: String,
    pub thinking_enabled: bool,
    pub search_enabled: bool,
    pub model_type: String,
    pub files: Vec<FilePayload>,
    /// 会话复用计划；None = 传统临时会话（上传历史文件）行为
    pub conversation: Option<ConversationPlan>,
}

/// v0_chat 返回值：SSE 字节流 + 账号标识
pub struct ChatResponse {
    pub stream: Pin<Box<dyn Stream<Item = Result<Bytes, CoreError>> + Send>>,
    pub account_id: String,
    /// 本次对话所在的云端会话 id（chat_session.id，即 fetch_page 侧栏里的那条）。
    /// 应用侧据此把本地会话与云端会话对上号，同步时不会重复导入（bug 3）。
    /// 临时会话（非持久，流的收尾会 delete_session）也为 Some，调用方自行决定是否透传。
    pub session_id: String,
    /// 持久会话（会话复用路径）：缓存管理其生命周期，应用侧可安全记录 session_id
    pub persistent: bool,
}

pin_project! {
    pub struct GuardedStream<S> {
        #[pin]
        stream: S,
        _guard: AccountGuard,
        client: DsClient,
        token: String,
        session_id: String,
        message_id: i64,
        finished: bool,
        // true = 持久会话（会话复用）：结束时只 stop_stream，不 delete_session，
        // 会话由 ConversationCache 负责生命周期（淘汰时才删）
        persistent: bool,
        sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    }

    impl<S> PinnedDrop for GuardedStream<S> {
        fn drop(this: Pin<&mut Self>) {
            let this = this.project();
            let client = this.client.clone();
            let token = this.token.clone();
            let session_id = this.session_id.clone();
            let message_id = *this.message_id;
            let finished = *this.finished;
            let persistent = *this.persistent;
            let sessions = this.sessions.clone();

            // 从活跃 session 追踪中移除
            sessions.lock().unwrap().remove(&session_id);

            tokio::spawn(async move {
                // 流未自然结束时通知服务端停止生成
                if !finished {
                    let payload = StopStreamPayload {
                        chat_session_id: session_id.clone(),
                        message_id,
                    };
                    if let Err(e) = client.stop_stream(&token, &payload).await {
                        log::warn!(target: "ds_core::accounts", "stop_stream 失败: {}", e);
                    }
                }
                // 临时会话：无论流是否完成都清理；持久会话保留（服务端持有历史）
                if !persistent {
                    if let Err(e) = client.delete_session(&token, &session_id).await {
                        log::warn!(target: "ds_core::accounts", "delete_session 失败: {}", e);
                    }
                }
            });
        }
    }
}

impl<S> GuardedStream<S> {
    pub fn new(
        stream: S,
        guard: AccountGuard,
        client: DsClient,
        token: String,
        session_id: String,
        message_id: i64,
        persistent: bool,
        sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    ) -> Self {
        Self {
            stream,
            _guard: guard,
            client,
            token,
            session_id,
            message_id,
            finished: false,
            persistent,
            sessions,
        }
    }
}

impl<S, E> Stream for GuardedStream<S>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::fmt::Display,
{
    type Item = Result<Bytes, CoreError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.project();
        match this.stream.poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => Poll::Ready(Some(Ok(bytes))),
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(CoreError::Stream(e.to_string())))),
            Poll::Ready(None) => {
                *this.finished = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.stream.size_hint()
    }
}

/// 读空闲超时包装：上游连接半开（TCP 黑洞、代理挂死）时，`idle` 内没有任何
/// 字节到达就报 Stream 错误结束请求。没有它，挂死的连接会让账号永远停在
/// Busy、客户端请求永不返回。所有字段均 Unpin，无需 pin 投影。
pub(crate) struct IdleTimeoutStream {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, CoreError>> + Send>>,
    idle: Duration,
    deadline: Option<Pin<Box<Sleep>>>,
}

impl Stream for IdleTimeoutStream {
    type Item = Result<Bytes, CoreError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(item) => {
                // 任何产出（含错误/结束）都解除超时器，避免悬挂的 Sleep 拖延 shutdown
                this.deadline = None;
                Poll::Ready(item)
            }
            Poll::Pending => {
                let idle = this.idle;
                let sleep = this
                    .deadline
                    .get_or_insert_with(|| Box::pin(tokio::time::sleep(idle)));
                match sleep.as_mut().poll(cx) {
                    Poll::Ready(()) => Poll::Ready(Some(Err(CoreError::Stream(format!(
                        "读空闲超时（{} 秒内上游无任何数据）",
                        idle.as_secs()
                    ))))),
                    Poll::Pending => Poll::Pending,
                }
            }
        }
    }
}

/// SSE 读空闲上限：正常流式输出（含服务端保活与混淆填充）远不会静默这么久
const SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

pub struct Completions {
    client: RwLock<DsClient>,
    solver: RwLock<PowSolver>,
    pool: Arc<AccountPool>,
    active_sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    /// 会话复用缓存：context_hash → 持久 DeepSeek 会话（LRU + TTL）
    conversations: Arc<Mutex<HashMap<String, CachedConversation>>>,
}

/// 会话复用缓存条目
#[derive(Debug, Clone)]
pub struct CachedConversation {
    pub account_id: String,
    pub session_id: String,
    /// 最近一次请求消息 id（edit_message 锚点）
    pub last_request_msg_id: i64,
    /// 最近一次响应消息 id（Append 的 parent 锚点）
    pub last_response_msg_id: i64,
    /// 最近一次用户消息文本（区分新轮次 vs 编辑重答）
    pub last_user_text: String,
    pub model_type: String,
    pub last_used_ms: u64,
}

const CONVO_CACHE_CAP: usize = 128;
const CONVO_TTL_MS: u64 = 6 * 60 * 60 * 1000;

/// 会话缓存的纯写入逻辑（与账号池解耦，便于单测）：
/// 把同一个条目写到所有键上——**已存在的键同样覆盖**，未存在的键新增；
/// 随后按 `last_used_ms` 淘汰超容量的最旧条目，返回它们供调用方删除服务端会话。
fn apply_conversation_insert(
    map: &mut HashMap<String, CachedConversation>,
    keys: Vec<String>,
    entry: CachedConversation,
) -> Vec<CachedConversation> {
    let mut unique: Vec<String> = Vec::with_capacity(keys.len());
    for k in keys {
        if !unique.contains(&k) {
            unique.push(k);
        }
    }
    // 覆盖写：条目代表「该上下文之后最近一次发出的 user 消息与消息锚点」，
    // 同一上下文被再次使用（续聊/编辑）时必须更新，否则适配器读到陈旧值。
    for k in &unique {
        map.insert(k.clone(), entry.clone());
    }

    let mut victims = Vec::new();
    if map.len() > CONVO_CACHE_CAP {
        let mut by_age: Vec<(String, u64)> = map
            .iter()
            .map(|(k, v)| (k.clone(), v.last_used_ms))
            .collect();
        by_age.sort_by_key(|(_, ms)| *ms);
        let overflow = map.len() - CONVO_CACHE_CAP;
        for (victim_key, _) in by_age.into_iter().take(overflow) {
            if let Some(victim) = map.remove(&victim_key) {
                victims.push(victim);
            }
        }
    }
    victims
}

impl Completions {
    pub async fn new(client: DsClient, solver: PowSolver, pool: AccountPool) -> Self {
        let pool = Arc::new(pool);
        // 存储 client/solver 供后台恢复任务使用
        pool.set_client_solver(client.clone(), solver.clone()).await;
        // 启动后台恢复任务
        pool.start_recovery_task();
        Self {
            client: RwLock::new(client),
            solver: RwLock::new(solver),
            pool,
            active_sessions: Arc::new(Mutex::new(HashMap::new())),
            conversations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // ---------- 会话复用缓存 ----------

    pub(crate) fn lookup_conversation(&self, key: &str) -> Option<CachedConversation> {
        let mut map = self.conversations.lock().unwrap();
        let entry = map.get(key)?.clone();
        let now_ms = now_ms_u64();
        if now_ms.saturating_sub(entry.last_used_ms) > CONVO_TTL_MS {
            map.remove(key);
            self.spawn_delete_session(&entry.account_id, &entry.session_id);
            return None;
        }
        Some(entry)
    }

    /// 同一会话写入多个键（查找键 + 下一轮预期键），LRU 淘汰按条目数计。
    ///
    /// 已存在的键**必须覆盖**：缓存条目上的 `last_user_text` 是「该上下文之后那条
    /// user 消息」，适配器据此判断续聊 / 编辑重答。旧实现把已存在的键直接跳过，
    /// 于是条目一直保留最早的 `last_user_text`（以及过期的消息锚点）——
    /// 下一轮拿上下文尾部来比会命中一个陈旧值，编辑被误判成续聊（反之亦然），
    /// 这正是"同一对话上下文丢失"的另一个成因（bug 1）。
    pub(crate) fn insert_conversation_multi(&self, keys: Vec<String>, entry: CachedConversation) {
        let victims = {
            let mut map = self.conversations.lock().unwrap();
            apply_conversation_insert(&mut map, keys, entry)
        };
        for victim in victims {
            self.spawn_delete_session(&victim.account_id, &victim.session_id);
        }
    }

    pub(crate) fn remove_conversation(&self, key: &str) {
        self.conversations.lock().unwrap().remove(key);
    }

    /// 尽力而为地删除持久会话（淘汰/失效时）；账号可能已被移除或忙，失败静默
    fn spawn_delete_session(&self, account_id: &str, session_id: &str) {
        let token = self.pool.token_of(account_id);
        // tokio RwLock 不可 Clone，先 try_read 取出 DsClient 克隆（拿不到就放弃）
        let client = self.client.try_read().ok().map(|c| c.clone());
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            if let (Some(token), Some(client)) = (token, client) {
                if let Err(e) = client.delete_session(&token, &session_id).await {
                    log::debug!(
                        target: "ds_core::accounts",
                        "淘汰持久会话 {} 失败（忽略）: {}", session_id, e
                    );
                }
            }
        });
    }

    pub async fn v0_chat(
        &self,
        req: ChatRequest,
        request_id: &str,
    ) -> Result<ChatResponse, CoreError> {
        if let Some(notice) = self.pool.all_muted_notice() {
            return Err(CoreError::Rejected(notice));
        }
        // 会话复用优先：命中缓存则续聊/重答（历史由服务端持有，不再上传历史文件）
        if let Some(plan) = &req.conversation {
            if let Some(target) = &plan.reuse {
                match self.v0_chat_reuse(&req, plan, target, request_id).await {
                    Ok(resp) => return Ok(resp),
                    Err(CoreError::NoAccounts) => return Err(CoreError::NoAccounts),
                    // 限流**绝不降级冷启动**：降级会新建一个 session（还可能换到别的
                    // 账号）再撞一次上游，把限流的洪峰续上——用户点一次「重试」就多
                    // 一轮请求；是否导致禁言尚无因果证据。
                    // 原样上抛，由适配层返回 429 并由应用侧劝阻等待。
                    Err(e @ CoreError::RateLimited(_)) => return Err(e),
                    // 账号禁言/确定性拒绝不能通过换号或重建会话恢复这一请求。
                    Err(e @ CoreError::Rejected(_)) => return Err(e),
                    Err(CoreError::Overloaded) => return Err(CoreError::Overloaded),
                    Err(e) => {
                        log::warn!(
                            target: "ds_core::accounts",
                            "req={} 会话复用失败，降级冷启动（历史文件路径）: {}", request_id, e
                        );
                        // 限流类错误保留缓存条目（会话仍有效）；其它错误视为会话失效
                        if !matches!(e, CoreError::Overloaded) {
                            self.remove_conversation(&plan.cache_key);
                            self.remove_conversation(&plan.next_key);
                        }
                        // 清除 reuse 后走冷启动；缓存计划保留以便新会话回写
                        let mut cold = req;
                        if let Some(c) = cold.conversation.as_mut() {
                            c.reuse = None;
                        }
                        return self.v0_chat_cold(cold, request_id).await;
                    }
                }
            }
        }
        self.v0_chat_cold(req, request_id).await
    }

    /// 冷启动路径（原有行为）：新建临时/持久会话，历史上传为文件，完成后按需回写缓存
    async fn v0_chat_cold(
        &self,
        req: ChatRequest,
        request_id: &str,
    ) -> Result<ChatResponse, CoreError> {
        const MAX_ATTEMPTS: usize = 3;

        // 拆分历史（支持 ChatML 和非 ChatML 格式）—— 与账号无关，只需做一次
        let (inline_prompt, history_content) = split_history_prompt(&req.prompt);

        if !history_content.is_empty() {
            log::debug!(
                target: "ds_core::accounts",
                "req={} 触发历史拆分, history_size={}", request_id, history_content.len()
            );
        }

        for attempt in 0..MAX_ATTEMPTS {
            let first_try = attempt == 0;
            match self
                .v0_chat_once(
                    &req,
                    &inline_prompt,
                    &history_content,
                    request_id,
                    first_try,
                )
                .await
            {
                Ok(resp) => return Ok(resp),
                Err(CoreError::NoAccounts) => {
                    // 账号池为空：重试也不会变多，直接返回
                    return Err(CoreError::NoAccounts);
                }
                Err(CoreError::RateLimited(msg)) => {
                    // 上游限流**绝不重试**：每次重试都要新建 session + 再次冲击上游，
                    // 这会放大无效流量。让调用方把"稍后再试"带给用户。
                    log::warn!(
                        target: "ds_core::accounts",
                        "req={} 上游限流，停止重试: {}", request_id, msg
                    );
                    return Err(CoreError::RateLimited(msg));
                }
                Err(CoreError::Overloaded) => {
                    if attempt + 1 >= MAX_ATTEMPTS {
                        return Err(CoreError::Overloaded);
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                }
                Err(e @ CoreError::Rejected(_)) => {
                    // 上游对本次请求的确定性拒绝（输入超长/账号禁言）：重试不会改变
                    // 结果，却要再建 session、再传一遍文件——直接上抛（bug 1）
                    log::warn!(
                        target: "ds_core::accounts",
                        "req={} 上游拒绝请求，停止重试: {}", request_id, e
                    );
                    return Err(e);
                }
                Err(e) => {
                    log::warn!(
                        target: "ds_core::accounts",
                        "req={} 请求失败 (attempt {}/{}): {}",
                        request_id, attempt + 1, MAX_ATTEMPTS, e
                    );
                    if attempt + 1 >= MAX_ATTEMPTS {
                        return Err(e);
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                }
            }
        }
        Err(CoreError::Overloaded)
    }

    /// 会话复用路径：同一账号的持久会话上续聊（Append）或编辑重答（Regenerate）
    async fn v0_chat_reuse(
        &self,
        req: &ChatRequest,
        plan: &ConversationPlan,
        target: &ReuseTarget,
        request_id: &str,
    ) -> Result<ChatResponse, CoreError> {
        // 1. 取创建会话的同一账号；忙则短等（应用侧发送是串行的，忙多为抖动）
        let guard = {
            let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(5000);
            loop {
                if let Some(g) = self.pool.get_account_by_id(&target.account_id) {
                    break g;
                }
                if self.pool.is_empty() {
                    return Err(CoreError::NoAccounts);
                }
                if let Some(notice) = self.pool.account_mute_notice(&target.account_id) {
                    return Err(CoreError::Rejected(notice));
                }
                if self.pool.account_quota_exhausted(&target.account_id) {
                    return Err(CoreError::RateLimited(
                        "当前账号已达到本地最近一小时请求上限，请等待配额恢复".into(),
                    ));
                }
                // 目标账号正在限流退避：这里必须直接报限制，而不是等到超时后
                // 降级冷启动——冷启动会换账号新建 session，等于用户每点一次重试
                // 就多一轮上游请求，正是"限流升级成禁言"的路径（bug 1）。
                let cooldown = self.pool.account_cooldown_remaining(&target.account_id);
                if cooldown > 0 {
                    log::warn!(
                        target: "ds_core::accounts",
                        "req={} 会话账号 {} 在限流退避中（剩余 {}s），不降级冷启动",
                        request_id, target.account_id, cooldown
                    );
                    return Err(CoreError::RateLimited(format!(
                        "上游限流中，请 {} 秒后再试（当前继续发送会被判定为异常客户端并可能被禁言）",
                        cooldown
                    )));
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(CoreError::Overloaded);
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            }
        };
        let account = guard.account();
        let account_id = account.display_id().to_string();
        let token = account.token().to_string();

        let client = self.client.read().await.clone();
        log::debug!(
            target: "ds_core::accounts",
            "req={} 会话复用: session={}, account={}, regenerate={}",
            request_id, target.session_id, account_id, plan.regenerate
        );

        // 2. 本轮新文件先上传到同一会话（编辑重答走 edit_message，不支持带文件）
        let mut ref_file_ids: Vec<String> = Vec::new();
        for file in &req.files {
            let fid = self
                .upload_and_poll(
                    &token,
                    &file.filename,
                    &file.content_type,
                    &file.content,
                    request_id,
                    &req.model_type,
                    req.thinking_enabled,
                )
                .await?;
            ref_file_ids.push(fid);
        }

        // 3. PoW + 发起请求（Append 用 completion，Regenerate 用 edit_message）
        let pow_target = if plan.regenerate {
            "/api/v0/chat/edit_message"
        } else {
            "/api/v0/chat/completion"
        };
        let pow_header = self.compute_pow_for_target(&token, pow_target).await?;

        let mut raw_stream = if plan.regenerate {
            let payload = EditMessagePayload {
                chat_session_id: target.session_id.clone(),
                message_id: target.last_request_msg_id,
                prompt: req.prompt.clone(),
                search_enabled: req.search_enabled,
                thinking_enabled: req.thinking_enabled,
                model_type: None,
            };
            client
                .edit_message(&token, &pow_header, &payload)
                .await
                .map_err(|e| {
                    self.pool.mark_error(&account_id);
                    CoreError::from(e)
                })?
        } else {
            let payload = CompletionPayload {
                chat_session_id: target.session_id.clone(),
                parent_message_id: Some(target.last_response_msg_id),
                action: None,
                model_type: req.model_type.clone(),
                prompt: req.prompt.clone(),
                ref_file_ids,
                thinking_enabled: req.thinking_enabled,
                search_enabled: req.search_enabled,
                preempt: false,
            };
            client
                .completion(&token, &pow_header, &payload)
                .await
                .map_err(|e| {
                    self.pool.mark_error(&account_id);
                    CoreError::from(e)
                })?
        };

        // 4. 收集前两个事件（ready + hint），并回写缓存锚点
        let mut buf = Vec::new();
        let mut text_buf = String::new();
        let (ready_block, second_block) = loop {
            let chunk = raw_stream
                .next()
                .await
                .ok_or_else(|| {
                    let raw = String::from_utf8_lossy(&buf);
                    log::error!(
                        target: "ds_core::accounts",
                        "req={} 复用空 SSE 流, 已收到 {} 字节: {}", request_id, buf.len(), raw
                    );
                    // 残留字节里可能就是禁言提示（禁言账号常只下发 hint 即断流）；
                    // 登录时已记录 mute_until，能给出精确到期时间
                    if let Some(notice) = extract_mute_notice(&buf) {
                        self.pool.mark_muted(&account_id, extract_mute_until(&buf));
                        let mute_until = account.mute_until();
                        // 禁言 → Rejected（不重试、不做换号重发）：每次重试都要
                        // 新建 session 再撞一次上游，是延迟封号后的请求放大器（bug 2）。
                        let msg = if mute_until > 0 {
                            format!(
                                "账号已被禁言至 {}（user is muted），到期前请更换账号或等待解禁",
                                format_mute_time(mute_until)
                            )
                        } else {
                            format!("账号已被禁言（user is muted）：{}", notice)
                        };
                        return CoreError::Rejected(msg);
                    }
                    if buf.is_empty() {
                        self.pool.mark_error(&account_id);
                        let mute_until = account.mute_until();
                        if mute_until > 0 {
                            return CoreError::Rejected(format!(
                                "账号已被禁言至 {}（user is muted），到期前请更换账号或等待解禁",
                                format_mute_time(mute_until)
                            ));
                        }
                        CoreError::Rejected(
                            "服务端未返回任何数据，当前账号可能已被限制或禁言；请更换账号".to_string(),
                        )
                    } else {
                        CoreError::Stream(format!("空 SSE 流 (已收到 {} 字节)", buf.len()))
                    }
                })?
                .map_err(|e| CoreError::Stream(e.to_string()))?;
            buf.extend_from_slice(&chunk);
            text_buf.push_str(&String::from_utf8_lossy(&chunk));
            if let Some((first, second)) = split_two_events(&text_buf) {
                break (first.to_owned(), second.to_owned());
            }
        };

        let (req_msg_id, stop_id) = parse_ready_message_ids(ready_block.as_bytes());

        if let Some((hint_block, err)) = initial_hint_error(&ready_block, &second_block) {
            if matches!(err, CoreError::RateLimited(_)) {
                // 同上（冷路径）：限流让账号退避，不标记 Error、不触发重登
                let secs = self.pool.mark_rate_limited(&account_id);
                log::warn!(
                    target: "ds_core::accounts",
                    "req={} 复用请求限流，账号退避 {}s", request_id, secs
                );
            } else if err.to_string().contains("禁言") {
                self.pool.mark_muted(&account_id, extract_mute_until(hint_block.as_bytes()));
                // 登录时记录了 mute_until，把精确到期时间补进提示
                // （复用路径为持久会话：禁言不使其失效，无需 delete）
                if account.mute_until() > 0 {
                    let enriched = CoreError::Rejected(format!(
                        "禁言提示：账号已被禁言至 {}（user_is_muted），到期前请更换账号",
                        format_mute_time(account.mute_until())
                    ));
                    log::warn!(target: "ds_core::accounts", "req={} 复用请求禁言: {}", request_id, enriched);
                    return Err(enriched);
                }
            }
            log::warn!(
                target: "ds_core::accounts",
                "req={} 复用请求 hint 错误: {:?}", request_id, err
            );
            return Err(err);
        }

        // 5. 回写缓存（新锚点 + 本轮用户文本；查找键 + 下一轮键双写）
        let entry = CachedConversation {
            account_id: account_id.clone(),
            session_id: target.session_id.clone(),
            last_request_msg_id: req_msg_id,
            last_response_msg_id: stop_id,
            last_user_text: plan.user_text.clone(),
            model_type: req.model_type.clone(),
            last_used_ms: now_ms_u64(),
        };
        self.insert_conversation_multi(
            vec![plan.cache_key.clone(), plan.next_key.clone()],
            entry,
        );

        // 6. 重建流；持久会话：GuardedStream 只 stop_stream，不 delete
        let stream =
            futures::stream::once(futures::future::ready(Ok(Bytes::from(buf)))).chain(raw_stream);

        Ok(ChatResponse {
            stream: Box::pin(GuardedStream::new(
                Box::pin(stream),
                guard,
                client.clone(),
                token,
                target.session_id.clone(),
                stop_id,
                true,
                self.active_sessions.clone(),
            )),
            account_id,
            session_id: target.session_id.clone(),
            persistent: true,
        })
    }

    /// 单次请求尝试（不含重试逻辑）
    async fn v0_chat_once(
        &self,
        req: &ChatRequest,
        inline_prompt: &str,
        history_content: &str,
        request_id: &str,
        first_try: bool,
    ) -> Result<ChatResponse, CoreError> {
        // 1. 获取空闲账号（首次等待 30s，重试不等待立即换号）
        let guard = if first_try {
            self.pool.get_account_with_wait(30_000).await
        } else {
            self.pool.get_account()
        }
        .ok_or_else(|| {
            // 账号池为空（未配置账号）与"都在忙/不健康"是不同语义，分开报错
            if self.pool.is_empty() {
                log::warn!(
                    target: "ds_core::accounts",
                    "req={} 账号池为空（未配置账号）", request_id
                );
                CoreError::NoAccounts
            } else if self.pool.all_in_cooldown() {
                // 全部账号都在限流退避中：这是"上游在限你"，不是"账号不够用"。
                // 报 RateLimited 让上层与应用侧停止重试，等退避窗口过去（bug 1）。
                let secs = self.pool.max_cooldown_remaining();
                log::warn!(
                    target: "ds_core::accounts",
                    "req={} 所有账号均在限流退避中，剩余最长 {}s", request_id, secs
                );
                CoreError::RateLimited(format!(
                    "上游限流中，请 {} 秒后再试（当前继续发送会被判定为异常客户端并可能被禁言）",
                    secs
                ))
            } else {
                log::warn!(
                    target: "ds_core::accounts",
                    "req={} 账号池无可用账号", request_id
                );
                CoreError::Overloaded
            }
        })?;

        let account = guard.account();
        let account_id = account.display_id().to_string();
        let token = account.token().to_string();

        log::debug!(
            target: "ds_core::accounts",
            "req={} 分配账号: model_type={}, account={}",
            request_id, req.model_type, account_id
        );

        let client = self.client.read().await.clone();
        // 3. 创建临时 session；随后立即构造 SessionGuard 兜底清理（任何错误路径自动 delete）
        let session_id = match client.create_session(&token).await {
            Ok(id) => id,
            Err(e) => {
                // 认证/网络错误 → 标记账号 Error
                self.pool.mark_error(&account_id);
                return Err(e.into());
            }
        };
        let mut session_guard = SessionGuard::new(client.clone(), token.clone(), session_id.clone());
        log::debug!(
            target: "ds_core::accounts",
            "req={} 创建 session: id={}", request_id, session_id
        );
        // 人速抖动（风控差异 #7）：官方前端从建会话到发 completion 之间有
        // 秒级人类间隔（输入/渲染），我们机器速连发。每步间随机 300-1200ms。
        tokio::time::sleep(tokio::time::Duration::from_millis(human_delay_ms())).await;

        // 4. 上传文件：先历史文件，再外部文件（对话阅读顺序）
        let mut ref_file_ids: Vec<String> = Vec::new();
        // 历史文件上传失败时退回到完整 prompt 内联发送
        let mut history_upload_failed = false;

        if !history_content.is_empty() {
            match self
                .upload_and_poll(
                    &token,
                    SESSION_HISTORY_FILE,
                    "text/plain",
                    history_content.as_bytes(),
                    request_id,
                    &req.model_type,
                    req.thinking_enabled,
                )
                .await
            {
                Ok(file_id) => ref_file_ids.push(file_id),
                Err(e) => {
                    let msg = e.to_string();
                    // 上传接口对禁言账号返回 biz_code=14（biz_data 是 mute 信息、
                    // 无文件 id）：标记账号并立即失败，别退回内联发送打同一账号
                    if msg.contains("user is muted") {
                        let until = extract_mute_until(msg.as_bytes()).unwrap_or(0);
                        self.pool.mark_muted(&account_id, (until > 0).then_some(until));
                        log::warn!(
                            target: "ds_core::accounts",
                            "req={} 历史文件上传时发现账号被禁言（until={:?}）", request_id, until
                        );
                        return Err(upload_mute_rejected(until));
                    }
                    log::warn!(
                        target: "ds_core::accounts",
                        "req={} 历史文件上传失败，退回内联发送: {}", request_id, e
                    );
                    history_upload_failed = true;
                }
            }
        }

        for file in &req.files {
            match self
                .upload_and_poll(
                    &token,
                    &file.filename,
                    &file.content_type,
                    &file.content,
                    request_id,
                    &req.model_type,
                    req.thinking_enabled,
                )
                .await
            {
                Ok(file_id) => ref_file_ids.push(file_id),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("user is muted") {
                        let until = extract_mute_until(msg.as_bytes()).unwrap_or(0);
                        self.pool.mark_muted(&account_id, (until > 0).then_some(until));
                        log::warn!(
                            target: "ds_core::accounts",
                            "req={} 外部文件上传时发现账号被禁言（until={:?}）", request_id, until
                        );
                        return Err(upload_mute_rejected(until));
                    }
                    log::warn!(
                        target: "ds_core::accounts",
                        "req={} 外部文件上传失败 ({}): {}", request_id, file.filename, e
                    );
                    return Err(CoreError::ProviderError(format!(
                        "外部文件上传失败 ({}): {}",
                        file.filename, e
                    )));
                }
            }
        }

        // 5. 计算 PoW（completion 专用）
        let pow_header = match self
            .compute_pow_for_target(&token, "/api/v0/chat/completion")
            .await
        {
            Ok(h) => h,
            Err(e) => {
                self.pool.mark_error(&account_id);
                return Err(e);
            }
        };
        log::debug!(
            target: "ds_core::accounts",
            "req={} completion PoW 计算完成", request_id
        );

        // 6. 发起 completion。
        // 历史文件上传失败时，绝不回退为完整 ChatML prompt 内联发送：多轮
        // <｜end▁of▁sentence｜>/<｜User｜>/<｜Assistant｜> 原生标签的整段重放不是
        // Web 端的请求形态（Web 端历史在服务端），是风控判定协议重放的封号特征。
        // 安全降级：历史脱敏为纯文本角色标记（[用户]/[助手]）+ 长度截断，
        // 拼接在 inline prompt 前；当前轮次保持原生标签（与 Web 单轮形态一致）。
        let completion_prompt: String = if history_upload_failed {
            let history_plain = sanitize_history_inline(history_content);
            log::warn!(
                target: "ds_core::accounts",
                "req={} 历史上传失败，降级为脱敏纯文本历史（len={}）内联，不回传原生标签",
                request_id,
                history_plain.len()
            );
            format!("{}{}", history_plain, inline_prompt)
        } else {
            inline_prompt.to_string()
        };

        log::trace!(
            target: "ds_core::accounts",
            "req={} completion 请求: ref_file_ids={:?}, history_fallback={}, prompt=\n{}\n---历史文件内容---\n{}",
            request_id, ref_file_ids, history_upload_failed, completion_prompt, history_content
        );

        let payload = CompletionPayload {
            chat_session_id: session_id.clone(),
            parent_message_id: None,
            action: None,
            model_type: req.model_type.clone(),
            prompt: completion_prompt,
            ref_file_ids,
            thinking_enabled: req.thinking_enabled,
            search_enabled: req.search_enabled,
            preempt: false,
        };

        let mut raw_stream = match client.completion(&token, &pow_header, &payload).await {
            Ok(s) => s,
            Err(e) => {
                self.pool.mark_error(&account_id);
                return Err(e.into());
            }
        };

        // 7. 收集字节直到拿到前两个 SSE 事件（ready + hint/update_session）
        let mut buf = Vec::new();
        let mut text_buf = String::new();
        let (ready_block, second_block) = loop {
            let chunk = raw_stream
                .next()
                .await
                .ok_or_else(|| {
                    let raw = String::from_utf8_lossy(&buf);
                    log::error!(
                        target: "ds_core::accounts",
                        "req={} 空 SSE 流, 已收到 {} 字节: {}", request_id, buf.len(), raw
                    );
                    // 残留字节里可能就是禁言提示（禁言账号常只下发 hint 即断流）；
                    // 登录时已记录 mute_until，能给出精确到期时间
                    if let Some(notice) = extract_mute_notice(&buf) {
                        self.pool.mark_muted(&account_id, extract_mute_until(&buf));
                        let mute_until = account.mute_until();
                        // 禁言 → Rejected（不重试，bug 2 放大器修复）
                        let msg = if mute_until > 0 {
                            format!(
                                "账号已被禁言至 {}（user is muted），到期前请更换账号或等待解禁",
                                format_mute_time(mute_until)
                            )
                        } else {
                            format!("账号已被禁言（user is muted）：{}", notice)
                        };
                        return CoreError::Rejected(msg);
                    }
                    // 零字节空流绝大多数是账号被限制/禁言/登录态失效（非网络抖动），
                    // 标记 Error 触发换号重试，并把可能原因写进错误消息直达用户。
                    if buf.is_empty() {
                        self.pool.mark_error(&account_id);
                        let mute_until = account.mute_until();
                        if mute_until > 0 {
                            return CoreError::Rejected(format!(
                                "账号已被禁言至 {}（user is muted），到期前请更换账号或等待解禁",
                                format_mute_time(mute_until)
                            ));
                        }
                        CoreError::Rejected(
                            "服务端未返回任何数据，当前账号可能已被限制或禁言；请更换账号".to_string(),
                        )
                    } else {
                        CoreError::Stream(format!("空 SSE 流 (已收到 {} 字节)", buf.len()))
                    }
                })?
                .map_err(|e| CoreError::Stream(e.to_string()))?;
            log::trace!(
                target: "ds_core::accounts",
                "req={} <<< ({} bytes) {}", request_id, chunk.len(), String::from_utf8_lossy(&chunk)
            );
            buf.extend_from_slice(&chunk);
            text_buf.push_str(&String::from_utf8_lossy(&chunk));

            if let Some((first, second)) = split_two_events(&text_buf) {
                break (first.to_owned(), second.to_owned());
            }
        };

        let (req_msg_id, stop_id) = parse_ready_message_ids(ready_block.as_bytes());

        // 8. 检查 hint 事件（rate_limit / input_exceeds_limit）
        if let Some((hint_block, err)) = initial_hint_error(&ready_block, &second_block) {
            if matches!(err, CoreError::RateLimited(_)) {
                // 限流**不是**账号故障：标记 Error 会让后台恢复任务 5 分钟后去重新登录，
                // 而重登本身也是上游请求；用户继续点发送时又会新建 session 再撞一次——
                // 这两股流量叠加正是账号被禁言的直接原因（bug 1）。
                // 这里改为"让账号退避一段时间"：不重登、不再分配，等窗口自己过去。
                let secs = self.pool.mark_rate_limited(&account_id);
                log::warn!(
                    target: "ds_core::accounts",
                    "req={} hint 限流: rate_limit_reached，账号退避 {}s", request_id, secs
                );
            } else if err.to_string().contains("禁言") {
                // 保留明确的账号限制，不换号重试本次请求。
                self.pool.mark_muted(&account_id, extract_mute_until(hint_block.as_bytes()));
                // 同步本次响应的 mute_until，把精确到期时间补进提示
                if account.mute_until() > 0 {
                    let enriched = CoreError::Rejected(format!(
                        "禁言提示：账号已被禁言至 {}（user_is_muted），到期前请更换账号",
                        format_mute_time(account.mute_until())
                    ));
                    log::warn!(target: "ds_core::accounts", "req={} hint 禁言: {}", request_id, enriched);
                    let _ = client.delete_session(&token, &session_id).await;
                    session_guard.disarm();
                    return Err(enriched);
                }
            } else {
                let hint_detail = second_block
                    .lines()
                    .find_map(|l| l.strip_prefix("data: "))
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
                    .and_then(|v| {
                        v.get("content")
                            .or(v.get("finish_reason"))
                            .and_then(|c| c.as_str().map(String::from))
                    })
                    .unwrap_or_else(|| "(unknown)".into());
                log::warn!(
                    target: "ds_core::accounts",
                    "req={} hint 错误: {}", request_id, hint_detail
                );
            }
            let _ = client.delete_session(&token, &session_id).await;
            log::debug!(
                target: "ds_core::accounts",
                "req={} hint 后清理 session: id={}", request_id, session_id
            );
            // 已同步清理，解除 SessionGuard 兜底，避免重复 delete
            session_guard.disarm();
            return Err(err);
        }

        log::debug!(
            target: "ds_core::accounts",
            "req={} SSE ready: resp_msg={}", request_id, stop_id
        );

        // 9. 注册活跃 session（含 message_id 用于 stop_stream）
        {
            let mut map = self.active_sessions.lock().unwrap();
            map.insert(
                session_id.clone(),
                ActiveSession {
                    token: token.clone(),
                    session_id: session_id.clone(),
                    message_id: stop_id,
                },
            );
        }

        // 10. 用原始 buf 重建流（包含已消耗的 chunk）
        let stream =
            futures::stream::once(futures::future::ready(Ok(Bytes::from(buf)))).chain(raw_stream);

        // 持久会话：冷启动命中缓存计划时，会话保留（历史由服务端持有），由缓存管理生命周期
        let persistent = req.conversation.is_some();
        if let Some(plan) = &req.conversation {
            let entry = CachedConversation {
                account_id: account_id.clone(),
                session_id: session_id.clone(),
                last_request_msg_id: req_msg_id,
                last_response_msg_id: stop_id,
                last_user_text: plan.user_text.clone(),
                model_type: req.model_type.clone(),
                last_used_ms: now_ms_u64(),
            };
            self.insert_conversation_multi(
                vec![plan.cache_key.clone(), plan.next_key.clone()],
                entry,
            );
            log::debug!(
                target: "ds_core::accounts",
                "req={} 持久会话已缓存: key={}..., session={}",
                request_id,
                &plan.cache_key[..plan.cache_key.len().min(12)],
                session_id
            );
        }

        // 成功移交 GuardedStream：解除 SessionGuard 清理责任，收尾交给 GuardedStream（stop_stream + delete_session）
        session_guard.disarm();

        Ok(ChatResponse {
            // 外层再包读空闲超时：连接半开时不会永远 Pending
            stream: Box::pin(IdleTimeoutStream {
                inner: Box::pin(GuardedStream::new(
                    Box::pin(stream),
                    guard,
                    client.clone(),
                    token,
                    session_id.clone(),
                    stop_id,
                    persistent,
                    self.active_sessions.clone(),
                )),
                idle: SSE_IDLE_TIMEOUT,
                deadline: None,
            }),
            account_id,
            session_id,
            persistent,
        })
    }

    async fn compute_pow_for_target(
        &self,
        token: &str,
        target_path: &str,
    ) -> Result<String, CoreError> {
        let challenge_data = self
            .client
            .read()
            .await
            .create_pow_challenge(token, target_path)
            .await?;
        let result = self
            .solver
            .read()
            .await
            .solve(&challenge_data)
            .map_err(|e| {
                log::warn!(target: "ds_core::accounts", "PoW 计算失败: {}", e);
                CoreError::ProofOfWorkFailed(e)
            })?;
        Ok(result.to_header())
    }

    /// 上传文件并轮询直到 SUCCESS 或超时
    ///
    /// `model_type` / `thinking_enabled` 只用于填 web 端实抓的
    /// `x-model-type` / `x-thinking-enabled` 请求头，不影响上传语义。
    async fn upload_and_poll(
        &self,
        token: &str,
        filename: &str,
        content_type: &str,
        content: &[u8],
        request_id: &str,
        model_type: &str,
        thinking_enabled: bool,
    ) -> Result<String, CoreError> {
        let pow_header = self
            .compute_pow_for_target(token, "/api/v0/file/upload_file")
            .await?;

        let upload_data = self
            .client
            .read()
            .await
            .upload_file(
                token,
                &pow_header,
                filename,
                content_type,
                content.to_vec(),
                model_type,
                thinking_enabled,
            )
            .await?;
        let file_id = upload_data.id;

        for _ in 0..UPLOAD_POLL_MAX_RETRIES {
            let fetch_data = self
                .client
                .read()
                .await
                .fetch_files(token, std::slice::from_ref(&file_id))
                .await?;
            if let Some(file) = fetch_data.files.first() {
                match file.status.as_str() {
                    "SUCCESS" => {
                        log::debug!(
                            target: "ds_core::accounts",
                            "req={} 文件上传成功: file_id={}, tokens={:?}, name={}",
                            request_id, file_id, file.token_usage, file.file_name
                        );
                        return Ok(file_id);
                    }
                    "FAILED" => {
                        return Err(CoreError::ProviderError(format!(
                            "文件上传失败: {}",
                            file.file_name
                        )));
                    }
                    _ => {} // PENDING，继续轮询
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(UPLOAD_POLL_INTERVAL_MS)).await;
        }
        Err(CoreError::ProviderError("文件处理超时".into()))
    }

    pub fn account_statuses(&self) -> Vec<crate::ds_core::accounts::AccountStatus> {
        self.pool.account_statuses()
    }

    /// 获取账号池状态
    pub async fn get_pool_status(&self) -> crate::openai_adapter::AccountPoolStatus {
        self.pool.get_pool_status().await
    }

    /// 动态添加账号
    pub async fn add_account(
        &self,
        creds: &crate::config::Account,
    ) -> Result<String, crate::ds_core::accounts::PoolError> {
        let client_guard = self.client.read().await;
        let solver_guard = self.solver.read().await;
        self.pool
            .add_account(creds, &client_guard, &solver_guard)
            .await
    }

    /// 动态移除账号
    pub async fn remove_account(
        &self,
        email_or_mobile: &str,
    ) -> Result<String, crate::ds_core::accounts::PoolError> {
        self.pool.remove_account(email_or_mobile).await
    }

    /// 拉取云端会话列表（#10 同步已有对话）：从号池取一个空闲账号的 token
    /// 调 fetch_page 并按 has_more 游标翻页（每页服务端封顶，实测 99 条/页）。
    /// 以会话 id 去重防止游标参数失效时重复/死循环；单次同步最多 10 页。
    pub async fn list_cloud_sessions(
        &self,
    ) -> Result<Vec<crate::ds_core::client::CloudSession>, CoreError> {
        let guard = self
            .pool
            .get_account()
            .ok_or_else(|| {
                if self.pool.is_empty() {
                    CoreError::NoAccounts
                } else {
                    CoreError::Overloaded
                }
            })?;
        let token = guard.account().token().to_string();
        let client = self.client.read().await.clone();
        let mut all: Vec<crate::ds_core::client::CloudSession> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut cursor: Option<f64> = None;
        let mut pages = 0;
        loop {
            let page = client
                .fetch_session_page(&token, cursor)
                .await
                .map_err(CoreError::from)?;
            let mut progressed = false;
            for s in page.sessions {
                if seen.insert(s.id.clone()) {
                    // 列表按 updated_at 降序，最后一个 id 的 updated_at 即下一页游标
                    cursor = Some(s.updated_at);
                    progressed = true;
                    all.push(s);
                }
            }
            pages += 1;
            if !page.has_more || !progressed || pages >= 10 {
                if pages > 1 {
                    log::info!(
                        target: "ds_core::accounts",
                        "云端会话分页完成: {} 条 / {} 页", all.len(), pages
                    );
                }
                break;
            }
        }
        drop(guard);
        Ok(all)
    }

    /// 拉取云端会话的消息内容（#10 完整同步；与列表相同，无需 PoW）
    pub async fn list_cloud_session_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<crate::ds_core::client::CloudMessage>, CoreError> {
        let guard = self
            .pool
            .get_account()
            .ok_or_else(|| {
                if self.pool.is_empty() {
                    CoreError::NoAccounts
                } else {
                    CoreError::Overloaded
                }
            })?;
        let token = guard.account().token().to_string();
        let client = self.client.read().await.clone();
        let messages = client
            .fetch_session_messages(&token, session_id)
            .await
            .map_err(CoreError::from)?;
        drop(guard);
        Ok(messages)
    }

    /// 删除云端会话（本地删除对话时同步调用，bug 3）。
    ///
    /// 依次用每个空闲账号尝试：会话是**账号作用域**的，应用侧记录的 cloudId
    /// 未必属于当前空闲的那个账号（多账号池下账号轮换过）。逐个试到成功为止，
    /// 全部失败才报错——这样"删了本地、云端还在，下次同步又冒出来"不再发生。
    ///
    /// 返回实际删除所用的账号 id。
    pub async fn delete_cloud_session(&self, session_id: &str) -> Result<String, CoreError> {
        if self.pool.is_empty() {
            return Err(CoreError::NoAccounts);
        }
        // 先清掉本地复用缓存里指向这个会话的条目（避免下次续聊撞到已删除会话）
        self.conversations
            .lock()
            .unwrap()
            .retain(|_, v| v.session_id != session_id);

        let client = self.client.read().await.clone();
        let mut tried = 0usize;
        let mut last_err: Option<CoreError> = None;
        // 上游尝试上限（bug 2 延迟封号缓解）：删除是"本地删了顺手同步"的操作，
        // 不值得为它把整个账号池都打一遍（多账号机器一次删除 = 全池上游请求）。
        const MAX_DELETE_ATTEMPTS: usize = 3;

        for _ in 0..self.pool.account_count().min(MAX_DELETE_ATTEMPTS) {
            let Some(guard) = self.pool.get_account() else {
                break;
            };
            let account_id = guard.account().display_id().to_string();
            let token = guard.account().token().to_string();
            tried += 1;
            match client.delete_session(&token, session_id).await {
                Ok(()) => {
                    log::info!(
                        target: "ds_core::accounts",
                        "云端会话已删除: id={} account={}", session_id, account_id
                    );
                    return Ok(account_id);
                }
                Err(e) => {
                    log::warn!(
                        target: "ds_core::accounts",
                        "账号 {} 删除云端会话失败（换账号重试）: {}", account_id, e
                    );
                    last_err = Some(CoreError::from(e));
                }
            }
        }
        if tried == 0 {
            return Err(CoreError::Overloaded);
        }
        // 所有账号都失败：把最后一次错误抛出（多为会话不属于任何账号 / 已删除）
        Err(last_err.unwrap_or_else(|| CoreError::ProviderError("删除云端会话失败".into())))
    }

    /// 标记账号为 Error 状态
    pub fn mark_error(&self, email_or_mobile: &str) {
        self.pool.mark_error(email_or_mobile)
    }

    /// 手动重新登录指定账号
    pub async fn re_login_single(&self, email_or_mobile: &str) -> Result<(), String> {
        self.pool.re_login_single(email_or_mobile).await
    }

    /// 优雅关闭：清理所有残留的活跃 session
    pub async fn shutdown(&self) {
        let client = self.client.read().await.clone();
        let sessions = {
            let mut map = self.active_sessions.lock().unwrap();
            std::mem::take(&mut *map)
        };

        if sessions.is_empty() {
            self.pool.shutdown(&client).await;
            return;
        }

        log::info!(
            target: "ds_core::accounts",
            "shutdown: 清理 {} 个残留 session", sessions.len()
        );

        use futures::future::join_all;
        let futures: Vec<_> = sessions
            .into_values()
            .map(|s| {
                let client = client.clone();
                async move {
                    let payload = StopStreamPayload {
                        chat_session_id: s.session_id.clone(),
                        message_id: s.message_id,
                    };
                    let _ = client.stop_stream(&s.token, &payload).await;
                    let _ = client
                        .delete_session(&s.token, &s.session_id)
                        .await
                        .inspect_err(|e| {
                            log::warn!(
                                target: "ds_core::accounts",
                                "shutdown 清理 session {} 失败: {}",
                                s.session_id, e
                            );
                        });
                }
            })
            .collect();
        join_all(futures).await;

        self.pool.shutdown(&client).await;
    }

    pub async fn reload_config(&self, config: &Config) -> Result<(), CoreError> {
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
            crate::ds_core::client::preloaded_cookies_from_accounts(&config.accounts),
            config.deepseek.hif_leim.clone(),
            config.deepseek.hif_dliq.clone(),
            config.deepseek.hif_auto_fetch,
        );
        let wasm_bytes = client.get_wasm().await?;
        let solver = PowSolver::new(&wasm_bytes)?;

        self.pool
            .set_client_solver(client.clone(), solver.clone())
            .await;
        *self.client.write().await = client;
        *self.solver.write().await = solver;
        Ok(())
    }
}

// ── ChatML 解析与历史拆分 ──────────────────────────────────────────────

struct ChatBlock {
    role: String,
    content: String,
}

fn role_tag(role: &str) -> String {
    let mut r = role.to_string();
    if let Some(c) = r.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    format!("<｜{}｜>", r)
}

/// 解析 DeepSeek 原生标签格式的 prompt 为结构化块
///
/// 格式: `<｜Role｜>content\n`（无闭合标签），内容截止到下一个 `<｜` 或字符串末尾。
fn parse_native_blocks(prompt: &str) -> Vec<ChatBlock> {
    let mut blocks = Vec::new();
    let mut pos = 0;
    while let Some(start_idx) = prompt[pos..].find(TAG_START) {
        let abs_start = pos + start_idx;
        let role_start = abs_start + TAG_START.len();
        let role_end = match prompt[role_start..].find(TAG_END) {
            Some(i) => role_start + i,
            None => break,
        };
        let role = prompt[role_start..role_end].trim().to_lowercase();
        let content_start = role_end + TAG_END.len();
        let content_end = match prompt[content_start..].find(TAG_START) {
            Some(i) => content_start + i,
            None => prompt.len(),
        };
        let content = prompt[content_start..content_end]
            .trim_end_matches('\n')
            .to_string();
        blocks.push(ChatBlock { role, content });
        pos = content_end;
    }
    blocks
}

/// 拆分 prompt 为 inline_prompt 和 history_content
///
/// 优先策略：找到最后一个带 `<think>` 的 `<｜Assistant｜>` 块，
/// - inline = 仅该 assistant+think 块（包含工具提醒等）
/// - history = 其余所有块，包装为 [file content end] … [file content begin] 格式上传
///
/// 无 think 块时（如无工具定义的简单对话），退回到原来基于 user/tool 的切分：
/// - inline = 最后一个 user/tool 块 → 末尾
/// - history = 其余块
fn split_history_prompt(prompt: &str) -> (String, String) {
    let blocks = parse_native_blocks(prompt);

    // 优先：找最后一个带 <think> 的 assistant 块，只保留该块 inline
    if let Some(think_idx) = blocks
        .iter()
        .rposition(|b| b.role == "assistant" && b.content.contains("<think>"))
    {
        let mut inline = String::new();
        inline.push_str(&role_tag(&blocks[think_idx].role));
        inline.push_str(&blocks[think_idx].content);
        inline.push('\n');

        let mut history = String::new();
        history.push_str("[file content end]\n\n");
        for block in &blocks[..think_idx] {
            history.push_str(&role_tag(&block.role));
            history.push_str(&block.content);
            history.push('\n');
        }
        history.push_str("[file name]: IGNORE\n[file content begin]\n");

        return (inline, history);
    }

    // 无 think 块 → 原来基于 user/tool 的切分
    let split_idx = match blocks
        .iter()
        .rposition(|b| b.role == "user" || b.role == "tool")
    {
        Some(i) if i > 0 => i,
        _ => return (prompt.to_string(), String::new()),
    };

    let mut inline = String::new();
    for block in &blocks[split_idx..] {
        inline.push_str(&role_tag(&block.role));
        inline.push_str(&block.content);
        inline.push('\n');
    }

    let mut history = String::new();
    history.push_str("[file content end]\n\n");
    for block in &blocks[..split_idx] {
        history.push_str(&role_tag(&block.role));
        history.push_str(&block.content);
        history.push('\n');
    }
    history.push_str("[file name]: IGNORE\n[file content begin]\n");

    (inline, history)
}

/// 历史上传失败时的安全降级：把待上传的历史脱敏为纯文本对话回顾。
/// 关键约束：历史部分不允许出现任何 `<｜...｜>` 原生协议标签（含 tool 包装标签），
/// 多轮原生标签整段内联会被风控判定为协议重放，实测稳定触发封号/禁言。
/// 同时限制长度：应用侧 max_input_tokens 通常仅 4096，超长会 input_exceeds_limit。
fn sanitize_history_inline(history_content: &str) -> String {
    const MAX_CHARS: usize = 3000;

    let header = "以下是基于此前对话历史的简要回顾（仅供参考）：\n";
    let footer = "以上是历史回顾，请结合它回答接下来的问题。\n\n";

    let stripped = history_content
        .replace("[file content end]", "")
        .replace("[file name]: IGNORE", "")
        .replace("[file content begin]", "");

    let mut body = String::new();
    for block in parse_native_blocks(stripped.trim()) {
        if block.content.trim().is_empty() {
            continue;
        }
        let label = match block.role.as_str() {
            "user" => "用户",
            "assistant" => "助手",
            "system" => "系统设定",
            "tool" => "工具结果",
            other => other,
        };
        body.push('[');
        body.push_str(label);
        body.push_str("] ");
        body.push_str(strip_native_tags(&block.content).trim());
        body.push('\n');
    }

    let mut out = format!("{}{}{}", header, body, footer);
    let char_count = out.chars().count();
    if char_count > MAX_CHARS {
        // 保留尾部（更接近当前问题），并从截断后第一个换行起，避免切半个词
        let keep_from = char_count - MAX_CHARS;
        let tail: String = out.chars().skip(keep_from).collect();
        let start = tail.find('\n').map(|i| i + 1).unwrap_or(0);
        out = format!("（更早的历史已省略）\n{}", &tail[start..]);
    }
    out
}

/// 移除字符串中残留的 `<｜...｜>` 原生标签（不成对时移除起始标记及其后内容到字符串尾）
fn strip_native_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(TAG_START) {
        out.push_str(&rest[..i]);
        match rest[i + TAG_START.len()..].find(TAG_END) {
            Some(j) => rest = &rest[i + TAG_START.len() + j + TAG_END.len()..],
            None => {
                // 未闭合：丢弃剩余全部，防止半截标签泄入 prompt
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

// ── SSE 解析辅助 ──────────────────────────────────────────────────────

fn now_ms_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 从原始 SSE 字节中提取禁言提示。
/// 实测两种形态：
/// 1. 中文原文（若服务端下发）："由于违反用户使用规范，你的账号已被禁言至 2026 年 9 月 9 日 14:44…"——含到期时间，优先；
/// 2. 含糊错误码 `user_is_muted`（网页端据此渲染禁言弹窗）——转换为可读提示。
/// 禁言账号的 completion 可能只下发一条 hint 即关闭流（应用侧表现为"空 SSE 流"），
/// 提示就在残留字节里——提取出来直达用户，替代笼统的空流报错。
fn extract_mute_notice(raw: &[u8]) -> Option<String> {
    parse_mute_response(raw).map(|(notice, _)| notice)
}

fn extract_mute_until(raw: &[u8]) -> Option<i64> {
    parse_mute_response(raw).and_then(|(_, until)| until)
}

/// 上传环节发现禁言：统一用户可读文案（带到期时间）。
/// Rejected 不触发换号重试，账号已被 mark_muted 标记。
fn upload_mute_rejected(until: i64) -> CoreError {
    CoreError::Rejected(format!(
        "账号已被禁言（user is muted），上传文件被拒绝，请更换账号或等待解禁{}",
        if until > 0 {
            format!("（至 {}）", format_mute_time(until))
        } else {
            String::new()
        }
    ))
}

/// 仅从业务错误或 hint 事件读取账号状态。普通回答提及「禁言」不等于账号禁言，
/// biz_code=50 也不能被字符串前缀 biz_code=5 误判。
fn parse_mute_response(raw: &[u8]) -> Option<(String, Option<i64>)> {
    let text = String::from_utf8_lossy(raw);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
        return mute_from_value(&value, false);
    }
    // 兼容上游直接返回的纯文本拒绝；不扫描正常 SSE 回答里的任意关键词。
    if text.trim_start().starts_with("由于违反用户使用规范") && text.contains("禁言") {
        let message = text.trim();
        return Some((message[..floor_utf8_end(message, 240)].to_string(), None));
    }
    let normalized = text.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        let event = block.lines().find_map(|line| line.trim().strip_prefix("event:"))
            .map(str::trim);
        if event.is_some_and(|name| name != "hint") { continue; }
        let data = block.lines().filter_map(|line| line.trim().strip_prefix("data:"))
            .map(str::trim).collect::<Vec<_>>().join("\n");
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data)
            && (event == Some("hint") || value.get("type").and_then(|v| v.as_str()) == Some("error"))
            && let Some(mute) = mute_from_value(&value, true) {
            return Some(mute);
        }
    }
    None
}

fn mute_from_value(value: &serde_json::Value, hint: bool) -> Option<(String, Option<i64>)> {
    let data = value.get("data").filter(|v| v.is_object()).unwrap_or(value);
    let biz = data.get("biz_data").unwrap_or(data);
    let message = data.get("biz_msg").or_else(|| if hint { data.get("content") } else { None })
        .and_then(|v| v.as_str()).unwrap_or("");
    let muted = data.get("biz_code").and_then(|v| v.as_i64()) == Some(5)
        || biz.get("is_muted").and_then(|v| v.as_i64()).is_some_and(|v| v != 0)
        || matches!(message, "user is muted" | "user_is_muted")
        || (hint && message.contains("禁言"));
    if !muted { return None; }
    let until = biz.get("mute_until").or_else(|| data.get("mute_until"))
        .and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.ceil() as i64);
    let notice = if message.contains("禁言") {
        message[..floor_utf8_end(message, 240)].to_string()
    } else {
        "账号已被禁言（user is muted），请等待解禁".into()
    };
    Some((notice, until))
}

/// 从字符串中提取前两个完整 SSE 事件块
fn split_two_events(buf: &str) -> Option<(&str, &str)> {
    let parts: Vec<&str> = buf.splitn(3, "\n\n").collect();
    if parts.len() < 3 {
        return None;
    }
    Some((parts[0], parts[1]))
}

/// 检查 hint 事件，返回错误（禁言 → 携带原文含到期时间；rate_limit → RateLimited；超长 → Rejected）
fn initial_hint_error<'a>(first: &'a str, second: &'a str) -> Option<(&'a str, CoreError)> {
    // 拒绝响应不保证先发送 ready：hint + close 也必须在交付流之前拒绝。
    check_hint(first).map(|err| (first, err))
        .or_else(|| check_hint(second).map(|err| (second, err)))
}

fn check_hint(event_block: &str) -> Option<CoreError> {
    if let Some(notice) = extract_mute_notice(event_block.as_bytes()) {
        return Some(CoreError::Rejected(format!("禁言提示：{}", notice)));
    }
    let is_hint = event_block.lines().any(|l| {
        l.trim()
            .strip_prefix("event:")
            .is_some_and(|v| v.trim() == "hint")
    });
    if !is_hint {
        return None;
    }
    if event_block.contains("rate_limit") {
        // 限流用独立错误类型：调用方据此让账号退避而不是标记 Error 后换号重试
        return Some(CoreError::RateLimited(
            "上游触发限流（rate_limit_reached），请稍后再试".into(),
        ));
    }
    if event_block.contains("input_exceeds_limit") {
        // 输入超长是**请求级**的确定性拒绝：重试不会让输入变短，
        // 每次重试却要新建 session、重传文件——用 Rejected 让重试循环直接上抛（bug 1）
        return Some(CoreError::Rejected("输入内容超长，请缩短后重试".into()));
    }
    None
}

/// 从第一个 SSE ready 事件中解析 request/response_message_id
///
/// 格式: `event: ready\ndata: {"request_message_id":1,"response_message_id":2,...}\n\n`
///
/// 返回 `(request_msg_id, response_msg_id)`，未找到时兜底为 `(1, 2)`
fn parse_ready_message_ids(chunk: &[u8]) -> (i64, i64) {
    let text = std::str::from_utf8(chunk).ok();
    if let Some(text) = text {
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data: ")
                && let Ok(val) = serde_json::from_str::<serde_json::Value>(data)
                && let (Some(r), Some(s)) = (
                    val.get("request_message_id").and_then(|v| v.as_i64()),
                    val.get("response_message_id").and_then(|v| v.as_i64()),
                )
            {
                return (r, s);
            }
        }
    }
    (1, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(account: &str, session: &str, last_user_text: &str, last_used_ms: u64) -> CachedConversation {        CachedConversation {
            account_id: account.to_string(),
            session_id: session.to_string(),
            last_request_msg_id: 1,
            last_response_msg_id: 2,
            last_user_text: last_user_text.to_string(),
            model_type: "default".to_string(),
            last_used_ms,
        }
    }

    #[test]
    fn check_hint_classifies_rate_limit_separately() {
        // 限流必须是独立的 RateLimited（而不是 Overloaded）：
        // Overloaded 会被上层换号/退避重试，反复新建 session 是禁言的直接诱因（bug 1）。
        let rate = "event: hint\ndata: {\"content\":\"rate_limit_reached\"}\n";
        match check_hint(rate) {
            Some(CoreError::RateLimited(_)) => {}
            other => panic!("限流应返回 RateLimited，实际 {:?}", other),
        }

        // 禁言与 JSON 拒绝采用同一分类，不能因返回 SSE 就触发换号重试。
        let muted = "event: hint\ndata: {\"content\":\"user_is_muted\"}\n";
        match check_hint(muted) {
            Some(CoreError::Rejected(m)) => assert!(m.contains("禁言")),
            other => panic!("禁言应返回 Rejected，实际 {:?}", other),
        }

        // 超长输入是 Rejected（请求级确定性拒绝）：重试不会让输入变短，
        // 每次重试却要新建 session + 重传文件，正是要避免的放大（bug 1）
        let too_long = "event: hint\ndata: {\"content\":\"input_exceeds_limit\"}\n";
        match check_hint(too_long) {
            Some(CoreError::Rejected(m)) => assert!(m.contains("超长")),
            other => panic!("超长应返回 Rejected，实际 {:?}", other),
        }

        // 非 hint 事件不报错
        let normal = "event: update_session\ndata: {}\n";
        assert!(check_hint(normal).is_none());
    }

    #[test]
    fn conversation_insert_overwrites_existing_keys() {
        // 已存在的键必须被覆盖：否则适配器会一直读到最早的 last_user_text，
        // 把编辑误判成续聊（bug 1 的第二个成因）。
        let mut map: HashMap<String, CachedConversation> = HashMap::new();
        apply_conversation_insert(&mut map, vec!["k1".into()], entry("a", "s1", "u1", 100));
        assert_eq!(map.get("k1").unwrap().last_user_text, "u1");

        // 同一键再次写入（同一上下文、新一轮 user 消息）→ 条目被刷新
        let victims = apply_conversation_insert(
            &mut map,
            vec!["k1".into(), "k2".into()],
            entry("a", "s1", "u2", 200),
        );
        assert!(victims.is_empty());
        assert_eq!(map.get("k1").unwrap().last_user_text, "u2");
        assert_eq!(map.get("k1").unwrap().last_used_ms, 200);
        assert_eq!(map.get("k2").unwrap().last_user_text, "u2");
    }

    #[test]
    fn conversation_insert_evicts_oldest_over_cap() {
        let mut map: HashMap<String, CachedConversation> = HashMap::new();
        for i in 0..CONVO_CACHE_CAP {
            apply_conversation_insert(
                &mut map,
                vec![format!("k{}", i)],
                entry("a", &format!("s{}", i), "u", i as u64),
            );
        }
        assert_eq!(map.len(), CONVO_CACHE_CAP);

        // 再插两个新键 → 超容量，淘汰最旧的两个（k0/k1）
        let victims = apply_conversation_insert(
            &mut map,
            vec!["new1".into(), "new2".into()],
            entry("a", "s-new", "u", 10_000),
        );
        assert_eq!(map.len(), CONVO_CACHE_CAP);
        let mut evicted: Vec<String> = victims.iter().map(|v| v.session_id.clone()).collect();
        evicted.sort();
        assert_eq!(evicted, vec!["s0".to_string(), "s1".to_string()]);
        assert!(map.contains_key("new1") && map.contains_key("new2"));
    }

    #[test]
    fn sanitize_history_removes_native_tags() {
        let history = "[file content end]\n\n\
            <｜System｜>你是助手\n\
            <｜User｜>你好\n\
            <｜Assistant｜>你好！有什么可以帮你？\n\
            <｜User｜>介绍一下Rust\n\
            [file name]: IGNORE\n[file content begin]\n";
        let out = sanitize_history_inline(history);
        assert!(!out.contains("｜>") && !out.contains("<｜"), "残留原生标签: {}", out);
        assert!(out.contains("[用户] 你好"));
        assert!(out.contains("[助手] 你好！有什么可以帮你？"));
        assert!(out.contains("[系统设定] 你是助手"));
        assert!(out.starts_with("以下是"));
    }

    #[test]
    fn sanitize_history_truncates_long_input() {
        let mut history = String::from("[file content end]\n\n");
        for i in 0..500 {
            history.push_str(&format!("<｜User｜>这是第{}轮很长的用户消息内容，用来撑大历史体积。\n", i));
            history.push_str(&format!("<｜Assistant｜>这是第{}轮同样很长的助手回复内容。\n", i));
        }
        history.push_str("[file name]: IGNORE\n[file content begin]\n");
        let out = sanitize_history_inline(&history);
        assert!(out.chars().count() <= 3200, "截断失败: {}", out.chars().count());
        assert!(!out.contains("<｜"));
        assert!(out.contains("已省略"));
    }

    #[test]
    fn sanitize_history_unpaired_tag_dropped() {
        let history = "<｜User｜>正常消息\n<｜Assistant｜>未闭合标签";
        let out = sanitize_history_inline(history);
        assert!(!out.contains("<｜"), "未闭合标签应整体丢弃: {}", out);
        assert!(out.contains("[用户] 正常消息"));
    }

    #[test]
    fn strip_tags_partial() {
        assert_eq!(strip_native_tags("a<｜User｜>b"), "ab");
        // 标签只剥壳，标签之间的内容保留（tool 包装内的正文属于历史内容）
        assert_eq!(strip_native_tags("a<｜tool▁outputs▁begin｜>xb<｜tool▁outputs▁end｜>c"), "axbc");
        assert_eq!(strip_native_tags("a<｜oops"), "a");
    }

    #[test]
    fn mute_notice_extraction() {
        // 形态 2（用户情报实测）：SSE 只含 user_is_muted 错误码，无中文
        let sse_code = "event: hint\ndata: {\"type\":\"error\",\"content\":\"user_is_muted\",\"finish_reason\":\"user_is_muted\"}\n\n";
        let notice = extract_mute_notice(sse_code.as_bytes()).unwrap();
        assert!(notice.contains("禁言"), "应识别错误码并给中文文案: {}", notice);
        // 形态 3（本机真机实测 2026-09-24）：禁言时 completion 直接返回 JSON 空流
        // {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted",...}}——
        // 空格形态 + biz_code 5，旧实现漏检导致被重试 3 次（bug 2 放大器）。
        let biz_json = br#"{"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted","biz_data":{"is_muted":1,"mute_until":1790440554.409}}}"#;
        let notice = extract_mute_notice(biz_json).expect("biz_code=5/user is muted 必须识别");
        assert!(notice.contains("禁言"), "应识别真实禁言响应: {}", notice);
        // 形态 1：中文原文（含到期时间）
        let sse_cn = "data: {\"type\":\"error\",\"content\":\"由于违反用户使用规范，你的账号已被禁言至 2026 年 9 月 9 日 14:44，如有疑问请联系我们。\"}\n\n";
        let notice = extract_mute_notice(sse_cn.as_bytes()).unwrap();
        assert!(notice.contains("禁言至 2026 年 9 月 9 日 14:44"), "应含到期时间: {}", notice);
        assert!(notice.starts_with("由于违反"), "应从句首截取: {}", notice);
        assert!(notice.ends_with('。'), "应到句号为止: {}", notice);
        // 无禁言内容 → None
        assert!(extract_mute_notice(b"event: ready\ndata: {}\n\n").is_none());
    }

    /// 回归：中文提示无句号且 >200 字节时，旧版 (idx+200) 直接按字节截断，
    /// 中文（3 字节/字符）必然切在字符中间 → panic（panic=abort 下杀掉整个进程）。
    #[test]
    fn extract_mute_notice_cjk_without_period_does_not_panic() {
        let mut raw = String::from("由于违反用户使用规范，你的账号已被禁言");
        while raw.len() < 400 {
            raw.push_str("，了解更多请联系管理员客服");
        }
        assert!(raw.len() > 400, "前置条件：buffer 必须远超 200 字节");
        let notice = extract_mute_notice(raw.as_bytes());
        assert!(notice.is_some(), "长中文无句号也应提取出禁言提示");
        assert!(notice.unwrap().contains("禁言"));
    }

    /// 回归：is_muted 带空格的形态（"is_muted": 1）也要命中
    #[test]
    fn extract_mute_notice_detects_spaced_is_muted() {
        assert!(extract_mute_notice(br#"{"biz_msg":"user is muted","biz_data":{"is_muted": 1}}"#).is_some());
        assert!(extract_mute_notice(br#"{"biz_code": 5}"#).is_some());
    }

    #[test]
    fn mute_deadline_is_read_from_business_response_and_hint() {
        let response = br#"{"code":0,"data":{"biz_code":5,"biz_msg":"user is muted","biz_data":{"is_muted":1,"mute_until":1790440554.409}}}"#;
        assert_eq!(extract_mute_until(response), Some(1790440555));
        let hint = b"event:hint\r\ndata:{\"content\":\"user_is_muted\",\"mute_until\":1790440554.409}\r\n\r\n";
        assert_eq!(extract_mute_until(hint), Some(1790440555));
        assert!(matches!(check_hint(std::str::from_utf8(hint).unwrap()), Some(CoreError::Rejected(_))));
    }

    #[test]
    fn ordinary_content_and_other_business_codes_are_not_mutes() {
        assert!(extract_mute_notice(br#"{"data":{"biz_code":50,"biz_msg":"other error"}}"#).is_none());
        assert!(extract_mute_notice(br#"{"data":{"biz_code":0,"biz_data":{"is_muted":0,"mute_until":null}}}"#).is_none());
        let content = "event: update\ndata: {\"content\":\"user_is_muted 表示账号禁言\"}\n\n";
        assert!(extract_mute_notice(content.as_bytes()).is_none());
        let answer = br#"{"content":"user_is_muted"}"#;
        assert!(extract_mute_notice(answer).is_none());
    }

    #[test]
    fn mute_hint_is_recognized_without_a_ready_event() {
        let hint = "event: hint\ndata: {\"content\":\"user_is_muted\"}";
        assert!(matches!(initial_hint_error(hint, "event: close\ndata: {}"),
            Some((_, CoreError::Rejected(_)))));
        assert!(matches!(initial_hint_error("event: ready\ndata: {}", hint),
            Some((_, CoreError::Rejected(_)))));
    }
}
