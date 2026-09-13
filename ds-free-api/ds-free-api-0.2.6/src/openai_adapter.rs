//! OpenAI 协议适配层 —— OpenAI JSON 与 ds_core 内部格式的双向转换
//!
//! 本模块负责将 OpenAI 兼容的 HTTP 请求转换为 ds_core 内部格式，
//! 并将 ds_core 的响应转换为 OpenAI 兼容的 JSON 格式。
//!
//! 对外暴露最小接口：OpenAIAdapter, OpenAIAdapterError

use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;
use futures::{Stream, StreamExt};

use crate::ds_core::{CoreError, DeepSeekCore};
use std::collections::HashMap;

mod models;
pub(crate) mod request;
pub(crate) mod response;
pub(crate) mod types;

pub use types::{ChatCompletionsRequest, ChatCompletionsResponse, ChatCompletionsResponseChunk};

/// 流式响应类型（SSE 字节流）
pub type StreamResponse = Pin<Box<dyn Stream<Item = Result<Bytes, OpenAIAdapterError>> + Send>>;

/// 流式响应结构体流
pub type ChunkStream =
    Pin<Box<dyn Stream<Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>> + Send>>;

/// Chat Completions 统一输出
pub enum ChatOutput {
    Stream(ChunkStream),
    Json(ChatCompletionsResponse),
}

/// adapter 层通用结果包装：携带请求结果和账号标识
pub struct ChatResult<T> {
    pub data: T,
    pub account_id: String,
    pub prompt_tokens: u32,
}

/// OpenAI 适配器
pub struct OpenAIAdapter {
    ds_core: Arc<DeepSeekCore>,
    model_types: tokio::sync::RwLock<Vec<String>>,
    model_registry: tokio::sync::RwLock<HashMap<String, String>>,
    model_aliases: tokio::sync::RwLock<Vec<String>>,
    max_input_tokens: tokio::sync::RwLock<Vec<u32>>,
    max_output_tokens: tokio::sync::RwLock<Vec<u32>>,
    tag_config: tokio::sync::RwLock<Arc<response::TagConfig>>,
    /// 缓存的 tiktoken BPE 编码器（避免每次请求重建）
    bpe: Option<Arc<tiktoken_rs::CoreBPE>>,
}

impl OpenAIAdapter {
    /// 创建适配器实例
    pub async fn new(config: &crate::config::Config) -> Result<Self, OpenAIAdapterError> {
        let ds_core = Arc::new(DeepSeekCore::new(config).await?);
        let model_registry = config.deepseek.model_registry();
        // 预初始化 tiktoken BPE（避免每次请求重建词表）
        let bpe = tiktoken_rs::cl100k_base().ok().map(Arc::new);

        Ok(Self {
            ds_core,
            model_types: tokio::sync::RwLock::new(config.deepseek.model_types.clone()),
            model_registry: tokio::sync::RwLock::new(model_registry),
            model_aliases: tokio::sync::RwLock::new(config.deepseek.model_aliases.clone()),
            max_input_tokens: tokio::sync::RwLock::new(config.deepseek.max_input_tokens.clone()),
            max_output_tokens: tokio::sync::RwLock::new(config.deepseek.max_output_tokens.clone()),
            tag_config: tokio::sync::RwLock::new(Arc::new(response::TagConfig::from_config(
                &config.deepseek.tool_call,
            ))),
            bpe,
        })
    }

    /// POST /v1/chat/completions（统一入口）
    ///
    /// 内部校验参数、构建 ChatML prompt、按 stream 标记分流：
    /// - stream=true  → 返回 SSE 字节流
    /// - stream=false → 将 SSE 流聚合为单个 JSON 对象后返回
    pub async fn chat_completions(
        &self,
        mut req: ChatCompletionsRequest,
        request_id: &str,
    ) -> Result<ChatResult<ChatOutput>, OpenAIAdapterError> {
        log::debug!(target: "adapter", "req={} 适配器开始处理: model={}, stream={}", request_id, req.model, req.stream);
        use crate::openai_adapter::types::{
            FunctionCallOption, NamedFunction, NamedToolChoice, Tool, ToolChoice,
        };

        // 兼容旧版 functions / function_call → tools / tool_choice
        if req.tools.as_ref().map(|t| t.is_empty()).unwrap_or(true)
            && let Some(functions) = req.functions.clone()
            && !functions.is_empty()
        {
            req.tools = Some(
                functions
                    .into_iter()
                    .map(|f| Tool {
                        ty: "function".to_string(),
                        function: Some(f),
                        custom: None,
                    })
                    .collect(),
            );
        }
        if req.tool_choice.is_none()
            && let Some(fc) = req.function_call.clone()
        {
            req.tool_choice = Some(match fc {
                FunctionCallOption::Mode(mode) => ToolChoice::Mode(mode),
                FunctionCallOption::Named(named) => ToolChoice::Named(NamedToolChoice {
                    ty: "function".to_string(),
                    function: NamedFunction { name: named.name },
                }),
            });
        }

        let norm = request::normalize::apply(&req).map_err(OpenAIAdapterError::BadRequest)?;
        let tool_ctx = request::tools::extract(&req).map_err(OpenAIAdapterError::BadRequest)?;
        let registry = self.model_registry.read().await;
        let model_res = request::resolver::resolve(
            &registry,
            &req.model,
            req.reasoning_effort.as_deref(),
            req.web_search_options.as_ref(),
        )
        .map_err(OpenAIAdapterError::BadRequest)?;
        drop(registry);

        // ── 会话复用判定（Web 端形态：持久会话，历史由服务端持有）──
        // 上下文哈希命中缓存 → 续聊/编辑重答；未命中 → 冷启动（必要时走历史文件）。
        // 工具/格式约束与原始流调试端点不参与复用（走传统路径）。
        let reuse_ctx: Option<(String, String)> = if tool_ctx.format_block.is_none()
            && tool_ctx.defs_text.is_none()
            && tool_ctx.instruction_text.is_none()
            && req.response_format.is_none()
        {
            // (本轮查找键, 下一轮预期键)
            conversation_context_key(&req, &model_res.model_type)
                .and_then(|k| conversation_next_key(&req, &model_res.model_type).map(|n| (k, n)))
        } else {
            None
        };

        let (prompt, files, has_http_urls, conversation) = if let Some((ctx, next_key)) = reuse_ctx
        {
            match self.plan_conversation(&req, &ctx, &next_key).await {
                Some(out) => {
                    let has_http = req
                        .messages
                        .last()
                        .and_then(|m| m.content.as_ref())
                        .map(content_has_http_url)
                        .unwrap_or(false);
                    (out.prompt, out.files, has_http, Some(out.plan))
                }
                None => {
                    let prompt = request::prompt::build(&req, &tool_ctx);
                    let file_result = request::files::extract(&req);
                    let plan = last_user_plan(&req, &ctx, &next_key);
                    (prompt, file_result.files, file_result.has_http_urls, plan)
                }
            }
        } else {
            let prompt = request::prompt::build(&req, &tool_ctx);
            let file_result = request::files::extract(&req);
            (prompt, file_result.files, file_result.has_http_urls, None)
        };

        let prompt_tokens = self
            .bpe
            .as_ref()
            .map(|bpe| bpe.encode_with_special_tokens(&prompt).len() as u32)
            .unwrap_or(0);

        let chat_req = crate::ds_core::ChatRequest {
            prompt,
            thinking_enabled: model_res.thinking_enabled,
            search_enabled: model_res.search_enabled || has_http_urls,
            model_type: model_res.model_type,
            files,
            conversation,
        };

        let chat_resp = self.try_chat(chat_req, request_id).await?;
        let account_id = chat_resp.account_id;

        // 为修复模型准备工具定义信息
        let tool_defs = req.tools.as_ref().map(|tools| {
            tools
                .iter()
                .filter_map(|t| t.function.as_ref())
                .map(|f| {
                    format!(
                        "- {}: {}",
                        f.name,
                        serde_json::to_string(&f.parameters).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        });

        if req.stream {
            let repair_fn = self.create_repair_fn(request_id, tool_defs.clone()).await;
            let s = response::stream(
                chat_resp.stream,
                req.model,
                response::StreamCfg {
                    include_usage: norm.include_usage,
                    include_obfuscation: norm.include_obfuscation,
                    stop: norm.stop,
                    prompt_tokens,
                    repair_fn: Some(repair_fn),
                    tag_config: self.tag_config.read().await.clone(),
                },
            );
            Ok(ChatResult {
                data: ChatOutput::Stream(s),
                account_id,
                prompt_tokens,
            })
        } else {
            let repair_fn = self.create_repair_fn(request_id, tool_defs).await;
            let json = response::aggregate(
                chat_resp.stream,
                req.model,
                response::StreamCfg {
                    include_usage: true,
                    include_obfuscation: false,
                    stop: norm.stop,
                    prompt_tokens,
                    repair_fn: Some(repair_fn),
                    tag_config: self.tag_config.read().await.clone(),
                },
            )
            .await?;
            Ok(ChatResult {
                data: ChatOutput::Json(json),
                account_id,
                prompt_tokens,
            })
        }
    }

    /// 内部辅助：对 `Overloaded` 进行退避重试（v0_chat 内部已做换号重试，此处为号池级兜底）。
    /// MAX_RETRIES 从 2 降到 1：v0_chat 内部最多 3 次 + 此处 2 次 = 单请求最多 6 次 session
    /// 尝试，是触发风控/禁言的重要放大因素；降到 1 后最多 4 次，平衡可用性与风控风险。
    pub(crate) async fn try_chat(
        &self,
        req: crate::ds_core::ChatRequest,
        request_id: &str,
    ) -> Result<crate::ds_core::ChatResponse, CoreError> {
        const MAX_RETRIES: usize = 1;
        const BASE_DELAY_MS: u64 = 2000;

        for attempt in 0..MAX_RETRIES {
            match self.ds_core.v0_chat(req.clone(), request_id).await {
                Ok(resp) => {
                    if attempt > 0 {
                        log::info!(target: "adapter", "req={} 第 {} 次重试成功", request_id, attempt);
                    }
                    return Ok(resp);
                }
                Err(CoreError::Overloaded) if attempt + 1 < MAX_RETRIES => {
                    let delay = BASE_DELAY_MS * (1 << attempt);
                    log::warn!(target: "adapter", "req={} Overloaded, 第 {} 次重试等待 {}ms", request_id, attempt + 1, delay);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
                Err(e) => return Err(e),
            }
        }
        log::warn!(target: "adapter", "req={} {} 次重试均失败，放弃", request_id, MAX_RETRIES);
        Err(CoreError::Overloaded)
    }

    /// GET /v1/models
    pub async fn list_models(&self) -> types::OpenAIModelList {
        let model_types = self.model_types.read().await;
        let max_input = self.max_input_tokens.read().await;
        let max_output = self.max_output_tokens.read().await;
        let aliases = self.model_aliases.read().await;
        models::list(&model_types, &max_input, &max_output, &aliases)
    }

    /// GET /v1/models/{model_id}
    pub async fn get_model(&self, model_id: &str) -> Option<types::OpenAIModel> {
        let model_types = self.model_types.read().await;
        let max_input = self.max_input_tokens.read().await;
        let max_output = self.max_output_tokens.read().await;
        let aliases = self.model_aliases.read().await;
        models::get(&model_types, &max_input, &max_output, &aliases, model_id)
    }

    /// 原始 DeepSeek SSE 流（不经 OpenAI 协议转换）
    ///
    /// 用于流分析：对比原始响应与 OpenAI 转换后的差异，定位转换 bug
    pub async fn raw_chat_completions_stream(
        &self,
        body: &[u8],
        request_id: &str,
    ) -> Result<ChatResult<StreamResponse>, OpenAIAdapterError> {
        let chat_req: ChatCompletionsRequest = serde_json::from_slice(body)
            .map_err(|e| OpenAIAdapterError::BadRequest(format!("bad request: {}", e)))?;
        let registry = self.model_registry.read().await;
        let model_res = request::resolver::resolve(
            &registry,
            &chat_req.model,
            chat_req.reasoning_effort.as_deref(),
            chat_req.web_search_options.as_ref(),
        )
        .map_err(OpenAIAdapterError::BadRequest)?;
        let ds_req = crate::ds_core::ChatRequest {
            prompt: request::prompt::build(
                &chat_req,
                &request::tools::extract(&chat_req).map_err(OpenAIAdapterError::BadRequest)?,
            ),
            thinking_enabled: model_res.thinking_enabled,
            search_enabled: model_res.search_enabled,
            model_type: model_res.model_type,
            files: vec![],
            conversation: None,
        };
        let chat_resp = self.try_chat(ds_req, request_id).await?;
        let data = Box::pin(
            chat_resp
                .stream
                .map(|r| r.map_err(OpenAIAdapterError::from)),
        );
        Ok(ChatResult {
            data,
            account_id: chat_resp.account_id,
            prompt_tokens: 0,
        })
    }

    /// 获取 ds_core 账号池状态
    pub fn account_statuses(&self) -> Vec<crate::ds_core::AccountStatus> {
        self.ds_core.account_statuses()
    }

    /// 动态添加账号
    pub async fn add_account(
        &self,
        creds: &crate::config::Account,
    ) -> Result<String, crate::ds_core::PoolError> {
        self.ds_core.add_account(creds).await
    }

    /// 动态移除账号
    pub async fn remove_account(
        &self,
        email_or_mobile: &str,
    ) -> Result<String, crate::ds_core::PoolError> {
        self.ds_core.remove_account(email_or_mobile).await
    }

    /// 标记账号为 Error 状态
    pub fn mark_error(&self, email_or_mobile: &str) {
        self.ds_core.mark_error(email_or_mobile)
    }

    /// 手动重新登录指定账号
    pub async fn re_login_single(&self, email_or_mobile: &str) -> Result<(), String> {
        self.ds_core.re_login_single(email_or_mobile).await
    }
}

impl OpenAIAdapter {
    /// 批量同步账号：对比当前账号池与目标配置，增删差异账号
    pub(crate) async fn sync_accounts(&self, new_accounts: &[crate::config::Account]) {
        let old_statuses = self.account_statuses();
        let old_ids: Vec<String> = old_statuses
            .iter()
            .map(|a| {
                if !a.email.is_empty() {
                    a.email.clone()
                } else {
                    a.mobile.clone()
                }
            })
            .collect();

        let mut _added = 0usize;
        let mut _failed = 0usize;
        for acct in new_accounts {
            let id = if !acct.email.is_empty() {
                &acct.email
            } else {
                &acct.mobile
            };
            if !old_ids.contains(id) {
                match self.add_account(acct).await {
                    Ok(_) => _added += 1,
                    Err(e) => {
                        log::warn!(target: "adapter", "同步添加账号 {} 失败: {}", id, e);
                        _failed += 1;
                    }
                }
            }
        }

        let mut _removed = 0usize;
        let new_ids: Vec<&str> = new_accounts
            .iter()
            .map(|a| {
                if !a.email.is_empty() {
                    a.email.as_str()
                } else {
                    a.mobile.as_str()
                }
            })
            .collect();
        for old_id in &old_ids {
            if !new_ids.contains(&old_id.as_str()) && !old_id.is_empty() {
                match self.remove_account(old_id).await {
                    Ok(_) => _removed += 1,
                    Err(e) => {
                        log::warn!(target: "adapter", "同步移除账号 {} 失败: {}", old_id, e);
                    }
                }
            }
        }
    }

    /// 优雅关闭
    pub async fn shutdown(&self) {
        self.ds_core.shutdown().await;
    }

    pub async fn reload_config(&self, new_config: &crate::config::Config) -> Result<(), CoreError> {
        // Sync accounts
        self.sync_accounts(&new_config.accounts).await;
        // Rebuild model registry
        let registry = new_config.deepseek.model_registry();
        *self.model_registry.write().await = registry;
        *self.model_types.write().await = new_config.deepseek.model_types.clone();
        *self.model_aliases.write().await = new_config.deepseek.model_aliases.clone();
        *self.max_input_tokens.write().await = new_config.deepseek.max_input_tokens.clone();
        *self.max_output_tokens.write().await = new_config.deepseek.max_output_tokens.clone();
        *self.tag_config.write().await = Arc::new(response::TagConfig::from_config(
            &new_config.deepseek.tool_call,
        ));
        // Rebuild DsClient if needed (deepseek/proxy changes)
        self.ds_core.reload_config(new_config).await
    }

    pub(crate) async fn create_repair_fn(
        &self,
        request_id: &str,
        tool_defs: Option<String>,
    ) -> response::RepairFn {
        use std::sync::atomic::{AtomicU16, Ordering};
        let core = self.ds_core.clone();
        let req_id = request_id.to_string();
        let seq = Arc::new(AtomicU16::new(0));
        let tag_config = self.tag_config.read().await.clone();
        let tools_info = tool_defs.unwrap_or_default();
        Arc::new(move |tool_text: String| {
            let core = core.clone();
            let req_id = req_id.clone();
            let seq = seq.clone();
            let tag_config = tag_config.clone();
            let tools_info = tools_info.clone();
            Box::pin(async move {
                use crate::ds_core::ChatRequest;
                let n = seq.fetch_add(1, Ordering::Relaxed);
                let repair_req_id = format!("{}-repair-{}", req_id, n);
                let mut prompt = String::new();
                if !tools_info.is_empty() {
                    prompt.push_str(&format!("可用的工具定义：\n{}\n\n", tools_info));
                }
                prompt.push_str(&format!(
                    "请将以下代码块中的内容提取并转换为合法的工具调用 JSON 数组。\
                     \n每个元素必须包含 \"name\"（字符串）和 \"arguments\"（对象）字段。\
                     \n只输出 JSON 数组本身，不要加 code fence，不要其他文字解释。\
                     \n注意：字符串值中的引号和换行符必须用反斜杠转义（如 \\\" 和 \\n）。\
                     \n\n需要修复的内容：\n~~~\n{tool_text}\n~~~"
                ));
                let req = ChatRequest {
                    prompt,
                    thinking_enabled: false,
                    search_enabled: false,
                    model_type: "default".to_string(),
                    files: vec![],
                    conversation: None,
                };
                log::debug!(
                    target: "adapter",
                    "{} 发起修复请求: len={}", repair_req_id, tool_text.len()
                );
                let resp = core
                    .v0_chat(req, &repair_req_id)
                    .await
                    .map_err(OpenAIAdapterError::from)?;
                response::execute_tool_repair(resp.stream, &tag_config).await
            })
        })
    }

    /// 获取账号池状态信息
    pub async fn get_account_pool_status(&self) -> AccountPoolStatus {
        self.ds_core.get_account_pool_status().await
    }

    /// 拉取云端会话列表（#10 同步已有对话）
    pub async fn list_cloud_sessions(
        &self,
    ) -> Result<Vec<crate::ds_core::CloudSession>, CoreError> {
        self.ds_core.list_cloud_sessions().await
    }

    /// 拉取云端会话的消息内容（#10 完整同步）
    pub async fn list_cloud_session_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<crate::ds_core::CloudMessage>, CoreError> {
        self.ds_core.list_cloud_session_messages(session_id).await
    }

    /// 会话复用：根据缓存判定续聊/编辑重答计划。
    /// None = 缓存未命中或不可复用（调用方退回冷启动路径并按 key 回写缓存）。
    async fn plan_conversation(
        &self,
        req: &ChatCompletionsRequest,
        key: &str,
        next_key: &str,
    ) -> Option<ReusePlanOut> {
        let cached = self.ds_core.lookup_conversation(key)?;
        let last = req.messages.last()?;
        if last.role != "user" {
            return None;
        }
        let text = message_plain_text(last);
        // 归一化与缓存写入口径一致（纯图片消息记为占位符），否则会误判为编辑
        let text_norm = if text.is_empty() { "[图片]".to_string() } else { text };
        // 编辑重答（edit_message）不能携带新文件；带文件时退回冷路径
        let files = request::files::extract_last_message(req);
        let regenerate = cached.last_user_text != text_norm;
        if regenerate && !files.files.is_empty() {
            return None;
        }

        let plan = crate::ds_core::ConversationPlan {
            cache_key: key.to_string(),
            next_key: next_key.to_string(),
            user_text: text_norm.clone(),
            reuse: Some(crate::ds_core::ReuseTarget {
                account_id: cached.account_id,
                session_id: cached.session_id,
                last_request_msg_id: cached.last_request_msg_id,
                last_response_msg_id: cached.last_response_msg_id,
            }),
            regenerate,
        };
        log::info!(
            target: "adapter",
            "会话复用命中: regenerate={} files={} prompt_len={}",
            regenerate,
            files.files.len(),
            text_norm.len()
        );
        Some(ReusePlanOut {
            prompt: text_norm,
            files: files.files,
            plan,
        })
    }
}

/// 会话复用计划结果
struct ReusePlanOut {
    prompt: String,
    files: Vec<crate::ds_core::FilePayload>,
    plan: crate::ds_core::ConversationPlan,
}

/// 消息纯文本：Text 原样；Parts 取 text 部分换行拼接（空返回空串）
fn message_plain_text(msg: &crate::openai_adapter::types::Message) -> String {
    match &msg.content {
        Some(crate::openai_adapter::types::MessageContent::Text(t)) => t.clone(),
        Some(crate::openai_adapter::types::MessageContent::Parts(parts)) => parts
            .iter()
            .filter_map(|p| p.text.as_deref())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 消息携带的图片/文件数量（键成分：区分"纯文本重复"与"带图消息"）
fn message_file_count(msg: &crate::openai_adapter::types::Message) -> usize {
    match &msg.content {
        Some(crate::openai_adapter::types::MessageContent::Parts(parts)) => parts
            .iter()
            .filter(|p| p.ty == "image_url" || p.ty == "file")
            .count(),
        _ => 0,
    }
}

/// content parts 是否含需要搜索访问的 http(s) 图片链接
fn content_has_http_url(content: &crate::openai_adapter::types::MessageContent) -> bool {
    if let crate::openai_adapter::types::MessageContent::Parts(parts) = content {
        parts.iter().any(|p| {
            p.ty == "image_url"
                && p.image_url
                    .as_ref()
                    .is_some_and(|img| {
                        img.url.starts_with("http://") || img.url.starts_with("https://")
                    })
        })
    } else {
        false
    }
}

/// 会话上下文键成分收集：sha256 的输入序列。
/// - `user` 字段（应用侧传会话 ID）是必要成分：不同新会话互不撞键；
///   未传 user 的客户端不做复用（一律冷启动，保持旧行为）。
/// - system/user 参与（user 带文件数），assistant 不参与（重试/重生成时
///   内容可能有采样差异），tool 出现即放弃复用。
/// 返回 None = 不可复用（最后一条不是 user / 含 tool / 缺 user 标识）。
fn conversation_user_parts(req: &ChatCompletionsRequest) -> Option<Vec<(u8, String)>> {
    if req.messages.is_empty() {
        return None;
    }
    let scope = req.user.as_deref().map(str::trim).filter(|s| !s.is_empty())?;
    if req.messages.last()?.role != "user" {
        return None;
    }
    let mut parts: Vec<(u8, String)> = Vec::new();
    parts.push((0u8, scope.to_string()));
    for msg in &req.messages {
        match msg.role.as_str() {
            "system" | "user" => {
                let mut s = message_plain_text(msg);
                if msg.role == "user" {
                    s.push_str(&format!("#f{}", message_file_count(msg)));
                }
                parts.push((1u8, format!("{}\x1f{}", msg.role, s)));
            }
            "assistant" => {}
            _ => return None,
        }
    }
    Some(parts)
}

fn hash_user_parts(model_type: &str, parts: &[(u8, String)]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"v1\x1e");
    hasher.update(model_type.as_bytes());
    for (kind, s) in parts {
        hasher.update(b"\x1e");
        hasher.update([*kind]);
        hasher.update(b"\x1f");
        hasher.update(s.as_bytes());
    }
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 本轮请求的查找键：上下文（除最后一条 user 外）的哈希。
fn conversation_context_key(req: &ChatCompletionsRequest, model_type: &str) -> Option<String> {
    let parts = conversation_user_parts(req)?;
    // 最后一个元素是最后一条 user 消息本身，不属于本轮上下文
    let ctx = &parts[..parts.len() - 1];
    Some(hash_user_parts(model_type, ctx))
}

/// 下一轮请求的预期查找键：上下文 + 本轮 user 消息。
/// 请求成功后缓存同时写入本键与查找键，下一轮（应用回放本轮+回复）即可命中。
fn conversation_next_key(req: &ChatCompletionsRequest, model_type: &str) -> Option<String> {
    let parts = conversation_user_parts(req)?;
    Some(hash_user_parts(model_type, &parts))
}

/// 冷启动路径的缓存计划：首条消息发出后把新会话写入缓存，后续请求即可复用
fn last_user_plan(
    req: &ChatCompletionsRequest,
    key: &str,
    next_key: &str,
) -> Option<crate::ds_core::ConversationPlan> {
    let last = req.messages.last()?;
    if last.role != "user" {
        return None;
    }
    let text = message_plain_text(last);
    Some(crate::ds_core::ConversationPlan {
        cache_key: key.to_string(),
        next_key: next_key.to_string(),
        user_text: if text.is_empty() { "[图片]".to_string() } else { text },
        reuse: None,
        regenerate: false,
    })
}

/// 账号池状态信息
#[derive(Debug, Clone, serde::Serialize)]
pub struct AccountPoolStatus {
    pub total: usize,
    pub idle: usize,
    pub busy: usize,
}

/// 适配器错误类型
#[derive(Debug, thiserror::Error)]
pub enum OpenAIAdapterError {
    /// 请求格式错误
    #[error("bad request: {0}")]
    BadRequest(String),

    /// 未配置任何 DeepSeek 账号
    #[error("no accounts configured")]
    NoAccounts,

    /// 服务过载，无可用的 ds_core 账号
    #[error("service overloaded")]
    Overloaded,

    /// 上游提供商错误（网络、业务错误等）
    #[error("provider error: {0}")]
    ProviderError(String),

    /// 内部错误（序列化、流转换等）
    #[error("internal error: {0}")]
    Internal(String),

    /// tool_calls 标记解析失败，携带 `{TOOL_CALL_START}...{TOOL_CALL_END}` 内的原始文本
    #[error("tool_calls repair needed: {0}")]
    ToolCallRepairNeeded(String),
}

impl From<CoreError> for OpenAIAdapterError {
    fn from(e: CoreError) -> Self {
        match e {
            CoreError::NoAccounts => Self::NoAccounts,
            CoreError::Overloaded => Self::Overloaded,
            CoreError::ProofOfWorkFailed(err) => {
                Self::Internal(format!("proof of work failed: {}", err))
            }
            CoreError::ProviderError(msg) => Self::ProviderError(msg),
            CoreError::Stream(msg) => Self::Internal(msg),
        }
    }
}

impl From<serde_json::Error> for OpenAIAdapterError {
    fn from(e: serde_json::Error) -> Self {
        Self::Internal(format!("json serialization failed: {}", e))
    }
}

impl OpenAIAdapterError {
    /// 返回对应 HTTP 状态码
    pub fn status_code(&self) -> u16 {
        match self {
            Self::BadRequest(_) => 400,
            // 未配置账号用 503（服务不可用），与 429 限流区分
            Self::NoAccounts => 503,
            Self::Overloaded => 429,
            Self::ProviderError(_) => 502,
            Self::Internal(_) => 500,
            Self::ToolCallRepairNeeded(_) => 500,
        }
    }
}

#[cfg(test)]
mod reuse_tests {
    use super::{conversation_context_key, message_plain_text};
    use crate::openai_adapter::types::{ChatCompletionsRequest, MessageContent, Message};

    fn parse(v: serde_json::Value) -> ChatCompletionsRequest {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn key_requires_user_scope() {
        let req = parse(serde_json::json!({
            "model": "deepseek-default",
            "messages": [{ "role": "user", "content": "hi" }]
        }));
        // 未传 user（会话标识）的客户端不做复用，保持旧行为
        assert!(conversation_context_key(&req, "default").is_none());
    }

    #[test]
    fn key_stable_across_assistant_replays_and_scoped() {
        let base = |user: &str, a1: &str| serde_json::json!({
            "model": "deepseek-default",
            "user": user,
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "u1" },
                { "role": "assistant", "content": a1 },
                { "role": "user", "content": "u2" }
            ]
        });
        let k1 = conversation_context_key(&parse(base("conv-a", "a1")), "default").unwrap();
        let k2 = conversation_context_key(&parse(base("conv-a", "a1")), "default").unwrap();
        let k3 = conversation_context_key(&parse(base("conv-b", "a1")), "default").unwrap();
        // assistant 回放文本差异不影响键（同一对话上下文）
        let k4 = conversation_context_key(&parse(base("conv-a", "a1 另一种采样")), "default").unwrap();
        assert_eq!(k1, k2);
        assert_ne!(k1, k3, "不同会话标识不得撞键");
        assert_eq!(k1, k4);
    }

    #[test]
    fn first_message_key_independent_of_text() {
        // 首条消息的键只由 scope+model 决定（上下文为空）：
        // 编辑首条消息命中同键，由 last_user_text 差异走 edit_message 重答
        let mk = |text: &str| {
            conversation_context_key(
                &parse(serde_json::json!({
                    "model": "deepseek-default",
                    "user": "conv-a",
                    "messages": [{ "role": "user", "content": text }]
                })),
                "default",
            )
            .unwrap()
        };
        assert_eq!(mk("原始问题"), mk("修改后的问题"));
    }

    #[test]
    fn mid_history_edit_maps_to_earlier_key() {
        let mk = |msgs: serde_json::Value| {
            conversation_context_key(
                &parse(serde_json::json!({
                    "model": "deepseek-default",
                    "user": "conv-a",
                    "messages": msgs
                })),
                "default",
            )
            .unwrap()
        };
        // 原始第二轮（上下文 u1）与编辑第一轮（上下文空）应得到不同键；
        // 编辑第一轮的键 == 首轮消息的键（上例），从而命中首轮缓存条目
        let k_u2 = mk(serde_json::json!([
            { "role": "user", "content": "u1" },
            { "role": "assistant", "content": "a1" },
            { "role": "user", "content": "u2" }
        ]));
        let k_edit_u1 = mk(serde_json::json!([
            { "role": "user", "content": "u1 改" }
        ]));
        assert_ne!(k_u2, k_edit_u1);
    }

    #[test]
    fn tool_messages_block_reuse() {
        let req = parse(serde_json::json!({
            "model": "deepseek-default",
            "user": "conv-a",
            "messages": [
                { "role": "user", "content": "q" },
                { "role": "tool", "tool_call_id": "t", "content": "r" },
                { "role": "user", "content": "q2" }
            ]
        }));
        assert!(conversation_context_key(&req, "default").is_none());
    }

    #[test]
    fn plain_text_and_image_count() {
        let msg = Message {
            role: "user".into(),
            content: Some(MessageContent::Parts(vec![
                serde_json::from_value(serde_json::json!({
                    "type": "text", "text": "解释一下这个梗"
                }))
                .unwrap(),
                serde_json::from_value(serde_json::json!({
                    "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" }
                }))
                .unwrap(),
            ])),
            name: None,
            tool_calls: None,
            tool_call_id: None,
            function_call: None,
            refusal: None,
            audio: None,
        };
        assert_eq!(message_plain_text(&msg), "解释一下这个梗");
        assert_eq!(super::message_file_count(&msg), 1);
    }
}
