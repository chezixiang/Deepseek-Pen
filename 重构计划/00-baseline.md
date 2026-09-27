# 00 执行前基线冻结记录（路线 C：ds-free-api → App）

- **冻结时间**：2026-09-27（Asia/Shanghai）。
- **执行角色**：重构流程首个工作 Agent；已确认 `重构计划\【上一阶段交接文件】` 不存在。
- **代码冻结点**：`main` @ `2c8d2bbb9b9d1259fd40b3497646de65cfb12c01`（2026-09-27 14:31:03 +0800，提交名「修了一堆bug，自己看吧」）；冻结时 `git status --porcelain` 输出为空。
- **本阶段文档提交**：`232b405`（本文件）、`17b6e4d`（`重构计划\【本阶段文件】.md`）。
- **追加核查**：2026-09-27 核查外部参考仓库 Pen-LVGL（第九节）与真机只读状态（第十节），并据此修订 G-1/G-2/G-3/G-10 的状态、新增 G-11/G-12。
- **依据文件**：《总体重构路线.md》《下一步开发计划.md》（已通读）。未读取任何历史会话记录，全部结论来自上述文件与当前工作区。
- **本轮范围**：只读核对与记录。未修改业务代码、未实施阶段 0、未迁移、未删除任何文件。
- **用途**：后续阶段（阶段 0—5）引用同一份基线、同一种交接格式；缺口统一以「待补项」列明，不代替阶段放行。

---

## 一、基线清单（工作区 / 构建 / 运行）

### 1.1 仓库与版本

| 项 | 值 | 证据 |
|---|---|---|
| 仓库根 | `G:\youdao\Deepseek`（单仓库 monorepo） | 目录清点 |
| 当前分支 / HEAD | `main` @ `2c8d2bb` | `git rev-parse HEAD` |
| 工作区状态 | 干净（无 modified/untracked 非忽略项） | `git status --porcelain=v1 -b` |
| 远程 | `origin`、`upstream`（指向 `NIyueeE/ds-free-api`，对照用） | `git branch -a` |
| 保留分支 | `backup-before-restructure` @ `579d282`（2026-09-13，目录整理前快照，**保留，不得删除**） | `git log -1 backup-before-restructure` |
| 标签 | `v0.2.8` | `git tag -l` |
| 跟踪文件数 | 308 | `git ls-files` |
| 规划目录 | `重构计划/` 跟踪 2 个文件（总体重构路线、下一步开发计划） | `git ls-files` |

### 1.2 组件与版本

| 组件 | 路径 | 版本 / 备注 |
|---|---|---|
| Rust 后端 | `ds-free-api/` | `Cargo.toml` version `0.2.19`，edition 2024 |
| 传输依赖 | `ds-free-api/Cargo.toml` | `wreq 5.3.0`（json/stream/multipart/socks/cookies/webpki-roots）、`wreq-util 2.2.6` |
| PoW 运行时 | 同上 | `wasmtime = 48`（cranelift），`panic = "abort"`、`opt-level = "z"`、`strip` |
| CAPTCHA crate | `CAPTCHA/`（crate 名 `sm_des`，`ds-free-api` 以 path 依赖） | 未改名，改名需原子修改 |
| 词典笔小程序 | `app/` | package version `0.1.5`，appid `8000000000182376`，QuickJS `20200705`，`bigNum:false` |
| 构建序号 | `app/src/services/build-info.js` | `BUILD_NUM = 128`，`BUILD_AT = 2026-09-27 03:25:32` |
| 上游对照副本 | `ds-free-api-newest/`（本地、被忽略、独立 git 仓库，version `0.4.0`） | 仅对照，不在本路线迁移范围 |

### 1.3 本地关键产物（未跟踪 / 被忽略，回滚时依赖）

| 产物 | 路径 | 大小 / 时间 |
|---|---|---|
| 内嵌后端二进制（打包源） | `app/backend/linux-aarch64-gnu/ds-free-api` | 4,841,260 B |
| 内嵌 blob | `app/src/services/backend-blob.js` | 6,462,162 B |
| 后端二进制副本 | `app/src/services/ds-free-api-aarch64`、`ds-free-api-aarch64`（根） | 4,570,640 B（两份同尺寸） |
| 历史安装包 | `app/8000000000182376.0_1_0.amr`、`0_1_2`、`0_1_3`、`0_1_5`、`deepseek.amr` | 4.67–5.08 MB |
| v0.2.6 旧版后端 | `ds-free-api/ds-free-api-v0.2.6-linux-aarch64-gnu/ds-free-api` | 7,511,448 B |
| v0.2.6 Windows 骨架 | `ds-free-api/ds-free-api-v0.2.6-windows-x86_64/`（含 `config.toml`、`logs/runtime.log`） | 30.6 MB exe |
| 构建缓存 | `ds-free-api/target/`、`ds-free-api/target-wsl/` | 被忽略 |
| 证据与临时目录 | `.probe/`、`.bench/`、`.shots/`、`logs/` | 被忽略 |

忽略规则（根 `.gitignore`）覆盖：`.mimosa/ .zcode/ .probe/ node_modules/ app/.falcon_/ app/*.amr app/dist/ app/backend/*（保留 config.example.toml） app/src/services/ds-free-api-aarch64 /ds-free-api-aarch64 target/ **/target/ *.log **/logs/ *- 副本* `ds-free-api-newest/`、`target-wsl/`、`target-*/`。

### 1.4 构建与 CI 基线

| 项 | 说明 | 证据 |
|---|---|---|
| 前端构建入口 | `app`：`npm run build:prod`（= `node scripts/build-wrapper.js prod`），dev 走 `build:dev` | `app/package.json` |
| 构建前置校验 | prod 构建先跑模板审计 + 回归脚本（LaTeX/config.toml/限流），再自动 `inline-backend.js` 重嵌后端 blob | `app/scripts/build-wrapper.js` |
| **Native 库打包路径（关键）** | SDK 构建步骤 `syncDirs()` 会把工程根目录的 `libs/`、`jsworkers/`、`assets/` 同步到 `app/.falcon_/`；`pack.js` 对 `.falcon_/` 整个目录打 zip 生成 `app/8000000000182376.0_1_5.amr`；`manifest.js` 为 `.falcon_/` 内全部文件写 md5 清单 | `app/node_modules/aiot-vue-cli/src/steps/build.js:56-74`、`steps/pack.js:14-33`、`steps/manifest.js` |
| 结论 | 规划中的 `app/libs/arm64/libjsapi_ds_probe.so` **可被常规构建链带入 amr**（前提是放在工程根 `app/libs/` 下）；`app/libs/` 目录当前不存在 | 目录清点：`app/libs` → `False` |
| Rust 构建 | 交叉编译：`ds-free-api/build-aarch64.sh`（aarch64 release + upx → 拷入 `app/backend/`）；`.cargo/config.toml` 默认 target 钉 aarch64 | 脚本 + `ds-free-api/.cargo/config.toml` |
| Rust 测试 | 宿主 target 必须显式覆盖：`ds-free-api/run-host-tests.sh`、`run-all-tests.sh`（`--target x86_64-unknown-linux-gnu` + 覆盖 CC/CXX/AR + `build.target=""`） | 脚本头注释 |
| CI | `.github/workflows/ci.yml`：`web`（npm ci + build + lint）→ `backend`（cargo check --all-targets + CAPTCHA/后端宿主单测 + aarch64 release）→ `miniapp`（SDK 检出 + 构建打包） | workflow 注释与 job 定义 |
| SDK 依赖 | `app/package.json` 硬编码 `file:D:/codes/youdao/sdk/packages/{core,types}`；本机 `D:\codes\youdao\sdk` 存在；CI 在检出后改写为相对路径 | `STRUCTURE_CHANGELOG.md`、CI 注释 |

### 1.5 真机与设备工具基线

| 项 | 值 |
|---|---|
| adb | `G:\youdao\others\adb.exe`（存在） |
| 设备在线状态 | 冻结时 `adb devices` 返回 1 台 `device` 状态（序列号脱敏：`MEC17****3678`） |
| 交互探针 | `.probe/pen.sh`：`cap/tap/swipe/start`，`miniapp_cli start 8000000000182376 [page]`，坐标映射已注释 |
| 设备端数据目录 | `$dataDir` = `/userdisk/secondary/miniapp/data/mini_app/pkg/8000000000182376/data`（应用运行期变量，X7 Pro 实测） |
| 设备端日志 | `<dataDir>/ds-app.log`、`<dataDir>/ds-free-api/logs/runtime.log` |
| 旧目录 | `/userdisk/ds-free-api/config.toml`（一次性迁移来源，`native.js#migrateLegacyDir`） |

---

## 二、行为基线（现状主链路，本轮只记录、不改动）

### 2.1 App 端调用链（现状）

```text
UI 页面（app/src/pages/{startup,login,index,settings}）
  → ds.js chatStream()/listXxx()
  → 写请求体到 <dataDir>/dsstream_*.req.json
  → execShell 后台执行：curl -s -N -m <timeout> -X POST http://127.0.0.1:<port>/v1/chat/completions -d @req.json > out.txt 2>&1 &
  → 每 200ms 轮询 out.txt，交给 ds-text.js parseSse()
  → 完成/取消后清理临时文件；取消用 native.js stopStream(token) → pkill -f <token>
```

证据：`app/src/services/ds.js:367` 起（注释明确「`$falcon.jsapi.http` 不支持增量回调，因此用后台 curl -N 写文件 + 轮询」）、`app/src/services/ds.js:488/558`（200ms 轮询）、`app/src/services/native.js:226`（`stopStream`）。

### 2.2 后端部署 / 配置 / 健康检查链（现状）

```text
启动页 → native.js deployBackend()：BACKEND_B64 解码 → <dataDir>/ds-free-api/ds-free-api（原子 mv；ds-backend.sha 摘要匹配走快速路径）
      → ensureDsConfig()：config.toml 缺失/字段漂移时自愈重建（含 UA/client_version/模型收敛）
      → restartDsFreeApi() → backend-health.js checkBackendHealth()：端口 22217–22222，GET /health，
        新后端以 ready 标记账号登录完成；账号写入后用 healthCheckWithAccount(75s) 等账号池就绪
账号写入：updateDsFreeApiAccount()（native.js:480）读 config.toml → JS 改写 [[accounts]] + 随机 api_key
      → cp config.toml config.toml.bak（备份）→ 写临时文件 → mv 覆盖 → 重启 → 探活
```

证据：`app/src/services/native.js:1178`（`deployBackend`）、`:1295`（`ensureBackendRunning`）、`:191-204`（`dsHomeDir`/`dsConfigPath`/`dsRuntimeLogPath`）、`:480-508`（账号写入与备份命令）、`app/src/services/backend-health.js:6`（端口表）与 `checkBackendHealth`（ready 语义、30 次 × 1s）。

### 2.3 Rust 后端行为基线（迁移语义来源）

| 主题 | 现状 | 证据位置 |
|---|---|---|
| 传输 | `wreq` client builder：`Emulation::Chrome136`、Cookie Jar、可选代理（http/socks5）、`connect_timeout 15s`、`redirect::Policy::limited(10)` | `ds-free-api/src/ds_core/client.rs:672-684` |
| 请求头 | web 导航语义头修正、`X-Client-Platform/Version/Locale`、Authorization Bearer、PoW 头独立注入 | `client.rs:751-866` |
| PoW | `PowSolver::new(wasm_bytes)` 动态探测导出（优先 `wasm_solve`，或匹配签名 `(i32,i32,i32,i32,i32,f64)->()`）；`Challenge{challenge,salt,expire_at,difficulty,signature,target_path}` → `PowResult{algorithm,challenge,salt,answer,signature,target_path,header}` | `ds-free-api/src/ds_core/pow.rs:17-171` |
| PoW target（I4） | completion → `/api/v0/chat/completion`；upload → `/api/v0/file/upload_file`；edit → `/api/v0/chat/edit_message` | `completions.rs:619-621`、`:935`、`:1218` |
| 账号池 | `accounts.rs`（一账号一并发、禁言/限流/恢复状态） | `ds-free-api/src/ds_core/accounts.rs`（57,886 B） |
| HIF | `HifManager::{leim,dliq,spawn_refresh}` | `ds-free-api/src/ds_core/hif.rs:64-85` |
| 设备身份采集 | 后端承载 WPE WebKit 浏览器小程序（appid `8001779591038449`）打开 `http://127.0.0.1:22230/device?key=…`，加载 `https://chat.deepseek.com/static/fp.min.js`，回传 `/device-id-capture/submit` | `ds-free-api/src/server/device_capture.rs:1-45`（`CAPTURE_PORT = 22230`） |
| 端口 | 主服务 22217（探测段 22217–22222），采集专用 22230 | 上述两处 |
| 单测存量 | 223 个 `#[test]`/`#[tokio::test]`：accounts 17、completions 13、client 12、openai_adapter 系 105、mint 7、fingerprint 7、hif 4、server/device_capture 2、config 2、tests/ 集成 4 等 | `rg -c '#\[(tokio::)?test\]'` |

### 2.4 本轮行为基线验证结果

| 验证 | 命令 | 结果 |
|---|---|---|
| App 回归脚本 | `app`: `npm test` | 退出码 0；9 个脚本（latex/config-parse/ratelimit/ds-text/markdown/store-schema/emoji/camera-layer/camera-regression）全部通过 |
| Rust 宿主单测 | `wsl -d Ubuntu -- bash -lc "… run-host-tests.sh"` | **未完成**：本机 WSL 报「此计算机上不支持嵌套虚拟化」，WSL 实例无法启动；未得到后端单测基线结果，列为待补项 G-5 |
| 工作区一致性 | `git status --porcelain=v1 -b` | 冻结时干净 |

---

## 三、待统一接口（阶段开工前必须冻结的命名与语义）

来源：《总体重构路线》§2.2；「现状」列为本工作区证据。

| 编号 | 分叉点 | 冲突双方 | 现状 | 统一截止点 |
|---|---|---|---|---|
| U1 | Native Transport 流式接口 | `requestStream()` + `"data"` 事件（源计划 §3.1） vs `openStream()` + `"chunk"` 事件（§4.2） | 尚无 Native transport；现实替代是 curl 文件轮询 | 阶段 1 开工前 |
| U2 | Runtime 退出语义 | `stop()`（源计划 §7 生命周期） vs `shutdown()`（§3.2 DsRuntime 接口） | 无 JS runtime；页面沿用 `pkill` 停流 | 阶段 3 开工前 |
| U3 | Probe 异步回显命名 | `asyncEcho()`（阶段 0 描述） vs `echo()`（§10 任务书） | 探针未实现 | 阶段 0 开工前（本阶段未冻结，见 G-2） |
| U4 | `ds-pow.js` 职责 | 源计划目标目录含该文件，阶段 3 顺序未列 | Rust `pow.rs` 内部完成挑战→求解→头注入 | 阶段 3 开工前 |
| U5 | Crypto 支线排期 | 源计划定义库边界但未列阶段 | 现有 `CAPTCHA`/`mint.rs` 自行实现算法 | 阶段 3/4 消费点确定时 |
| U6（本阶段新增） | 流式回调契约细节 | `streamId` 归属、`headers/data/end/error` 事件顺序、取消幂等、事件投递到 QuickJS 的方式 | 现状为 200ms 文件轮询，**必须被替换**（`$falcon.jsapi.http` 无增量回调） | 阶段 1 开工前，与 U1 同一份契约 |
| U7（本阶段新增） | 错误枚举与 PoW target 常量 | `NoAccounts/Overloaded/RateLimited/Rejected/ProofOfWorkFailed/ProviderError/StreamError/Muted/Unauthorized/CaptchaRequired`；target 三值 | 现状散落在 `ds-free-api/src/ds_core/*` 与 `app/src/services/error-classify.js` | 阶段 3 开工前（I4/I6 验收引用同一份常量表） |

---

## 四、验收样本位置

### 4.1 现有可用样本

| 类别 | 位置 | 规模 / 说明 |
|---|---|---|
| SSE / 渲染 / 流式回归 | `.bench/` | `case_*.json` 26 个（多模态/空流/部分流/真实样例等）、`real_reply.sse`（199,292 B）、`real_reply.txt`、`stream-render-bench.cjs`、`repro*.sh`、`verify.sh`、`run-dsfa-tests.sh` |
| App 纯逻辑回归 | `app/scripts/test-*.mjs` | 9 个脚本（`npm test` 全跑），含 `parseSse`、限流分类、config 解析、markdown、store schema、emoji、相机层 |
| Rust 单元测试 | `ds-free-api/src/**`（`#[cfg(test)]`） | 223 个用例；宿主运行脚本 `run-host-tests.sh` / `run-all-tests.sh` |
| Rust mock server | `ds-free-api/src/ds_core/mock_http.rs`（仅 `cfg(test)`） | 127.0.0.1 随机端口、捕获请求行与全部头；现服务 mint 协议、仿真头、代理路由、smidV2 cookie 断言 |
| 集成/e2e | `ds-free-api/tests/config_integration.rs`；`ds-free-api/py-e2e-tests/`（`runner.py`、`stress_runner.py`、`scenarios/repair/*.json` 10 例、`config.toml`） | 配置集成 + OpenAI 修复场景 |
| 真机抓包 / 审计 | `.probe/` | `new.har`（21,131,018 B）、`new.jsonl`（79,121,599 B）、`good.har`、`FULL.har`、`run.har`、`ban.har`、`resp-*.json`、`audit-013-backend*.bin`、`ban-audit.json`、`delayed-mute-audit.json` |
| 抓包分析工具 | `tools/audit_deepseek_captures.py`（+ `test_audit_deepseek_captures.py`）、`tools/extract_*.py` | 可重复离线分析 |
| 设备身份 / fp 逆向样本 | `tools/fp-reverse/` | `browser-manifest.json`、`fp-payload-real-browser.json`、`mint-dump*.json`、`replay-body.json`、`des-fields-to-decrypt.json`、`harness.js`、`patch-canonical.js`；模板 `ds-free-api/src/ds_core/fp-payload-template.json` |
| 设备库符号证据 | `.probe/jsapi_proxy.txt`、`.probe/libjsapi_proxy.so`、`.probe/libfalcon.txt` | 含 `jqutil_v2` 命名空间符号（`JQuick::BoundFunctionImpl<…jqutil_v2::JQAsyncExecutor…>`），可作 ABI 线索（非头文件） |
| CI 验收链 | `.github/workflows/ci.yml` | web → backend（check + 宿主单测 + aarch64 release）→ miniapp |

### 4.2 缺失样本（本阶段确认）

| 缺口 | 影响阶段 | 说明 |
|---|---|---|
| PoW 固定回归样本 | 阶段 2 | 工作区内无任何 `*.wasm`；无「challenge 输入 → answer/header 输出」固定对。需在阶段 2 前用现有后端导出样本（含过期/异常/并发用例） |
| Transport mock 验收用例 | 阶段 1 | 现有 `mock_http.rs` 只服务 mint/头断言；GET/POST JSON/Set-Cookie/302/401/429/分片流/跨 chunk UTF-8/超时/取消/销毁 未成套 |
| Probe 构建与导入样本 | 阶段 0 | `app/libs/` 不存在；无 JSAPI SDK 头文件、无最小探针工程；仅有设备侧 `.so` 的 strings 证据 |

---

## 五、配置与备份路径

| 项 | 路径 | 说明 |
|---|---|---|
| 运行时真源（现状） | 设备端 `<dataDir>/ds-free-api/config.toml` | 由 `ensureDsConfig()` 自愈重建；账号、代理、UA、模型收敛都在此 |
| 运行期自动备份 | 同目录 `config.toml.bak` | 每次账号/代理/net_capture 写入前 `cp` 生成（`native.js` 内 `configCommand`） |
| 示例模板 | `app/backend/config.example.toml`（2,834 B）、`ds-free-api/config.example.toml`（5,480 B）、`ds-free-api/docker/config.example.toml`、`ds-free-api-newest/config.example.toml` | 部署与重建参考 |
| 本地脱敏副本 | `.probe/config.toml`（356 B，密码字段已脱敏） | 事故复盘/重建参考 |
| 本地未跟踪副本 | `ds-free-api/ds-free-api-v0.2.6-windows-x86_64/config.toml`；`ds-free-api/py-e2e-tests/config.toml` | 测试/骨架配置 |
| 构建期自动备份 | 阶段文档不涉；`app/scripts/patch-cli.sh`、`build-wrapper.js` 自带缓存与版本递增 | 见脚本 |
| **缺口** | 无集中式、含真实账号的真机 `config.toml` 归档 | 供阶段 3「首次升级导入」与回滚演练使用，需在阶段 3 前从设备导出存档（待补项 G-6） |

---

## 六、回滚入口

| 层 | 入口 | 说明 |
|---|---|---|
| 代码 | `git`：`main` @ `2c8d2bb`（本次冻结点）；`backup-before-restructure` @ `579d282`（整理前快照，保留）；tag `v0.2.8`；`upstream/*` 对照分支 | 任何阶段回滚先对比这三处 |
| 应用包 | `app/8000000000182376.0_1_0.amr`、`0_1_2`、`0_1_3`、`0_1_5`、`app/deepseek.amr`（本地未跟踪） | 覆盖安装回旧版本 |
| 后端二进制 | `app/backend/linux-aarch64-gnu/ds-free-api`（内嵌源）；`app/src/services/ds-free-api-aarch64`；根 `ds-free-api-aarch64`；`ds-free-api/ds-free-api-v0.2.6-linux-aarch64-gnu/ds-free-api`（更旧版本） | 回退到旧后端 |
| 配置 | 设备端 `config.toml.bak`；本地 `.probe/config.toml`、`app/backend/config.example.toml` 重建 | 配置级回滚与重建 |
| 阶段 0 探针 | 探针只新增 `app/libs/arm64/libjsapi_ds_probe.so`（尚未存在）；撤销 = 删除该目录并重新构建旧 amr | 阶段 0 的边界与回滚方式 |
| 迁移总原则 | 阶段 5C 之前旧进程/旧入口一律保留；本阶段未删除、未迁移任何文件 | 与《总体重构路线》§七一致 |

---

## 七、待补项清单（基线缺口）

| 编号 | 缺口 | 阻塞级别 | 备注 |
|---|---|---|---|
| G-1 | `app/libs/` 不存在；`libs→.falcon_→amr` 链路有代码证据；**arch 目录名已由真机确认为 `arm64-popcorn`**（第十节）；仅剩真机 import / 卸载 / 升级行为待验证 | 阶段 0（已大幅收窄） | 证据：`aiot-vue-cli/src/steps/{build,pack,manifest}.js`、第九、十节 |
| G-2 | 无 JSAPI SDK 头文件本地副本、ABI 核验路径未定 | **阶段 0 前需复核**（已有外部 SDK 来源，见第九节） | 设备 strings + Pen-LVGL vendored SDK（Apache-2.0/LGPL 混合，需确认兼容性） |
| G-3 | Probe 命名（`asyncEcho` vs `echo`）未冻结；命名/导入约定已可从参考实现推出（`libjsapi_<name>.so` ↔ `import … from '<name>'`） | 阻塞阶段 0 验收口径（收窄） | 见 U3、第九节 |
| G-4 | 无 PoW 固定回归样本（无 `*.wasm`、无 challenge/answer 对） | 阻塞阶段 2 验收 | 需用现有后端导出 |
| G-5 | 后端宿主单测未在本机复核（WSL 不可用：嵌套虚拟化不支持）；本次仅 CI/脚本具备运行路径 | 不阻塞文档放行，阻塞「行为基线已复核」结论 | 建议以 CI 运行结果补档 |
| G-6 | 无真机 `config.toml` 集中归档 | 阻塞阶段 3 的导入/回滚演练 | 需导出存档 |
| G-7 | Transport 契约（U1/U6）与 Runtime 退出（U2）未冻结 | 阻塞阶段 1/3 开工 | 规划文档已列，本阶段不代决 |
| G-8 | 阶段 1 mock 验收用例未成套 | 阻塞阶段 1 验收 | 可复用 `mock_http.rs` 思路扩展 |
| G-9 | `app/package.json` 硬编码 `file:D:/codes/youdao/sdk/...`；本机构建依赖该绝对路径存在 | 非阻塞（本机存在） | CI 已绕开，本地换机需注意 |
| G-10 | X7 Pro 固件的 arch 目录名 | **已关闭**（真机确认为 `arm64-popcorn`） | 见第十节；通用回退 `arm64` 亦被系统包使用 |
| G-11 | 参考 SDK 与本机固件的 ABI 兼容性未验证 | 阶段 0 | 需符号集比对或最小 `.so` 真机 dlopen |
| G-12 | 真机已安装的 `libs/libjsapi_*.so` 与包内 `.so` 不一致：文件名多 `_<salt>` 后缀、内容与时间戳不同，存在独立的原生库下发/更新步骤 | 阶段 0 首迭代 | 见第十节 |

**停止条件判定**：G-1～G-3 未解决前不进入阶段 0 实施；本轮按约定停在基线冻结，未开展任何阶段 0 动作。

---

## 八、下一阶段（阶段 0）进入条件

1. G-2：登记 JSAPI SDK 来源与版本（优先使用第九节给出的外部 SDK 副本 + 设备侧符号集复核），并在本机完成“能编译出空模块并导出 `custom_init_jsapis`”的最小验证；取不到可用 SDK 时只允许环境诊断，不猜 ABI。
2. G-1：探针投放目录名已确认为 `app/libs/arm64-popcorn/`（第十节），阶段 0 只需在构建产物中核验 `.falcon_/libs/arm64-popcorn/libjsapi_ds_probe.so` 与 amr `manifest.json` 条目，并用真机验证 import 与 `custom_init_jsapis` 调用链。
3. G-3：冻结探针接口命名（`version()` 同步、异步回显、事件回调三者各一，参照第九节的同步/Promise/发布订阅三种绑定方式），并写进阶段 0 交接。
4. 回滚准备：保留现有 `app/*.amr` 与 `app/backend/linux-aarch64-gnu/ds-free-api`；探针引入失败时可删除 `app/libs/` 并重建旧包。
5. 真机通道：本阶段已确认 adb 在线（`G:\youdao\others\adb.exe`，设备脱敏 `MEC17****3678`）且设备自带 `/bin/miniapp_cli`（支持 `install {amrPath}` / `uninstall {appid}` / `start {appId} --{page}` / `capture {path}` / `debugApp`，root shell 可读 `/etc/miniapp` 与各 app 包目录）；阶段 0 直接复用该通道。
6. 验收记录口径：同步返回、Promise、事件回调、重复加载、退出/升级五类证据分开记录；mock 与真机证据不得互相替代。

---

## 九、外部参考仓库核查（Pen-LVGL，2026-09-27 追加）

### 9.1 仓库信息与采集方式

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/Magniswan/Pen-LVGL` |
| 采集版本 | HEAD `a8d9a668d63d69176e0c7a28740143381699a4c6`（浅克隆，仅见 1 个提交「Create LICENSE」，2026-09-09） |
| 采集方式 | `git clone --depth 1` 到系统临时目录；随后按目录子集拷贝到本仓库忽略目录 `.probe/refs/Pen-LVGL/`（121 个文件 ≈ 705 KB，含来源说明 `README.md`） |
| 许可 | 仓库根为 GNU LGPL-2.1；其 vendored `iot-miniapp-sdk` 内含 Apache-2.0（Android atomic）与 Dropbox（jqbson）头注，无单独 LICENSE；复用前需确认归属 |
| 平台一致性 | 同为 Falcon/QuickJS 小程序：`quickjs.version = 20200705`、`bigNum = false`、`aiot-vue-cli 1.0.32`、16 位 appid、AMR 打包 |

### 9.2 该仓库提供的、与本路线直接相关的能力

| 主题 | 位置（相对仓库根） | 要点 |
|---|---|---|
| Native JSAPI SDK | `launcher/native/iot-miniapp-sdk/{include,src}` | `jqutil_v2/*`（`JQObjectTemplate`、`JQFunctionTemplate`、`JQAsyncExecutor`、`JQSignal`、`jqbson` 等）、`jsmodules/JSCModuleExtension.h`、`looper/*`、`port/*`、`quickjs.h`；来源标注为 `haasui-falcon-app/templates/jsapi/iot-miniapp-sdk` 模板 |
| 模块注册契约 | `launcher/native/src/JSAPI.cpp`、`manager/native/src/JSAPI.cpp` | `extern "C" JQUICK_EXPORT void custom_init_jsapis()` → `registerCModuleLoader("<name>", &<name>_module_load)`；`DEF_MODULE_LOAD_FUNC_EXPORT` 宏（`jqmisc.h`）生成 loader 并注册 `default` 及各导出名 |
| 导入命名约定 | `launcher/src/services/launcher.js` | 模块名 = `libjsapi_<name>.so` 去掉 `libjsapi_` 前缀（`lvgl_launcher`），JS 侧 `import { Launcher } from 'lvgl_launcher'` |
| 同步方法 | `launcher/native/src/Launcher/JSLauncher.cpp` | `SetProtoMethod` + `info.GetReturnValue().Set(...)` / `ThrowInternalError` |
| 异步 Promise | 同上 | `SetProtoMethodPromise` + `info.post(Bson::object{...})` / `info.postError(...)`；JS 侧 `await Launcher.probe()` |
| 事件/订阅 | `jqutil_v2/JQPublishObject.h` | `publish(topic, bson)` + `onSubscribe/onUnsubscribe`（JS 侧 `on/off` 主题回调），即阶段 0“事件回调”的现成机制 |
| 构建脚本模板 | `launcher/tools/build-native.sh`、`manager/tools/build-native.sh` | aarch64-none-linux-gnu g++ 11.3、`-std=gnu++17 -O3 -fPIC`、`-shared -pthread -Wl,--unresolved-symbols=ignore-all`、`-Wl,-soname,libjsapi_<name>.so`；末尾校验 ELF64 AArch64 + `custom_init_jsapis` 导出，并检查无宿主 RPATH |
| AMR 产物结构 | `scripts/falcon_build_common.ps1:44,61,165` | 期望条目含 `app.js`、`app_icon.png`、`libs/arm64-orange/<NativeLibrary>`、`manifest.json`；逐条校验 cert md5 与大小；产出确定性归档（时间戳 1980-01-01）；`.so` 大小上限 16 MB |
| 设备脚本模式 | `scripts/{device_app_common,install_device_app,status_device_app,uninstall_device_app}.ps1` | 显式 `-Serial`、`miniapp_cli install/uninstall`、只读状态采集、绝不 `pkill`/杀 Falcon；设备安装目录与第 1.5 节一致（`/userdisk/secondary/miniapp/data/mini_app/pkg/<appid>`） |
| 开发期宿主模拟 | `launcher/api-mock/lvgl_launcher.js` | 不连真机即可在预览器验证 JS 业务；与本仓库 `app/api-mock/*.js` 同型 |

### 9.3 本设备固件侧证据（本地 `.probe` strings）

`.probe/libfalcon.txt`（X7 Pro `libfalcon.so` strings 存档）中与加载链直接相关的片段：

```text
dynamic_load_jsapi / custom_init_jsapis / dlsym in custom_init_jsapis
PrivateJSApiEntry::init do load jsapis
libjsapi_
libs/
[ERROR] %s is not a directory or not exist!
data/mini_app/pkg/
arm64
__templibs
extract arch libs from %s
[PMS]processArchLibs rename archLibs to libs failed
```

可确认：固件用 `libs/` + `libjsapi_<name>` 动态加载并调用 `custom_init_jsapis`；PMS 负责把 AMR 内的 arch 库目录重命名为 `libs` 后安装；本固件 strings 中出现的 arch 目录名是 `arm64`，未出现 `arm64-orange`（参考仓库使用的名字）。

### 9.4 对基线缺口的影响

| 缺口 | 状态变化 |
|---|---|
| G-2（SDK/ABI） | 部分解除：已有可用的 SDK 头文件与源码副本（`.probe/refs/Pen-LVGL/launcher/native/iot-miniapp-sdk`）与公开的模块注册/构建样板；剩余工作是**版本/ABI 与本机固件的一致性复核**，以及许可归属确认 |
| G-1（打包与导入） | 收窄但不解除：AMR 内容与 `manifest.cert` 契约已有他证；剩余不确定项是 **X7 Pro 选定的 arch 目录名**（`arm64` vs `arm64-orange`）与真机 import/卸载/升级行为 |
| G-3（探针命名） | 收窄：命名与绑定方式可直接对照参考实现（同步 `version()`、异步 promise 方法、`JQPublishObject` 订阅回调）；仅剩本路线自有命名（`echo` vs `asyncEcho`）的取舍 |
| U3/U6（接口契约） | 有新输入：事件回调形态可参考 `publish(topic, bson)` + JS `on/off`，但**本阶段不代决**，留给阶段 0/1 契约冻结 |
| 新增 G-10 | X7 Pro 固件的 arch 目录名未定，需在阶段 0 首个迭代内确认（本地固件 strings 指向 `arm64`） |
| 新增 G-11 | 参考 SDK 与本地固件 ABI 兼容性未验证：需比对 `jsapi_proxy`/`libfalcon` 导出符号与 SDK 头文件版本，必要时以“空模块 + `custom_init_jsapis`”最小产物做真机 dlopen 验证 |
| 后续更新 | G-10 已由真机只读核查关闭（设备 arch 目录 = `arm64-popcorn`），见第十节；同时新增 G-12（已安装 `.so` 与包内 `.so` 不一致） |

### 9.5 阶段 0 建议动作（不构成本轮实施）

1. 阅读顺序：`scripts/falcon_build_common.ps1` → `launcher/tools/build-native.sh` → `launcher/native/src/JSAPI.cpp` → `launcher/native/src/Launcher/JSLauncher.cpp` → `docs/superpowers/specs/2026-08-05-falcon-lvgl-launcher-design.md`。
2. 以参考脚本为模板产出探针构建脚本（保持 `-Wl,--unresolved-symbols=ignore-all`、无宿主 RPATH、导出 `custom_init_jsapis`、产物名 `libjsapi_ds_probe.so`）。
3. 在 X7 Pro 上用两种 arch 目录名各打一个探针包（或先查设备已装小程序包内 `libs/` 的实际目录名），以真机 import 结果定名，不靠猜测。
4. 保留参考仓库子集副本（忽略目录）作为离线依据；若后续需要完整仓库（含 LVGL、docs 全量），再单独拉取。

---

## 十、真机只读核查（adb，2026-09-27 追加）

### 10.1 查询环境与边界

| 项 | 值 |
|---|---|
| 通道 | `G:\youdao\others\adb.exe` → 设备脱敏 `MEC17****3678`；`adb shell` 为 root（`uid=0`） |
| 系统 | `Linux YoudaoDictionaryPen-678 5.10.160 #18 SMP Tue Jul 28 18:14:54 CST 2026 aarch64`；无 `getprop`；平台代号 `popcorn`（libfalcon 构建路径含 `product/popcorn-release`） |
| 设备工具 | `/bin/miniapp_cli`（`install {amrPath}` / `uninstall {appid}` / `start {appId} --{page}` / `startService` / `capture {path}` / `debugApp`）、`/bin/unzip`、`/bin/busybox`、`/bin/tar`；无 python |
| 本轮操作 | 全部只读：`ls` / `cat` / `grep` / `find` / `md5sum` / `od` / `unzip -l`、`unzip -p`（stdout）/ `adb devices`；未安装、未卸载、未写入任何设备文件 |

### 10.2 系统侧原生库位置

| 路径 | 大小 | 说明 |
|---|---|---|
| `/usr/lib/libfalcon.so` | 10,985,728 B | 框架本体（含 JSAPI 动态加载与 PMS 逻辑） |
| `/usr/lib/libjsapi_proxy.so` | 657,304 B | JSAPI 代理 |
| `/etc/miniapp/jsapis/libjsapi_export_core.so` | 1,533,864 B | 框架级 jsapi（与 `.probe/export_core.so` 对应） |
| `/etc/miniapp/resources/framework/js_modules/` | — | 框架 JS 模块目录 |

### 10.3 小程序原生库：包内声明 vs 实际安装

- 包内声明（AMR `manifest.cert` 的键）形如 `libs/<archDir>/libjsapi_<module>.so`；也允许平坦形式 `libs/libjsapi_<module>.so`。
- 本机全部已安装包 manifest 的 `<archDir>` 直方图：**`arm64-popcorn` 79 条**、`arm64` 3、`arm` 3、`arm64-cherry3566` 2、`arm64-orange` 1（跨机型遗留）⇒ **本机 arch 目录名 = `arm64-popcorn`**。
- 示例（单词本 `8080212246010681`）：manifest 声明 `libs/arm64-popcorn/libbusiness_wordbook.so` 与 `libs/arm64-popcorn/libjsapi_wordbook.so`。
- 安装后落盘形态：`/userdisk/secondary/miniapp/data/mini_app/pkg/<appid>/<slot>/libs/libjsapi_<module>_<salt>.so`（arch 目录已被 PMS `processArchLibs` 归并到 `libs/`）。
- 通用回退示例：`8001771940015915` 的 manifest 同时声明 `libs/arm`、`libs/arm64`、`libs/arm64-cherry3566`（**不含** `arm64-popcorn`），本机仍安装了 `libs/libjsapi_shell_*.so` 与 `libs/libjsapi_fileserver_*.so` ⇒ 缺少机型专属目录时会回退到通用目录（本机表现为接受 `arm64`），但同一包内多目录的选取规则未验证。
- 包内 `.so` 确认为 ELF64 AArch64（对 `bilibili.amr` 与 `loli_v1.14.1.amr` 的条目做首字节校验，均为 `7f 45 4c 46 … 03 00 b7 00`）。

### 10.4 加载链证据（与第九节一致）

`libfalcon.so` strings 与 PMS 行为吻合：`libjsapi_` + `libs/` 动态加载 → `dlsym custom_init_jsapis`；PMS 侧 `extract arch libs from %s`、`[PMS]processArchLibs rename archLibs to libs failed`。设备实测：浏览器小程序 `8001779591038449` 安装目录同时存在

- `libs/arm64-orange/libjsapi_browser.so`（6,934,672 B，md5 `692451…`，与 manifest cert **完全一致**，时间戳 Jul 29）
- `libs/libjsapi_browser_12345_1649439548.so`（7,142,144 B，md5 `38e0b0…`，时间戳 Sep 1）

### 10.5 新发现 G-12：已安装库与包内库不一致

已安装的 `libs/*.so` 并非包内文件的直接拷贝：文件名多出 `_<salt>` 后缀，内容与时间戳也不同。例：loli（`8001687764241341`，版本 1.12.23）包内 `libs/libjsapi_bridge.so` = 2,150,456 B / md5 `83640b…`，安装后 `libs/libjsapi_bridge_1592736819.so` = 2,267,040 B / md5 `1c2aa9…`（Sep 15）。

结论：系统存在**独立的原生库下发/更新步骤**（PMS 或应用商店侧），其与包内 `libs/` 的关系、以及加载器如何解析 `_<salt>` 后缀，必须用自研探针在阶段 0 验证（自研包内只有我们自己的 `.so`，验证点：是否被原样保留或重命名、`import` 是否成功、`custom_init_jsapis` 是否被调用）。

### 10.6 对基线与阶段 0 的结论

1. **G-10 关闭**：探针投放目录采用 `app/libs/arm64-popcorn/`（推荐）；如担心机型差异，可同时提供通用回退 `app/libs/arm64/`——系统包已证明该目录在本机可用，但同包多目录的选择规则未验证。
2. **G-1 收窄**：打包路径、arch 目录名、安装落盘形态均已明确；剩余为真机 import 与卸载/升级行为。
3. **G-12 新增**：自研探针必须验证安装后文件名/内容变化对加载的影响。
4. 设备操作通道就绪：`miniapp_cli install/uninstall/start/capture` 可直接用于阶段 0 的安装与回滚验证；探针包可用 `adb push` 到 `/tmp` 后 `miniapp_cli install`。

---

## 附录 A：本阶段证据命令与结果

```text
git rev-parse HEAD                         → 2c8d2bbb9b9d1259fd40b3497646de65cfb12c01
git status --porcelain=v1 -b               → ## main...origin/main（无改动）
git branch -a                              → main / backup-before-restructure / remotes/origin/main / remotes/upstream/*
git tag -l                                 → v0.2.8
git log -1 backup-before-restructure       → 579d282 2026-09-13 chore: relocate root images …
git ls-files | count                       → 308
重构计划/ 文件清点                          → 仅 总体重构路线.md、下一步开发计划.md（无上一阶段交接文件）
app/libs 存在性                             → False
adb devices                                → 1 台设备，状态 device（序列号脱敏）
app: npm test                              → exit 0，9 个脚本全部通过
wsl -d Ubuntu … run-host-tests.sh          → 未完成（本机不支持嵌套虚拟化）
git clone --depth 1 github.com/Magniswan/Pen-LVGL → 成功（临时目录），HEAD a8d9a66
rg 'jqutil|libjsapi|custom_init_jsapis' <clone>   → SDK/模块注册/构建样板齐备（见第九节）
rg 'libjsapi_|libs/|archLibs|arm64' .probe/libfalcon.txt → 固件加载链与 PMS arch 目录证据
参照子集拷贝 .probe/refs/Pen-LVGL/        → 121 个文件 ≈ 705 KB（忽略目录，不入 git）
adb devices -l                             → 1 台设备（脱敏 MEC17****3678），adb shell uid=0
uname -a                                   → YoudaoDictionaryPen-678 5.10.160 aarch64（2026-07-28 构建）
command -v miniapp_cli / unzip / busybox   → /bin/miniapp_cli、/bin/unzip、/bin/busybox（无 python）
find <pkg> -name 'libjsapi_*.so'           → 已安装原生库约 90 个，落盘于 <pkg>/<slot>/libs/
manifest cert 直方图                        → arm64-popcorn 79 / arm64 3 / arm 3 / arm64-cherry3566 2 / arm64-orange 1
已安装库 md5 与包内 cert 对比                → 文件名多 _<salt>、内容与时间戳不同（G-12）
```

## 附录 B：本轮明确未做的事

- 未实施阶段 0（未创建探针、未引入 `libs/`、未改构建脚本）。
- 未迁移、未删除、未重命名任何业务文件；未改 `ds-free-api`、`app`、`CAPTCHA` 代码。
- 未读取历史会话记录；未复制既有结论，规划文档中的行数/规模估算未逐行复核。
- 未在真机上安装、卸载或启动任何包（仅执行只读 `adb devices`）。
