# 阶段 1B-ii：Native Transport 实现报告（M01–M31 · 显式终止链五件套）

- **文档版本**：T1B.2-ii（2026-09-30，Asia/Shanghai）
- **阶段**：1B-ii——Native Transport 实现、native IUT 接入、显式终止链五件套、M01–M31 native 口径
- **依据**：`docs/astra/02b-phase1-transport-contract-r1.md`（T1A.2-r1）、`02c-phase1-r1-revision-record.md`、`03-phase1b-prep.md`（T1B.0）、`.probe/probe/phase1b/**`、`.probe/refs/Pen-LVGL/launcher/native/iot-miniapp-sdk`
- **工作区**：`G:\youdao\Deepseek`
- **一句话**：Native Transport 库（context 隔离 + 显式终止链五件套 + QuickJS 投递闸门）实现完成并接入 native IUT；**M01–M31 在 native 口径 31/31 PASS（Windows + WSL 双基线，violations=0）**；M28 kill -9 断言“无任何晚到回调”成立；ref 基线回归 31/31，未触碰任何业务代码与默认入口。

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| M 矩阵（native 口径） | **31/31 PASS**：Windows 规范基线 `out/run-1bii-native-v1`（violations=0）、WSL/Linux 基线 `out/run-1bii-native-wsl-v1`（node 18，真 SIGKILL，violations=0） |
| M28（kill -9） | `control_late_hit=true`、`kill9_late_hit=false`、`kill9_trampoline_enter=0`、`frozen_after_kill=true`、`host_exited=true`、`restart_ok=true`、`restart_old_dir_untouched=true`、`verdict=no-late-callbacks-after-kill9`（两基线同） |
| 显式终止链五件套 | 成套实现：状态机+generation / 投递闸门 / 终止闩锁 / cancelAll / closeContext（§3.2；代码位置见 §3.2 各条） |
| 宿主兜底依赖 | **不存在**：native 代码对宿主生命周期事件零引用；S1/S2/S4 分支 (a) 机器断言“不取消则投递继续、无终态、闸门丢弃=0”，M25–M27 全部通过（§3.7、§4.4） |
| ref 回归 | `out/run-1bii-ref-check` 31/31 PASS；1B-0 规范基线 `out/run-1b0-ref-v1` / `-wsl` 保持有效（分表见 §5） |
| 接口命名/取消幂等/背压水位 | 与 02b 一致：9 个操作名、outcome 集合、32/64/8/16 与 128/64、1 MiB/512 KiB、512/256、4 MiB/2 MiB、64 KiB chunk、16 MiB/8 MiB/64 KiB（§3.5、§3.6、§6 对照） |
| 未修改业务代码/默认入口 | 未触碰 `ds.js`、`native.js`、`backend-blob.js`、`00-baseline.md`、`02b`、`02c`、默认入口（§2 变更范围） |
| 停止条件 | 三项均不触发（§7） |

---

## 2. 交付物与变更范围

### 2.1 新增：Native Transport 库（`.probe/probe/phase1b/mock/iut/native/`）

| 文件 | 作用 |
|---|---|
| `libjsapi_ds_transport.mjs` | 入口/JSAPI 绑定层：唯一接口 `request/openStream/cancel/cancelAll/openContext/closeContext/setProxy/clearCookies/getCookies` + test-build 钩子 |
| `transport_core.mjs` | 核心：context 状态机（open/closing/closed + generation）、admission/队列、终止闩锁、投递闸门、背压、Cookie/代理快照 |
| `network_worker.mjs` | Native 网络：HTTP/1.1、HTTP/2(ALPN)、代理（absolute-form / CONNECT）、TLS 与错误码映射 |
| `js_thread_bridge.mjs` | QuickJS 投递桥：JS loop / Handler / postJSMessage 三路径（同一语义；返回值不依赖） |

### 2.2 修改：mock 工程接线

| 文件 | 变更 |
|---|---|
| `iut/adapter.mjs` | `native` 分支由 `native-stub` 改为加载 `iut/native/libjsapi_ds_transport.mjs`（方法面与 ref 一致） |
| `harness/run.mjs` | native 参与真实矩阵：放开 host-sim / kill9 的 native 阻断、kill9 透传 IUT、native 运行中 M01–M18/M20–M24 证据类别记 `native-contract`（用例定义不动；M25–M27 仍 negative-control、M28 仍 hard-termination） |
| `README.md`（mock 与 phase1b） | 更新为 1B-ii 接线状态与证据目录 |

### 2.3 明确未做 / 未触碰

- 未加入 DeepSeek endpoint、账号、session、PoW、mute、retry；未加入 `stream:true` / `requestStream` / `data` 兼容分支；未切换默认入口。
- 未修改：`app/src/services/ds.js`、`app/src/services/native.js`、`app/src/services/backend-blob.js`、`重构计划/00-baseline.md`、`docs/astra/02-phase1-transport-contract.md`、`02b-*`、`02c-*`、`.probe/probe/p4c/**`。
- 未连真机、未构建 `.so`：本次为 **native IUT（mock 宿主内）口径**；真机 `.so`/JSAPI 移植与真机证据为阶段 2 项（§7.2）。
- 工作区既有并行改动（`app/HOWTOBUILD.md`、`ds-free-api/**`、`tools/**`、`docs/deepseek-incident-*`）未触碰。

---

## 3. 实现说明

### 3.1 分层与真机移植对应

| mock 模块 | 真机对应（阶段 2 移植） |
|---|---|
| `transport_core.mjs` | C++ 核心状态机（context 表 / op 表 / 闸门 / 闩锁 / 队列） |
| `network_worker.mjs` | Native worker 线程：socket / TLS / HTTP2 / 代理 |
| `js_thread_bridge.mjs` | JS 线程投递：`JQAsyncExecutor`/`Handler::post` 或 `JSCModuleExtension::postJSMessage`（SDK 头文件口径一致） |
| `libjsapi_ds_transport.mjs` | JSAPI 模块导出（`ds_transport` 方法面） |

### 3.2 显式终止链五件套（成套实现）

1. **状态机 + generation**（`openContext`/`closeContext`）：`open → closing → closed`；close 顺序 = 停接纳 → 批量提交 `cancelled(context-closed)` → `generation += 1` → `closed`；重复 close 幂等（不再递增、不产生新终态）；`openContext()` 重开 +1 并重置 Jar/代理/epoch（M29）。
2. **投递闸门**（`_gate()`，每次 JS 可见投递前）：检查 实例登记 / 未投递过 / 非终态要求 `!terminal && state==open && capturedGeneration==generation`；失败即丢弃并计 `gateDrops`。终态豁免仅限“已提交且尚未投递过”的唯一一次（close 后仍允许）。
3. **终止闩锁**（`_commitTerminal`/`_enqueueEvent`）：`end/error/cancelled` 任一提交后，晚到 `chunk/headers` 在入队处丢弃；`terminalDelivered` 拦截重复终态（M30 三种注入）。
4. **cancelAll**：逐 op 幂等取消（先提交者获胜）；默认 `reason=app-lifecycle-end`；不改变 context 状态；`outcomes` 与实况一致（M19/M26/M31）。
5. **closeContext**：见第 1 条；close 后新操作 reject `ERR_CONTEXT_CLOSED`；旧 generation 一切非终态投递丢弃（M19/M27/M29）。

### 3.3 QuickJS 回调投递

- 所有 `onEvent` / Promise settle 一律经 `JsThreadBridge`（单 FIFO，每轮循环一个任务；Looper/Handler 语义）。
- 三路径同语义：`handler`（默认）/ `postjsmessage`（消息体自含 `requestId/seq/kind`，所有权在入队时拷贝）/ `jsoop`（测试对照）；已做三路径一致性自检（headers>chunk×3>end、seq 1..5 全一致；handler=7 次任务投递、postjsmessage=7 次消息投递，deliveries 均=5）。
- **R9**：`postJSMessage` 返回值只记录（`messageReturnValues`），不参与任何成败判定——投递结果由闸门状态与后续行为决定。
- 回调异常捕获记录（`callbackExceptions`），不改变已提交终态（M24）。

### 3.4 contextId 隔离

- 每 context：独立 Cookie Jar、代理、epoch、活动/排队计数、generation；请求 admission 快照 = {代理, 可发送 Cookie, generation, epoch}。
- `clearCookies` 递增 epoch：清理后旧响应（epoch 不匹配）不得写回；generation 不匹配同样拒绝写入（M04/M23/M29）。
- Cookie 仅按 `contextId` 隔离；Native 不保存账号/session/token（M03/M04/M15/M23）。

### 3.5 队列与背压（与 02b §5 数值逐项一致）

- 32/64（全局活跃/排队）、8/16（单 context）；超限立即 `ERR_QUEUE_FULL` 并计数（M16）。
- 流待投递水位：128/64 事件、1 MiB/512 KiB；全局 512/256、4 MiB/2 MiB；单 chunk ≤ 64 KiB（M11/M17a 峰值断言）。
- 可暂停源：暂停读取、低水位恢复、不丢字节；不可暂停源：唯一 `ERR_BACKPRESSURE`（M17b：`backpressureErrors=1`、无第二终态）。
- 请求体 16 MiB / 聚合响应 8 MiB / 响应头 64 KiB（M18；超限错误码 `ERR_INVALID_ARGUMENT` / `ERR_RESPONSE_TOO_LARGE`）。
- `request()` 不发流事件、不受流背压影响（M01 `deliveries=0` 断言）。

### 3.6 native IUT test-build 钩子（等价面）

- `testAPI()`：`injectLateChunk/injectLateEnd/injectLateCancelled`（M30/M27/M29）、`stats()`（gateDrops / pauseCount / resumeCount / backpressureErrors / startedSeq / queueRejections / maxStreamPending* / callbackExceptions / deliveries / jsLoop*）、`op()`（terminal / terminalDelivered / seqOut / pending* / paused / limitBreached / totalBytes）、`queueSnapshot()`、`contexts()`。
- 钩子仅在 test-build（`testBuild !== false`）可用；release 构建不导出。

### 3.7 反例自查：不存在“宿主销毁兜底”

- native 代码对页面/应用生命周期事件**零引用**：`onStop`/`appPaused`/`appDestroyed`/`ignore dlclose` 只存在于 host-sim 的日志文件（`host-events.jsonl`），与 Transport 无接口；取消/停止投递只可能来自 `cancel`/`cancelAll`/`closeContext`。
- M25–M27 分支 (a) 以机器断言反向暴露兜底：不取消时晚到投递必须继续（`deliveredLate>=1`）、无终态（`terminal=null`）、闸门丢弃=0——若存在隐藏停止路径必然 FAIL。
- M27(b) 额外断言“close 后注入被接受但被闸门丢弃”（`injectAfterClose=true`、`gateDrops>=1`、事件数不增长），证明清理不依赖 `dlclose`/卸载钩子。

---

## 4. M01–M31 通过记录（native 口径）

### 4.1 运行与证据

```text
Windows（规范基线）：
  cd .probe/probe/phase1b/mock
  node harness/run.mjs --all --iut native --out out/run-1bii-native-v1
  → counts={"PASS":31}  violations=0

WSL/Linux（node 18.20.4，真 SIGKILL）：
  bash out/wsl-native-run-all.sh        # → out/run-1bii-native-wsl-v1, 31/31, violations=0

ref 回归（同一 harness 改动后）：
  node harness/run.mjs --all --iut ref --out out/run-1bii-ref-check   # 31/31
```

单用例与 kill9 明细见 `out/run-1bii-native-v1/case-<ID>/result.json`；M28 见 `case-M28/kill9/kill9-result.json`。

### 4.2 逐用例（Windows 规范基线；证据类别与关键断言）

| ID | 场景 | 状态 | 证据类别 | 关键断言/证据（节选） | 时长 |
|---|---|---|---|---|---|
| M01 | GET 200 小 body | native-contract | status/headers/body/requestId 精确；无流事件（deliveries=0） | 23ms |
| M02 | POST 精确字节 | native-contract | Uint8Array/string body 字节一致；content-type json | 7ms |
| M03 | Set-Cookie 观察与回传 | native-contract | body 未完成时 Cookie 已可观察（headers 时写入）；二次请求自动带 Cookie | 412ms |
| M04 | Cookie 隔离/清理/不复活 | native-contract | A/B 不串；cleared=1；clear 后旧响应不写回 | 424ms |
| M05 | 代理隔离与 admission 快照 | native-contract | proxy-A/B 各 1 条；在途请求仍走快照代理；setProxy(null) 后直连 | 438ms |
| M06 | 302 follow（5 跳上限） | native-contract | 最终 200 + final URL；5 跳允许；第 6 跳 ERR_REDIRECT | 26ms |
| M07 | 302 manual | native-contract | 交付 302 本体；未访问 final | 4ms |
| M08 | 401 可观察 | native-contract | request resolve 401；stream headers→chunk*→end 唯一终止 | 4ms |
| M09 | 429 可观察/无重试 | native-contract | resolve 429；服务端恰 2 次命中（无退避重试） | 6ms |
| M10 | 分片流顺序 | native-contract | headers→3×chunk→end；seq 1..5；end.totalBytes=16；end 后零投递 | 359ms |
| M11 | UTF-8 跨 chunk 原样 | native-contract | bytes 拼接还原；存在多字节内部切分；chunk ≤64 KiB | 353ms |
| M12 | 取消长流 | native-contract | cancel-requested；唯一 cancelled(user)；取消后零晚到 | 498ms |
| M13 | 取消幂等/竞态 | native-contract | 第 2/3 次 already-cancelled；end 后 already-terminal(end)；竞态唯一终态 | 669ms |
| M14 | 超时（含排队预算） | native-contract | request/stream 仅 ERR_TIMEOUT；headers 前无 headers 事件；单终态 | 1868ms |
| M15 | 重复 requestId/并发 settle | native-contract | 重复 → ERR_DUPLICATE_REQUEST_ID；A/B 各 settle 恰一次 | 581ms |
| M16 | 队列上限 | native-contract | 单 ctx 溢出 + 全局溢出均 ERR_QUEUE_FULL；active=32/queued=64；96 个请求全完成；A 队列 FIFO | 1274ms |
| M17 | 背压 | native-contract | (a) 暂停/恢复、字节无丢失、峰值≤1 MiB+2×64 KiB；(b) 唯一 ERR_BACKPRESSURE（count=1） | 9359ms |
| M18 | 体/响应/头上限 | native-contract | 16 MiB→ERR_INVALID_ARGUMENT；8 MiB→ERR_RESPONSE_TOO_LARGE；64 KiB 头→ERR_RESPONSE_TOO_LARGE；无二次 settle | 223ms |
| M20 | TLS+ALPN h1/h2 | native-contract | h1=h1/1.1、h2=2.0/h2 记录齐；连接失败稳定 ERR_NETWORK | 125ms |
| M21 | 代理 TLS/HTTP2 | native-contract | CONNECT 隧道内 h2；ERR_PROXY（死代理）；不影响其他 context | 38ms |
| M22 | 断连/空流 | native-contract | headers 前 error；headers 后 headers→error（无 end）；空体 headers→end(0) | 101ms |
| M23 | Set-Cookie 与 clear 并发 | native-contract | epoch 防复活；新 admission 无 Cookie | 445ms |
| M24 | 回调异常隔离 | native-contract | 记录 callback exception；终态仍 end；后续 cancel=already-terminal；数据未丢失 | 123ms |
| M25 | S1 页面停止 | negative-control | (a) 停止后晚到仍投递、无终态、闸门丢弃=0；(b) cancel 后零晚到、唯一 cancelled(user)、cancel-requested | 5079ms |
| M26 | S2 切后台/停止小程序 | negative-control | (a) 后台投递继续、无终态；(b) cancelAll 后零晚到、唯一 cancelled(app-lifecycle-end)、cancelled=1 | 4660ms |
| M27 | S4 卸载（ignore dlclose） | negative-control | (a) 卸载后晚到仍执行；(b) cancelAll+close 后零晚到、close.cancelled=0/outcomes=already-cancelled、注入被闸门丢弃、无失效 JS 访问 | 5190ms |
| M28 | kill -9 硬终止 | hard-termination | control 晚到出现；kill9 后零晚到/零 trampoline/产物冻结/宿主退出/重启旧目录不动；verdict=no-late-callbacks-after-kill9 | 34641ms |
| M19 | 显式终止链 cancelAll→close | explicit-termination | cancelAll.cancelled=2（request+stream 均 cancel-requested）；close.cancelled=0、outcomes=already-cancelled；close 后 ERR_CONTEXT_CLOSED；hold reject ERR_CANCELLED；stream 唯一 cancelled(app-lifecycle-end) | 951ms |
| M29 | 状态机与 generation | explicit-termination | open gen=1；close1 gen=2/cancelled=1；close2 幂等 gen=2/cancelled=0；closed 拒绝；注入闸门丢弃；重开 gen=3/Jar 重置（0）；新代投递正常；clearCookies 生效 | 1924ms |
| M30 | 终态闩锁晚到注入 | explicit-termination | end 后 3 次注入全被接受且全丢弃（drops=3）、事件数不增长、cancel=already-terminal；error 流无 end；cancelled 流取消先提交 | 2124ms |
| M31 | cancelAll 并发/幂等 | explicit-termination | cancelAll1.cancelled=1（hold）、s1=already-cancelled；cancelAll2.cancelled=0 全 already-*；cancelAll 不改 open（新 admission ok）；close 后 cancelAll=ERR_CONTEXT_CLOSED；并发分支 hold 终态 cancelled 且已投递 | 948ms |

### 4.3 M28 明细（两个基线）

| 字段 | Windows（`out/run-1bii-native-v1/case-M28/kill9`） | WSL（`out/run-1bii-native-wsl-v1/case-M28/kill9`） |
|---|---|---|
| control_late_hit | true | true |
| kill9_late_hit | false | false |
| kill9_trampoline_enter | 0 | 0 |
| frozen_after_kill | true | true |
| host_exited | true | true |
| restart_ok / restart_old_dir_untouched | true / true | true / true |
| verdict | no-late-callbacks-after-kill9 | no-late-callbacks-after-kill9 |

口径：kill 目标为宿主进程（host-sim；Transport 与宿主同进程）；Windows 用 TerminateProcess、WSL 用真 `kill -9`；执行顺序保持“先拉取日志快照 → kill → 冻结断言 → 重启检查”。

### 4.4 S1/S2/S4（M25–M27）可用范围（重申）

- 仅作 (a) “宿主不停止投递”负向对照与 (b) “显式取消有效”证据；**不得**作为“已终止 / 已释放资源”证据。
- 本报告与 summary 守卫一致：M25–M27 证据类别固定 `negative-control`、断言名不含“已终止/terminated”表述；M28 是唯一认可的硬终止证据。

---

## 5. ref 与 native 分表

口径：**ref** = 1B-0 契约参考测试替身（`infra-self-test`，仅基建自检）；**native** = 1B-ii Native Transport（M01–M18/M20–M24 记 `native-contract`，其余类别同 1B-0 定义）。两套结果分目录保存，不混用。

| 用例组 | ref（基建自检） | native（1B-ii） | 结论 |
|---|---|---|---|
| M01–M09 | PASS（`out/run-1b0-ref-v1`；回归 `out/run-1bii-ref-check`） | PASS（`out/run-1bii-native-v1`） | 基础 HTTP/Cookie/代理/重定向/状态码一致 |
| M10–M18 | 同上 | PASS | 流顺序/UTF-8/取消/超时/队列/背压/上限一致 |
| M20–M24 | 同上 | PASS | TLS/ALPN/代理/断连/Cookie race/回调隔离一致 |
| M25–M27 | PASS（negative-control） | PASS（negative-control） | 宿主不停止 + 显式取消有效；均不得作“已终止”证据 |
| M28 | PASS（hard-termination，`out/kill9-standalone`、`out/run-1b0-ref-v1/case-M28`） | PASS（hard-termination，两基线） | “无任何晚到回调”成立 |
| M19、M29–M31 | PASS（explicit-termination） | PASS（explicit-termination） | 显式终止链/ generation / 闩锁 / 并发幂等一致 |

差异说明：ref 是“契约替身”，其通过只证明基建可重放；native 通过意味着契约语义由 Native Transport 库自身实现（本次验收口径）。native 运行不改动用例定义；仅运行器在 native 时把 M01–M18/M20–M24 的证据类别改名（`infra-self-test` → `native-contract`），M25–M28 的类别不受影响。

---

## 6. 未决问题更新（1A-r1 §10 / 03 §13 → 1B-ii 状态）

| # | 问题 | 1B-ii 状态 |
|---|---|---|
| ① | 固件是否向 JS 暴露 App 级卸载回调 | 结论不变（03/FINDINGS：未发现可依赖信号）；本实现**无任何**卸载依赖路径；M27(b) 机器验证“无卸载信号仍可完全终止” |
| ② | `postJSMessage` 返回值语义 | 保持“不可依赖”：实现只记录返回值、不参与判定；三路径自检语义一致（§3.3） |
| ③ | `jsapi_check_unload` 设计决策 | 本 build 不导出、不依赖；语义与显式终止链一致（M27(b)/M29 闸门丢弃旧 generation 投递） |
| ④ | 同宿主重装（同 appid）行为 | 仍未真机覆盖；generation 机制作为兜底已在 mock 内验证（M29：重开 +1、旧代投递全丢弃、Jar 重置） |
| ⑤ | 页面生命周期钩子（onHide/onUnload）触发时机 | 结论不变（不可依赖）；1B-ii 未新增宿主钩子；“最后一个可得生命周期节点”实现位置留待真机联调（02b §11.4 接口/联调桩） |
| ⑥ | 显式终止链期“最后安全 JS loop 时刻” | 不变：已按闸门丢弃设计，不依赖该时刻精度（M29/M30 注入用例） |
| ⑦–⑩ | TLS/HTTP2/代理真机稳定性、ERR_BACKPRESSURE 可实现性、错误码映射、16 MiB/8 MiB 覆盖性 | mock 侧已固定（M17/M20/M21/M18）；真机复测项保持 |

**1B-ii 新增实现层边界（供阶段 2 评审，非契约修订请求）**

1. **代理 scheme 支持面**：本 build 的 worker 实现 `http://`（absolute-form 与 CONNECT）；`https://`、`socks5://` 按“能力以 scheme 校验”口径 reject `ERR_PROXY`（保守默认，可配置点集中在 `setProxy`/`network_worker`）。
2. **投递路径**：默认 `handler`；`postjsmessage` 已实现且自检等价；真机接入时按宿主能力二选一（同一闸门、同一语义）。
3. **不可暂停源**：`ERR_BACKPRESSURE` 依赖网络栈 pause 能力；真机若读取不可暂停需按 M17b 语义保留唯一错误与硬上限约束。
4. **M28 mock 口径**：kill 目标是“宿主进程 + Transport 同进程”；真机脚本结构不变（先拉日志 → kill -9 → 冻结断言 → 重启检查），只替换进程与日志路径。

---

## 7. 停止条件核对与阶段 2 进入条件

### 7.1 停止条件核对（全部不触发）

| 停止条件 | 核对 |
|---|---|
| 任一 M 用例未过 → 停留在 1B-ii | 不触发：native 31/31（Windows + WSL），ref 回归 31/31 |
| 显式终止链缺失或依赖宿主 → 不得宣称 G1 通过 | 不触发：五件套成套实现（§3.2）；宿主生命周期零引用（§3.7）；M25–M27 (a) 负向对照机器验证 |
| 契约与实现冲突 → 停止并等待 1A-r2 | 不触发：未发现硬冲突；仅记录 3 条实现层边界（§6 末），全部按契约保守默认处理 |

### 7.2 进入阶段 2 的条件（1B-ii 视角，建议）

1. 真机移植按 §3.1 分层映射（core/worker/bridge/绑定），保持闸门为唯一投递路径。
2. 真机证据表：M20/M21（TLS/ALPN/HTTP2/代理）与 M28（宿主进程 kill -9）在真机重建；本 mock 证据不得冒充真机证据。
3. 保持 S1/S2/S4 负向对照口径与 M28 唯一硬终止口径。
4. 未决①–⑤ 真机补测项（卸载/销毁回调、postJSMessage 失败语义、check_unload、同宿主重装、最后安全节点）。
5. 禁止回退：不得出现 `requestStream` / `data` / `stream:true` 分支；不得引入 DeepSeek 业务逻辑（阶段 3 边界）。

### 7.3 证据索引（本轮）

```text
docs/astra/04-phase1b-impl.md                              本报告
.probe/probe/phase1b/mock/iut/native/**                   Native Transport 库（1B-ii）
.probe/probe/phase1b/mock/iut/adapter.mjs                  native IUT 接入
.probe/probe/phase1b/mock/harness/run.mjs                  harness 接线（native 全量参与）
.probe/probe/phase1b/mock/out/run-1bii-native-v1/          Windows 规范基线（31/31，violations=0）
.probe/probe/phase1b/mock/out/run-1bii-native-wsl-v1/      WSL 基线（31/31；M28 真 SIGKILL）
.probe/probe/phase1b/mock/out/run-1bii-ref-check/          ref 回归（31/31）
.probe/probe/phase1b/mock/out/wsl-native-run-all.sh        WSL native 重放脚本
.probe/probe/phase1b/mock/out/wsl-native-kill9.sh          WSL native kill9 重放脚本
```

### 7.4 变更范围声明（补充)

- 本阶段写入范围：`.probe/probe/phase1b/mock/iut/native/**`（新增）、`iut/adapter.mjs`、`harness/run.mjs`、两个 README、`mock/out/run-1bii-*`（证据）、`docs/astra/04-phase1b-impl.md`。
- 未修改任何业务代码与受保护文档；文档不含 token、密钥、Cookie 值或设备凭据。
- 未依赖宿主销毁兜底；未猜测固件行为；未决问题均按“不可依赖”设计。
