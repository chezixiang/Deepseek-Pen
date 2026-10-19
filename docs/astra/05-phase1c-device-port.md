# 阶段 1C：真机移植记录（停止于移植前一致性门）

- **日期**：2026-09-30（Asia/Shanghai）
- **工作区**：`G:\youdao\Deepseek`
- **状态**：**STOPPED — 未进入交叉编译、打包、安装和真机 M20/M21/M28 执行**
- **阻断原因**：移植前已实测发现 1B-ii 源码、02b 契约及 04 报告之间的投递闸门矛盾。本轮停在移植前核查，请求 1A-r2/1B 修订对齐。**这不是已经观测到的真机差异，也不是 M28 真机断言失败。**
- **证据边界**：本报告只记录本轮当前工作区、只读设备核查和移植前本地 IUT 复测；没有把 mock 结果冒充真机证据。

## 1. 本轮已读取的输入

按任务书核对规划、契约、实现报告、P4c、VERIFY，并读取 1B-ii 四个模块以及 Pen-LVGL 的构建脚本、模块注册和异步桥相关源码。输入范围：

- `重构计划/总体重构路线.md`
- `重构计划/下一步开发计划.md`
- `docs/astra/02b-phase1-transport-contract-r1.md`
- `docs/astra/04-phase1b-impl.md`
- `docs/astra/01-phase0-p4c.md`
- `.probe/probe/phase1b/mock/iut/native/**`
- `.probe/refs/Pen-LVGL/launcher/tools/build-native.sh`、`manager/tools/build-native.sh`、`launcher/native/src/JSAPI.cpp`、`Launcher/JSLauncher.cpp`、SDK 的 `JSCModuleExtension.h` / `JQAsyncExecutor.h` / `JQFunctionTemplate.h`
- `.probe/probe/VERIFY.md`

本轮没有读取或继承之前会话的聊天记录。

## 2. 移植前边界核查

### 2.1 工作区保护

开始时工作区已有并行修改：`app/HOWTOBUILD.md`、`ds-free-api/**`、`tools/**`、`docs/deepseek-incident-2026-09-30.md` 等。本轮没有触碰这些已有改动。

受保护文件的起始 SHA-256 快照写入：

```text
.probe/probe/phase1c/preflight/protected-before.json
```

复核结果：`ds.js`、`native.js`、`backend-blob.js`、路线基线、02b、02c、04 以及 1B-ii native mock 文件均未被本轮修改；本轮新增内容仅在 `.probe/probe/phase1c/` 与本报告。

### 2.2 设备只读核查

证据：

```text
.probe/probe/phase1c/preflight/device-readonly.txt
```

只读结果：

- adb 当前检测到 1 台 `device` 状态设备；
- 设备架构：`aarch64`；
- 当前宿主：`miniapp`；
- 设备侧已有 `libcurl.so.4.7.0`、`libssl.so.1.1`、`libcrypto.so.1.1`、`libquickjs.so`、`libjsapi_proxy.so`、`libstdc++.so.6.0.29`；
- 只读核查未执行 `miniapp_cli install`、`start`、`uninstall`、`adb push`，没有改变设备安装态。

### 2.3 交叉编译核查

Pen-LVGL 参考脚本采用 `aarch64-none-linux-gnu-g++`，默认工具链目录为 `/opt/arm-gnu-toolchain-11.3.rel1-x86_64-aarch64-none-linux-gnu`。当前 Windows PATH 中没有 `aarch64-popcorn-g++` 或 `aarch64-popcorn-linux-gnu-g++`；WSL 中可见的是 `aarch64-linux-gnu-g++ 15.2.0`。工具链核查证据为 `.probe/probe/phase1c/preflight/toolchain.txt`，默认 Pen-LVGL 工具链目录未发现。该检查范围仅为 PATH、已查看的 SDK 与参考目录，不等价于整台电脑全盘不存在其他工具链。由于移植前一致性缺口尚未处理，本轮未编译，也未把通用 g++ 标称为 `aarch64-popcorn` 专用工具链。

### 2.4 HTTP/2 依赖预检查（不等于 M20/M21）

只读执行 `curl --version`，完整输出见 `.probe/probe/phase1c/preflight/device-curl-capabilities.txt`。设备报告 curl 7.79.1、OpenSSL 1.1.1l；Features 行没有 `HTTP2`，版本依赖行没有 nghttp2。该系统 curl 构建没有宣告 HTTP/2 支持，后续移植需要单独落实 HTTP/2 网络依赖。**这不是真实 TLS/ALPN/代理请求结果，不作为 M20/M21 证据，也不推断整个固件的所有网络栈都缺少 HTTP/2。**

### 2.5 1B-ii 产物性质

`native/` 目录中只有四个 `.mjs` 文件；worker 导入 `node:http/https/http2/net/tls/fs`，bridge 用 Node 事件循环模拟 Handler/postJSMessage。04 §2.3 也明确记载“未连真机、未构建 .so”。因此本轮任务是 C++/QuickJS 的实际实现移植，不是把现有 C++ 源码换一次编译目标。04 中把真机移植称为阶段 2 的旧文字不作为本轮阶段编号依据；本轮严格遵照用户任务书的 **1C 真机移植、阶段 2 为 PoW** 边界。

## 3. 停止前复测：1B-ii 投递闸门差异

### 3.1 最小复现

复现脚本：

```text
.probe/probe/phase1c/tests/gate-audit.mjs
```

输出证据：

```text
.probe/probe/phase1c/preflight/gate-audit.json
```

步骤：

1. 使用**未修改**的 `.probe/probe/phase1b/mock/iut/native/` NativeTransport；
2. 以慢消费者制造已排队的 `headers` 与 `chunk`；
3. 在两条非终态事件已进入投递队列后调用 `cancel()`；
4. 观察 `cancelled` 提交后的 JS 可见事件。

实际结果：

```text
before.pendingEvents = 2
cancel.outcome = cancel-requested
afterCommit.terminal = cancelled
observed after cancel commit = headers, chunk, cancelled
gateDrops = 0
contractGateSatisfied = false
```

也就是说，`cancel()` 已经提交 `cancelled` 终态后，先前排队的 `headers` 与 `chunk` 仍到达用户回调；这与 02b §3.2 第 11 条、§7.5 的“终态提交后非终态投递全部丢弃”不一致。

### 3.2 三条投递路径复测

复测脚本：

```text
.probe/probe/phase1c/tests/gate-recheck.mjs
```

两次独立复测：

```text
.probe/probe/phase1c/preflight/recheck-1.json
.probe/probe/phase1c/preflight/recheck-2.json
.probe/probe/phase1c/preflight/recheck-1.stdout.txt
.probe/probe/phase1c/preflight/recheck-2.stdout.txt
.probe/probe/phase1c/preflight/recheck-exit-codes.json
```

每次 9 个组合：`handler/postjsmessage/jsoop × cancel/cancelAll/closeContext`。

```text
每次：cases=9, violations=6, node exitCode=2
失败组合：三条路径上的 cancel 与 cancelAll，共 6 组
通过组合：三条路径上的 closeContext，共 3 组
```

`closeContext` 组合通过的原因是 context 状态已变为 `closed`，闸门的 context-state 检查丢弃了旧非终态；`cancel` 与 `cancelAll` 保持 context `open`，因此暴露了同一缺口。这个结果不是传输路径差异，而是终态提交后的排队投递检查缺失。

### 3.3 根因定位

当前未修改源码的关键位置：

```text
.probe/probe/phase1b/mock/iut/native/transport_core.mjs:259-267
```

`_gate()` 检查了：

- `op.removed` 是否置位；
- 终态是否已经投递；
- JS context 是否可调用；
- 非终态的 context 状态是否为 `open`；
- generation 是否匹配；

但对**非终态事件在投递时是否已经提交 operation terminal**没有检查。与此同时：

```text
.probe/probe/phase1b/mock/iut/native/transport_core.mjs:587-592
```

`_enqueueEvent()` 的 `!isTerm && op.terminal` 只拦截“终态提交之后新进入队列”的事件，拦不住终态提交之前已经排队、随后才真正执行的事件。最终执行点：

```text
.probe/probe/phase1b/mock/iut/native/transport_core.mjs:618-631
```

调用 `_gate()` 时仍会放行这类已排队的非终态事件。

因此，当前问题是可稳定复现的实现/契约差异，不是固件猜测，也不是 M20/M21 网络差异。

### 3.4 正常结束对照：不应机械插入 `!op.terminal`

`.probe/probe/phase1c/tests/gate-normal-end-control.mjs` 使用同一个未修改 IUT、真实本地 HTTP 响应和慢消费者。`.probe/probe/phase1c/preflight/normal-end-control.json` 记录：

```text
任何回调执行前：terminal=end，terminalDelivered=false
随后执行：headers → chunk → end，totalBytes=4
```

这个对照证明当前实现会先提交网络终态，再排空之前已排队的正常响应前缀。若只在 `_gate()` 机械插入 `!op.terminal`，会把这种正常响应数据一并丢弃。这里需要 1A-r2/1B 明确“网络完成、终态提交、已排队前缀、取消即时抑制”的时序，再同时修正实现和验收；本轮没有擅自选择新语义。

### 3.5 与任务书三条真机停止条件的关系

| 任务书条件 | 本轮事实 |
|---|---|
| 真机加载失败且层次不明 | **未进入加载，未触发/未判定**；没有编译、打包、PMS 或宿主加载失败的证据 |
| 五件套真机行为与 1B-ii 不一致 | **尚未做真机比较**；这里发现的是原始 1B-ii 本地行为与冻结契约/报告不一致 |
| M28 真机断言不成立 | **未执行，未判定**；没有 M28 失败结论 |

本轮提前停止是为避免在存在已证实语义矛盾时，未经修订就选择“原样复制缺口”或“改变基线行为”。不是宣称上述任一真机停止条件已经被实测触发。

## 4. 真机与交付物状态

| 项 | 本轮状态 | 说明 |
|---|---|---|
| `libjsapi_ds_transport.so` | **未生成** | 移植前一致性缺口；未开始实现和编译真机库 |
| `app/libs/arm64-popcorn/` | **未写入** | 未打包、未安装 |
| `dynamic_load_jsapi` / `custom_init_jsapis` | **待验证** | 本轮未执行 install/start |
| 基础能力 `request/openStream/cancel/setProxy/clearCookies/getCookies` | **真机待验证** | 未进入设备运行阶段 |
| 五件套 | **未放行到真机** | 1B-ii 本地 IUT 的 cancel/cancelAll 排队投递行为已与 02b 契约冲突 |
| M20 TLS/HTTP2/代理 | **未执行** | 不写入真机 PASS |
| M21 代理 TLS/HTTP2 | **未执行** | 不写入真机 PASS |
| M28 kill -9 | **未执行** | 不写入真机“无晚到回调”结论 |
| S1/S2/S4 | **未执行** | 保持 negative-control 口径，不作“已终止”证据 |

1B-ii 的既有 mock 证据仍保留在 `.probe/probe/phase1b/mock/out/`；本报告没有将其提升为真机证据。

## 5. 未决问题 ①④⑤

由于停止发生在交叉编译和安装前，三项均没有新增真机输入：

| 编号 | 问题 | 1C 结论 |
|---|---|---|
| ① | 卸载时 JS `onDestroy` 是否触发 | **待验证**；本轮未安装 1C 包；不得把 P4c 的框架日志 `appDestroyed` 当作 JS `onDestroy` 结论 |
| ④ | 同宿主重装后 generation 是否正确 | **待验证**；本轮没有同宿主卸载/重装循环；继续按 generation 兜底设计，不依赖宿主行为 |
| ⑤ | `onHide/onUnload` JS 层触发时机 | **待验证**；本轮没有运行 1C 页面生命周期探针；实现路径不得依赖未确认的钩子 |

S1/S2/S4 的既有 P4c 结论保持原口径：它们是宿主不停止/显式取消有效性的负向对照，不是“已终止”证据。

## 6. 后续放行条件

当前不进入阶段 2，也不进入 1C 真机安装环节。重新启动 1C 前至少需要：

1. 由 1A-r2/1B 修订明确终态提交后已排队事件的投递语义；
2. 在不修改受保护业务代码、不新增 `requestStream`/`data`/`stream:true` 分支的前提下，重新通过三条投递路径的取消闸门复测；
3. 重新执行 1B-ii M01–M31，重点补齐“已排队非终态事件在 `cancel`/`cancelAll` 后不得到达”的断言；
4. 只有五件套行为与冻结契约一致后，才按 Pen-LVGL 参数准备目标交叉编译、`arm64-popcorn` 打包、`miniapp_cli install` 和真机 M20/M21/M28；
5. M28 必须在真机 kill -9 场景中保留“先拉日志、再 kill、重建后检查”的顺序，并独立断言“无任何晚到回调”；
6. 真机 ①④⑤ 需要另建可复核的 JS 生命周期/同宿主重装证据，不以 S1/S2/S4 替代。

**阶段 2 进入条件：未满足。**

## 7. 重放命令与最终保护校验

```powershell
node G:\youdao\Deepseek\.probe\probe\phase1c\tests\gate-recheck.mjs recheck-3
# 当前缺口仍在时：cases=9、violations=6、退出码 2；表示契约断言失败。
node G:\youdao\Deepseek\.probe\probe\phase1c\tests\gate-normal-end-control.mjs
# 正常结束对照：退出码 0、headers/chunk/end、totalBytes=4。
```

最终校验记录：`.probe/probe/phase1c/preflight/final-verification.json`，受保护源文件 SHA-256 前后比较、两次复测退出码与结果一致性、设备标识脱敏扫描均在交付前复核。完整 M01–M31 本轮未重跑；这里没有撤销或伪改旧矩阵结果，而是补充其当前覆盖之外的反例。

## 8. 本轮证据索引

```text
.probe/probe/phase1c/preflight/device-readonly.txt
.probe/probe/phase1c/preflight/protected-before.json
.probe/probe/phase1c/preflight/git-status-before.txt
.probe/probe/phase1c/preflight/git-diff-stat-before.txt
.probe/probe/phase1c/preflight/gate-audit.json
.probe/probe/phase1c/preflight/recheck-1.json
.probe/probe/phase1c/preflight/recheck-2.json
.probe/probe/phase1c/preflight/recheck-1.stdout.txt
.probe/probe/phase1c/preflight/recheck-2.stdout.txt
.probe/probe/phase1c/preflight/recheck-exit-codes.json
.probe/probe/phase1c/tests/gate-audit.mjs
.probe/probe/phase1c/tests/gate-recheck.mjs
```
补充：`preflight/toolchain.txt`、`device-curl-capabilities.txt`、`normal-end-control.json`、`normal-end-control.stdout.txt`、`final-verification.json`、`git-status-after.txt`、`git-diff-stat-after.txt` 与 `tests/gate-normal-end-control.mjs` 均位于 `.probe/probe/phase1c/`。
