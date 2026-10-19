# 1B 路线 C：容量边界与可实现性审查

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**交付结论：待总工程师选择并批准方案。不是容量通过。**

唯一现行规范是 **02d T1A.3-r2 及其继承的 02b**。02e 是修订记录，04b/04c 是部分修复和运行记录，不是修改容量边界的授权。本文所有新接口、解释和条款均为候选，未经批准不生效；没有修改或发布 r3。**1B 修复完成未批准，1C 仍阻断，G1 未放行，阶段 2 不开工。**

## 1. 结论与证据等级

1. **阻断：取得后拒收不能证明取得前硬限。** 现有 worker 先产生响应 `data` buffer，再进入 core 检查。旧严格入口在 Node 24/18 均为 FAIL：`previousPending=0`、`inputAtCoreEntry=1114112`、`completeUndelivered=1114112 > 1048576`，原始子进程退出码均为 2。此次只读保留，没有改判、改测试或重跑覆盖。
2. **阻断：core 水位不覆盖整个接收路径。** 04c 已处理 ingress/异步队列漏计，但没有网络层 credit token。`readQuantum=1 MiB` 是暂停 headroom，不是已经扣除、不可被另一流使用的预留。原 `data` 来源没有输入硬上界声明，Node 内部还有先于 core 的持有物。
3. **实测反例：pause/read(n)/HWM 不是全层内存限制。** 本次真实回环 H1/TLS/H2/CONNECT 实验在消费者暂停期间记录响应对象缓存增长；`read(4096)` 返回最多 4096，但暂停期 H1 响应缓存达到 66560。两端受控 Readable 又展示小视图引用大 backing。都不能把读取粒度、HWM 或队列统计等同内部峰值。
4. **证据边界：受控 emit、真实 Node 网络、wreq 目标栈、设备是四类证据。** 严格入口 FAIL 来自 EventEmitter 直接 emit，不证明 TCP/TLS 单次会交付 1114112；真实网络的小粒度观测也不否定该入口反例。Node 实验不证明 wreq/Chrome136 或设备容量。
5. **建议选择 B：显式分层预算的修订候选，先审批边界和库内预算能力调查，不直接批准实现完成。** 保持 wreq/Chrome136，使用受限 pull/transfer credit 管理适配器及投递链，另设必须证明的库内响应预算。若业务要求“从网络库最早取得起全纳入原 1/4 MiB”，选择 A；A 需要库内约束/审计，当前 Node 公共接口和已读 wreq 调用点不足以证明可行。仅把大输入改名 offered 或只换 `read(n)` 的方案 C 不推荐。

本文没有证明任何现成实现已满足全层硬限，也不声称 A 理论上不可能。实施选择的前置条件、不可证明时的停止点见 §7–§9。

### 1.1 原始材料索引

以下 `MOCK` 指 `.probe/probe/phase1b/mock/`，`OLD` 指 `MOCK/out/r2-capacity-20261003T021651681Z-cd9d446c/`，`OUT` 指 **`MOCK/out/capacity-boundary-review-20261003-ae459114/`**。

| 材料 | 本轮核对事实 | 不得外推 |
|---|---|---|
| 02b §3.3/§5/§7；02d §1.1/§1.2/§2/§3/§4.4/§5/§6；02e R2-08/E1–E7 | 原水位、取得口径、D/C 与所有权规则 | 不授权缩小计量范围 |
| 04b §2/§6/§8；`out/r2-fix-20261003/accounting-large/result.json` | 历史 pending=1048576，backlog=65536，FAIL | 不是当前 core 仍保留该 backlog 的证明 |
| 04c §2–§6；`OLD/strict-{windows,wsl}-acquisition/result.json` 及各 command JSON | 两端严格入口 FAIL/code=2；当前 core SHA 与运行记录相符 | 54/54 不消除严格失败 |
| `test-build/r2-probe.mjs:90`；`capacity-acquisition-boundary.mjs:10` | `fetchHeaders` 被受控 EventEmitter 替代，入口直接计 input+pending | 无 socket/TLS/HTTP2 接收证据 |
| `test-build/capacity-suite.mjs:16`、`:235`；`OLD/accepted-{windows,wsl}-capacity/result.json` | accepted 账本将拒收另记 rejected；真实 H1 每流 3211264，data 观测最大 65536，data 回调处 readableLength 最大为 0 | 不是暂停期/库内峰值零；不是 input 上界证明 |
| 当前 `iut/native/{transport_core,network_worker,js_thread_bridge}.mjs` | 下述路径与分配分析 | Node 模型不是已移植的原生库 |
| `OUT/{windows,wsl}-{runtime,experiment,command}.json` | 本轮独立有限实验，内置 JS 源码摘要/哈希、逐次事件、命令、code | code=0 只表示实验完成，不是容量验收 |

## 2. 计量对象：不混用的六本账

02b §5 原文：“‘待投递’从 Native 已取得但尚未在 JS 线程调用 `onEvent` 的数据开始计量；正在执行的回调不重复计量。”02d §4.4 又明确全部队列层级、出队未 D 均不能扣账。两者没有把 Native 网络库内部自动排除。

| 对象 | 审查定义/计量方法 | 已明确的约束与未决边界 |
|---|---|---|
| 响应 payload 逻辑字节 P | 用 `(operation,generation,body-offset)` 区间标识，已取得、尚未 D 且未完成丢弃释放的 body；相同字节复制到两处只计一个逻辑区间；不以实际物理去重冒充语义定义 | stream 1 MiB/global 4 MiB；取得至少不晚于 data-handler 入口。是否还从协议解码/库内 Readable 开始、压缩前后哪个表示、headers 是否属于 payload，规范未完全说清。不能由 core 实现自行排除 |
| 重复分配/背衬 A | 按唯一 backing allocation 与引用关系计大小，记录输入+副本+切片保留；跨层同一块内存不重复求和 | 64 KiB 是交付 chunk 长度，不是其 backing 大小；02b §3.3/§7 要求独立安全所有权，未给 A=1/4 MiB 的数值承诺。复制开销的硬限及生命周期仍未证明，不因此视为可无限增长 |
| 协议/运行库缓存 U | HTTP 解析、响应队列、TLS 密文/明文、H2 frame/DATA/HPACK、连接/stream 窗口与库内 pending；其中可识别 body 可能也属于 P，不是互斥集合 | “Native 已取得”的归属存在歧义；库内 body 不得默认豁免。HWM、窗口设置、session 内存参数各自约束不同，不能相加当完整内存上限 |
| 内核缓存 K | TCP 接收/发送队列、OS TLS/网络相关资源（若有）；按 socket/系统观测，区别于用户态分配 | 契约没有整体内核内存数字；收到内核是否等于 Native 取得未明确。不能静默删出审查范围；本轮未证明 K 的峰值或归属 |
| JS 已交付 J | D 后由用户合法持有的 JS-owned bytes/headers；包括同步回调仍执行及用户后续保存的值 | 02b §5(1)明确不重复计 pending，§3.3 要求不依赖可变 Native buffer；不允许取消时回收/破坏用户仍持有数据。用户长期保存无总量承诺；不是零内存 |
| 整体内存 M | RSS、heap、external、ArrayBuffer、native allocator、线程栈、代码、共享页，以及单列的内核资源 | 这些统计口径有重叠（如 arrayBuffers 包含于 external），不能直接相加；同进程实验服务端也占内存。M 不等于 P+A+U+J 的机械和，1/4 MiB 不是 RSS 承诺。整体峰值未证明 |

另外分开 **事件 E、headers H、聚合响应 B、请求体及控制/terminal 元数据**：

- 数据待投递事件 stream 128/global 512；低水位严格 `<64/<256`，payload 严格 `<512 KiB/<2 MiB`。每流一个 terminal slot 继承不变，不能把 terminal 当额外数据槽。
- 02b §5 单列 response headers 64 KiB；当前 headers 事件占一个事件、`pendingBytes` 增量为 0。headerBytes 以 JS string.length 统计，而 HTTP parser 在建立对象前另有限制，H2 又有解压后的 header list；统一字节表示与临时对象开销需要批准口径，不能把现状当规范。
- request 聚合 body 8 MiB；02b §5(5)明确 request 不受流事件水位约束。32 个活跃 request 各 8 MiB 已可有 256 MiB 逻辑聚合体，并非全实例只用 4 MiB；复制、待 settle、旧终态仍存留可更多。这是资源规划风险，不是本轮发现了新的契约数字。
- 32/64 与 8/16 是活跃/排队请求上限，不自动证明所有已终止未通知对象有界。terminal 槽生命周期、共享资源归属、终态积压下 admission 行为需明确核验；不得假设“最多 32 个 terminal”。本轮不替用户改变 admission 或新增错误码。

**当前最小确定结论**：core 入口已持有 1114112 的严格反例成立；对更早取得边界和 A/U/K/M 未定义细节，不得补一句“都不算”使失败变成功。

## 3. 数据路径与所有权

### 3.1 当前 Node 模型路径图

```text
远端 write/end（只决定应用写入粒度）
  -> 本机 TCP 内核接收 K                         [内核取得/持有；本轮内部量未证明]
  -> net.Socket / libuv/native read             [用户态输入分配；JS core 无前置 credit]
     -> HTTP 代理 absolute-form 或 CONNECT      [额外 socket/解析/head/隧道持有物]
     -> TLSSocket / TLS native                   [密文 -> 明文，可能并存/复制；未证明]
     -> HTTP1 parser -> IncomingMessage          [rawHeaders/headers/body Readable]
        或 HTTP2 session -> stream              [DATA/窗口/HPACK/session+stream 缓存]
                         -> H2 compat           [委托 on/off/pause/resume/destroy]
  -> fetchHeaders Promise                       [响应对象已有；core 尚未消费也可缓冲]
  -> _wireStreamResponse / data(buf)             [buf 已存在、取得已发生]
  -> _ingestData                                 [检查完整 size/事件数；失败 C(error)]
     -> ingress {buf,offset,remaining...}         [成功才加 pending；逻辑字节先入账]
     -> 精确长度 Uint8Array + set                [新副本；源 buf 仍在同步栈上]
     -> _enqueueEvent(reserved=true)             [逻辑额度转移，不再加账]
  -> deliveryChain 闭包 -> bridge.queue          [持有 ev；出队不等于交付]
  -> 已 post/局部 job/consumerDelay timer        [仍持有，仍计 pending]
  -> 最终 gate -> D(onEvent入口) -> R            [D 划入 JS-owned；用户可继续保留]
     或 C先发生 -> drop -> 清引用                [逻辑失效与物理释放分开]
```

### 3.2 逐层取得、复制、转移、释放

| 层/定位 | 取得与持有 | 复制/转移 | 释放与当前证明限制 |
|---|---|---|---|
| socket/TLS/HTTP native | 收到数据到 libuv、TLS、parser；可能尚不能归属某个 H2 stream | TCP/TLS record/HTTP2 DATA/chunk 不是相同边界；明密文不同比例，不能用 DATA 长度限制整个底层 | core 不持有 allocator 控制；socket close 不证明所有 native/OS 内存立即回收 |
| worker `fetchHeaders:79`、H1 `:160` | `state.req/res/socket/session/connectReq` 与 Promise/事件监听器持引用 | rawHeaders 到 headersToObject 建新对象；H1 parser maxHeaderSize 实为 1 MiB，64 KiB 检查在 response 回调后 | 超头部可销毁，但不能倒推解析前未分配；错误清理与 header 限制是两项证据 |
| H2 `:204–257` | 每次调用 `http2.connect` 新 session，一个 req；compat 闭包保留 req | compat 不是独立 buffer；无 read/readableLength/HWM 暴露 | `abort:130` 会 destroy 整 session，适用于当前独占布局；不能移植到共享布局用于单流取消 |
| `core:560–605` | headers 入队后订阅 data；可在 headers 等待/paused 时已有库内 body | 传入 buf 原引用，没有入口前 token | data 被终态拒绝只是不再处理，不能否认 buf 已分配/到达 |
| `_ingestData:607–635` | success 后 ingress 保存整 buf；计 remainingBytes/events | 每次新建精确 Uint8Array，set 从 buf 复制；剩余逻辑区间转移至事件 | finally 清 ingress；即使 remainingBytes 减少，源 backing 在循环/栈内仍完整，A 可能接近输入+全部副本；短视图还可能来自更大的 backing |
| `_enqueueEvent:663–699` | promise chain 闭包持有 ev，metadata 消息与 deliver 闭包关联 | Node bridge 没有序列化 payload 实验；真正 postJSMessage 的复制/所有权成本未证明 | Q/X/post/timer 均不能扣账；未调用事件要在清理时扣一次 |
| `bridge:68–136` | 队列持 job，postJSMessage 再包闭包；三路径最终同 Node loop | 与原生跨线程不是同一内存模型 | queue.shift 只移出队列，job 在途仍持有；成功返回值 1 不等于释放/投递成功 |
| `_deliverEvent:707–744` | 最终检查后同步进入回调；event bytes 成为用户值 | `_releaseEvent` 在同步 D 前紧邻调用处扣逻辑账；不清正常交付 bytes | 本模型无异步插入点；原生必须使 C/D 线性化。J 不因 R/取消就物理释放；不能把 released 计数当 GC/allocator 证据 |
| `_commitTerminal:392`、`_teardownNetwork:418` | C 使剩余事件逻辑失效；先取消网络、解绑响应，再置 null | 未投递事件在链上回收时丢 bytes；terminal 单独机会 | pending=0、op.net=null、res.close、listener off、allocator free 分开记录；GC 时刻未证明 |

request 分支 `core:464–513` 另走：响应 data -> chunks[] 保存原 buffer -> EOF `Buffer.concat(chunks)` 复制 -> `new Uint8Array(buf)` 再复制 -> op.response -> JS Promise settle。三种 body 表示可短暂共存，8 MiB 是逻辑 body 限制，不是三者总物理分配上限。取消/错误、redirect 被销毁响应、CONNECT 等待时的内部持有也不能漏掉；本轮不修改这些分支。

### 3.3 目标 wreq 路径不是 Node 替代品

已只读确认 `ds-free-api/Cargo.toml:31–32` / lock：wreq 5.3.0、wreq-util 2.2.6；`src/ds_core/client.rs:673–684` 使用 `Emulation::Chrome136`，`:1323/:1369` 使用 `resp.bytes_stream()`。lock 还有 hyper2/http2/tokio-boring2；这只是依赖和调用点证据，不是已经检查其全部内部容量。

目标分析路径应为 socket/TLS/HTTP2/代理 -> wreq Response/body stream -> 适配器 -> credit/core -> Native 队列 -> JS bridge。停止 poll `bytes_stream` 只直接控制应用层消费，不能据此断言连接驱动、TLS 解码、H2 多路复用任务均停止分配。没有在本轮联网取源码、改 lock、换栈或构建设备库。任何 A/B 实施均保留 wreq/Chrome136；若调整 HTTP2 SETTINGS/窗口/连接复用等会改变可见仿真行为，须单独批准并验证指纹，不能偷偷当内存调优。

## 4. Node 18/24 能力核查

本次使用 Windows v24.18.1、WSL v18.20.4；`OUT/*-runtime.json` 保存各自 `process.binding('natives')` 的实际内置 JS 模块哈希和带原源码行号片段。它是版本固定的实现证据，不是公共 API 也不是 C++/TLS allocator 证明；实验没有把该私有接口用作生产实现。

| 能力 | 能保证/可利用 | 不能保证/实施约束 |
|---|---|---|
| `pause()` | 停止该 Readable 的 flowing data 交付；H1 push 返回 false 后 parser 调用 readStop；H2 stream pause 调用 native handle.readStop | 不是同步撤销正在进行的 socket read、TLS record 或 H2 frame；已有 buffer 不消失；不是 session 所有流暂停，也不是内核归零 |
| `read(n)` | binary 非 objectMode、无 setEncoding、正整数 n 时，取得最多 n 字节；未够且未 EOF 可返回 null；EOF 可交尾部短块 | n 不约束 `_read`/上游 push 粒度或库缓存；读取可能触发补读，也可返回共享大 backing 的短 view；不能混用 data listener/另一 reader；`read()` 无参数不具备 n 限制 |
| highWaterMark | 触发 producer 背压的阈值；push 返回 false 提醒停止；本次真实 response 的 HWM 为 16384 | 不是硬限，单次 push 可跨过阈值；read(n)>HWM 会提高 HWM；不能依赖 Node 大版本默认值或把 HWM 作为已预留额 |
| `readableLength` | 当前 JS Readable 队列逻辑长度快照 | 不含全部 native TLS/H2/内核或正在执行的 push 输入；采样零不证明峰值零；同 backing 重复视图也不是独立分配总量 |
| H2 session/window | DATA 流控有 stream 和 connection 两级；可提供容量模型的输入、抑制后续 DATA | 已授予窗口不会因 core pause 自动收回；control frames/headers/HPACK 不等同 DATA 流控；不能用默认 65535 推导所有 buffers≤65535；共享连接暂停可能阻塞兄弟流/控制推进 |
| H2 `maxSessionMemory` 等参数 | 可作为版本特定的 session 资源策略约束之一 | 当前 worker 未配置；不能视为每流 payload credit、完整进程上限或无过冲保证；未经对应 native 源码/受控测试不能写硬上界 |
| 当前 compat | on/off/pause/resume/destroy | **没有** read/readableLength/HWM；直接改 core 调 read(n) 不支持现有 H2 路径。实验通过 task.state.req 访问底层，是隔离探针，不是已修改 release 接口 |

源码关键机制：两版 `_http_common.parserOnBody` 均先 `stream.push(b)` 再根据返回值停 socket；`_http_incoming._read(n)` 只负责恢复 socket，不按 n 分配响应；Readable 的 length 在加入 buffer 后增长。两版 H2 `streamOnPause` 停 stream handle，不证明共享 session 的 socket/TLS/其它 stream 一同停止。观察与源码一致，但没有由此推导跨版本的固定输入最大值。

## 5. 本轮独立有限实验

### 5.1 设计、命令与观测边界

新增目录仅 `MOCK/capacity-boundary-review/`，结果仅 OUT。`experiment.mjs` 只导入 Node 内置模块及只读 NetworkWorker；没有导入旧带执行副作用的容量/保护脚本，没有实例化 core、bridge 或用户业务回调。consumer-acquire 表示实验消费者，不冒充 r2 的 D。读取现有自签名测试证书，不新建证书或访问设备/外网。

- 每次运行最多 25 秒，记录器 40 秒；Node old-space 上限 128 MiB（不是 RSS/external 硬限），有限 body 256 KiB/流，六个串行网络场景加一个双流 session；服务端总 body 发送上限 2 MiB/端。仅绑定 127.0.0.1 随机端口；代理只接受本次 TLS/H2 端口。
- 服务端每流 3 次写入为 **1024、131072、130048** 字节。不是 TCP segment、TLS record、H2 DATA 或客户端 data 的尺寸保证。
- 每个响应 push 前/后同步记录输入长度、backing 大小、response readableLength/HWM、socket 可见指标、session.state、消费者累计数；暂停期再每 10 ms 连续采样 12 次。记录 pause-start/end 与数据守恒，不能用最终一点代替过程。
- 独立共享 H2：A 一直暂停，B 消费；连续记录后只关闭 A，不销毁 session，B 完整。用于说明共享竞争/取消的可行机制，不是当前 worker 已共享的证据。
- TLS/native H2 缓存、内核缓存、真正 allocator 释放都显式写 `UNPROVEN`（未证明）。事件钩子覆盖本次可见 response.push，定时 RSS/heap 只是采样下界；没有单点或采样最大值的硬峰值承诺。服务端与客户端同进程，M 不能归因客户端。

实际命令完整参数/输出在 `OUT/windows-command.json`、`wsl-command.json`。工作目录 MOCK：

```text
node capacity-boundary-review/run.mjs out/capacity-boundary-review-20261003-ae459114 windows node --max-old-space-size=128 capacity-boundary-review/experiment.mjs out/capacity-boundary-review-20261003-ae459114 windows
node capacity-boundary-review/run.mjs out/capacity-boundary-review-20261003-ae459114 wsl wsl -e /opt/node18/bin/node --max-old-space-size=128 /mnt/g/youdao/Deepseek/.probe/probe/phase1b/mock/capacity-boundary-review/experiment.mjs /mnt/g/youdao/Deepseek/.probe/probe/phase1b/mock/out/capacity-boundary-review-20261003-ae459114 wsl
```

两端各 8 个场景、683 条记录、code=0；`capacityAccepted=false`。WSL 保留 PATH/systemd 与 TLS ServerName 警告原文；并未因为警告忽略运行错误。没有重跑全矩阵，没有新增容量 PASS。

### 5.2 结果：同值是本次观测，不是平台保证

以下两端本次值相同；完整顺序/时刻/环境分别见各 experiment/runtime JSON，不合并冒充一次运行。

| 实际网络路径/消费方式 | 暂停起点→末点 response readableLength | 暂停期消费者新增 | 本次最大输入 push | 单次 consumer 最大 |
|---|---:|---:|---:|---:|
| H1 data | 0→65536 | 0 | 65536 | 65536 |
| H1 read(4096) | 0→66560 | 0 | 65536 | 4096 |
| TLS H1 read(4096) | 0→17408 | 0 | 16384 | 4096 |
| TLS H2 data | 0→64511 | 0 | 16384 | 16384 |
| TLS H2 read(4096) | 0→65535 | 0 | 16384 | 4096 |
| CONNECT+TLS H2 read(4096) | 0→65535 | 0 | 16384 | 4096 |

所有六条网络消费最终为 262144 字节，SHA-256 均 `81d0141af58569f91edf2d036b67a6b82c062d1829fd93aec50ed96b4773d225`。close/destroyed 已观察，native/heap 实际释放仍未证明。socket JS readableLength 的观测最大 H1 为 65536、TLS H1 为 49152、H2 为 0；**H2 的 0 不表示 TLS/nghttp2 没缓存**，也不能与 responseLength 简单相加当唯一物理内存。

独立 shared-h2 的暂停 A 可见 readableLength 达到 65535；B 完整 262144，关闭 A 时 sessionDestroyed=false。证明本次同 session 不消费 A 不妨碍 B 完成；**关闭 A 时 B 已完成，不能证明取消 A 对仍在途 B 的隔离**。未覆盖 connection-window 枯竭、慢 B、错误/GOAWAY、或暂停时原生 frame 队列峰值。

受控 Readable（**不是网络**）：设置 HWM=1024，push 1114112 返回 false 但队列已持有 1114112；read(4096) 后持有 1110016，返回 view 长 4096 但 backing 长 1114112，读取还把 HWM 提高到 4096（结果字段记的是读取后值）。这与旧直接 emit 属不同受控模型；它具体反驳“push false 就没接纳”“小 read 就只有小分配”。不能据此断言真实 H1 会一次收到 1114112。

## 6. 取得前 credit：成立条件与竞态

### 6.1 至少需要的接口与不变量（设计候选，未实现）

`reserve(op,generation,byteMax,eventMax) -> token`；`readInto(token,ownedStorage) -> DATA(k) | WAIT | EOF | ERROR`；`transfer(token,stage)`；`retire(token,reason)`。

1. 原子检查单流/全局两本余额，一次成功或全部失败；**先扣预留再启动允许取得的动作**。每个 token 带 generation、取消 epoch、唯一 id；只能由一个读取任务消费，不能用“所有流都看到还有空余”代替 reservation。
2. 逻辑证明式为 `P_i + R_i <= 1 MiB`、`sum(P_i)+R_global <= 4 MiB`；事件为 `E_i+RE_i<=128`、`sum(E_i)+RE_global<=512`，terminal slot 独立。R/RE 是尚未转为实际持有的预留，不重复计入 P/E。
3. token 的 byteMax 是新取得最多量，不是网络任意 push 后的拒收阈值。readInto 必须 binary、单 reader、无旁路 data listener，无未计量 prefetch；WAIT/null 不等于 EOF。标准 Node Readable/wreq stream 高层没有自动兑现此全层承诺。
4. 一次最多 b 字节、按最多 64 KiB 输出时预留 `ceil(b/64 KiB)` 个槽，但仅在该读取结果最多产生这批事件时成立。很多 1-byte reads 不能只按字节容量推断事件够用；每次读取都需事件额度，或在已计量且有界的聚合槽内合并。headers 独立预留一槽，真正 EOF/control 不能靠数据槽才能获知，否则满槽死锁。
5. 获得 k≤b 时将 k 的预留转为持有，未用 b-k 只在确认没有关联在途工作时归还；逐层转移 token 不释放容量。D/安全丢弃恰一次退休，用户持有的 J 不清空。物理 allocator budget 另记，不用逻辑退休假装复制已释放。
6. 多流调度使用集中仲裁或等价原子机制；公平轮转与每流最多一个 outstanding read 可减小预算占用。不能多个流各预留 1 MiB 占完 4 MiB 后都等另一个 header/control 额度。严格低水位仍是必要条件，新增 reservation 可用量也是必要条件；不能把低水位数值改大或所有流同时 resume 后超售。

### 6.2 各关键情形

| 情形 | 必须成立的处理 | 当前缺口/验收点 |
|---|---|---|
| 多流、跨 context 竞争 | 同一全局池对 Q、ingress、预留、在途同时计算；一个流无法消费其它 token；公平唤醒 | 现有 `_capacity/_applyBackpressure` 只看已接纳 pending；Node 同 loop 的串行回调不证明原生多线程 reserve 正确 |
| cancel/close/deadline 与 outstanding read 竞争 | 先 C 与闸门失效；撤销未来读取；未开始 token 可归还，已在途 token 保留到完成/取消确认；迟到 bytes 有归属、丢弃后只释放一次 | 不能 C 时把额度全归还又允许晚到 read 分配，造成双花；不能等待收尾才提交 C；旧 generation token 不能供重开操作使用 |
| EOF | 无 payload 完成也需可达；read null 继续等 readable/end；EOF 候选保存，剩余前缀 D/R 后才 C(end) | 满 payload/事件时仍能观察错误/EOF/取消；原 deadline 不重置；清理正常候选不能截短 body |
| 网络错误/不可暂停源 | 即时 C(error)，剩余非终态无 D，清理 token；无额外 drain 或重试 | 已超限取得后再报 ERR_BACKPRESSURE 只限制后果，不满足 A 的硬限；无法支持前置预算的源应在读取前判定不支持，而非默认为合规 |
| TLS | 给网络密文、解密明文、输出副本各自可证明预算；同批次转换建立归属 | 原 payload credit 不能控制 TLS allocator；未知 record/buffer 上界写未证明，禁止用观测到 16 KiB 当全层上界 |
| H2 共享 session | 两级流控、已发放但未使用窗口、连接读取/解码、各流 reservation 联合建模；单流取消用 stream reset，不能销毁兄弟 session | HPACK/headers/control 与 DATA 不同；暂停连接牵连兄弟流，放行连接可能为暂停流产生缓存。当前独占 session 实现不能直接复用其 abort |
| 代理/CONNECT/redirect | 头部/隧道握手独立有限 budget；代理 socket 与 TLS socket 分层记录；late CONNECT 按旧 token 清理；redirect 旧响应收尾后才能释放归属 | 不可把“还没最终 response”当资源未取得；本次成功隧道实验不证明延迟 CONNECT/错误全部分支 |
| 物理复制/跨线程桥 | 逻辑 token 转移，allocation token 在新副本创建前另申请；所有 holder 有 release 证据 | 不改变 core 无法控制库内所有 malloc；改变 core 也不自动控制它们；真正 QuickJS 线程/JSValue 与桥消息复制仍需独立验证 |

**A 与 B 的差别在 reserve 管的最早边界，而非是否有 reserve。** A 必须在任何被计作 Native 已取得的库内 body 出现之前保证预算；B 只管批准的新适配器边界，但另一个库内预算也必须成立，不能把同一问题无限后移。

## 7. 方案比较与实现顺序

| 方案 | 契约影响/可实现性 | 证据、限制和代价 | 验收 |
|---|---|---|---|
| A：保留 r2 的全路径预算适配 | 不缩小 Native 已取得口径，1/4 MiB 等不变；为库内 payload 预留静态最坏 headroom 或纳入统一动态 credit。已有接口不足，**有条件设计可行，当前栈可兑现性未证明** | 必须证明上界 H_i/H_session，并使 queued+ingress+inflight+库内 body≤原值；只有测量无上界不够。可能需 wreq 同栈内部适配/插桩、有界 allocator、无旁路 prefetch；TLS/H2/代理工作大，不能仅改 core。不得擅改 Chrome136 SETTINGS/指纹 | 最早取得前预算、库内上界与逐层守恒；§7.1 顺序及 §8 的共同回归要求 |
| B：显式分层预算（推荐候选） | 修改取得边界；adapter 受限 transfer 保持投递 1/4 MiB/128/512；库内 U/A/control 另行给出有限且可证明预算 | 实现责任清楚，可用 binary pull + 精确副本 + token；但不会让原严格 FAIL 消失。U 取值/目标库内部证明仍是门槛，无库内约束不能交付容量验收。需要规范审批和新测试，不是“免审网络库” | 边界/预算表先批准；B-1 至 B-5，库内未知项不许豁免 |
| C：将 offered/rejected 一概排除，或只 read(n)/HWM/减小 chunk | 偷换取得口径或仅限输出；不能保持 r2 严格口径 | 04c 已做事后整批拒收；本次实验已反驳 HWM/read 内存推断。任意大 input 在进入前就可分配，RSS 无约束 | 不推荐；不能用 accepted-suite 通过作为新容量结论 |

表中 A/B 验收均为下述条件，不是已通过项：A 的**最早取得**边界、B 的**明确转移**边界必须有逐操作守恒、全局 reservation、真实输入前置量、错误/取消收敛；共同需要库内上界和真实栈验证。不存在通过减并发/禁用 H2/替换 TLS 栈等隐性行为变化获得合规的捷径；这些若必要也必须批准。

### 7.1 不改契约的 A：可验证约束与顺序

1. 在所锁版本 wreq/Chrome136 中定位 response/body driver、TLS 与 H2 connection/stream 的全部可留存 body，建立 holder/allocator 清单。未知归属作为预算负债，不记零。先确认最多可预发窗口/预读/解码量 H，不能先写 core 宣称结束。
2. 可选择保守的库内预留：每流 P_core+H_stream、全局 sum(P_core)+H_session_unique+sum(H_stream) 均不越原 1/4 MiB；共享一次计，不能遗漏。为还未能归属 stream 的 body 保留 global escrow，并证明任何目的 stream 仍有空间。H 占用同一预算，不能额外叠加成“1 MiB+H”。若 H 不可证明/已大于限额，A 停止。
3. 在明确最早取得点实现 token 或证明库固有上界始终小于预留；映射到有限读接口，提供无未计量内部队列、单个结果最大值、view backing 限制、取消确认/EOF/错误、不越 generation 等接口承诺。回调开始才 reserve 不合格。若库需改造而本轮无授权，只上报，不实施。
4. core/bridge 接入逻辑转移及独立 allocation budget；保持 r2 C/D/R、admission、FIFO、terminal slot、原低水位及错误码。终态/control 总量处理如需改变 admission 行为须先获得批准，不能自行增加 public 限制。
5. 先受控调度验证 reservation 不超售，再真实 H1/TLS/H2/代理和共享 session，最后按 02d §6 补全 gate；原 Node 验证与 wreq/原生分别出表。受控旧 push 1114112 应保留为不受限入口负向对照，新的受限源必须证明超过 credit 的数据根本不能形成合法取得；不能只删掉大 buffer 场景。

“有条件设计可行”不等于当前 Node 或 wreq 公共 API 能保证这些约束。若无法找到/实现符合约束的源，继续阻断，而不是在 A 标签下使用 B 的取得定义。

### 7.2 推荐 B 的理由与批准边界

B 把可控制的 adapter/queue 所有权和第三方网络缓存分别规定，避免要求普通 response API 承诺它控制不了的内部分配；同时保留对库内 memory 的硬验收义务。其代价是**确实变更取得边界**，不是对 r2 的已批准解释。推荐只批准 B 的规范设计方向及目标库预算能力调查；在 §8 的预算表/归属/接口尚无具体可证明值之前，不建议批准新版本发布或容量完成。

若总工程师要求原 1/4 MiB 含全部 native 已取得 body，不选择 B，按 A 做库级预算可行性验证；无法证明则停止。不得为 B 省事更换 wreq/Chrome136，或先将 B 实施后请总工程师追认。

## 8. B 的精确条款草案（未批准，不生效）

建议仅在未来获批版本替换/增补指定条款，02d 的 C/D/R/闸门规则全保留。以下引号内为候选规范文本，不是 r2 现行义务的解释。

### B-1：替换 02b §5 背压规则第 1 条的计量起点

> “投递 payload 计量起点 A 为受限响应适配器将 body 字节转入 Transport 自有受限存储并提交 ownership token 的原子点。必须在发起这次转移/为目的存储分配之前同时取得单操作与全局的 byte/event credit。A 到 D 或完成丢弃释放之间的所有 ingress、队列、桥消息、局部变量、在途任务和原地合并区均属待投递；层间转移不得扣账。网络库在 A 之前持有的 body 受 B-3 的独立库内预算约束，不因未转移而豁免资源验收。正在执行和已开始的回调数据不再重复计投递 payload，但按 B-4 保持有效所有权。”

### B-2：增补 02b §5 计量单位及输入接口

> “payload 指交付给 JS 的 response body 字节区间，按同一操作/generation/offset 去重，重复副本另记 allocation。单流/全局实际待投递 payload 加未兑现的 byte reservation 不得超过 1 MiB/4 MiB；非终态事件加 event reservation 不得超过 128/512。每次转移最多 64 KiB，一个非空转移至少预留一个 chunk 事件槽；不足额度时不启动转移，短读退还未使用且无在途责任的额度。headers 独立占一个非终态事件槽，其 body payload 计量为零；response headers 按规范化前名称和值的 UTF-8 字节数加每对 4 字节分隔计算，仍不得超过 64 KiB；解析/解压临时头部内存按 B-3 约束。request 聚合逻辑 body 仍限 8 MiB，不并入流 payload 池，但其库内和副本分配受 B-3 约束。”

> “适配器必须使用无 setEncoding 的二进制、非 objectMode、单 reader；禁止旁路 data listener/后台未计量 prefetch。调用 read(n)/poll 后又从超额返回值截片不构成受限取得证明；不满足受限接口的源不得作为该实现的合规输入源。错误仍使用既有分类，不增加自动重试。”

说明：这里明确 headers 归属、字节表示、64 KiB 转移上界都是**候选变更/补充**，不能倒推 r2 原文已经这样定义。HTTP content decoding 的启用方式必须锁定并列入预算表；解码后 body 与压缩前存储分开记，不能因编码变化漏计。

### B-3：新增库内、复制与控制资源验收义务

> “版本发布必须附批准的有限预算表，至少含每连接、每 HTTP2 session、每 stream 的可留存 body、未分流入站数据、TLS/代理/HTTP header/control 缓存，adapter 与桥接复制/背衬分配，request 聚合副本，已终止未释放的控制对象及 terminal 通知。共享分配唯一计量，未归属输入由连接/global escrow 负责。每项列出单位、数值、有效并发、代码/库版本、实现约束、上界证明、超额前的停止/错误行为及释放判据。仅有观测最大值、HWM、操作 pending 或进程 RSS 采样不能证明上界。”

> “内核缓存和用户已交付数据不计入该投递 payload 数字，但必须分别报告；OS 可配置限制、不可观测部分、测试平台差异明确标注。不得以范围外名称隐藏网络库用户态 body。任何未证明且可能增长的库内分配项使容量验收保持未通过。总 RSS 不承诺等于各逻辑上限之和，需另行实测并区分已承诺的资源预算与平台结果。”

> “terminal/control 资源耗尽不得阻止已有操作取消、错误提交或唯一终态机会；如需影响新 admission，数值及行为必须与 32/64、8/16 的既有语义一起审议并明确批准，不得由实现私增拒绝条件。无此证明时不得以每流一槽宣称全局有界。”

待批准预算表至少具有 `U_conn, U_session, U_stream, U_unassigned, U_headers_control, A_transfer_bridge, A_request, N_terminal_pending`。**这些不是本报告给出的可执行数值**：本轮没有 wreq 库内上界依据，填实验采样最大值会伪造保证。条款要求具体值、归属及失败行为全部批准后方可发布；空白/未证明不能标成“配置项以后再说”而过门。

### B-4：补充 02b §3.3/§7 与 02d §4.4

> “逻辑 credit 转移不代表物理存储已释放。复制必须先获得独立 allocation budget；不得用短 view 异步持有未计量大 backing。D 前数据保持安全独立所有权，D 后的 JS-owned 值不得因 R、cancel 或 close 失效。取消先 C，不等待网络排空；已在途 token 仅在收尾确认后归还，迟到完成按原 generation 丢弃并恰释放一次。EOF 仅为候选，WAIT/null 不构成 EOF。必须分别记录 C、D/R、token retire、引用解绑、socket/session 收尾及可证明的物理释放。”

### B-5：受影响测试、旧证据与重验

- **保留原件**：02b/02d/02e/04b/04c、旧 accounting-large、red/dev/accepted、strict 两端 FAIL 和 code=2、1C 反例、此次 runtime/experiment/baseline 原样保留。不得改旧 strict 断言使同一源 PASS；新版本新目录、新 test id、新规范标识，并逐项映射旧失败处置。
- **直接受影响**：M17/容量 acquisition-audit/accepted ledger/128–512 与 1–4 MiB、low-water；B 的 A 点与旧严格入口不同，旧失败仍为“r2 未通过”，新增测试证明 B-1 转移前 credit 和 B-3 库内预算，不能称旧缺陷自然消失。
- **所有权与完整性**：M10/M11/M18/M24，正常长流、短读、view backing、压缩/头部表示、request 聚合、副本分配、EOF；必须用输入/交付 SHA 与外部账本，不以实现 totalBytes 自证。
- **竞态与隔离**：M12–M14/M16/M19/M22/M29–M34，token 取消/归还/再分配、generation、timeout、header/EOF/error control 独立推进，容量压力下 WQ/WX/WG；保持原 C 后零非终态入口、唯一终态与正常前缀先于 C(end)。不要求无意义全排列，使用确定性冲突窗口及一例正常对照覆盖每个不变量。
- **真实栈必测**：M20/M21 的 TLS/ALPN、H2 shared session、多流窗口竞争、成功/延迟/失败 CONNECT、cancel 一流不扰兄弟、redirect/headers 期间取消；Node 18/24 验证接口机制，wreq/Chrome136 单列真正库内上界证据，设备另行授权。HTTP 200/response.close 不能替代资源和握手证据。
- **发布门**：方案及数值批准 -> 实施/新增版本专属测试 -> 单项机制与库内预算证明 -> 02d §6 要求的 M01–M34 回归与两轮三路径闸门证据 -> 总工程师验收；之后才谈恢复 1C。真机 M20/M21/M28 和既有生命周期未决仍独立，不因 Node 实验完成而关闭。

## 9. 本轮范围保护与手动交付

新增前对整个工作区（含 ignored、历史证据、备份/恢复副本、依赖和 Git 元数据，无路径排除）进行 SHA-256：**47137 文件**。`OUT/baseline.json` 记录 02:38:47.276Z–02:43:23.647Z 的读取窗口、文件大小/哈希、HEAD 和 Git 状态；这是逐文件快照而非文件系统原子快照。基线文件自身 SHA-256：`9360db5889da9b136542f5dca1b046615a1a5a23123e42ed4f7cb5533a76953d`。扫描期间无内容写入；基线 JSON 是首个新增文件。

允许新增仅本报告、`MOCK/capacity-boundary-review/`、唯一 OUT。全程未改现有实现/测试/契约/报告/历史证据/业务文件；未写永久归档或恢复目录、未执行恢复或旧项目写入脚本、未使用子 Agent/创建或联系其它会话、未联网安装、未构建设备库、未操作设备、未提交/暂存/回退 Git。工作区之外的永久归档未访问，不能把工作区哈希清单说成覆盖外部归档。

结束核验由新增独立 `verify.mjs` 重新读取基线全部文件并枚举新路径，结果为 `OUT/scope-verification.json`；检查原文件变更/删除、新增越界、HEAD/Git 状态和严格 FAIL 原件，并核对新实验完成记录及新脚本语法。基线中的 Git 既有修改只保留，不修理历史 diff 空白。若出现范围外变化，必须如实列出，不能回滚掩盖。

实际结束核验：`PASS_SCOPE_AND_ARTIFACT_CHECKS_ONLY`，47137 个原文件 **changed=0、deleted=0**，核验输出落盘前允许新增 11 文件，**unexpectedAdded=[]**，HEAD 和既有 Git 状态一致；3 个新增 mjs 语法检查通过。两端严格原件仍 FAIL/code=2；两端独立实验各 8 场景/683 记录/code=0、boundClaim=false。随后只为本新增报告补入本段，最终报告及核验文件哈希另以 `OUT/final-artifact-check.json` 记录，不覆盖前一核验记录。范围核验不是容量验收。

**当前交付只用于用户手动转交总工程师：待总工程师选择并批准方案。1B 修复完成未批准；1C 仍阻断，G1 未放行，阶段 2 不开工。**
