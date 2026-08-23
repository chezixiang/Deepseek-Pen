# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file serves dual duty as both `AGENTS.md` (the real file) and `CLAUDE.md` (symlink → `AGENTS.md`).
> Edit `AGENTS.md` directly; `CLAUDE.md` stays in sync automatically.

---

## Project Overview

Rust API proxy exposing free DeepSeek model endpoints. Translates standard OpenAI-compatible and Anthropic-compatible requests to DeepSeek's internal protocol with account pool rotation, PoW challenge handling, and streaming response support.

**Runtime:** Rust **1.95.0** (pinned in `rust-toolchain.toml`) with **edition 2024**.

**Key dependencies and why they exist:**
- `wasmtime` — executes DeepSeek's PoW WASM solver; the entire PoW system depends on this
- `tiktoken-rs` — client-side prompt token counting (DeepSeek returns 0 for `prompt_tokens`)
- `pin-project-lite` — underpins every streaming response wrapper (`SseStream`, `StateStream`, etc.)
- `axum` / `rquest` — HTTP server and client respectively; `rquest` uses BoringSSL with Chrome 136 TLS fingerprint for WAF bypass
- `tokio` with `signal` feature — async runtime with graceful shutdown on SIGTERM/SIGINT

---

## Architecture

### Module Structure

```
src/
├── main.rs              # Binary entry (~10 lines): init runtime_log, parse CLI (load_with_args), run server
├── lib.rs               # Public API surface: re-exports Config, DeepSeekCore, OpenAIAdapter, etc.
├── config.rs            # Config load/save from config.toml (-c / DS_CONFIG_PATH), Arc<RwLock<Config>>
│
├── ds_core/             # DeepSeek implementation facade (src/ds_core.rs)
│   ├── ds_core.rs       # Facade: DeepSeekCore, CoreError; declares submodules
│   ├── accounts.rs      # Account pool: init validation, idle-aware selection, AccountGuard (Drop → release)
│   ├── pow.rs           # PoW solver: wasmtime WASM loader, DeepSeekHashV1 computation
│   ├── completions.rs   # Chat orchestration: create_session → upload → PoW → stream → GuardedStream
│   └── client.rs        # Raw HTTP client: API endpoints, Envelope parsing, zero business logic
│
├── openai_adapter/      # OpenAI protocol adapter facade (src/openai_adapter.rs)
│   ├── openai_adapter.rs # Facade: OpenAIAdapter, OpenAIAdapterError, StreamResponse
│   ├── types.rs         # Request/response structs (ChatCompletionsRequest, etc.)
│   ├── models.rs        # Model registry and listing endpoints
│   ├── request/         # Request pipeline: normalize → tools → files → prompt → resolver → tiktoken
│   │   ├── request.rs   # Facade for submodules
│   │   ├── normalize.rs # Validation, default params
│   │   ├── tools.rs     # Tool definition → prompt injection
│   │   ├── files.rs     # Data URL → FilePayload, HTTP URL → search mode
│   │   ├── prompt.rs    # ChatML → DeepSeek native tags, tool injection
│   │   ├── resolver.rs  # Model resolution, capability toggles
│   │   └── tiktoken.rs  # Token counting
│   └── response/        # Response pipeline: sse_parser → state → converter → tool_parser
│       ├── response.rs  # Facade + StreamCfg struct
│       ├── sse_parser.rs    # SseStream: raw bytes → SseEvent (event+data)
│       ├── state.rs         # StateStream: DeepSeek JSON patches → DsFrame
│       ├── converter.rs     # ConverterStream: DsFrame → ChatCompletionsResponseChunk
│       ├── tool_parser.rs   # ToolCallStream: XML tag detection, sliding-window repair
│
├── anthropic_compat/    # Anthropic protocol translator (on top of openai_adapter)
│   ├── anthropic_compat.rs # Facade
│   ├── request.rs       # Anthropic JSON → OpenAI request mapping
│   └── response/
│       ├── stream.rs    # OpenAI SSE → Anthropic SSE events
│       └── aggregate.rs # OpenAI JSON → Anthropic JSON
│

└── server/              # HTTP server facade (src/server.rs)
    ├── server.rs        # Facade: axum router, auth middleware, graceful shutdown
    ├── admin.rs         # Admin panel route handlers (setup, login, config, stats, keys, models)
    ├── auth.rs          # JWT sign/verify, password setup/login, login rate limiter
    ├── error.rs         # ServerError: API error JSON responses
    ├── handlers.rs      # Business route handlers (OpenAI + Anthropic)
    ├── runtime_log.rs   # File log redirection (stdout → runtime.log)
    ├── stats.rs         # Request stats recording (RequestStats, StatsHandle)
    ├── store.rs         # StoreManager: delegates admin/keys to Config::save(), stats → stats.json
    └── stream.rs        # SseBody: wraps StreamResponse → axum::body::Body
```
**Additional resources:**
- `config.example.toml` — authoritative configuration reference with all fields documented
- `examples/adapter_cli.rs` + `examples/adapter_cli/` — debug CLI + JSON request samples
- `py-e2e-tests/` — Python e2e test suite (uv-managed, JSON-driven scenarios)
- `docs/` — `code-style.md`, `logging-spec.md`, `deepseek-prompt-injection.md`, `deepseek-api-reference.md`

### Binary / Library Split

`main.rs` is a ~10-line wrapper: init `runtime_log`, read `DS_DATA_DIR`, parse CLI args via `Config::load_with_args()` → `(Config, PathBuf)`, call `server::run(config, config_path)`. The crate can be built both as a library (`cargo build --lib`) and a binary (`cargo build --bin ds-free-api`). `lib.rs` defines the full public API surface.

### Facade Module Pattern

`ds_core.rs`, `openai_adapter.rs`, `server.rs`, `request.rs`, `response.rs`, and `anthropic_compat.rs` are **facades**:
- They declare submodules with `mod` (keeping implementation private)
- They re-export only the minimal public interface via `pub use`
- They sometimes contain `#[cfg(test)]` test modules

This means the file tree does not directly map to the public API. To understand what a module exposes externally, read its facade file, not the directory listing.

### StreamResponse Type

`StreamResponse` is the unifying bridge between adapter layers and the HTTP server:
- Every adapter's streaming method returns `StreamResponse` (a boxed `Stream<Item = Result<Bytes>> + Send`)
- `server/stream.rs::SseBody` wraps `StreamResponse` and converts it into an `axum::body::Body`
- This decouples the adapters from the HTTP framework — they produce bytes, the server handles SSE framing


### CI Build Pipeline

On tag push (`.github/workflows/release.yml`):

```
build-frontend (npm ci + npm run build)
build-frontend (npm ci + npm run build)
  ├── build-linux-gnu (cargo build)    │
  ├── build-linux-musl (cross/cargo)   │── release (tar.gz + zip)
  ├── build-macos (cargo build)  │
  └── build-windows (cargo build)│
  └── docker (ghcr.io image)
```

`build-frontend` produces a `web-dist` artifact. Each build job downloads it before
compiling Rust, so `rust_embed` embeds the real frontend assets.

### Frontend (`web/`)

Vite + React + shadcn/ui SPA under `web/`. Built by `npm run build` in `web/`.
The binary embeds `web/dist/` via `rust_embed` at compile time.

```
web/
├── src/
│   ├── App.tsx            # Routes (login + protected layout + pages)
│   ├── lib/api.ts         # Typed API client for all admin endpoints
│   ├── lib/auth.tsx       # JWT auth context (localStorage token)
│   ├── pages/             # ConfigPage, DashboardPage, Layout, LoginPage, LogsPage, ModelsPage
│   └── components/ui/     # shadcn/ui primitives (badge, button, card, input, etc.)
├── public/favicon.svg     # → symlink to assets/logo.svg
├── index.html
├── package.json
└── vite.config.ts
```

**Admin panel config editor**: `ConfigPage.tsx` fetches from `GET /admin/api/config`,
edits all sections (accounts, api_keys, server, deepseek, models, proxy, tool_call tags),
submits via `PUT /admin/api/config` (full replace + hot-reload). Passwords/key values
sent as `***`/empty are merged with existing values server-side.

**Dev mode (HMR)**: Run `cd web && npm run dev` (Vite HMR) alongside `just serve`.
Backend reads from `web/dist/` filesystem when available.
---

## Principles

### 1. Single Responsibility
Every module has one job. Cross-module boundaries are strict:
- `config.rs`: Configuration load & save only, no client creation or business logic
- `client.rs`: Raw HTTP calls only, no token caching, retry, or SSE parsing
- `accounts.rs`: Account pool management only, no network requests
- `pow.rs`: WASM computation only, no account management or request sending
- `anthropic_compat.rs`: Protocol translation only, no direct `ds_core` access

### 2. Minimal Viable
- No premature abstractions: Extract traits/structs when needed, not before
- No redundant code: Remove unused imports, avoid over-documenting, no pre-written tests
- Delay dependency introduction: only add deps when actually needed

### 3. Control Complexity
- Explicit over implicit: Dependencies injected via parameters, no global state
- Composition over inheritance: Small modules composed via functions, no deep inheritance
- Clear boundaries: Modules interact via explicit interfaces, no internal logic leakage

---

## Key Architectural Patterns

### Account Pool Model

1 account = 1 session = 1 concurrency. Scale via more accounts in `config.toml`.

`AccountGuard` wraps `Arc<Account>`. It marks account as `busy` (via `AtomicBool`) on creation and releases on `Drop`. Held in `GuardedStream` to keep account busy during streaming.

### Account Initialization Flow

`AccountPool::init()` spins up accounts concurrently (capped at 13 via `tokio::sync::Semaphore`):
1. `login` — obtain Bearer token
2. `create_session` — create chat session
3. `health_check` — test completion (with PoW) to verify writable session
4. `update_title` — rename session to "managed-by-ai-free-api"

Each account retries 3x with 2s delay on failure. If an account fails all retries it's marked as `InitFailed`.

### Request Flow (per-chat)

`v0_chat()` → `get_account()` → `split_history()` → `create_session()` → `upload_files()` → `compute_pow()` → `completion()` → `parse_ready()` → `GuardedStream`

Each `v0_chat()` call creates a dedicated session, uploads multi-turn history as files, then streams the response. The session is destroyed when the stream ends via `GuardedStream::drop`, which also calls `stop_stream` on abnormal disconnects. Sessions are tracked in `active_sessions: Arc<Mutex<HashMap<String, ActiveSession>>>`.

### Single-Struct Pipeline (OpenAI)

The adapter uses a **single struct** (`ChatCompletionsRequest`) through the entire request pipeline — no intermediate types:

```
ChatCompletionsRequest
  → normalize::apply |
  → tools::extract   |  reads ChatCompletionsRequest fields directly
  → files::extract   |
  → prompt::build    |
  → resolver::resolve|
  → tiktoken
  → try_chat (ds_core::ChatRequest)
  → if req.stream → ChatCompletionsResponseChunk | else → ChatCompletionsResponse
```

### Response Pipeline (OpenAI) — 4-Layer Stream Chain

```
ds_core SSE bytes → SseStream (sse_parser)
                 → StateStream (state/patch machine)
                 → ConverterStream (converter)
                 → ToolCallStream (tool_parser)
                 → SSE bytes
```

All stream wrappers use `pin_project_lite::pin_project!` macro and implement `Stream` with `poll_next`. Each wrapper is a pinned struct with an inner stream and state, using `Projection` to access fields in `poll_next`.

### Tool Calls via XML

Tool definitions are injected as natural language into the prompt inside a `<think>` block (see `docs/deepseek-prompt-injection.md`). Response `<tool_calls>` XML is parsed back into structured JSON via `ToolCallStream`:

1. **Sliding window detector** accumulates content chunks and looks for `<tool_calls>` XML tags
2. **Fuzzy character normalization**: U+FF5C→|, U+2581→_
3. **JSON repair**: backslash escaping, unquoted keys
4. **Fallback tags**: configurable via `TagConfig.extra_starts`/`extra_ends` in `config.toml`
7. **`<invoke>` XML fallback** for alternative tag formats
8. `arguments` field normalized to always be a JSON string

Primary tag: `<tool_calls>` (plural). Configurable fallback tags via `TagConfig` in `config.toml`.

### History Splitting & File Upload

Multi-turn conversations split history at `split_history_prompt()`:
- The last user+assistant pair + final user message go **inline** in the prompt
- Earlier turns are wrapped in `[file content begin]`/`[file content end]` markers and uploaded as `EMPTY.txt`
- External files (data URLs) upload individually with a separate PoW computation targeting `/api/v0/file/upload_file`
- Upload polling: 3 attempts with 0.5/1/2s backoff, checking file existence via `fetch_files`

### Capability Toggles

Request fields mapped in `request/resolver.rs`:
- **Reasoning**: defaults to `"high"` (on). Set `"none"` to disable.
- **Web search**: `web_search_options` enables; omitted = off.
- **File upload**: data URL content parts → auto upload to session; HTTP URLs → search mode.
- **Response format**: `response_format` → JSON/schema text injection in prompt.

### Overloaded Retry

`OpenAIAdapter::try_chat()` retries up to **6 times** with **exponential backoff** (1s → 2s → 4s → 8s → 16s) on `CoreError::Overloaded`, triggered by DeepSeek's `rate_limit_reached` SSE hint or all accounts busy.

### Anthropic Compatibility Layer

Pure protocol translator on top of `openai_adapter` — no direct `ds_core` access:
- Request: `Anthropic JSON → to_openai_request() → OpenAIAdapter::chat_completions() / try_chat()`
- Response: `OpenAI SSE/JSON → from_chat_completion_stream() / from_chat_completion_bytes() → Anthropic SSE/JSON`
- ID mapping: `chatcmpl-{hex}` → `msg_{hex}`, `call_{suffix}` → `toolu_{suffix}`
- `ToolUnion` in `request.rs` defaults to `Custom` type when absent (backward compat with Claude Code)

### Error Translation Chain

Errors propagate upward with translation at each module boundary:

1. **`client.rs`**: `ClientError` (`Http` | `Status` | `Business` | `Json` | `InvalidHeader`)
   - Parses DeepSeek's wrapper envelope `{code, msg, data: {biz_code, biz_msg, biz_data}}` via `Envelope::into_result()`
2. **`accounts.rs`**: `PoolError` (`AllAccountsFailed` | `Client`(ClientError) | `Pow`(PowError) | `Validation` | `Exists`)
3. **`ds_core.rs`**: `CoreError` (`Overloaded` | `ProofOfWorkFailed` | `ProviderError` | `Stream`)
4. **`openai_adapter.rs`**: `OpenAIAdapterError` (`BadRequest` | `Overloaded` | `ProviderError` | `Internal` | `ToolCallRepairNeeded`)
5. **`anthropic_compat.rs`**: `AnthropicCompatError` (`BadRequest` | `Overloaded` | `Internal`)
6. **`server/error.rs`**: `ServerError` (`Adapter`(OpenAIAdapterError) | `Anthropic`(AnthropicCompatError) | `Unauthorized` | `NotFound`(String))

All errors use `thiserror` derive macro.

### Request Tracing & Account Header

Each request gets a `req-{n}` ID at the handler level, threaded through adapter → `ds_core`. Key log points carry `req=` for cross-layer tracing:
```bash
RUST_LOG=debug 2>&1 | grep 'req=req-1'
```
The `x-ds-account` HTTP response header carries the account identifier upstream.

### HTTP Routes

| Endpoint | Handler | Description |
|----------|---------|-------------|
| `GET /` | `handlers::root` | Redirect to /admin |
| `POST /v1/chat/completions` | `handlers::openai_chat` | OpenAI chat completion |
| `GET /v1/models` | `handlers::openai_models` | List models |
| `GET /v1/models/{id}` | `handlers::openai_model` | Get model |
| `POST /anthropic/v1/messages` | `handlers::anthropic_messages` | Anthropic messages |
| `GET /anthropic/v1/models` | `handlers::anthropic_models` | List models (Anthropic format) |
| `GET /anthropic/v1/models/{id}` | `handlers::anthropic_model` | Get model (Anthropic format) |

Optional Bearer auth via `[[api_keys]]` in config; no auth when empty.|

### Model ID Mapping

`model_types` in `[deepseek]` config (default: `["default", "expert"]`) maps to OpenAI model ID `deepseek-{type}` (e.g., `deepseek-default`, `deepseek-expert`). Anthropic compat uses the same IDs.

---

## Conventions

### Code

```rust
// Import grouping: std → third-party → crate → local, separated by blank lines
use std::sync::Arc;

use serde::Deserialize;

use crate::config::Config;

use super::inner::Helper;
```

- **Visibility**: `pub(crate)` for types not part of the public API; facade modules keep submodules private with `mod`
- **Comments**: Chinese in source files (team preference)
- **Error messages**: Chinese for user-facing output; English for internal/debug
- **Naming**: `snake_case` for modules/functions, `PascalCase` for types/enum variants, `SCREAMING_SNAKE_CASE` for constants
- **Module files**: `foo.rs` declares sub-modules, `foo/` contains implementation

### Comments

Follow `docs/code-style.md`:
- `//!` — module docs: first line = responsibility, then key design decisions
- `///` — public API docs: verb-led, note side effects and panic conditions
- `//` — inline: explain "why", not "what"

### Logging

- `log` crate with **explicit targets**. Untargeted logs (e.g., bare `log::info!`) are prohibited.
- Targets used:
  - `ds_core::accounts`, `ds_core::client`
  - `adapter` (for `openai_adapter`)
  - `http::server`, `http::request`, `http::response` (for `server`)
  - `anthropic_compat`, `anthropic_compat::models`, `anthropic_compat::request`, `anthropic_compat::response::stream`, `anthropic_compat::response::aggregate`
- See `docs/logging-spec.md` for full target/level mapping

### Config

- Uncommented values in `config.toml` = required; commented = optional with default
- `src/config.rs` is the single source for config loading — no other module reads config files
- `Config::load_with_args()` returns `(Config, PathBuf)` — the path is propagated to `AppState.config_path` for reload
- `Config` is wrapped in `Arc<RwLock<Config>>` — runtime-mutable, admin panel changes auto-persist via `Config::save()`
- `Config::save()` writes atomically (tmp + rename, 0600 permissions). `Config` now includes `AdminConfig` (password hash, JWT secret) and `api_keys: Vec<ApiKeyEntry>` — no separate JSON files

### Testing

- All tests are inline (`#[cfg(test)]` within `src/` files). No separate `tests/` directory.
- `request.rs` has sync unit tests for parsing logic
- `response.rs` has `tokio::test` async tests for stream aggregation
- `println!`/`eprintln!` allowed inside `#[cfg(test)]` for debugging failures; prohibited in library code

## Anti-Patterns

- Do **NOT** create separate config entry points — `src/config.rs` is the single source
- Do **NOT** implement provider logic outside its `*_core/` module
- Do **NOT** commit `config.toml` (only `config.example.toml`)
- Do **NOT** use `println!`/`eprintln!` in library code — use `log` crate with target
- Do **NOT** use untargeted log macros — always specify `target: "..."`
- Do **NOT** access `ds_core` directly from `anthropic_compat` — always go through `OpenAIAdapter`
- Do **NOT** add `#[allow(...)]` outside `src/ds_core/client.rs` — dead API methods and deserialized fields for API symmetry are expected only in the raw HTTP client layer
- Do **NOT** keep admin/auth config in separate JSON files (`admin.json`, `api_keys.json`) — they are merged into `Config` fields and persisted via `Config::save()` into `config.toml`
- Do **NOT** run `git checkout`, `git commit`, or `gh` commands without explicit user permission — always ask before destructive or persistent operations
---

## Troubleshooting

| Issue | Symptom | Likely Cause / Fix |
|-------|---------|--------------------|
| WASM load failure | `PowError::Execution` on startup | DeepSeek recompiled WASM. PowSolver now uses dynamic export probing (no hardcoded symbols). Update `wasm_url` in `config.toml` if WASM URL changed |
| WAF blocking (non-US) | AWS WAF Challenge response (status 202) | Configure a non-US proxy in `config.toml` `[proxy]` |
| WAF blocking (fingerprint) | HTTP 403 or connection reset | `rquest` with BoringSSL automatically emulates Chrome 136 TLS fingerprint. If blocked, try updating `rquest` or switching emulation profile |
| Account init failure | All accounts stuck in init | Bad credentials (login fails first) or rate-limited (too many sessions). Check `[accounts]` in config |
| Tool call parse failure | No `tool_calls` in response, raw XML visible | Model output a tag variant not in the parse list. Add fallback `extra_starts`/`extra_ends` in `config.toml` `[deepseek]` |
| Rate limited | Repeated `CoreError::Overloaded` | Add more accounts or reduce concurrency. 6x exponential backoff handles transient spikes |
| Session errors mid-stream | `invalid message id`, session not found | Usually handled by `GuardedStream::drop` cleanup. If persistent, check concurrent access to same account |
| Streaming stalls | No SSE events after initial connection | Check `RUST_LOG=adapter=trace,ds_core::accounts=debug,info` for where the pipeline halts |

---

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Config loading | `src/config.rs` | Single unified entry, `-c` flag support |
| Config reference | `config.example.toml` | All fields documented with examples (authoritative) |
| DeepSeek chat flow | `src/ds_core/` | accounts → pow → completions → client |
| Chat orchestration + file upload | `src/ds_core/completions.rs` | `v0_chat()`, history splitting, upload retry, `GuardedStream` |
| OpenAI request parsing | `src/openai_adapter/request/` | normalize → tools → files → prompt → resolver |
| File upload extraction | `src/openai_adapter/request/files.rs` | data URL → FilePayload, HTTP URL → search mode |
| OpenAI response conversion | `src/openai_adapter/response/` | sse_parser → state → converter → tool_parser |
| Tool call parser & stop sequences | `src/openai_adapter/response/tool_parser.rs` | `TagConfig` with extra_starts/extra_ends; stop filtering embedded |
| Stream pipeline config | `src/openai_adapter/response.rs` | `StreamCfg` struct (consolidates 8 stream params) |
| Anthropic compat layer | `src/anthropic_compat/` | Built on openai_adapter, no direct ds_core access |
| Anthropic streaming response | `src/anthropic_compat/response/stream.rs` | OpenAI SSE → Anthropic SSE event stream |
| Anthropic aggregate response | `src/anthropic_compat/response/aggregate.rs` | OpenAI JSON → Anthropic JSON |
| OpenAI protocol types | `src/openai_adapter/types.rs` | Request/response structs, `#![allow(dead_code)]` |
| Model listing | `src/openai_adapter/models.rs` | Model registry and listing |
| HTTP server/routes | `src/server/` | handlers → stream → error |
| PoW WASM solver | `src/ds_core/pow.rs` | wasmtime loading, dynamic export probing, DeepSeekHashV1 |
| DeepSeek HTTP client | `src/ds_core/client.rs` | `Envelope::into_result()`, WAF detection, all API methods |
| Unified debug CLI | `examples/adapter_cli.rs` | Modes: chat/raw/compare/concurrent/status/models |
| Example request JSON | `examples/adapter_cli/` | Pre-built ChatCompletionsRequest samples |
| Scripted regression test | `just adapter-cli -- source examples/adapter_cli-script.txt` | Runs all JSON samples in sequence |
| e2e scenario test framework | `py-e2e-tests/` | JSON-driven scenarios with checks |
| CI pipeline | `.github/workflows/ci.yml` | `cargo check + clippy + fmt + audit + machete` + `cargo test` |
| Release workflow | `.github/workflows/release.yml` | Tag `v*` → 8 targets, 4 platforms, CHANGELOG release |
| Code style | `docs/code-style.md` | Comments, naming conventions (Chinese in source files) |
| Logging spec | `docs/logging-spec.md` | Targets, levels, message format for `log` crate |
| Prompt injection strategy | `docs/deepseek-prompt-injection.md` | DeepSeek native tags, claude-3.5-sonnet system prompt research |
| API reference | `docs/deepseek-api-reference.md` | DeepSeek endpoint details |
| Admin panel routes | `src/server/admin.rs` | Setup/login/config/status/stats/models/logs handlers |
| JWT auth + password | `src/server/auth.rs` | `setup_admin()`/`login_admin()`, JWT sign/verify, login rate limiter |
| Store manager | `src/server/store.rs` | API key validation, stats persistence, delegates admin/keys to `Config::save()` |
| Request stats | `src/server/stats.rs` | `RequestStats`, `StatsHandle`, background flush to `stats.json` |
| Runtime log | `src/server/runtime_log.rs` | stdout redirect to `runtime.log` with rotation |

---

## Commands

```bash
# Setup (config auto-created on first run; copy example only if you want defaults)

# Enable pre-commit hook (check + clippy + fmt + audit + machete + cargo test)
git config core.hooksPath .githooks

# One-pass check (check + clippy + fmt + audit + unused deps)
just check

# Run the HTTP server with basic logging
just serve
RUST_LOG=info just serve
# Trace through the entire SSE pipeline
RUST_LOG=adapter=trace,ds_core::accounts=debug,info just serve
# Module-level logging filters
RUST_LOG=ds_core::accounts=debug,ds_core::client=warn,info just serve
RUST_LOG=adapter=debug,anthropic_compat=debug just serve

# Run unified protocol debug CLI (modes: chat, raw, compare, concurrent N, status, models, model <id>)
just adapter-cli
RUST_LOG=debug just adapter-cli
# Script mode — runs all JSON samples in sequence (full regression)
just adapter-cli -- source examples/adapter_cli-script.txt
# Interactive mode with a specific config
cargo run --example adapter_cli -- -c /path/to/config.toml

# Run specific test modules
just test-adapter-request
just test-adapter-response
just test-adapter-request converter_emits_role_and_content -- --exact

# Run a single Rust test (use -- --exact for precise name matching)
cargo test converter_emits_role_and_content -- --exact

# Run all Rust tests
cargo test

# Run only library tests (skips example compilation, faster iteration)
cargo test --lib

# e2e tests (requires `uv`, server on port 22217)
just e2e-basic    # Basic: 基础功能测试（OpenAI + Anthropic 双端点）
just e2e-repair   # Repair: 工具调用损坏修复专项测试
just e2e-stress   # Stress: 全部场景 × 3 次迭代压测
# See docs/development.md for full e2e CLI parameters (filter, parallel, model, report, etc.)

# Start server with e2e config
just e2e-serve

# Individual checks
cargo check
cargo clippy -- -D warnings
cargo fmt --check
cargo audit        # requires: cargo install cargo-audit
cargo machete      # requires: cargo install cargo-machete

# Build
cargo build
cargo build --release

# Release (tag push triggers CI: 8 targets, 4 platforms, aarch64 on ARM runners)
git tag v0.x.x
git push origin v0.x.x
# CI extracts changelog from CHANGELOG.md, creates GitHub release
```
