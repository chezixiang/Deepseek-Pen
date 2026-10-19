# 阶段 1B-0：可重放 mock / fixture / 宿主生命周期模拟 / kill -9 测试 + 未决问题 ①⑤ 调查

- **文档版本**：T1B.0（2026-09-30，Asia/Shanghai）
- **阶段**：1B-0（前置基建）。**未进入 1B-ii，未实现 Native Transport。**
- **依据**：`docs/astra/02b-phase1-transport-contract-r1.md`（T1A.2-r1）、`02c-phase1-r1-revision-record.md`、`01-phase0-p4c.md`、`.probe/probe/p4c/EVIDENCE.md`
- **工作区**：`G:\youdao\Deepseek`
- **一句话**：M01–M31 已成套建立并可独立重放（Windows + WSL 两套基线各 31/31 通过，运行于**契约测试替身**的基建自检模式）；M28 kill -9 断言"无任何晚到回调"成立；未决问题 ①⑤ 完成只读调查并给出"结论 + 待验证"边界；原生 Transport 的 M 矩阵结果留待 1B-ii。

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| M 矩阵 | **31/31 PASS（ref 基建自检）**：Windows 基线 `out/run-1b0-ref-v1`（总用例时长 ≈ 70.0 s，末次终态重跑 69.95 s）、WSL/Linux node 18 基线 `out/run-1b0-ref-v1-wsl`（≈ 62.3 s）；每用例独立可运行、失败可定位到具体断言（`case-<ID>/result.json`） |
| M28 | kill -9 断言成立：`control_late_hit=true`、`kill9_late_hit=false`、`kill9_trampoline_enter=0`、`frozen_after_kill=true`、`restart_old_dir_untouched=true`、`verdict=no-late-callbacks-after-kill9`（Windows TerminateProcess 与 POSIX 真 SIGKILL 各自验证） |
| S1/S2/S4（M25–M27） | 机器强制为 **negative-control**：只允许断言"宿主事件不停投递（负向对照）+ 显式取消有效"；summary 守卫会拒绝任何"已终止"表述（详见 §7.3） |
| 未决问题 ① | **本地证据未发现 JS 可见的卸载专用回调**；相邻机制均为 Native 侧（`registerAppLifecycle` C++ 回调、`jsapi_check_unload` 库卸载协议）。"卸载时 JS `onDestroy` 是否触发" = **待验证**；设计口径不变（不得依赖卸载信号） |
| 未决问题 ⑤ | **可得钩子清单：明确**（页面 `onLoad/onNewOptions/onShow/onHide/onUnload`；应用 `onLaunch/onShow/onHide/onDestroy/onError`，两个框架版本存档一致、官方小程序真实使用）。**JS 层触发时机：待验证**（P4c 未注册钩子）；Native 日志层触发序列已记录。约束：`onHide/onUnload` 不得作为 `cancelAll` 唯一触发点 |
| 1B-ii 进入条件 | 本基建满足"可重放 mock/fixture"门槛；进入 1B-ii 前需：①把 `iut/adapter.mjs` 的 native 分支接真实模块；②为 native IUT 提供等价 test-build 钩子（§11）；③保持 M28/S1-S2-S4/闸门语义不变。**未发现 ①⑤ 与 cancelAll 触发时机的冲突**（记录一条约束，见 §10.3） |
| 停止条件核对 | "mock 不可重放" → 不成立（三次独立重放一致）；"①⑤ 与 cancelAll 冲突" → 未发现硬冲突。不触发停止。 |

---

## 2. 范围与边界

### 2.1 本轮完成

1. **Mock 工程**（HTTP/TLS(ALPN h1/h2)/双代理 fixture + 控制面）：M01–M18、M20–M24 素材与断言。
2. **宿主生命周期模拟器**：S1（页面停止）、S2（切后台/停止小程序）、S4（卸载，含 `ignore dlclose` 文本模拟）、M19/M29/M30/M31 场景；标记链与 P4c 探针口径一致（`scheduled → trampoline-enter/exit`、JS hit、host-events、terminals）。
3. **kill -9 测试**：Windows（`Stop-Process -Force` = TerminateProcess）与 POSIX（真 `kill -9`，WSL 实测）两版；含 control 组、先拉日志、冻结断言、重启后旧目录不变检查。
4. **IUT 适配层**：`ref`（契约参考测试替身，用于基建自检）/ `native`（1B-ii 接入点，当前 `native-stub` 输出结构化 PENDING）。
5. **未决问题 ①⑤ 只读调查**（`.probe/probe/phase1b/lifecycle/`）。
6. **本报告 + M01–M31 断言映射表**。

### 2.2 明确未做（按任务边界）

- **未实现 Native Transport**（无 `.so`、无 C++/JSAPI 代码）。
- 未修改 `app/src/services/ds.js`、`native.js`、`backend-blob.js`；未切换默认入口。
- 未修改 `重构计划/00-baseline.md`、`docs/astra/02b-*`、`02c-*`、`02-phase1-transport-contract.md`。
- 未连真机、未安装/启动设备应用（①⑤ 调查为本地存档只读）。
- 未进入 1B-ii。

### 2.3 证据分级（硬性口径）

| 类别 | 用例 | 含义与可用范围 |
|---|---|---|
| `infra-self-test` | M01–M18、M20–M24 | 用 **ref 契约测试替身** 运行的基建自检：证明 mock/fixture/断言/运行器可重放、失败可定位。**不是 Native Transport 的 G1 证据，不得用于宣称传输层通过。** |
| `negative-control` | M25、M26、M27 | S1/S2/S4：只证明 (a) 宿主生命周期事件不停投递（负向对照）(b) 显式取消有效。**不得作为"已终止 / G1 销毁项通过"的证据。** |
| `explicit-termination` | M19、M29、M30、M31 | 显式终止链语义（cancel/cancelAll/closeContext + 闸门 + generation + 终止闩锁）在 mock 内成立。 |
| `hard-termination` | M28 | kill -9（进程终止）是**唯一**认可的硬终止证据；断言口径为"无任何晚到回调"。 |

> 1B-ii 换用 native IUT 后，上表语义不变；**同一 harness、同一用例、同一断言**原样复用，结果表另建（避免把 ref 自检结果误读为传输实现结果）。

---

## 3. 交付物与目录

```text
.probe/probe/phase1b/
├── README.md                       工程索引
├── mock/                           mock 工程（本报告引用根）
│   ├── README.md                   运行方式 / 证据口径 / 1B-ii 接入点
│   ├── package.json
│   ├── server/
│   │   ├── mock_server.mjs         HTTP + HTTPS(ALPN h1/h2) + /control/* + 全部 fixture
│   │   ├── proxy_fixture.mjs       双代理（HTTP 转发 + CONNECT 隧道 + proxy marker 记录）
│   │   ├── state.mjs               控制面状态（请求记录/ALPN/代理记录/held）
│   │   └── certs/{key,cert}.pem    本地测试自签证书（非设备凭据；可重建）
│   ├── iut/
│   │   ├── adapter.mjs             IUT 适配层（ref | native）
│   │   ├── ref-transport.mjs       契约参考测试替身（非 Native；仅基建自检）
│   │   └── native-stub.mjs         native 占位（结构化 NOT_IMPLEMENTED / PENDING）
│   ├── host-sim/host_sim.mjs       宿主生命周期模拟器（s1/s2/s4/m19/m28/m29/m30/m31）
│   ├── harness/
│   │   ├── run.mjs                 运行器（--all/--case/--list/--iut）
│   │   ├── lib/{assert,util,report}.mjs
│   │   └── cases/{m01_09,m10_18,m20_24,m25_31}.mjs
│   ├── scripts/
│   │   ├── run-all.ps1 / run-all.sh
│   │   ├── run-case.ps1
│   │   ├── kill9-test.ps1 / kill9-test.sh
│   │   └── gen-certs.ps1
│   └── out/                        运行证据
│       ├── run-1b0-ref-v1/         Windows 规范基线（31/31 PASS）
│       ├── run-1b0-ref-v1-wsl/     WSL/Linux 基线（31/31 PASS）
│       ├── kill9-standalone/       kill9 脚本独立运行证据
│       ├── run-1b0-native-stub2/   native PENDING 姿态证据
│       └── smoke*/                 开发期冒烟记录（可整体删除）
└── lifecycle/
    ├── FINDINGS.md                 ①⑤ 调查结论（含证据行号）
    ├── investigate.ps1             只读调查脚本（可重放）
    └── evidence/{findings.json, raw/*}
```

---

## 4. 运行方式（全部实测命令）

### 4.1 Windows（本机基线）

```powershell
cd G:\youdao\Deepseek\.probe\probe\phase1b\mock

# 全矩阵（ref 基建自检；约 70 s）
node harness/run.mjs --all --out out/run-1b0-ref-v1
# 单用例（失败定位到断言名）
node harness/run.mjs --case M07
# 列出用例
node harness/run.mjs --list
# kill -9（独立脚本；约 30 s）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kill9-test.ps1 -OutDir out/kill9-standalone
# 或经 harness（200 s 超时 + 进程树清理）
node harness/run.mjs --case M28
# 包装脚本
scripts\run-all.ps1 [-Iut ref|native] [-Out DIR]
scripts\run-case.ps1 -Case M07
```

### 4.2 WSL / Linux（node 18.20.4 实测）

```bash
cd /mnt/g/youdao/Deepseek/.probe/probe/phase1b/mock
export PATH=/opt/node18/bin:$PATH        # 本机 WSL 的 Linux node；或自备 node>=18
node harness/run.mjs --all --out out/run-1b0-ref-v1-wsl
bash scripts/kill9-test.sh /tmp/kill9-sh-test 8000 2500 ref
```

### 4.3 输出

- `out/<run>/case-<ID>/result.json`：逐条断言（`name/ok/detail`）、`status`、`evidenceClass`、耗时。
- `out/<run>/summary.json` / `summary.md`：矩阵结果 + 证据分级守卫结果。
- `out/<run>/case-M28/kill9/kill9-result.json`：`control_late_hit / kill9_late_hit / kill9_trampoline_enter / frozen_after_kill / host_exited / restart_ok / restart_old_dir_untouched / verdict`。
- 生命周期用例另有 `case-<ID>/<scenario>/…`：`native-marks.jsonl`、`host-events.jsonl`、`js-hits.jsonl`、`terminals.jsonl`、`result.json`。

---

## 5. 1B-0 运行结果（ref 基建自检）

| 运行 | 环境 | 结果 | 时长 |
|---|---|---|---|
| `out/run-1b0-ref-v1` | Windows，node v24.18.1 | **31/31 PASS**（0 FAIL / 0 PENDING） | ≈ 70.0 s（终态重跑 69.95 s） |
| `out/run-1b0-ref-v1-wsl` | WSL Ubuntu，node 18.20.4 | **31/31 PASS** | ≈ 62.3 s |
| `out/kill9-standalone` | Windows（TerminateProcess） | `verdict=no-late-callbacks-after-kill9` | ≈ 32 s |
| `out/run-1b0-native-stub2` | Windows，`--iut native` | 31×PENDING（结构化未就绪） | < 1 s |

- **可重放验证**：ref 基线在 Windows 与 WSL 两环境独立重放一致；kill9 在 TerminateProcess 与真 SIGKILL 两种语义下断言一致。
- **失败可定位**：每个用例独立执行、独立写 `result.json`；summary 列出每个用例的失败断言名。
- **native 姿态**：`--iut native` 输出 PENDING（非通过非失败），防止误读；接入真实模块后同一命令重跑即为 1B-ii 结果表。

---

## 6. M01–M31 断言映射表

> 结果列"PASS"均为 ref 基建自检口径（§2.3）；"1B-ii"列为接入 native IUT 后需产出的结果位。

| ID | 组 | Fixture / 场景 | 关键断言（摘要） | 证据类别 | 1B-0 结果 | 1B-ii |
|---|---|---|---|---|---|---|
| M01 | HTTP | `GET /plain` | 200；`x-fixture` 头；body 字节精确；最终 URL；无流事件 | infra-self-test | PASS | 待跑 |
| M02 | HTTP | `POST /echo` | Uint8Array/string body 精确回显；content-length 设置 | infra-self-test | PASS | 待跑 |
| M03 | Cookie | `/cookie/delay-body` + `/cookie/set` + `/cookie/echo` | Set-Cookie 在 resolve 前可观察（headers 时刻写入）；第二次请求带 Cookie | infra-self-test | PASS | 待跑 |
| M04 | Cookie | 双 context + `/cookie/race` | A/B 隔离；`clearCookies(A)` 不影响 B；旧响应 Set-Cookie 不复活 | infra-self-test | PASS | 待跑 |
| M05 | 代理 | proxy-A / proxy-B + `/delay/headers` | 按 context 走对应代理；在途请求用 admission 快照；`setProxy(null)` 后直连；互不串用 | infra-self-test | PASS | 待跑 |
| M06 | 重定向 | `/redirect/start`、`/redirect/hop` | follow 得最终 200；5 跳允许；第 6 跳 `ERR_REDIRECT` | infra-self-test | PASS | 待跑 |
| M07 | 重定向 | 同一 302 + `redirect:"manual"` | 302 原样交付；不访问 final；无业务事件 | infra-self-test | PASS | 待跑 |
| M08 | 状态码 | `/status/401` | request resolve 401（非异常）；stream `headers→chunk*→end`；WWW-Authenticate 可见 | infra-self-test | PASS | 待跑 |
| M09 | 状态码 | `/status/429` | 同上；Retry-After 可见；服务端记录恰 2 次请求（无重试/退避） | infra-self-test | PASS | 待跑 |
| M10 | 流 | `/stream/basic` | 严格 `headers→3×chunk→end`；seq 1..5；拼接内容；end 后零投递 | infra-self-test | PASS | 待跑 |
| M11 | 流 | `/stream/utf8` | 原始字节跨 chunk 交付；拼接恢复完整 UTF-8；存在切在多字节字符内部的 chunk 边界 | infra-self-test | PASS | 待跑 |
| M12 | 取消 | `/stream/long` + `cancel()` | 首次 `cancel-requested`；唯一 `cancelled(user)`；取消后零晚到；单终态 | infra-self-test | PASS | 待跑 |
| M13 | 取消 | long / basic / 竞态 | 二次取消 `already-cancelled`；end 后 `already-terminal(end)`；竞态"先提交者获胜"+单终态 | infra-self-test | PASS | 待跑 |
| M14 | 超时 | `/delay/headers`、`/delay/body` | 统一 `ERR_TIMEOUT`；stream 头前 error / 头后 `headers→error`；无二次投递 | infra-self-test | PASS | 待跑 |
| M15 | 重复 | `/dup-target` + 双 context 并发 | 重复 requestId `ERR_DUPLICATE_REQUEST_ID`；原请求不受影响；各自恰好 settle 一次 | infra-self-test | PASS | 待跑 |
| M16 | 队列 | `/hold` 多批 + `/control/release` | 单 context 8 活跃+16 排队后 `ERR_QUEUE_FULL`；全局 32 活跃+64 排队后拒绝；FIFO 启动顺序；全部 96 请求完成 | infra-self-test | PASS | 待跑 |
| M17 | 背压 | `/stream/backpressure`（400×4 KiB）与 `/stream/unpausable` | (a) 慢消费者触发暂停/低水位恢复、零丢失、峰值 ≤ 1 MiB+余量、无超限 chunk；(b) 不可暂停源 → 唯一 `ERR_BACKPRESSURE` | infra-self-test | PASS | 待跑 |
| M18 | 上限 | `/big-body`、`/big-headers` | body>16 MiB → `ERR_INVALID_ARGUMENT`；响应>8 MiB / 头>64 KiB → `ERR_RESPONSE_TOO_LARGE`；无二次 settle | infra-self-test | PASS | 待跑 |
| M19 | 显式链 | `/hold` + `/stream/late` + cancelAll→closeContext | 各操作单终态（stream `cancelled(app-lifecycle-end)`、request `ERR_CANCELLED`）；close 幂等 outcomes `already-*`；close 后 `ERR_CONTEXT_CLOSED` | explicit-termination | PASS | 待跑 |
| M20 | TLS | `/tls/plain`（h1 与 h2） | 200；httpVersion 1.1/2.0；ALPN 记录 `http/1.1` 与 `h2`；连接失败分类 `ERR_NETWORK` | infra-self-test | PASS | 待跑 |
| M21 | 代理+TLS | 代理隧道内 h2 + 死代理 | 经 proxy-A CONNECT 得 h2；不影响其他 context；死代理 `ERR_PROXY`；错误后其他 context 正常 | infra-self-test | PASS | 待跑 |
| M22 | 断连 | `/stream/close-before-headers`、`close-after-headers`、`/empty` | 头前断连仅 `error`；头后 `headers→chunk*→error`；空 body `headers→end`；request 版 `ERR_NETWORK` | infra-self-test | PASS | 待跑 |
| M23 | Cookie race | `/cookie/race` + `clearCookies` | clear 后旧响应不得写回；正常写入/清理计数；清理后新 admission 无 Cookie | infra-self-test | PASS | 待跑 |
| M24 | 回调隔离 | `/stream/basic` + 抛异常回调 | 记录 callback exception；终态仍唯一（end）；不伪装成网络 error；后续 cancel `already-terminal` | infra-self-test | PASS | 待跑 |
| M25 | 生命周期(S1) | host-sim `s1` a/b | (a) 负向对照：页面停止后晚到 chunk 仍投递、无终态、闸门不变；(b) cancel 后零晚到、唯一 `cancelled(user)`、cancel 返回 `cancel-requested` | **negative-control** | PASS | 待跑 |
| M26 | 生命周期(S2) | host-sim `s2` a/b | (a) 后台投递继续、无终态；(b) cancelAll 后零晚到、唯一 `cancelled(app-lifecycle-end)` | **negative-control** | PASS | 待跑 |
| M27 | 生命周期(S4) | host-sim `s4` a/b（`ignore dlclose` 文本） | (a) 卸载后晚到投递仍执行；(b) cancelAll+closeContext 后零晚到；close 后注入被闸门丢弃；单终态 | **negative-control** | PASS | 待跑 |
| M28 | kill -9 | `kill9-test`（control + kill + restart） | control 组晚到回调出现；kill 后无 js-hit、无 trampoline；产物冻结；宿主退出；重启后旧目录不变 | **hard-termination** | PASS | 待跑 |
| M29 | generation | host-sim `m29` | close 幂等（gen 不二次递增）；closed 后 `ERR_CONTEXT_CLOSED`；close 后注入丢弃；重开 gen+1、Jar 重置、新代投递正常 | explicit-termination | PASS | 待跑 |
| M30 | 闩锁 | host-sim `m30`（end/error/cancelled 三态注入） | 终态后 chunk/end/重复取消注入全部丢弃（事件数不增长）；先提交者获胜 | explicit-termination | PASS | 待跑 |
| M31 | cancelAll | host-sim `m31`（并发+幂等） | cancel 与 cancelAll 幂等；重复 cancelAll 全 `already-*`；不改 open 状态；并发 cancelAll/closeContext 单终态；close 后拒绝 | explicit-termination | PASS | 待跑 |

### 6.1 与 02b §8.1 记录字段的覆盖对照

| 02b 要求记录项 | 1B-0 落点 | 1B-ii 补充 |
|---|---|---|
| 请求上下文 / requestId / 代理路径 / 收到 headers/body | `/control/state`（httpRequests/proxyRecords）+ 用例断言 | 同 |
| 事件序列 / 终止原因 | `case-*/result.json` 断言 + host-sim `terminals.jsonl`/`js-hits.jsonl` | 同 |
| 队列峰值 | ref `stats().queueSnapshot/startedSeq` 断言（M16） | native 需提供等价 test 钩子 |
| 是否发生晚到回调 | host-sim `native-marks.jsonl` + `js-hits.jsonl`（M25–M28） | 同 |
| 宿主进程存活 / native 线程 / `.so` 映射 | M28：宿主进程退出 + 产物冻结 + 重启检查 | 真机：补 `.so` 映射与 native 线程标记（设备侧采集） |
---

## 7. 宿主生命周期模拟框架（host-sim）

### 7.1 设计

`host-sim/host_sim.mjs` 以独立进程运行一个"宿主 + JS 侧编排"的模拟体：

- 对 mock server 打开真实请求/流（与 1B-ii 相同的 IUT 接口 `request/openStream/cancel/cancelAll/closeContext`）；
- 按场景注入**宿主事件**（模拟固件行为，与 P4c 证据口径一致）：
  - S1：`PageLifecycle->onStop`（页面停止，**不通知 transport**）；
  - S2：`AppLifecycle->appPaused`（切后台/停止小程序，不通知 transport）；
  - S4：`AppLifecycle->appDestroyed` + `[DynamicLib] … has no jsapi_check_unload symbol; ignore dlclose`（卸载，不通知 transport；模拟"无卸载信号"）；
- 标记链与 P4c 探针一致：`native-marks.jsonl`（`scheduled`/`trampoline-enter`/`trampoline-exit`/`explicit-termination`）、`js-hits.jsonl`（JS 回调落盘）、`terminals.jsonl`、`host-events.jsonl`、`result.json`（结构化判定数据）。

场景注册表：`s1|s2|s4`（各含 branch a=负向对照 / b=显式终止）、`m19`（cancelAll→closeContext）、`m28`（kill -9 用）、`m29`（generation）、`m30`（闩锁注入）、`m31`（并发/幂等）。

### 7.2 S1/S2/S4 的场景语义（负向对照 + 显式有效性）

每个分支各跑一次：

- **(a) 负向对照**：只注入宿主事件、不取消 → 断言"晚到 chunk 仍被投递、操作无终态、闸门丢弃 = 0"。若投递没发生，说明存在隐藏的自动停止路径 → 用例 FAIL（这与 02b §4.2 的原则冲突，必须暴露）。
- **(b) 显式终止**：注入宿主事件 + `cancel()`（S1）/`cancelAll()`（S2）/`cancelAll()+closeContext()`（S4） → 断言"零晚到投递、唯一终态（reason 按 §3.1 映射）、cancel 返回 `cancel-requested`（证明宿主事件本身未产生终态）"。

### 7.3 "不得作为已终止证据"的机器强制

1. 三个用例的 `evidenceClass` 固定为 `negative-control`（写在用例定义里，运行器不可覆盖）。
2. `harness/lib/report.mjs` 守卫：M25–M27 若非 `negative-control`、或其断言名出现"已终止/terminated"字样 → summary 记录 **VIOLATION**，退出码非 0。
3. 用例 `notes` 字段固定写入："S1/S2/S4 负向对照：不得作为'已终止'证据；仅证明宿主事件不停投递 + 显式取消有效"。
4. M28 的 `evidenceClass` 固定 `hard-termination`；只有 kill -9 场景允许"无晚到回调"作为终止证据。

---

## 8. kill -9 测试（M28）

### 8.1 脚本流程（`scripts/kill9-test.ps1` / `.sh` 同构）

1. 启动独立 mock server（临时端口）。
2. **control 组**（不 kill）：host-sim 打开 `/stream/late?ms=8000`，等待晚到 chunk → **必须出现** `js-hits.jsonl` 记录（证明检测链有效，避免"空断言"）。
3. **kill 组**：host-sim 挂起同一请求 → 等到 `scheduled-confirmed` 标记 → **先拉取日志快照**（`pull-before-kill/`，哈希存档）→ `kill -9` 宿主进程（Windows：`Stop-Process -Force`=TerminateProcess；POSIX：`kill -9`）。
4. 等到晚到时刻 + 3 s：
   - `kill9_late_hit=false`、`kill9_trampoline_enter=0`（无任何晚到回调）；
   - `frozen_after_kill=true`（拉取快照与现状哈希一致，无新写入）；
   - `host_exited=true`（宿主进程已退出）。
5. **重启检查**：新宿主跑一次 control（自身正常 + 旧 run 目录不被复活），断言 `restart_ok=true`、`restart_old_dir_untouched=true`。
6. 输出 `kill9-result.json`（含 `verdict=no-late-callbacks-after-kill9` 或 FAILED），退出码 0/1。

### 8.2 实测结果

- Windows（canonical：`out/run-1b0-ref-v1/case-M28/kill9/`；standalone：`out/kill9-standalone/`）：
  `control_late_hit=true, kill9_late_hit=false, kill9_trampoline_enter=0, frozen_after_kill=true, host_exited=true, restart_ok=true, restart_old_dir_untouched=true, verdict=no-late-callbacks-after-kill9`。
- WSL/Linux（真 SIGKILL）：同断言集合全部通过（`/tmp/kill9-sh-test`，见 `out/wsl-kill9-run.sh` 的重放脚本）。

### 8.3 与 02b 的约束对应

- **"先拉取日志再 kill"**（`EVIDENCE.md:53-67`）：第 3 步内建（kill 前快照 + 哈希）。
- **唯一硬终止证据**：M28 之外无任何用例产生"已终止"结论（§7.3 守卫）。
- **1B-ii 换真机**：同一脚本结构不变，把 kill 目标换成原生宿主进程（真机为 `kill -9 <pid>`；安卓宿主同理）。

---

## 9. 未决问题 ①：固件是否向 JS 暴露 App 级卸载回调

**结论（详见 `.probe/probe/phase1b/lifecycle/FINDINGS.md` §2）**：

1. **明确：本地证据未发现 JS 可见的"卸载"专用回调。** JS 框架的应用钩子集合为 `onLaunch/onShow/onHide/onDestroy/onError`（`jsframework.txt:109-113`、`jsfm.txt:62-66`），没有 `onUninstall` 一类命名。
2. **明确：存在两套 Native 侧相邻机制（非 JS）**：
   - `JQuick::registerAppLifecycle`（C++ 函数指针；`LC_STATE_DESTROYED=4`）——注册方是原生模块，不是 JS（`jsapi_proxy.txt:137-157`；SDK `JQuickContext.h:108-122`）；
   - `DynamicLibManager` 库卸载协议 `jsapi_check_unload`（1=允许卸载 / 0=延后 / 无符号=ignore dlclose）——库级语义（`jsapi_proxy.txt:2021-2024`）。
3. **待验证：卸载时 JS 侧 `onDestroy` 是否触发、何时触发。** 桥层存在"销毁进入 JS"的通路（`FalconJSBridge::onDestroy` 与 `destroyApp/unloadPage` 相邻出现，`libfalcon.txt:34413-34415`），但 P4c 探针未注册 App 钩子，未直接观测 → 以补充探针实测（FINDINGS §3.4 方案）。
4. **设计口径不变（不可依赖）**：1B-ii 的终止不得等待任何卸载信号；`cancelAll()+closeContext()` 必须在最后一个确认可得的 JS 执行节点主动执行（与 02b §4.5 一致）。

---

## 10. 未决问题 ⑤：页面生命周期可得钩子（onHide/onUnload）及触发时机

**结论（详见 `FINDINGS.md` §3）**：

1. **明确（可得性）**：页面钩子 `onLoad / onNewOptions / onShow / onHide / onUnload`（内部名 `$onUnload`）、应用钩子 `onLaunch / onShow / onHide / onDestroy / onError`；两个框架存档版本（0.0.32 / 1.3.0）集合一致；`settings/article/openear/ime_main` 页注册 `onShow/onHide/onUnload`，`ime_app` 注册应用四件套（真实使用证据）。
2. **明确（Native 日志层触发序列）**：页面离开 → `PageLifecycle->onStop`（无 onDestroy，F1）；应用前后台 → `appResumed/appPaused`；拆除/卸载链路 → `PageLifecycle->onDestroy` → `AppLifecycle->appDestroyed` → `ignore dlclose`；页面启动 → `onStart/onNewOptions`。
3. **待验证（JS 层触发时机）**：`onHide/onUnload` 在 S1/S2/S4 各场景的实际触发与相对时序、以及与 native 日志的对应关系，均未实测（P4c 探针未注册钩子）→ 列入 1B-ii 前置补测（FINDINGS §3.4）。
4. **版本核对待验证**：两份框架存档版本不同（0.0.32 / 1.3.0），当前固件实际生效版本未核对；不影响"钩子存在"结论。

### 10.1 与 1B-ii `cancelAll` 触发时机的冲突检查（任务停止条件）

- ① 无 JS 可见卸载信号 → 与"JS 主动 cancelAll"设计**不冲突**（本就必须主动）。
- ⑤ 钩子存在但 JS 时机未验证 → **不构成硬冲突**，但记录一条硬约束：
  **`onHide`/`onUnload` 只能作为补充触发点；`cancelAll` 的唯一性不得绑定到任一未验证钩子。** 1B-ii 若出现"只挂在 onUnload 上"的设计，按本约束退回修改，无需停止整个阶段。
- **结论：未发现需要触发"停止并写明冲突点"的冲突项。**

---

## 11. 1B-ii 接入契约（本基建的接口面）

1. **IUT 适配层**：`iut/adapter.mjs` 的 `native` 分支替换为真实模块加载；方法面保持 `request/openStream/cancel/cancelAll/openContext/closeContext/setProxy/clearCookies/getCookies`（与 02b §2 同名同形）。
2. **test-build 钩子（native IUT 必须提供，仅供测试）**：
   - `testAPI().injectLateChunk/injectLateEnd/injectLateCancelled`（M30 闩锁注入；对应"投递闸门前的注入点"）；
   - `testAPI().stats()`：至少 `gateDrops / pauseCount / resumeCount / backpressureErrors / startedSeq / queueRejection`（M16/M17/M29–M31 断言依赖）；
   - `testAPI().op(requestId)`：`terminal / terminalDelivered / seqOut / pendingBytes`（单终态与闩锁断言）。
3. **M28**：`kill9-test` 的 kill 目标换成原生宿主；其余断言（control 正例、冻结、重启检查）不变。
4. **结果表**：native 运行使用 `--iut native --out out/run-<ver>-native`；**ref 结果与 native 结果分表保存**，不得混用（§2.3）。
5. **证据字段补齐（真机/原生）**：`.so` 映射与 native 线程标记（02b §8.1 要求）在真机宿主侧采集；mock 侧对应项为进程存活 + 冻结检查。

---

## 12. 1B-ii 进入条件核对（对 02b §11）

| 02b §11 条件 | 本基建状态 |
|---|---|
| 1. 唯一入口/事件命名（request/openStream；无 requestStream/data） | 用例与替身按此实现；§6 表逐项覆盖 | 
| 2. 显式终止链成套实现、无宿主兜底 | M19/M29/M30/M31 断言已就绪（含"页面停止仍继续投递"负向对照，专门暴露宿主兜底假设） |
| 3. kill -9 用例（M28）且断言"无任何晚到回调" | ✅ 脚本 + 断言 + 双平台实测 |
| 4. JS 生命周期义务落为接口/联调桩 | M25–M27 场景化（取消时机可在 host-sim 编排）；1B-ii 需在真实 App 生命周期节点接 `cancelAll`（时机选择见 §10.1 约束） |
| 5. 按 M01–M31 建立可重放 mock server/fixture | ✅ 本工程（31/31 重放通过） |
| 6. 普通/流式入口不引入兼容分支 | 替身与用例按此校验（M01/M10 等） |
| 7. 401/429 作为可观察响应；无业务重试 | M08/M09 断言（含"恰 2 次请求"） |
| 8. mock 与真机两套结果表（TLS/HTTP2/代理独立证据） | M20/M21 在 mock 侧有独立 TLS/ALPN/代理证据；真机证据留 1B-ii |
| 9. 保护文件与回滚边界 | ✅ 未触碰（§15） |
| 10. §10 待验证项不得固化；保守默认 | ①⑤ 调查按"明确/待验证"分档；替换实现须保留调整点 |

**停止条件核对**：mock 可重放（两环境 + 独立脚本三次一致）→ 不触发；①⑤ 与 cancelAll 时机无硬冲突 → 不触发。**可以进入 1B-ii。**

---

## 13. 未决问题 / 待验证清单（1B-ii 视角）

1. 卸载时 JS `onDestroy` 是否触发（补测探针，FINDINGS §3.4）。
2. JS 钩子（onHide/onUnload）在 S1/S2/S4 的触发时机与 native 日志对应关系（同上）。
3. 当前固件生效框架版本核对（0.0.32 vs 1.3.0）。
4. 02b §10 既有清单一并保持：`postJSMessage` 返回语义（部分）、`jsapi_check_unload` 设计决策、同宿主重装行为、显式终止链期最后安全 JS loop 时刻、TLS/HTTP2/代理真机稳定性、`ERR_BACKPRESSURE` 可实现性、代理/TLS 错误码映射、16 MiB/8 MiB 上限覆盖性。
5. native IUT 的 test-build 钩子设计需与实现一起评审（§11.2）。

---

## 14. 证据索引（本轮）

```text
docs/astra/03-phase1b-prep.md                        本报告
.probe/probe/phase1b/mock/                             mock 工程（README/package.json/全部源码）
.probe/probe/phase1b/mock/out/run-1b0-ref-v1/          Windows 规范基线（31/31）
.probe/probe/phase1b/mock/out/run-1b0-ref-v1-wsl/      WSL 基线（31/31）
.probe/probe/phase1b/mock/out/kill9-standalone/        kill9 独立证据（含 pull-before-kill/）
.probe/probe/phase1b/mock/out/run-1b0-native-stub2/    native PENDING 姿态
.probe/probe/phase1b/mock/out/wsl-kill9-run.sh         WSL kill9 重放脚本
.probe/probe/phase1b/mock/out/wsl-run-all.sh           WSL 全矩阵重放脚本
.probe/probe/phase1b/lifecycle/FINDINGS.md             ①⑤ 结论（含证据行号）
.probe/probe/phase1b/lifecycle/evidence/               ①⑤ 原始 grep 与 findings.json
```

---

## 15. 变更范围声明

- 新增文件仅位于：`.probe/probe/phase1b/**`、`docs/astra/03-phase1b-prep.md`。
- 未修改：`app/src/services/ds.js`、`app/src/services/native.js`、`app/src/services/backend-blob.js`、默认入口、`重构计划/00-baseline.md`、`docs/astra/02-phase1-transport-contract.md`、`02b-phase1-transport-contract-r1.md`、`02c-phase1-r1-revision-record.md`、`.probe/probe/p4c/**`（只读引用）。
- 未实现 Native Transport；未进入 1B-ii；未进行设备操作。
- 工作区内既有的其他未提交改动（`app/HOWTOBUILD.md`、`ds-free-api/**`、`tools/**`、`docs/deepseek-incident-*`）属于并行工作，本轮未触碰。