//! OpenAI 响应转换 —— 将 DeepSeek SSE 流映射为 OpenAI 响应格式
//!
//! 数据流：sse_parser -> state -> converter -> tool_parser
//! - 仅 THINK / RESPONSE 片段映射到用户可见文本
//! - obfuscation 在最终 SSE 序列化阶段动态注入

mod converter;
mod sse_parser;
mod state;
mod tool_parser;

pub(crate) use tool_parser::{TOOL_CALL_END, TOOL_CALL_START, TagConfig};

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::{Stream, StreamExt};
use log::{debug, info, trace, warn};
use pin_project_lite::pin_project;
use rand::RngExt;
use tokio::time::Sleep;

use crate::openai_adapter::{
    OpenAIAdapterError,
    types::{
        ChatCompletionsResponse, ChatCompletionsResponseChunk, Choice, ChunkChoice, Delta,
        FunctionCall, MessageResponse, ToolCall, Usage,
    },
};

static CHATCMPL_ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_chatcmpl_id() -> String {
    let n = CHATCMPL_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("chatcmpl-{:016x}", n)
}

pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

const OBFUSCATION_TARGET_LEN: usize = 512;
const OBFUSCATION_MIN_PAD: usize = 16;
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(1);
const FINISH_STOP: &str = "stop";
const FINISH_TOOL_CALLS: &str = "tool_calls";

fn random_padding(len: usize) -> String {
    if len == 0 {
        return String::new();
    }
    let byte_len = (len * 3).div_ceil(4);
    let mut bytes = vec![0u8; byte_len];
    rand::rng().fill(&mut bytes);
    let s = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    s[..len].to_string()
}

pub(crate) fn sse_serialize(
    chunk: &ChatCompletionsResponseChunk,
) -> Result<Bytes, OpenAIAdapterError> {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(b"data: ");
    serde_json::to_writer(&mut buf, chunk).map_err(OpenAIAdapterError::from)?;
    buf.extend_from_slice(b"\n\n");
    Ok(Bytes::from(buf))
}

fn find_stop_pos(content: &str, stop: &[String]) -> Option<usize> {
    stop.iter().filter_map(|s| content.find(s)).min()
}

/// RepairStream 内部使用的流类型
type ChunkStream =
    Pin<Box<dyn Stream<Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>> + Send>>;

/// 工具调用修复闭包类型
pub(crate) type RepairFn = Arc<
    dyn Fn(
            String,
        )
            -> Pin<Box<dyn Future<Output = Result<Vec<ToolCall>, OpenAIAdapterError>> + Send>>
        + Send
        + Sync,
>;

/// 执行 tool_calls 修复：将 ds_core 字节流解析后提取文本，转换为结构化 ToolCall
pub(crate) async fn execute_tool_repair(
    ds_stream: Pin<Box<dyn Stream<Item = Result<Bytes, crate::ds_core::CoreError>> + Send>>,
    tag_config: &TagConfig,
) -> Result<Vec<ToolCall>, OpenAIAdapterError> {
    let sse = sse_parser::SseStream::new(ds_stream);
    let state_stream = state::StateStream::new(sse);
    futures::pin_mut!(state_stream);

    let mut text = String::new();
    while let Some(frame) = state_stream.next().await {
        if let state::DsFrame::ContentDelta(t) = frame? {
            text.push_str(&t);
            if text.len() > tool_parser::MAX_XML_BUF_LEN {
                return Err(OpenAIAdapterError::Internal(
                    "修复模型输出过长，放弃修复".into(),
                ));
            }
        }
    }

    let wrapped = if tool_parser::contains_start_tag_with(&text, tag_config) {
        text.trim().to_string()
    } else {
        format!(
            "{}{}{}",
            tool_parser::TOOL_CALL_START,
            text.trim(),
            tool_parser::TOOL_CALL_END
        )
    };

    let (calls, _) = tool_parser::parse_tool_calls_with(&wrapped, tag_config).ok_or_else(|| {
        OpenAIAdapterError::Internal(format!(
            // 修复模型输出常含中文等多字节字符，直接按字节截断可能切在字符中间 panic
            "修复模型返回无法解析为工具调用: {}",
            &text[..tool_parser::floor_char_boundary(&text, text.len().min(200))]
        ))
    })?;

    // 修复模型可能返回空结果，提前检查
    let trimmed = text.trim();
    if trimmed == "[]" || trimmed == "{}" {
        return Err(OpenAIAdapterError::Internal("修复模型返回空结果".into()));
    }
    Ok(calls)
}

enum RepairState {
    Forwarding,
    Repairing {
        future: Pin<Box<dyn Future<Output = Result<Vec<ToolCall>, OpenAIAdapterError>> + Send>>,
    },
    RepairFailed(String),
    Done,
}

pin_project! {
    /// 工具调用修复流：在 ToolCallStream 之后、StopDetectStream 之前
    ///
    /// 当 ToolCallStream 返回 Err(ToolCallRepairNeeded) 时，
    /// 丢弃上游流（释放账号），通过 repair_fn 发起修复请求，
    /// 将修复后的 tool_calls 发送给客户端。
    struct RepairStream {
        #[pin]
        inner: Option<ChunkStream>,
        repair_fn: Option<RepairFn>,
        state: RepairState,
        model: String,
        #[pin]
        keepalive_deadline: Sleep,
    }
}

impl RepairStream {
    fn new(inner: ChunkStream, repair_fn: RepairFn, model: String) -> Self {
        Self {
            inner: Some(inner),
            repair_fn: Some(repair_fn),
            state: RepairState::Forwarding,
            model,
            keepalive_deadline: tokio::time::sleep_until(
                tokio::time::Instant::now() + KEEPALIVE_INTERVAL,
            ),
        }
    }
}

impl Stream for RepairStream {
    type Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut this = self.project();

        loop {
            match this.state {
                RepairState::Forwarding => {
                    match this.inner.as_mut().as_pin_mut().map(|p| p.poll_next(cx)) {
                        Some(Poll::Ready(Some(Ok(chunk)))) => {
                            return Poll::Ready(Some(Ok(chunk)));
                        }
                        Some(Poll::Ready(Some(Err(OpenAIAdapterError::ToolCallRepairNeeded(
                            tool_text,
                        ))))) => {
                            warn!(
                                target: "adapter",
                                "RepairStream 捕获修复请求: len={}",
                                tool_text.len()
                            );
                            trace!(target: "adapter", ">>> repair: accepting tool_text len={}", tool_text.len());
                            drop(this.inner.as_mut().get_mut().take());
                            if let Some(f) = this.repair_fn.take() {
                                let future = f(tool_text);
                                *this.state = RepairState::Repairing { future };
                            } else {
                                *this.state =
                                    RepairState::RepairFailed("no repair function".into());
                            }
                            continue;
                        }
                        Some(Poll::Ready(Some(Err(e)))) => {
                            return Poll::Ready(Some(Err(e)));
                        }
                        Some(Poll::Ready(None)) | None => {
                            return Poll::Ready(None);
                        }
                        Some(Poll::Pending) => {
                            return Poll::Pending;
                        }
                    }
                }

                RepairState::Repairing { future } => match future.as_mut().poll(cx) {
                    Poll::Ready(Ok(calls)) => {
                        info!(
                            target: "adapter",
                            "tool_calls 修复成功: {} 个工具调用",
                            calls.len()
                        );
                        trace!(target: "adapter", ">>> repair: success {} calls", calls.len());
                        *this.state = RepairState::Done;
                        return Poll::Ready(Some(Ok(converter::make_chunk(
                            this.model,
                            Delta {
                                tool_calls: Some(calls),
                                ..Default::default()
                            },
                            Some(FINISH_TOOL_CALLS),
                        ))));
                    }
                    Poll::Ready(Err(e)) => {
                        warn!(target: "adapter", "tool_calls 修复失败: {}", e);
                        *this.state = RepairState::RepairFailed(format!("修复失败: {}", e));
                        continue;
                    }
                    Poll::Pending => {
                        if this.keepalive_deadline.as_mut().poll(cx).is_ready() {
                            trace!(target: "adapter", ">>> keepalive(repair): 发送空工具增量");
                            this.keepalive_deadline
                                .as_mut()
                                .reset(tokio::time::Instant::now() + KEEPALIVE_INTERVAL);
                            return Poll::Ready(Some(Ok(ChatCompletionsResponseChunk {
                                id: "chatcmpl-keepalive".into(),
                                object: "chat.completion.chunk",
                                created: 0,
                                model: this.model.clone(),
                                choices: vec![ChunkChoice {
                                    index: 0,
                                    delta: Delta {
                                        tool_calls: Some(vec![ToolCall {
                                            id: String::new(),
                                            ty: "function".into(),
                                            function: Some(FunctionCall {
                                                name: String::new(),
                                                arguments: String::new(),
                                            }),
                                            custom: None,
                                            index: 0,
                                        }]),
                                        ..Default::default()
                                    },
                                    finish_reason: None,
                                    logprobs: None,
                                }],
                                usage: None,
                                service_tier: None,
                                system_fingerprint: None,
                                ds_title: None,
                                ds_session_id: None,
                            })));
                        }
                        return Poll::Pending;
                    }
                },

                RepairState::RepairFailed(msg) => {
                    let msg = std::mem::take(msg);
                    return Poll::Ready(Some(Err(OpenAIAdapterError::Internal(msg))));
                }

                RepairState::Done => return Poll::Ready(None),
            }
        }
    }
}

pin_project! {
    struct StopDetectStream<S> {
        #[pin]
        inner: S,
        stop: Vec<String>,
        model: String,
        stopped: bool,
        // buffer 中已转发给客户端的字节数。为防 stop 序列跨 chunk 边界时
        // 「前缀已转发、无法撤回」，转发位置永远落后 buffer 末尾至少
        // max(stop 字节数)-1 字节（holdback）；残余在上游结束或收到
        // 无 content 的 chunk（finish/usage 等）时冲出去。
        sent_len: usize,
        buffer: String,
        include_obfuscation: bool,
    }
}

impl<S> Stream for StopDetectStream<S>
where
    S: Stream<Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>>,
{
    type Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut this = self.project();
        loop {
            match this.inner.as_mut().poll_next(cx) {
                Poll::Ready(None) => {
                    // 上游正常收尾（未命中 stop）：把 holdback 扣住的残余冲出去，
                    // 否则最后一段内容会丢在本地 buffer 里。
                    if !*this.stopped && *this.sent_len < this.buffer.len() {
                        let tail = this.buffer[*this.sent_len..].to_string();
                        *this.sent_len = this.buffer.len();
                        return Poll::Ready(Some(Ok(converter::make_chunk(
                            this.model,
                            Delta {
                                content: Some(tail),
                                ..Default::default()
                            },
                            None,
                        ))));
                    }
                    return Poll::Ready(None);
                }
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Some(Err(e))),
                Poll::Ready(Some(Ok(mut chunk))) => {
                    if *this.stopped {
                        // usage / ds_title / ds_session_id 尾随 chunk（空 choices）继续放行
                        if chunk.choices.is_empty()
                            && (chunk.usage.is_some()
                                || chunk.ds_title.is_some()
                                || chunk.ds_session_id.is_some())
                        {
                            return Poll::Ready(Some(Ok(chunk)));
                        }
                        // 允许 finish_reason 从 stop 升级为 tool_calls
                        if let Some(choice) = chunk.choices.first_mut()
                            && choice.delta.content.is_none()
                            && choice.delta.reasoning_content.is_none()
                            && choice.delta.tool_calls.is_none()
                            && choice.finish_reason == Some(FINISH_TOOL_CALLS)
                        {
                            return Poll::Ready(Some(Ok(chunk)));
                        }
                        continue;
                    }

                    if let Some(choice) = chunk.choices.first_mut()
                        && let Some(ref content) = choice.delta.content
                    {
                        this.buffer.push_str(content);
                        if let Some(pos) = find_stop_pos(this.buffer, this.stop) {
                            trace!(target: "adapter", ">>> stop: truncate at {}", pos);
                            // pos >= sent_len 恒成立：sent_len 落后 buffer 末尾至多
                            // max(stop)-1 字节，而此处新命中的 stop 匹配必然起始于
                            // 上一次检查之后（更早出现的匹配早已触发 stopped）。
                            let truncated = this.buffer[*this.sent_len..pos].to_string();
                            if truncated.is_empty() {
                                choice.delta.content = None;
                            } else {
                                choice.delta.content = Some(truncated);
                            }
                            choice.finish_reason = Some(FINISH_STOP);
                            *this.stopped = true;
                            this.buffer.clear();
                            *this.sent_len = 0;
                        } else {
                            // 无命中：只转发安全前缀，扣住末尾 max(stop)-1 字节，
                            // 防止下一片把 stop 序列补全时前缀已经发给客户端。
                            let hold = this.stop.iter().map(|s| s.len()).max().unwrap_or(0);
                            let limit = if hold <= 1 {
                                this.buffer.len()
                            } else {
                                tool_parser::floor_char_boundary(
                                    this.buffer,
                                    // buffer 可能比 holdback 还短（中文 stop 6 字节 +
                                    // 短内容），必须 saturating 防止减法下溢 panic
                                    this.buffer.len().saturating_sub(hold - 1),
                                )
                            };
                            let emit = this.buffer[*this.sent_len..limit].to_string();
                            *this.sent_len = limit;
                            choice.delta.content = if emit.is_empty() {
                                None
                            } else {
                                Some(emit)
                            };
                        }
                    } else if !*this.stopped && *this.sent_len < this.buffer.len() {
                        // 无 content 的 chunk（finish / usage / reasoning 等）：
                        // 把扣住的残余搭这趟车冲出去，避免流结束后才 flush 导致乱序。
                        if let Some(choice) = chunk.choices.first_mut()
                            && choice.delta.content.is_none()
                        {
                            let tail = this.buffer[*this.sent_len..].to_string();
                            *this.sent_len = this.buffer.len();
                            choice.delta.content = Some(tail);
                        }
                    }
                    if *this.include_obfuscation && !chunk.choices.is_empty() {
                        let without = serde_json::to_string(&chunk)
                            .map_err(|e| OpenAIAdapterError::Internal(format!("json: {}", e)))?;
                        let overhead = r#","obfuscation":"""#.len();
                        let pad_len = if without.len() + overhead < OBFUSCATION_TARGET_LEN {
                            OBFUSCATION_TARGET_LEN - without.len() - overhead
                        } else {
                            OBFUSCATION_MIN_PAD
                        };
                        if let Some(choice) = chunk.choices.first_mut() {
                            choice.delta.obfuscation = Some(random_padding(pad_len));
                        }
                    }
                    return Poll::Ready(Some(Ok(chunk)));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// 流式响应参数（减少 stream() 参数个数）
pub(crate) struct StreamCfg {
    pub include_usage: bool,
    pub include_obfuscation: bool,
    pub stop: Vec<String>,
    pub prompt_tokens: u32,
    pub repair_fn: Option<RepairFn>,
    pub tag_config: Arc<TagConfig>,
    /// 本对话的云端会话 id（持久会话才有）：流末尾追加一个尾随 chunk 透传给客户端，
    /// 供应用侧把本地会话与云端会话对上号（同步去重）。
    pub session_id: Option<String>,
}

/// 流式响应：把 ds_core 字节流转换为 ChatCompletionsResponseChunk 流
pub(crate) fn stream<S>(ds_stream: S, model: String, cfg: StreamCfg) -> ChunkStream
where
    S: Stream<Item = Result<Bytes, crate::ds_core::CoreError>> + Send + 'static,
{
    debug!(
        target: "adapter",
        "构建流式响应: model={}, include_usage={}, include_obfuscation={}, stop_count={}, repair={}",
        model, cfg.include_usage, cfg.include_obfuscation, cfg.stop.len(), cfg.repair_fn.is_some()
    );
    let sse = sse_parser::SseStream::new(ds_stream);
    let state_stream = state::StateStream::new(sse);
    let converted = converter::ConverterStream::new(
        state_stream,
        model.clone(),
        cfg.include_usage,
        cfg.include_obfuscation,
        cfg.prompt_tokens,
    );
    let tool_parsed = tool_parser::ToolCallStream::new(converted, model.clone(), cfg.tag_config);
    let tool_boxed: Pin<
        Box<dyn Stream<Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>> + Send>,
    > = Box::pin(tool_parsed);

    let after_repair: Pin<
        Box<dyn Stream<Item = Result<ChatCompletionsResponseChunk, OpenAIAdapterError>> + Send>,
    > = if let Some(f) = cfg.repair_fn {
        Box::pin(RepairStream::new(tool_boxed, f, model.clone()))
    } else {
        tool_boxed
    };

    let stop_detect = StopDetectStream {
        inner: after_repair,
        stop: cfg.stop,
        model: model.clone(),
        stopped: false,
        sent_len: 0,
        buffer: String::new(),
        include_obfuscation: cfg.include_obfuscation,
    };
    // 持久会话：末尾追加会话 id 尾随 chunk（与 ds_title 同形态），供应用侧做云端会话关联
    match cfg.session_id {
        Some(sid) => {
            let tail = futures::stream::once(futures::future::ready(Ok(
                converter::make_session_chunk(&model, sid),
            )));
            Box::pin(stop_detect.chain(tail))
        }
        None => Box::pin(stop_detect),
    }
}

/// 非流式响应：stream() 的下游收集器，纯重组无特殊逻辑
///
/// 始终保持为 stream() 的流式收集和重组：
/// - 所有核心处理（修复、转换、停止序列）都在 stream() 中完成
/// - 本函数仅将 stream() 的输出事件聚合并重组成单条 ChatCompletionsResponse JSON
/// - 不要在此函数中添加任何独立于 stream() 的处理逻辑
pub(crate) async fn aggregate<S>(
    ds_stream: S,
    model: String,
    cfg: StreamCfg,
) -> Result<ChatCompletionsResponse, OpenAIAdapterError>
where
    S: Stream<Item = Result<Bytes, crate::ds_core::CoreError>> + Send + 'static,
{
    debug!(target: "adapter", "构建非流式响应: model={}, stop_count={}", model, cfg.stop.len());
    let chunk_stream = stream(
        ds_stream,
        model.clone(),
        StreamCfg {
            include_usage: true,
            include_obfuscation: false,
            ..cfg
        },
    );
    futures::pin_mut!(chunk_stream);

    let mut id = String::new();
    let mut created = 0u64;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Option<Vec<ToolCall>> = None;
    let mut usage = None;
    let mut ds_title: Option<String> = None;
    let mut ds_session_id: Option<String> = None;
    let mut finish_reason: Option<&'static str> = None;

    while let Some(res) = chunk_stream.next().await {
        let chunk = res?;

        if id.is_empty() {
            id = chunk.id;
            created = chunk.created;
        }

        if let Some(sid) = chunk.ds_session_id {
            ds_session_id = Some(sid);
            continue;
        }

        if let Some(t) = chunk.ds_title {
            ds_title = Some(t);
        }

        if let Some(u) = chunk.usage {
            usage = Some(Usage {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
                prompt_tokens_details: None,
                completion_tokens_details: None,
            });
        }

        if let Some(choice) = chunk.choices.into_iter().next() {
            if finish_reason.is_none() {
                finish_reason = choice.finish_reason;
            }
            if let Some(c) = choice.delta.content {
                content.push_str(&c);
            }
            if let Some(r) = choice.delta.reasoning_content {
                reasoning.push_str(&r);
            }
            if let Some(tc) = choice.delta.tool_calls
                && !tc.is_empty()
            {
                tool_calls = Some(tc);
            }
        }
    }

    let reasoning_content = if reasoning.is_empty() {
        None
    } else {
        Some(reasoning)
    };

    let has_tool_calls = tool_calls.is_some();
    let message_content = if content.is_empty() && !has_tool_calls {
        warn!(
            target: "adapter",
            "聚合响应内容为空: model={}, finish_reason={:?}, has_tool_calls={}, usage={:?}",
            model, finish_reason, tool_calls.is_some(), usage
        );
        None
    } else {
        Some(content)
    };
    let final_reason = if has_tool_calls {
        Some(FINISH_TOOL_CALLS)
    } else {
        finish_reason
    };

    let completion = ChatCompletionsResponse {
        id,
        object: "chat.completion",
        created,
        model,
        choices: vec![Choice {
            index: 0,
            message: MessageResponse {
                role: "assistant",
                content: message_content,
                reasoning_content,
                refusal: None,
                annotations: None,
                audio: None,
                function_call: None,
                tool_calls,
            },
            finish_reason: final_reason,
            logprobs: None,
        }],
        usage,
        service_tier: None,
        system_fingerprint: None,
        ds_title,
        ds_session_id,
    };

    debug!(
        target: "adapter",
        "非流式响应聚合完成: finish_reason={:?}, has_tool_calls={}, usage={:?}, ds_title={:?}",
        completion.choices[0].finish_reason,
        completion.choices[0].message.tool_calls.is_some(),
        completion.usage,
        completion.ds_title
    );
    Ok(completion)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bytes::Bytes;
    use futures::StreamExt;

    use super::*;

    fn default_tag_config() -> Arc<TagConfig> {
        Arc::new(TagConfig::from_config(&Default::default()))
    }

    fn sse_bytes(body: &str) -> Result<Bytes, crate::ds_core::CoreError> {
        Ok(Bytes::from(body.to_string()))
    }

    fn tool_span(content: &str) -> String {
        format!(
            "{}{}{}",
            tool_parser::TOOL_CALL_START,
            content,
            tool_parser::TOOL_CALL_END
        )
    }

    /// 将内容拆分为流式 DS SSE 帧序列，模拟字符级输出（每 ~3 字符一片）
    /// - pieces: 按顺序排列的 (内容, 片段类型) 对，类型变化时自动插入新 fragment 事件
    fn make_ds_stream(
        pieces: &[(&str, &str)],
        usage_tokens: Option<u32>,
    ) -> Vec<Result<Bytes, crate::ds_core::CoreError>> {
        let mut frames = vec![sse_bytes("event: ready\ndata: {}\n\n")];

        for (idx, (content, frag_type)) in pieces.iter().enumerate() {
            let is_first = idx == 0;
            let prev_type = if idx > 0 {
                Some(pieces[idx - 1].1)
            } else {
                None
            };
            let type_changed = prev_type != Some(*frag_type);

            if is_first {
                // 首个片段：在 response 创建中声明
                frames.push(sse_bytes(&format!(
                    "data: {{\"v\":{{\"response\":{{\"fragments\":[{{\"type\":\"{frag_type}\",\"content\":\"\"}}]}}}}}}\n\n"
                )));
            } else if type_changed {
                // 片段类型变化：APPEND 新片段到 fragments 数组
                frames.push(sse_bytes(&format!(
                    "data: {{\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{{\"type\":\"{frag_type}\",\"content\":\"\"}}]}}\n\n"
                )));
            }

            // 每 3 字符切割一片
            let mut i = 0;
            while i < content.len() {
                let mut end = (i + 3).min(content.len());
                while !content.is_char_boundary(end) {
                    end -= 1;
                }
                let piece = &content[i..end];
                let escaped = piece.replace('"', "\\\"");
                frames.push(sse_bytes(&format!(
                    "data: {{\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\"{escaped}\"}}\n\n"
                )));
                i = end;
            }
        }

        if let Some(tokens) = usage_tokens {
            frames.push(sse_bytes(&format!(
                "data: {{\"p\":\"response\",\"o\":\"BATCH\",\"v\":[{{\"p\":\"accumulated_token_usage\",\"v\":{tokens}}},{{\"p\":\"quasi_status\",\"v\":\"FINISHED\"}}]}}\n\n"
            )));
        }

        frames.push(sse_bytes(
            "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n",
        ));
        frames.push(sse_bytes("event: finish\ndata: {}\n\n"));

        frames
    }

    #[tokio::test]
    async fn stream_ds_title_trailing_chunk() {
        // 会话首条消息时 DeepSeek 在 finish 之后发 event: title，
        // 应以空 choices 的尾随 chunk 透传 ds_title
        let fixture = "event: ready\ndata: {}\n\n\
            data: {\"v\":{\"response\":{\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"\"}]}}}\n\n\
            data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\"hello\"}\n\n\
            data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n\
            event: finish\ndata: {}\n\n\
            event: title\ndata: {\"content\":\"测试标题\"}\n\n";
        let bytes_stream = futures::stream::iter(vec![sse_bytes(fixture)]);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        let title_chunk = chunks.iter().find(|c| c["ds_title"].is_string());
        assert!(
            title_chunk.is_some(),
            "应有 ds_title 尾随 chunk, chunks={}",
            serde_json::to_string(&chunks).unwrap()
        );
        assert_eq!(title_chunk.unwrap()["ds_title"], "测试标题");
    }

    #[tokio::test]
    async fn aggregate_ds_title() {
        let fixture = "event: ready\ndata: {}\n\n\
            data: {\"v\":{\"response\":{\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"hi\"}]}}}\n\n\
            data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n\
            event: finish\ndata: {}\n\n\
            event: title\ndata: {\"content\":\"会话名\"}\n\n";
        let stream = futures::stream::iter(vec![sse_bytes(fixture)]);
        let resp = aggregate(
            stream,
            "deepseek-default".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(resp.ds_title.as_deref(), Some("会话名"));
        assert_eq!(resp.choices[0].message.content.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn aggregate_plain_text() {
        let frames = make_ds_stream(&[("hello world", "RESPONSE")], Some(41));
        let stream = futures::stream::iter(frames);
        let resp = aggregate(
            stream,
            "deepseek-default".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(resp.object, "chat.completion");
        assert_eq!(resp.model, "deepseek-default");
        let msg = &resp.choices[0].message;
        assert_eq!(msg.content.as_deref(), Some("hello world"));
        assert_eq!(resp.choices[0].finish_reason, Some("stop"));
        assert_eq!(resp.usage.as_ref().unwrap().completion_tokens, 41);
    }

    #[tokio::test]
    async fn aggregate_thinking() {
        let frames = make_ds_stream(&[("thinking", "THINK"), ("answer", "RESPONSE")], None);
        let stream = futures::stream::iter(frames);
        let resp = aggregate(
            stream,
            "deepseek-expert".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )
        .await
        .unwrap();
        let msg = &resp.choices[0].message;
        assert_eq!(msg.reasoning_content.as_deref(), Some("thinking"));
        assert_eq!(msg.content.as_deref(), Some("answer"));
        assert_eq!(resp.choices[0].finish_reason, Some("stop"));
    }

    #[tokio::test]
    async fn aggregate_tool_calls() {
        let tool_xml = tool_span(r#"[{"name": "get_weather", "arguments": {"city": "beijing"}}]"#);
        let frames = make_ds_stream(&[(&tool_xml, "RESPONSE")], None);
        let stream = futures::stream::iter(frames);
        let resp = aggregate(
            stream,
            "deepseek-default".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )
        .await
        .unwrap();
        let msg = &resp.choices[0].message;
        assert_eq!(msg.content.as_deref(), Some(""));
        let calls = msg.tool_calls.as_ref().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].ty, "function");
        assert_eq!(calls[0].function.as_ref().unwrap().name, "get_weather");
        assert_eq!(
            calls[0].function.as_ref().unwrap().arguments,
            r#"{"city":"beijing"}"#
        );
        assert_eq!(resp.choices[0].finish_reason, Some("tool_calls"));
    }
    use std::pin::Pin;

    fn to_bytes_stream(
        st: ChunkStream,
    ) -> Pin<Box<dyn Stream<Item = Result<Bytes, OpenAIAdapterError>> + Send>> {
        Box::pin(st.map(|r| r.and_then(|c| sse_serialize(&c))))
    }

    async fn collect_chunks(
        st: Pin<Box<dyn Stream<Item = Result<Bytes, OpenAIAdapterError>> + Send>>,
    ) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        let mut st = st;
        while let Some(res) = st.next().await {
            let text = String::from_utf8(res.unwrap().to_vec()).unwrap();
            let json = text
                .strip_prefix("data: ")
                .unwrap()
                .strip_suffix("\n\n")
                .unwrap();
            out.push(serde_json::from_str(json).unwrap());
        }
        out
    }

    #[tokio::test]
    async fn stream_plain_text() {
        let frames = make_ds_stream(&[("hi", "RESPONSE")], None);
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (plain_text) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("===================================\n");
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        // 所有 content 合并后应为 "hi"
        let all_content: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert_eq!(all_content, "hi");
        // 最终 finish_reason
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "stop"
        );
    }

    #[tokio::test]
    async fn stream_include_usage() {
        let frames = make_ds_stream(&[("x", "RESPONSE")], Some(12));
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: true,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (include_usage) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("======================================\n");
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        // 所有 content 合并后应为 "x"
        let all_content: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert_eq!(all_content, "x");
        // usage chunk
        let usage_chunk = chunks
            .iter()
            .find(|c| c["usage"]["completion_tokens"].as_i64() == Some(12));
        assert!(usage_chunk.is_some(), "should have usage chunk");
        // finish_reason 在含 choices 的最后一个 chunk 中
        let finish_chunk = chunks.iter().rev().find(|c| {
            c["choices"].as_array().map_or(false, |a| !a.is_empty())
                && c["choices"][0]["finish_reason"].as_str().is_some()
        });
        assert_eq!(finish_chunk.unwrap()["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test]
    async fn stream_tool_calls() {
        let tool_xml = tool_span(r#"[{"name": "f", "arguments": {}}]"#);
        let frames = make_ds_stream(&[(&tool_xml, "RESPONSE")], None);
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (tool_calls) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("===================================\n");
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        let has_tool_calls = chunks
            .iter()
            .any(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some());
        assert!(has_tool_calls, "should have a tool_calls chunk");
        let all_content: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert!(
            !all_content.contains(tool_parser::TOOL_CALL_START),
            "content should not contain tool_calls tags"
        );
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "tool_calls"
        );
    }

    #[tokio::test]
    async fn stream_fragmented_tool_calls_with_thinking() {
        let tool_xml = tool_span(r#"[{"name": "get_weather", "arguments": {"city": "北京"}}]"#);
        let frames = make_ds_stream(&[("思考中", "THINK"), (&tool_xml, "RESPONSE")], None);
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (fragmented_tool_calls_with_thinking) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("============================================================\n");
        assert!(chunks.len() >= 3);
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        // reasoning_content 应包含思考内容
        let all_reasoning: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["reasoning_content"].as_str())
            .collect();
        assert!(all_reasoning.contains("思考中"), "should contain 思考中");
        // 某个 chunk 应包含 tool_calls
        let has_tool_calls = chunks
            .iter()
            .any(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some());
        assert!(has_tool_calls, "should have a tool_calls chunk");
        let tc_chunk = chunks
            .iter()
            .find(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some())
            .unwrap();
        let calls = tc_chunk["choices"][0]["delta"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["function"]["name"], "get_weather");
        assert_eq!(calls[0]["function"]["arguments"], r#"{"city":"北京"}"#);
        // finish
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "tool_calls"
        );
    }

    #[tokio::test]
    async fn stream_with_tool_search_and_open() {
        let fixture = "event: ready\ndata: {}\n\n\
            data: {\"v\":{\"response\":{\"fragments\":[{\"type\":\"THINK\",\"content\":\"思考\"}]}}}\n\n\
            data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"id\":3,\"type\":\"TOOL_SEARCH\",\"content\":null,\"queries\":[{\"query\":\"q\"}],\"results\":[],\"stage_id\":1}]}\n\n\
            data: {\"p\":\"response/fragments/-2/results\",\"o\":\"SET\",\"v\":[{\"url\":\"https://example.com\",\"title\":\"ex\",\"snippet\":\"snip\"}]}\n\n\
            data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"id\":4,\"type\":\"TOOL_OPEN\",\"status\":\"WIP\",\"result\":{\"url\":\"https://open.com\",\"title\":\"open\",\"snippet\":\"open-snippet\"},\"reference\":{\"id\":3,\"type\":\"TOOL_SEARCH\"},\"stage_id\":1}]}\n\n\
            data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"type\":\"THINK\",\"content\":\"继续\"}]}\n\n\
            data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"type\":\"RESPONSE\",\"content\":\"\"}]}\n\n\
            data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\"hello\"}\n\n\
            data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n\
            event: finish\ndata: {}\n\n";
        let bytes_stream = futures::stream::iter(vec![sse_bytes(fixture)]);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (tool_search_and_open) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("=============================================\n");
        assert!(chunks.len() >= 3);
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        // 所有 reasoning 合并后应包含 "思考" 和 "继续"
        let all_reasoning: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["reasoning_content"].as_str())
            .collect();
        assert!(all_reasoning.contains("思考"), "should contain 思考");
        assert!(all_reasoning.contains("继续"), "should contain 继续");
        // 所有 content 合并后应为 "hello"
        let all_content: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert_eq!(all_content, "hello");
        // finish_reason
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "stop"
        );
    }

    #[tokio::test]
    async fn stream_include_obfuscation() {
        let frames = make_ds_stream(
            &[("这是一段足够长的中文文本用于测试混淆", "RESPONSE")],
            None,
        );
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: true,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (include_obfuscation) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!(
                "chunk[{i}] len={}:\n{}",
                serde_json::to_string(c).unwrap().len(),
                serde_json::to_string_pretty(c).unwrap()
            );
        }
        println!("============================================\n");
        assert!(chunks.len() >= 2);
        // 所有含 choices 且有 content 的 chunk 都应被动态 padding 到目标长度附近
        for c in &chunks {
            if c["choices"][0]["delta"]["content"].as_str().is_some()
                || c["choices"][0]["finish_reason"].as_str().is_some()
            {
                assert!(
                    c["choices"][0]["delta"]["obfuscation"].as_str().is_some(),
                    "chunk with content or finish_reason should have obfuscation"
                );
                let len = serde_json::to_string(c).unwrap().len();
                assert!(
                    len >= 490 && len <= 530,
                    "chunk len {} out of expected 490..=530 range",
                    len
                );
            }
        }
        // 内容完整
        let all_content: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert!(
            all_content.contains("足够长的中文文本"),
            "should contain expected text, got {all_content:?}"
        );
        // finish_reason
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "stop"
        );
    }

    #[tokio::test]
    async fn aggregate_tool_calls_with_leading_text() {
        let tool_xml = tool_span(r#"[{"name": "get_weather", "arguments": {"city": "beijing"}}]"#);
        let frames = make_ds_stream(
            &[("好的，我来帮你。", "RESPONSE"), (&tool_xml, "RESPONSE")],
            None,
        );
        let stream = futures::stream::iter(frames);
        let resp = aggregate(
            stream,
            "deepseek-default".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )
        .await
        .unwrap();
        let msg = &resp.choices[0].message;
        assert_eq!(msg.content.as_deref(), Some("好的，我来帮你。"));
        let calls = msg.tool_calls.as_ref().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.as_ref().unwrap().name, "get_weather");
        assert_eq!(
            calls[0].function.as_ref().unwrap().arguments,
            r#"{"city":"beijing"}"#
        );
        assert_eq!(resp.choices[0].finish_reason, Some("tool_calls"));
    }

    #[tokio::test]
    async fn stream_tool_calls_with_leading_text_fragmented() {
        let tool_xml = tool_span(
            r#"[{"name": "astrbot_execute_shell", "arguments": {"command": "cat /data/astrbot/skills/doubao-image-gen/SKILL.md"}}]"#,
        );
        let frames = make_ds_stream(
            &[
                ("好的，我来帮你用豆包生成图片。", "RESPONSE"),
                (&tool_xml, "RESPONSE"),
            ],
            None,
        );
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (tool_calls with leading text, fragmented) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("====================================================================\n");
        // 验证核心语义：前导文本 + tool_calls + finish_reason
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        // 所有 content 合并后应包含前导文本
        let all_content: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert!(
            all_content.contains("好的，我来帮你用豆包生成图片"),
            "should contain leading text, got {all_content:?}"
        );
        // 某个 chunk 应包含 tool_calls
        let has_tool_calls = chunks
            .iter()
            .any(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some());
        assert!(has_tool_calls, "should have a tool_calls chunk");
        let tc_chunk = chunks
            .iter()
            .find(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some())
            .unwrap();
        let calls = tc_chunk["choices"][0]["delta"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["function"]["name"], "astrbot_execute_shell");
        // finish
        let last = chunks.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
    }

    #[tokio::test]
    async fn stream_tool_calls_with_leading_text_multi_chunk_fragments() {
        let tool_xml = tool_span(r#"[{"name": "f", "arguments": {}}]"#);
        let frames = make_ds_stream(
            &[("让我来查一下。", "RESPONSE"), (&tool_xml, "RESPONSE")],
            None,
        );
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (leading text + multi-chunk JSON fragments) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("=============================================================\n");
        // 应该输出: role, leading text, tool_calls, finish
        for (i, c) in chunks.iter().enumerate() {
            eprintln!(
                "chunk[{}] content={:?} tool_calls={:?} finish={:?}",
                i,
                c["choices"][0]["delta"]["content"],
                c["choices"][0]["delta"]["tool_calls"],
                c["choices"][0]["finish_reason"]
            );
        }
        // 必须有 tool_calls chunk
        let has_tool_calls = chunks
            .iter()
            .any(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some());
        assert!(has_tool_calls, "should have a tool_calls chunk but didn't");
        let last = chunks.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
    }

    #[tokio::test]
    async fn stream_tool_calls_with_thinking_then_leading_text_then_fragmented_json() {
        // 最完整的生产场景：thinking -> leading text -> 碎片化 tool_calls
        let tool_xml = tool_span(r#"[{"name": "get_weather", "arguments": {"city": "beijing"}}]"#);
        let frames = make_ds_stream(
            &[
                ("用户要查天气，我需要调用工具", "THINK"),
                ("好的，我来帮你查一下。", "RESPONSE"),
                (&tool_xml, "RESPONSE"),
            ],
            None,
        );
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (thinking + leading + fragmented JSON) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("=============================================================\n");
        for (i, c) in chunks.iter().enumerate() {
            eprintln!(
                "chunk[{}] content={:?} reasoning={:?} tool_calls={:?} finish={:?}",
                i,
                c["choices"][0]["delta"]["content"],
                c["choices"][0]["delta"]["reasoning_content"],
                c["choices"][0]["delta"]["tool_calls"],
                c["choices"][0]["finish_reason"]
            );
        }
        // 必须有 tool_calls chunk
        let has_tool_calls = chunks
            .iter()
            .any(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some());
        assert!(has_tool_calls, "should have a tool_calls chunk but didn't");
        let last = chunks.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
    }

    #[tokio::test]
    async fn stream_tool_calls_json_split_right_after_tag() {
        let tool_xml = tool_span(r#"[{"name": "f", "arguments": {}}]"#);
        let frames = make_ds_stream(&[("好的。", "RESPONSE"), (&tool_xml, "RESPONSE")], None);
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (JSON split right after tool_call) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("=============================================================\n");
        let has_tool_calls = chunks
            .iter()
            .any(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some());
        assert!(has_tool_calls, "should have a tool_calls chunk but didn't");
        let last = chunks.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
    }

    #[tokio::test]
    async fn stream_tool_calls_no_leading_text() {
        let tool_xml = tool_span(r#"[{"name": "get_weather", "arguments": {"city": "beijing"}}]"#);
        let frames = make_ds_stream(&[(&tool_xml, "RESPONSE")], None);
        let bytes_stream = futures::stream::iter(frames);
        let chunks = collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "deepseek-default".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop: vec![],
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await;
        println!("\n=== STREAM CHUNKS (tool_calls, no leading text) ===");
        for (i, c) in chunks.iter().enumerate() {
            println!("chunk[{i}]:\n{}", serde_json::to_string_pretty(c).unwrap());
        }
        println!("===================================================\n");
        // 应该有 role chunk + tool_calls chunk + finish chunk
        for (i, c) in chunks.iter().enumerate() {
            eprintln!(
                "chunk[{}] content={:?} tool_calls={:?} finish={:?}",
                i,
                c["choices"][0]["delta"]["content"],
                c["choices"][0]["delta"]["tool_calls"],
                c["choices"][0]["finish_reason"]
            );
        }
        assert!(
            chunks.len() >= 2,
            "expected at least 2 chunks, got {}",
            chunks.len()
        );
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        // 找包含 tool_calls 的 chunk
        let tc_idx = chunks
            .iter()
            .position(|c| c["choices"][0]["delta"]["tool_calls"].as_array().is_some())
            .expect("should have a chunk with tool_calls");
        let tc_chunk = &chunks[tc_idx];
        let calls = tc_chunk["choices"][0]["delta"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["function"]["name"], "get_weather");
        assert_eq!(calls[0]["function"]["arguments"], r#"{"city":"beijing"}"#);
        // 最后一个 chunk 的 finish_reason 应该是 tool_calls
        let last = chunks.last().unwrap();
        assert_eq!(
        last["choices"][0]["finish_reason"], "tool_calls",
        "finish_reason should be tool_calls, got {:?}",
        last["choices"][0]["finish_reason"]
    );
    }

    // ── StopDetectStream 回归（stop 序列跨 chunk 边界） ──────────────────

    async fn run_stop_stream(pieces: &[(&str, &str)], stop: Vec<String>) -> Vec<serde_json::Value> {
        let frames = make_ds_stream(pieces, None);
        let bytes_stream = futures::stream::iter(frames);
        collect_chunks(to_bytes_stream(super::stream(
            bytes_stream,
            "m".into(),
            super::StreamCfg {
                include_usage: false,
                include_obfuscation: false,
                stop,
                prompt_tokens: 0,
                repair_fn: None,
                tag_config: default_tag_config(),
                session_id: None,
            },
        )))
        .await
    }

    fn joined_content(chunks: &[serde_json::Value]) -> String {
        chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect()
    }

    /// P0 回归：stop 序列跨 chunk 边界。旧实现把已转发前缀记进 sent_len 后
    /// 用 buffer[sent_len..pos] 截断——"abc" + "d"（stop="cd"）时 pos(2) <
    /// sent_len(3)，切片直接 panic；release 是 panic=abort，等于杀掉整个
    /// 服务进程。修复后 holdback 扣住末尾，命中时截在正确位置。
    #[tokio::test]
    async fn stream_stop_straddling_chunk_boundary() {
        // "abcd" 每 3 字符一片 → "abc" + "d"，stop="cd" 恰好跨片
        let chunks = run_stop_stream(&[("abcd", "RESPONSE")], vec!["cd".to_string()]).await;
        assert_eq!(joined_content(&chunks), "ab", "stop 前内容完整且不含 stop 序列");
        assert_eq!(chunks.last().unwrap()["choices"][0]["finish_reason"], "stop");
    }

    /// holdback 轮次：内容尾部被扣住，stop 在后续片上补全时一并截断
    #[tokio::test]
    async fn stream_stop_hit_after_holdback() {
        // "abxy" → "abx" + "y"，stop="xy" 从片 2 开始
        let chunks = run_stop_stream(&[("abxy", "RESPONSE")], vec!["xy".to_string()]).await;
        assert_eq!(joined_content(&chunks), "ab");
        assert_eq!(chunks.last().unwrap()["choices"][0]["finish_reason"], "stop");
    }

    /// 中文 stop 序列 + 短内容：holdback 字节数可能大于 buffer，
    /// 旧修复（减法下溢）与新行为都要保证不 panic、内容最终完整冲出去
    #[tokio::test]
    async fn stream_no_stop_flushes_multibyte_tail_at_end() {
        // "结果好" 9 字节按 3 字节切片；stop="结束" 6 字节 → holdback=5，
        // 第一片（3 字节）时 buffer 比 holdback 还短
        let chunks = run_stop_stream(&[("结果好", "RESPONSE")], vec!["结束".to_string()]).await;
        assert_eq!(joined_content(&chunks), "结果好", "未命中 stop 时内容必须完整（含 holdback 残余）");
        // finish_reason 由 converter 合并在最后一个上游内容 chunk 上；
        // holdback 残余经合成 chunk 在其后冲出（finish_reason=None），
        // 所以这里断言「finish 出现过」而不是「最后一个 chunk 带 finish」
        assert!(
            chunks
                .iter()
                .any(|c| c["choices"][0]["finish_reason"] == "stop"),
            "应有 finish_reason=stop"
        );
    }

    /// 中文内容命中中文 stop：截断点必须落在字符边界
    #[tokio::test]
    async fn stream_stop_multibyte_boundary() {
        let chunks = run_stop_stream(&[("结果结束", "RESPONSE")], vec!["结束".to_string()]).await;
        assert_eq!(joined_content(&chunks), "结果");
        assert_eq!(chunks.last().unwrap()["choices"][0]["finish_reason"], "stop");
    }

    /// 无 stop 配置时行为与旧版逐字节一致（回归保护：holdback 路径不启用）
    #[tokio::test]
    async fn stream_no_stop_passthrough() {
        let chunks = run_stop_stream(&[("hello 世界", "RESPONSE")], vec![]).await;
        assert_eq!(joined_content(&chunks), "hello 世界");
        assert_eq!(chunks.last().unwrap()["choices"][0]["finish_reason"], "stop");
    }
}
