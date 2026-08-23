# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.6] - 2026-05-05

### Added
- **Web 管理面板**：基于 Vite + React + shadcn/ui 的 SPA，含登录、Dashboard 概览页、配置编辑页。
  `PUT /admin/api/config` 统一替代旧 keys/accounts CRUD / reload / relogin 等 6 个分散端点。
  配置编辑支持 Server、DeepSeek、模型类型、工具调用标签、代理、账号、API Keys 七节编辑，
  账号和 Keys 常驻展开，其余默认折叠。
- **管理后台安全**：`auth.rs` JWT 签发/验证（HMAC + SHA256），管理员密码设置与登录，
  密码 bcrypt 哈希存储，登录频率限制。
- **Config 管理增强**：
  - 配置自动创建：配置文件不存在时自动生成最小配置写入磁盘
  - `Config::save()` 原子写入（tmp + rename + 0600 权限）
  - `Config` 改为 `Arc<RwLock<Config>>`，运行时可变，管理面板变更自动持久化
  - `DS_CONFIG_PATH` 环境变量，优先级：`-c` > `DS_CONFIG_PATH` > 默认 `config.toml`
  - 配置归并：`admin.json`、`api_keys.json` 合并到 `config.toml` 的 `[admin]` / `[[api_keys]]` 节
  - PUT 配置合并保护：密码/key 为 `***`/空值时自动保留当前值
- **Docker 部署**：`docker/Dockerfile`（alpine:3.21，musl 静态编译，~20MB 镜像）、
  `docker/docker-compose.yaml`、`docker/config.example.toml`（host = 0.0.0.0，空账号）。
  镜像发布到 ghcr.io。
- **重试全链路日志**：`try_chat()` 每次 Overloaded 退避重试输出 WARN 日志（含尝试次数和等待时间），
  重试成功输出 INFO，全部失败输出 WARN 终结日志
- **WAF 友好提示**：检测到 AWS WAF Challenge 时输出清晰的双语提示，替代原有的无意义错误
- **账号自动去重**：启动时按 email（优先）或 mobile 去重
- **`X-Client-Locale` 请求头**：DeepSeekConfig 新增 `client_locale` 字段，默认 `zh_CN`
- **代理配置**：`[proxy]` 配置项，支持 HTTP/HTTPS/SOCKS5
- **CI build-frontend 独立 job**：产物供后端 check/test 使用，确保编译嵌入真实前端文件
- **GPL-3.0 许可证**

### Changed
- **HTTP 客户端**：`reqwest`（rustls）→ `rquest`（BoringSSL + Chrome 136 TLS 指纹模拟）。
  替换后 TLS 握手指纹模拟 Chrome 136 浏览器，配合 Android 请求头绕过 WAF 指纹检测
- **默认端口**：`5317` → `22217`，避开 Win10 Hyper-V 动态端口保留区间（5000–6000）
- **默认请求头**：全面切换为 DeepSeek Android 客户端格式 ——
  `User-Agent: DeepSeek/2.0.4 Android/35`、`X-Client-Version: 2.0.4`、`X-Client-Platform: android`
- **wasmtime**：43.0.0 → 44.0.0，修复安全通告 RUSTSEC-2026-0114
- **`model_aliases` 类型**：`HashMap<String, String>` → `Vec<String>`，按 index 对齐 `model_types`
- **`/` 根路径**：从 JSON 端点列表改为 302 重定向到 `/admin`
- **stderr 彩色日志**：TRACE=紫、INFO=绿、WARN=黄、ERROR=红、DEBUG=蓝，仅终端连接时启用
- **handler/store 重构**：
  - `chat_completions` / `anthropic_messages` 统计日志提取为 `AppState::record_request()`
  - `admin_setup` / `admin_login` 从各 ~50 行压缩到 ~12 行
  - `admin_reload_config` 从 ~70 行压缩到 ~10 行
  - `StoreManager` 从读写独立 JSON 改为委托共享 `Arc<RwLock<Config>>`
- **CI 构建重构**：
  - `build-frontend` 独立 job，check/test 通过 `needs` 依赖前端产物
  - `cross` 升级到 0.2.5，aarch64-linux-gnu/musl 迁移到原生 ARM 运行器（`ubuntu-24.04-arm`）
  - `actions-rust-lang/setup-rust-toolchain` 替换 `dtolnay/rust-toolchain`
  - `just check-web` 新增前端校验命令（npm ci + build + lint）
- **过时内容清除**：
  - 移除 6 个分散管理端点（keys CRUD / accounts CRUD / reload / relogin）
  - 移除 `sse_stream()` / `SseSerializer`（流式响应全面改用 `inspect`/`map`/`TokenGuardStream`）
  - 移除 `StopStream` / repetition detection
  - 移除 `.dockerignore`、根目录 `Dockerfile` / `docker-compose.yml`
  - 移除 `web/config.toml` 等无用旧文件

### Removed
- `reqwest` 依赖
- `admin.json`、`api_keys.json` 独立文件（合并入 `config.toml`）
- 启动时 `accounts.is_empty()` 验证（无账号通过管理面板补充）
- `DS_CONFIG` 环境变量（由 `DS_CONFIG_PATH` 替代）
- `web/config.toml`

### Fixed
- **CI 幂等性**：`cargo install` 步骤添加 `command -v` 前置检查
- **client.rs 日志违规**：`print_waf_hint()` 中 11 条 `warn!` 补全 target 参数
- **stats.json 空文件**：不再触发 EOF 解析 WARN，降级为 INFO
- **e2e 端口硬编码**：runner.py / stress_runner.py 改为从 config.toml 动态读取端口
- **AGENTS.md 过时内容**：`/` 端点描述、`[[server.api_tokens]]` → `[[api_keys]]`、WASM 故障排查等

### Docs
- **README / README.en.md**：新增环境变量表格；设计哲学补充"非必要不引入额外运行时系统依赖"；管理面板截图
- **`docs/en/`**：英文文档目录，所有文档提供英文版
- **`docs/development.md` / `docs/en/development.md`**：构建、Docker、e2e 测试开发指南
- **Prompt injection 策略**：更新 README 中 DeepSeek 原生标签注入策略说明
- **CLAUDE.md / AGENTS.md**：架构描述精简，新增故障排除表、请求追踪 grep 示例、`#[allow]` 策略说明

## [0.2.5] - 2026-04-30

### Added
- **文件上传**：支持通过 API 上传文件/图片到 DeepSeek。OpenAI 端点的 `file` / `image_url` content part
  和 Anthropic 端点的 `document` / `image` content block 均可使用。内联 data URL 自动上传，
  HTTP URL 触发搜索模式，由模型自行访问
- **XML `<invoke>` 格式原生解析**：直接解析 `<invoke name="..."><parameter>` 格式的工具调用，
  无需触发修复管道，响应更快
- **流式工具调用保活**：模型生成工具调用期间（通常 2–10s），每 1s 发送空增量块防止客户端超时。
  OpenAI 端点为空 `tool_calls` delta，Anthropic 端点为 `"tool_calls..."` thinking 块
- **工具调用标签用户自维护**：`config.toml` 新增 `[deepseek.tool_call]` 配置项，
  用户可随时追加新发现的模型幻觉标签，无需等待代码更新

### Changed
- **Prompt 格式升级**：从 ChatML（`<|im_start|>` / `<|im_end|>`）全面迁移到 DeepSeek 原生标签格式。
  每次 `<｜User｜>` 前插入 `<｜end▁of▁sentence｜>` 闭合上一轮；工具结果改用 `<｜tool▁outputs▁begin｜>` 包裹；
  reminder 嵌入 `<think>` 块。与 DeepSeek 官方 chat_template 对齐后，模型遵循度明显提升
- **工具调用主标签变更**：从 `<|tool_calls_begin|>` 改为 `<|tool▁calls▁begin|>` / `<|tool▁calls▁end|>`
  （使用 ASCII `|` + `▁`）。模型输出这个标签的概率大幅高于旧标签，幻觉变体明显减少。
  默认回退标签覆盖已知变体：`<|tool_calls_begin|>`、`<|tool▁calls_begin|>`、`<|tool_calls▁begin|>`、`<tool_call>`
- **智能搜索默认开启**：搜索模式下 DeepSeek 注入的系统提示词更强，能提升工具调用遵循度

### Fixed
- **Anthropic 协议兼容性**：`message_start` 补回 `stop_reason: null` / `stop_sequence: null`；
  `message_delta` 始终携带 `usage.output_tokens`；usage 不再始终为 0。
  以上修复解决 Claude Code 等标准 Anthropic 客户端的兼容性问题
- **文件上传错误处理**：历史对话文件上传失败时自动回退为内联 prompt，不再静默丢失上下文；
  外部文件上传失败直接返回明确错误，不再静默跳过
- **修复模型准确度**：自修复请求现在自动携带工具定义列表和 JSON 转义提示，
  模型从破碎文本推测正确参数的能力明显提升

## [0.2.4] - 2026-04-27

### Added
- **历史对话文件化**：多轮对话历史自动拆分上传为独立文件，绕过 DeepSeek 单次输入长度限制。
  对适配器层完全透明，上传失败不影响主流程，自动退化为纯文本发送
- **临时 Session 生命周期**：每次请求创建独立 session，请求结束自动清理（stop_stream + delete_session），
  彻底杜绝 session 泄漏和 TTL 过期残留
- **工具调用自修复**：当模型输出的 tool_calls 格式异常时，使用 DeepSeek 自身修复损坏的 JSON/XML，
  流式和非流式路径均覆盖，大幅提升工具调用成功率
- **arguments 类型归一**：自动处理 arguments 为 JSON 字符串的异常情况，避免客户端双重转义解析失败
- **`input_exceeds_limit` 检测**：识别输入超长错误并返回明确错误信息，不再静默失败
- **全链路日志追踪**：`req-{n}` 标识贯穿 handler → adapter → ds_core 全层，
  `x-ds-account` 响应头标识处理账号，单次请求可完整 grep 追踪
- **TRACE 级别字节追踪**：流管道各层 TRACE 日志，可观察字节在 SSE 管道中的完整转换过程
- **`/` 端点**：免鉴权返回可用端点列表和项目地址
- **e2e 测试重构**：从 pytest 迁移为 JSON 场景驱动框架，场景独立存放，配置动态读取

### Changed
- **请求流程重构**：从"持久 session + edit_message"升级为"临时 session + completion + 文件上传"，
  每次请求独立生命周期，不再依赖预创建的持久 session
- **限流自动重试**：检测到 rate_limit 时以 1s→2s→4s→8s→16s 指数退避自动重试（最多 6 次），
  对用户透明，大幅降低限流导致的请求失败
- **Prompt 构建优化**：reminder 插入位置调整到最后一轮对话之前，确保模型优先遵循指令；
  工具描述的代码块格式化；工具调用结果的 Markdown 结构化展示
- **推理控制语义修正**：禁用思考时使用 `"none"` 替代 `"minimal"`，语义更明确
- **日志级别规范化**：账号池耗尽提升为 `WARN`，常规分配降为 `DEBUG`，
  新增 session/上传/PoW 等 debug 日志，health_check 合并为单条带耗时日志

### Removed
- 账号初始化不再按 model_type 管理 session，移除 session 持久化和 update_title 逻辑
- 移除旧 pytest e2e 测试目录（被 JSON 场景驱动框架替代）

### Test Results

#### py-e2e-tests
- **4 账号 + 3 并发 + 3 迭代**：17 场景 × 2 模型 × 3 次 = 102 次请求，成功率 100%，总耗时 5.5 分钟
- 覆盖场景：基础对话、深度思考、流式、标准工具调用，以及 10 种 tool_calls 损坏格式
  （XML/JSON 混合、字段名不一致、arguments 字符串、括号不匹配/缺失、
  name/arguments 互换、参数外溢等），修复管道全部正确兜底

#### claude-code 测试
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5317/anthropic
export ANTHROPIC_AUTH_TOKEN=sk-test
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-expert
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-expert
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-default
claude
```
- 基本稳定, 工具解析时会使得claude-code暂时卡住是正常现象, 部分情况可能出现模型不遵循指令导致工具调用指令泄漏
- 其他编程工具没有大量测试, 希望大家积极反馈

## [0.2.3] - 2026-04-24

### Added
- Tool call XML 解析增强：增加 `repair_invalid_backslashes` 与 `repair_unquoted_keys`
  宽松修复，当模型输出的 JSON 包含未引号 key 或无效转义时自动修复后重试
- 增加 `is_inside_code_fence` 检查：跳过 markdown 代码块中的工具示例，防止误解析
- 新增 Anthropic 协议压测脚本 `stress_test_tools_anthropic.py`，与 OpenAI 版对称
- 示例文件正交化：`examples/adapter_cli/` 下按功能拆分为
  `basic_chat`/`stream`/`stop`/`reasoning`/`web_search`/`reasoning_search`/`tool_call` 等独立文件
- 默认 adapter-cli 配置文件路径指向 `py-e2e-tests/config.toml`

### Changed
- 账号池选择策略：从**轮询线性探测**改为**空闲最久优先**，最大化账号复用间隔
- 移除固定的冷却时间常量，选择算法天然避免账号被过快重用
- 同步更新中英文 README，增加并发经验说明

### Stress Test Results

针对 4 账号池的 70 请求压测（7 场景 × 2 模型 × 5 迭代）：

| 策略 | 并发 | 成功率 | 平均耗时 |
|------|------|--------|----------|
| 轮询 + 无冷却 | 3 | 25.7% | 2.57s |
| 轮询 + 2s 冷却 | 3 | 97.1% | 10.46s |
| **空闲最久优先 + 无冷却** | **2** | **100%** | **10.14s** |
| **空闲最久优先 + 无冷却 (Anthropic)** | **2** | **100%** | **11.31s** |

结论：稳定安全并发 ≈ 账号数 ÷ 2，空闲最久优先策略可在不设冷却的前提下实现 100% 成功率。

## [0.2.2] - 2026-04-22

### Added
- Anthropic Messages API 兼容层：
  - `/anthropic/v1/messages` streaming + non-streaming 端点
  - `/anthropic/v1/models` list/get 端点（Anthropic 格式）
  - 请求映射：Anthropic JSON → OpenAI ChatCompletion
  - 响应映射：OpenAI SSE/JSON → Anthropic Message SSE/JSON
- OpenAI adapter 向后兼容：
  - 已弃用的 `functions`/`function_call` 自动映射为 `tools`/`tool_choice`
  - `response_format` 降级：在 ChatML prompt 中注入 JSON/Schema 约束（`text` 类型为 no-op）
- CI 发布流程改进：
  - tag 触发 release（`push.tags v*`）
  - CHANGELOG 自动提取版本说明
  - 发布前校验 Cargo.toml 版本与 tag 一致

### Changed
- Rust toolchain 升级到 1.95.0，CI workflow 同步更新
- justfile 添加 `set positional-arguments`，安全传递带空格的参数
- Python E2E 测试套件重组为 `openai_endpoint/` 和 `anthropic_endpoint/`
- 启动日志显示 OpenAI 和 Anthropic base URLs
- README/README.en.md 添加 SVG 图标、GitHub badges、同步文档
- LICENSE 添加版权声明 `Copyright 2026 NIyueeE`
- CLAUDE.md/AGENTS.md 同步更新

### Fixed
- Anthropic 流式工具调用协议：使用 `input_json_delta` 事件逐步传输工具参数
- Tool use ID 映射一致性：`call_{suffix}` → `toolu_{suffix}`
- Anthropic 工具定义兼容：处理缺少 `type` 字段的情况（Claude Code 客户端）

## [0.2.1] - 2026-04-15

### Added
- 默认开启深度思考：`reasoning_effort` 默认设为 `high`，搜索默认关闭。
- WASM 动态探测：`pow.rs` 改为基于签名的动态 export 探测，不再硬编码 `__wbindgen_export_0`，降低 DeepSeek 更新 WASM 后启动失败的风险。
- 新增 Python E2E 测试套件：覆盖 auth、models、chat completions、tool calling 等场景。
- 新增 `tiktoken-rs` 依赖，用于服务端 prompt token 计算。
- CI 新增 `cargo audit` 与 `cargo machete` 检查。

### Changed
- 账号初始化优化：日志在手机号为空时自动回退显示邮箱。
- 更新 `axum`、`cranelift` 等核心依赖至最新 patch 版本。
- Client Version 保持与网页端一致的 `1.8.0`。

### Removed
- 移除未使用的 `tower` 依赖。

## [0.2.0] - 2026-04-13

### Added
- 项目从 Python 全面重构到 Rust，带来原生高性能和跨平台支持。
- OpenAI 兼容 API（`/v1/chat/completions`、`/v1/models`）。
- 账号池轮转 + PoW 求解 + SSE 流式响应。
- 深度思考和智能搜索支持。
- Tool calling（XML 解析）。
- GitHub CI + 多平台 Release（8 目标平台）。
- 兼容最新 DeepSeek Web 后端接口。
