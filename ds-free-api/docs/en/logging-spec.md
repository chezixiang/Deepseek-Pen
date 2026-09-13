# Logging System Specification

## Principles

1. **Library code zero output**: Library modules like `ds_core/` only use the `log` crate, never print directly to stdout/stderr
2. **Caller control**: Log levels, format, and output targets are determined by the application layer (main.rs / examples)
3. **Structured target**: Module-level filtering via target paths

## Log Levels

| Level | Usage Scenario | Example |
|-------|----------------|---------|
| `ERROR` | Fatal errors requiring human intervention | All account initialization failed, PoW computation crash, configuration error |
| `WARN` | Degraded but recoverable exceptions | Single account initialization failure, session cleanup failure, rate limiting, account pool exhaustion, SSE stream interruption, tool_parser parse failure triggering repair |
| `INFO` | Key lifecycle events | Account initialization succeeded, service start/shutdown |
| `DEBUG` | Debug information | HTTP request/response summary, account allocation, SSE event type |
| `TRACE` | Finest granularity data | Raw SSE event content, Anthropic transformation details |

## Target Specification

Format: `crate::module` or `crate::module::submodule`

| Module | Target | Description |
|--------|--------|-------------|
| `ds_core::accounts` | `ds_core::accounts` | Account pool lifecycle, allocation, health check, rate limit detection |
| `ds_core::client` | `ds_core::client` | HTTP request/response, API calls |
| `ds_core::completions` | `ds_core::accounts` | Dialog orchestration, SSE stream processing, stop_stream (shares target with accounts) |
| `ds_core::pow` | `ds_core::accounts` | PoW computation (shares target with accounts) |
| `openai_adapter` | `adapter` | OpenAI protocol adaptation layer (request parsing, response transformation, SSE parsing, tool_parser) |
| `anthropic_compat` | `anthropic_compat` | Anthropic protocol compatibility layer entry |
| `anthropic_compat::request` | `anthropic_compat::request` | Anthropic → OpenAI request mapping |
| `anthropic_compat::models` | `anthropic_compat::models` | Anthropic model list |
| `anthropic_compat::response::stream` | `anthropic_compat::response::stream` | Anthropic streaming response transformation |
| `anthropic_compat::response::aggregate` | `anthropic_compat::response::aggregate` | Anthropic non-streaming response aggregation |
| `server` | `http::server` | Service lifecycle (startup, shutdown signals) |
| `server::handlers` | `http::request` / `http::response` | HTTP request summary (path, stream flag), response summary (status code, bytes) |
| `server::error` | `http::response` | HTTP error response (status code, error message) |
| `server::stream` | `http::response` | SSE stream errors |

## Code Conventions

### Library Code (ds_core/)

```rust
use log::{info, debug, warn, error};

// INFO: 关键生命周期
info!(target: "ds_core::accounts", "账号 {} 初始化成功", display_id);

// WARN: 单个失败可降级
warn!(target: "ds_core::accounts", "账号 {} 初始化失败: {}", display_id, e);

// WARN: 限流 / 账号耗尽
warn!(target: "ds_core::accounts", "req={} 账号池无可用账号: model_type={}", request_id, model_type);

// ERROR: 所有账号全部失败
error!(target: "ds_core::accounts", "所有账号初始化失败");

// DEBUG: PoW 调试信息
debug!(target: "ds_core::accounts", "health_check model_type={}", model_type);
```

### Response Transformation Layer (openai_adapter/)

```rust
use log::{debug, info, trace, warn};

// DEBUG: 适配器入口（请求开始处理）
debug!(target: "adapter", "req={} 适配器开始处理: model={}, stream={}", request_id, model, stream);

// DEBUG: 响应管道初始化
debug!(target: "adapter", "构建流式响应: model={}, include_usage={}, include_obfuscation={}, stop_count={}, repair={}", model, usage, obfuscation, stop, repair);

// DEBUG: 非流式响应聚合完成
debug!(target: "adapter", "非流式响应聚合完成: finish_reason={:?}, has_tool_calls={}", reason, has_tc);

// TRACE: 原始 SSE 事件
trace!(target: "adapter", "<<< {} {}", event, data);

// TRACE: 状态机帧输出
trace!(target: "adapter", ">>> state: {frame}");

// TRACE: 转换器增量
trace!(target: "adapter", ">>> conv: content delta len={}", len);

// TRACE: 序列化后的 chunk
trace!(target: "adapter", ">>> {}", chunk_json);

// WARN: SSE 流中断（上游连接异常）
warn!(target: "adapter", "SSE 流错误: {}", e);

// WARN: tool_parser 解析失败→请求修复
warn!(target: "adapter", "tool_parser 解析失败→请求修复");

// WARN: 转换器流提前结束
warn!(target: "adapter", "转换器流提前结束: model={}, usage_value={:?}", model, usage);

// WARN: 工具调用修复失败
warn!(target: "adapter", "tool_calls 修复失败: {}", e);

// INFO: 重试成功
info!(target: "adapter", "req={} 第 {} 次重试成功", request_id, attempt);

// DEBUG: 正常解析
debug!(target: "adapter", "tool_parser 解析出 {} 个工具调用", count);
```

### Orchestration Layer (ds_core/completions + accounts)

```rust
use log::{debug, error, info, trace, warn};

// INFO: 账号初始化关键事件
info!(target: "ds_core::accounts", "账号 {} 初始化成功", display_id);

// DEBUG: 请求编排过程
debug!(target: "ds_core::accounts", "req={} 分配账号: model_type={}", request_id, model_type);
debug!(target: "ds_core::accounts", "req={} 创建 session: id={}", request_id, session_id);
debug!(target: "ds_core::accounts", "req={} completion PoW 计算完成", request_id);
debug!(target: "ds_core::accounts", "req={} SSE ready: resp_msg={}", request_id, stop_id);

// TRACE: 原始 SSE 字节
trace!(target: "ds_core::accounts", "req={} <<< ({} bytes) {}", request_id, len, content);

// WARN: 账号初始化失败（单个可降级）
warn!(target: "ds_core::accounts", "账号 {} 初始化失败: {}", display_id, e);

// WARN: 账号池耗尽
warn!(target: "ds_core::accounts", "req={} 账号池无可用账号", request_id);

// WARN: 限流 / 上传失败
warn!(target: "ds_core::accounts", "req={} hint 限流: rate_limit_reached", request_id);

// ERROR: 所有账号全部失败
error!(target: "ds_core::accounts", "所有账号初始化失败");
```

### Application Layer (examples/ / main.rs / server/)

```rust
// DEBUG: HTTP 请求摘要（handler 入口）
debug!(target: "http::request", "req={} POST /v1/chat/completions stream={}", req_id, stream);

// DEBUG: HTTP 响应摘要（handler 出口）
debug!(target: "http::response", "req={} 200 JSON response {} bytes", req_id, len);

// ERROR: SSE 流错误（响应发送阶段）
error!(target: "http::response", "SSE stream error: {}", e);
```

## Runtime Control

```bash
# Default level (info)
just serve

# Debug mode - see all debug logs
RUST_LOG=debug just serve

# Module-level filtering - only accounts debug
RUST_LOG=ds_core::accounts=debug just serve

# Multi-level combination - debug for accounts, warn for others
RUST_LOG=ds_core::accounts=debug,ds_core::client=warn,info just serve

# Completely silent (errors only)
RUST_LOG=error just serve

# Output to file
RUST_LOG=debug just serve 2> server.log

# Focus on rate limit events and request tracing
RUST_LOG=ds_core::accounts=debug,adapter=warn just serve
```

## Prohibitions

- ❌ Using `println!` / `eprintln!` directly in library code
- ❌ Using log macros without a target (e.g. `log::info!` without target)
- ❌ Printing sensitive information (tokens, passwords) in logs
- ❌ High-frequency TRACE logs (e.g. every SSE byte) enabled by default

## Dependencies Configuration

**Cargo.toml**
```toml
[dependencies]
log = "0.4"

[dev-dependencies]
env_logger = { version = "0.11", default-features = false, features = ["auto-color"] }
```

Note: The `auto-color` feature automatically adds colors in terminals and automatically disables them in non-TTY environments.
