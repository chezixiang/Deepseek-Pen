# 阶段 1A-r2：Native Transport 终态与排队投递契约

- **文档版本**：T1A.3-r2（2026-10-03，Asia/Shanghai）
- **定位**：1B-ii 修复的唯一规范基线；替代 `02b-phase1-transport-contract-r1.md`（T1A.2-r1）的独立基线地位。
- **依据**：两份重构计划、02b、02c、04、05 与 `.probe/probe/phase1c/` 当前文件；不使用先前会话结论。
- **状态**：文档语义已冻结；实现修复、r2 矩阵执行与真机验证均未执行。1C 继续停在移植前一致性门，G1 未放行。
- **范围**：只补时序、闸门与验收。没有 Transport 实现、默认入口变更、构建、安装或固件行为推断。
- **修订记录**：`02e-phase1-r2-revision-record.md`（R2-01 至 R2-10、E1 至 E7）。

**唯一选择：任何 `end/error/cancelled` 终态提交后，该操作所有已入队但尚未实际投递的 `headers/chunk` 一律丢弃，不允许投递完再终止。** 正常流须在提交 `end` 之前完成正常响应前缀的交付；网络 EOF 不是终态提交。取消和错误不等待前缀交付。

## 1. 继承与替代

### 1.1 规范合并方式

为避免重抄接口造成漂移，本文件将 02b 的未改条款按引用纳入本版本。实现只接受 T1A.3-r2 这一版本：先应用本文件，再应用明确继承的 02b 条款，不存在任选 r1/r2 的开关。02c/04/05 是记录，不是另一套规范；04 的旧通过记录不得覆盖 05 的反例。

| 02b 条款 | 本版本处置 |
|---|---|
| §1 边界、§2 公共类型/九个 API 签名、输入校验、返回结构与错误码、§3.1 事件字段和 reason 映射 | 原样继承；生命周期和投递时间点按本文解释，不增删接口或字段 |
| §2.3–§2.4、§2.9–§2.10 中提交、取消、终态投递时序；§3.2、§4.1、§4.3 | 时序由本文 §2–§4 替代；单终态、先提交者获胜与取消幂等不变 |
| §3.3 数据所有权、§4.2/§4.4–§4.6 显式生命周期责任、§6 隔离与 generation、§7.1–§7.4 线程/所有权/GC | 原样继承；唯一终态通知和 admission 确认的时序明确见本文 §3.4、§4.3 |
| §5 全部水位/错误码/暂停恢复/terminal slot | 数值与结构原样继承；§5 第 3 条“已排队前缀之后”明确替换为“已实际投递前缀之后”，见本文 §4.4 |
| §7.5 投递闸门 | 由本文 §3 完整替代，覆盖多级队列和检查后到回调入口的窗口 |
| §8 M 矩阵与 G1 映射、§11 实施进入条件 | 由本文 §5–§6 更新；既有非时序断言仍须全部执行 |
| §9 历史来源、§10 未决问题 | 保留历史证据边界；本文 §7 与 02e 添加当前证据及待验证项 |
| §12–§13 结论/修订摘要 | 作为 r1 历史记录，不作为当前完成或放行结论 |

### 1.2 不变项

- 九个操作名仍为 `request`、`openStream`、`cancel`、`setProxy`、`clearCookies`、`getCookies`、`openContext`、`closeContext`、`cancelAll`。不增加 `requestStream`、`data`、`stream:true` 或兼容分支。
- `cancel` outcome 集合、reason 映射、唯一终态及“先提交者获胜”不变。`already-cancelled` 用于取消已提交但通知未执行的重复取消；通知完成后为 `already-terminal`；已提交 end/error 始终为 `already-terminal`。不把收到 EOF 当作已提交 end。
- 五件套仍为：**状态机 + generation、投递闸门、终止闩锁、cancelAll、closeContext**。只补五件套之间的时序，不增加公共状态或另一条终止路径。
- Cookie/代理隔离、cookie epoch、请求快照、401/429 可观察 HTTP 结果、字节所有权和线程规则不变。
- 宿主生命周期不可作为停止或资源释放依据；M25–M27 仍是负向对照，M28 仍是唯一硬终止口径。继承这些责任，不新增固件事实。

背压/容量保持以下原值，不能借本次修复扩大：

| 资源 | 硬上限 | 低水位/行为 |
|---|---|---|
| 全局活跃/排队请求 | 32 / 64 | FIFO admission |
| 单 context 活跃/排队请求 | 8 / 16 | 原超限错误不变 |
| 请求 body / 聚合响应 body / response headers | 16 MiB / 8 MiB / 64 KiB | 原错误码不变 |
| 单 chunk | 64 KiB | 大块拆分 |
| 单 stream 待投递事件 / payload | 128 / 1 MiB | 低于 64 / 512 KiB 恢复 |
| 全局待投递事件 / payload | 512 / 4 MiB | 低于 256 / 2 MiB 恢复 |

## 2. 时间点与终态提交

### 2.1 定义

同一操作的关键动作必须能建立可审计的先后关系。下列符号是契约记号，不要求新增公共 API 或同名实现字段。

| 记号 | 时间点 | 不等于什么 |
|---|---|---|
| N | 网络收到元数据/字节、EOF 或错误的观察点 | 不等于用户已收到，也不自动等于终态提交 |
| Q(e) | 事件被某一级投递队列接受并持有数据的入队点 | 不等于完成闸门授权或已投递 |
| X(e) | 从该级队列取出事件的出队点 | 不等于投递；在途、局部批次、已 post 的闭包仍属待投递 |
| C(op, kind) | 操作终止闩锁从未提交到唯一 `end/error/cancelled` 的原子提交点 | 不等于创建终态候选、排队 terminal、cancel Promise 返回或 terminal 回调执行 |
| D(e) | 最终闸门成功并实际开始调用用户 `onEvent` 的入口点 | 不得提前定义成检查、领取许可、出队或 postJSMessage 的时刻 |
| R(e) | 本次同步回调返回或抛出异常被隔离的点 | 用户启动的异步任务不属于 Transport 回调完成条件 |
| T(op) | 已提交的唯一终态通知实际开始投递的点 | 必须晚于 C；通知入队不能替代 C |

- C 一经发生即不可回退、覆盖或重复；所有队列、dispatcher 和桥接路径必须观察同一提交结果。
- 对于非终态事件，**合法实际投递必须满足 `D(e) < C(op, kind)`**。若 C 尚未发生，可继续检查其它条件。若 `Q(e) < C <= D(e)`，事件必须丢弃，因而不得真正产生 D。
- C 与最终检查到 D 的动作必须具有一致的线性化顺序，不允许“检查时无终态，检查结束后 C 已提交，随后仍进入回调”。不得用提前登记一个 D 时间戳掩盖实际晚到调用。
- 若 D 已先发生，回调已经在执行，可以在 C 之后返回；不会回滚已执行用户代码。回调中重入 cancel 可提交 C，余下事件必须被抑制。不能把“已出队但回调未开始”归入此例外。
- 终态通知不得与该 stream 已进入的回调并发或嵌套执行，必须等待它返回/异常隔离；cancel 的提交不等待它或网络收尾完成。

### 2.2 统一丢弃规则

| C 时事件所处位置 | C 后唯一允许处置 |
|---|---|
| 还未入队的 headers/chunk | 拒绝入队并释放其持有物 |
| Native 队列、JS bridge 队列、Handler/message 队列内 | 标记不可投递；回收时丢弃，不得调用 onEvent |
| 已出队、在局部批次、等待慢消费者、已通过前一次检查，但尚未 D | 最终检查必须拒绝；不得因来自“已排队前缀”而豁免 |
| D 已发生、尚未 R | 只允许当前回调收尾；不得继续下一条数据回调 |
| 唯一已提交终态的通知 | 经终态闸门获一次投递机会；不是 headers/chunk 的豁免 |

物理清空队列可以早做，也可在消费时清理，但逻辑失效必须在 C 生效；物理清理不能成为 C 或取消确认的前置 drain。所有丢弃项恰释放一次，其 pending 事件数和字节数恰扣减一次。释放失败/停滞不得被报告为资源验收通过。

### 2.3 正常 EOF 与 end

正常流必须保持完整 `headers → chunk* → end`，不得通过丢失正常数据来满足闸门。

1. 网络正常 EOF 只形成“正常完成候选”，停止新网络读取；该候选不是 C，不设终止闩锁，不产生公开终态。已有 headers/chunk 仍属于未终止操作的待投递内容。
2. 按 FIFO 在闸门下交付正常响应前缀。必须确认所有非终态前缀已实际投递且回调已返回/异常被隔离，所有层级及在途项均无遗漏，然后才可竞争提交 `C(end)`。
3. C(end) 成功后，交付唯一 end；`end.totalBytes` 与交付的完整正常 body 一致。仅检查一个队列为空、仅检测 socket EOF 或仅看工作线程退出都不够。
4. EOF 之后、C(end) 之前仍可取消、关闭或到达原操作 deadline。取消/错误若先提交，正常完成候选作废，剩余前缀丢弃；不得因为网络已经完成而返回 `already-terminal(end)`。既有 deadline 不因等待交付而重置或取消。
5. C(end) 已先提交则后续取消返回 `already-terminal(end)`；任何晚到或重复数据全部丢弃。若实现于 C(end) 时还有正常前缀未交付，这是实现违规，不允许通过“终态后补投递”修补。

这不是选择“终态后投递完再终止”：正常前缀的 D/R 全在 C(end) **之前**，且前缀等待期间不享有对取消或错误的优先权。

### 2.4 error 与 cancelled

- `error`（含超时、背压与网络失败）和获胜的 `cancelled` 均不等待非终态前缀 drain；在该失败/取消处理获得提交次序时直接竞争 C。先提交者获胜，后来候选只做清理。
- 网络已经收到 headers 不等于 headers 已投递。若 headers 尚未 D，error 先 C，则用户只看到 error；若 headers 已 D，用户看到已实际投递前缀后接 error。替代 02b 中可能把“headers 后失败”理解为“必须补发排队 headers”的解读。
- 禁止在 C 之后继续补发 headers/chunk 来维持历史日志形状。error/cancelled 允许没有 headers 前缀；正常 end 不允许借此截断 body。

## 3. 三处闸门与最后窗口

### 3.1 检查点：全部必需

| 检查点 | 强制检查 | 目的 |
|---|---|---|
| 入队 Q | Native 可安全检查的实例/操作登记、事件身份、终态闩锁、context 状态、captured generation；持有物有效 | 阻止 C 后新数据进入队列；不得在 worker 线程调用或操作 JS 值 |
| 出队 X | 重新检查上述当前状态及重复投递/丢弃状态 | 拦截 Q 后已发生 C、close 或 generation 变化的事件 |
| 实际调用前 | 在 JS loop 重新核验上述条件、JS context 可调用性与数据所有权，并与 D 原子地确定先后 | 拦截 X 后或前次检查后发生 C 的窗口 |

“全部”指每一级实际入/出队边界以及最终回调入口；不能只在第一级队列执行一次。若出队与调用确为同一个无间隙动作，可以共用一次检查，但必须证明没有可插入 C 的窗口；异步 post、等待、切线程、批量取出或重新调度后必须重查。

### 3.2 非终态放行条件

仅当下列条件在最终调用入口仍全部成立，headers/chunk 才可开始 D：

- Transport 与操作仍有效且已登记，属于原 requestId 与 captured generation；拥有事件数据。
- 操作 **尚未提交任何终态**。这是 operation 级要求，不能以 context 仍 open 或 terminal 尚未投递替代。
- context 为 open，captured generation 与当前 generation 相等，JS context 可调用。
- 该事件尚未投递或丢弃；事件序列顺序合法。

任一条件失败即丢弃，不重试、不产生新终态、不触碰失效 JS 值。`terminalDelivered == false` 不是非终态放行依据。

### 3.3 终态放行条件

- 必须匹配该操作在 C 提交的唯一结果，不能将第二个 terminal 候选伪装成通知。
- 原操作/实例及通知所需引用仍可安全访问；JS context 仍可调用；终态通知未开始过也未被不可调用规则丢弃。
- 至多开始一次终态通知；用户回调抛异常也消耗该机会，不重试。只有该唯一通知可豁免 context closing/closed 或 generation 提升检查，且只能投向原操作的原接收者，不得绑定到重开的新操作。
- 此条沿用 02b §7.5/§6.5 的既有终态豁免，含 cancelAll 已提交、随后 closeContext 的情形；不是只允许 closeContext 新产生的终态，也不允许任何数据豁免。
- JS 不可调用时，内部 C 仍有效，通知被安全丢弃；不能为得到“恰一回调”强行调用失效上下文。可调用且正常推进的 mock 中必须恰一通知。

### 3.4 Promise 与序号

- `request()` 的最终 resolve/reject 是终态通知，遵循 C/唯一 settle 和安全闸门，不把“已经提交终态”当成丢弃其唯一结果的理由；它不发 headers/chunk 流事件。
- `openStream()` 的 admission Promise 是登记确认，不是 end。成功接纳的确认仍须在该 stream 的第一条事件之前完成；如果取消已获胜，不能因此将登记确认悬空，只交付确认后的一次 cancelled，不交付已失效数据。登记失败则 reject，不产生流事件。
- 控制 API（cancel/cancelAll/closeContext 等）的 Promise 是其调用结果，不是该 stream 的数据。它们各自仅 settle 一次，在安全的 JS loop 执行；控制调用确认不绕过数据闸门。
- 对用户可观察的 stream 序号，首条为 1，按实际开始投递顺序递增；被丢弃事件不消耗可观察序号。队列内部编号不视为公开 seq。因此无前缀取消可只观察到 `cancelled(seq=1)`；正常 M10 仍连续，不重排已经投递的前缀。

## 4. 三个入口与清理

### 4.1 cancel

`cancel()` 在未终止操作上提交 C(cancelled)，**提交前不 drain，提交后由统一闸门丢弃所有未投递数据**；不得先向消费者交付排队数据再响应取消。`cancel-requested` 确认不得早于 C 及其数据抑制生效，不等待 socket 排空/线程退出。仍保持 context open、generation 不变，不改变其它请求或配置。

### 4.2 cancelAll

每个被本次调用纳入的操作分别按 §4.1 竞争 C，不要求整个批次共享一个 C；该操作一经提交即受抑制，不得等最后一个操作取消完才关闸。批次确认必须在各 outcome 对应状态成立之后。`cancelled` 只计本次新提交 cancelled 的操作，重复调用不重复计数。

不先 drain、不等 worker 退出、不关闭 context、不提升 generation。调用处理时已登记的操作纳入本次范围；与新 admission 必须有确定次序，处理边界之后接纳的新操作可继续运行。不同 context 不受影响。

### 4.3 closeContext 与组合链

保持原顺序：停止接纳并进入 closing，逐未终止操作提交 C(cancelled)，generation +1，然后 closed。各数据投递即使处于已出队/已 post 状态也不得穿越关闸；不 drain。重复 close 不再次提升 generation。close 的返回确认在这组状态变更生效之后，不依赖清空网络线程。

保留 `cancelAll → 终态通知机会 → closeContext` 的规范组合；close 不得覆盖前一步已提交的 reason，不产生第二终态。已提交唯一终态按 §3.3 可投递一次；这不要求人为补投任何前缀。重开仅服务新 generation；老数据永久失效。

### 4.4 背压与清理账目

- 02b §5 水位、terminal slot、低水位恢复规则原样保留。计量包括所有层级和出队后尚未 D 的数据，不因移到局部变量或桥接消息而提前扣账。
- C 之后待投递项不再有投递资格，清理恰扣账一次；不能解除背压后恢复该已终止操作的读取。其它存活操作仍按原低水位规则恢复。
- 不可暂停源触发 `ERR_BACKPRESSURE` 时立即竞争 C(error)，丢弃所有未投递 headers/chunk，唯一 error 在**已实际投递**前缀之后通知。不得为了排空未投递前缀继续读取或交付。
- 当前回调结束、终态通知已投递或安全丢弃、待投递持有物释放，以及 worker/socket/定时器停止解绑，均需独立记录。C、cancel 确认、pending=0 不互相冒充资源完全释放证据。

## 5. 更新后的 M 矩阵（M01–M34）

### 5.1 执行与证据要求

以下矩阵是 r2 验收定义，不是运行结果。**全部待 1B 修复后重跑**。M01–M31 保留原非时序断言，表中明确列出需增强项；不能拿 04 的旧 31/31 填入 r2 PASS。

- M32–M34 必须分别执行 `handler/postjsmessage/jsoop` 三路径；路径名仅表示当前 Node IUT 的三个测试模式，不证明真实 QuickJS/固件行为。
- WQ：确定性暂停实际调用，证明 headers/chunk 已 Q 且尚未 D，再触发入口。WX：证明已 X、仍未 D，再提交 C。WG：在早期/初次最终检查通过后、实际调用前尝试提交 C，验证只有 `D < C` 或“C 获胜、无 D”两个结果，不得出现检查放行后 `C < D`。WQ/WX/WG 都是必测子场景，不以 sleep 延时单独作为窗口证据。
- 多级队列、局部批次、已 post 待执行的项均须覆盖。控制同步只能使用隔离的 test-build 探针，不新增 release 公共接口；本轮只定义，不实现探针。
- 记录脱敏的事件身份、路径、context generation、Q/X/检查/C/D/R 次序、终态种类、outcome、drop 原因、pending 账目/峰值、实际回调序列。优先用同一操作的可比较逻辑序号，不能仅依靠不同线程墙钟推断先后。
- 测试在 **C** 划线，而非取消 Promise 返回或 cancelled 回调时刻。恢复消费者、完成已投递任务的屏障并执行后到注入后，仍无非终态回调，才通过；没有成功制造窗口的子场景记未覆盖，不记 PASS。
- 每个新用例至少包含“零已投递前缀”与“headers/一个 chunk 已投递、还有 chunk 待投递”的分支；WQ 的最小复现用零前缀。JS 可调用时断言恰一终态；不可调用时按 §3.3 断言安全丢弃。

### 5.2 完整索引

| ID | 场景/fixture | r2 关键断言（继承项仍全部适用） |
|---|---|---|
| M01 | GET 小 body | request resolve 精确响应，只 settle 一次，不发流事件 |
| M02 | POST echo | string/Uint8Array 输入与响应字节精确 |
| M03 | 设置与回传 Cookie | 同 context 处理、响应交付前可观察；记录不得含真实值 |
| M04 | context Cookie 隔离/清理 | A/B 不串，旧 epoch 响应不复活 |
| M05 | 两个代理 | context 隔离与 admission 快照不变 |
| M06 | 302 follow | 最终响应且至多 5 跳；正常前缀在 C(end) 前交付 |
| M07 | 302 manual | 保留 3xx，不访问 final；不丢正常响应前缀 |
| M08 | HTTP 401 | 可观察响应，stream 正常 headers/chunk*/end，不作传输错误 |
| M09 | HTTP 429 | 同 M08；不做业务重试/换 context |
| M10 | 正常分片与慢消费者，增强 | 正常 seq 连续、body 完整；EOF 时有待投递前缀则不得 C(end)；最后前缀 R 后 C(end)，再 T；三路径补跑 1C 四字节正常结束对照 |
| M11 | 跨 chunk UTF-8 | 原始字节无重组/丢失，单 chunk 不超过 64 KiB |
| M12 | 长流 cancel，增强 | C 后无新 headers/chunk，恰一 cancelled；排队窗口由 M32 强制覆盖 |
| M13 | 重复 cancel / end 竞态，增强 | outcome/幂等不变；新增 EOF 候选未 C 时取消获胜、C(end) 后取消不覆盖、回调内重入取消三分支 |
| M14 | timeout，增强 | 排队/网络/EOF 后等待交付仍在原 deadline 内；timeout 先 C 则候选 end 作废，未投递数据丢弃；唯一 ERR_TIMEOUT |
| M15 | 重复 ID / 多 context | 不重复接纳，每操作独立 settle，不串隔离状态 |
| M16 | 32/64、8/16 请求上限 | 超限 ERR_QUEUE_FULL，无无界增长，FIFO admission 可追踪 |
| M17 | 慢消费者/不可暂停源，增强 | 原水位不变；可暂停正常流无丢字节；不可暂停 error 先 C、未投递前缀全丢、账目释放一次、无终止后恢复读取 |
| M18 | body/response/header 上限 | 原错误码、无泄漏、无二次 settle |
| M19 | cancelAll + close，增强 | request reject ERR_CANCELLED；stream 唯一 cancelled；不覆盖先提交 reason；包括不等终态回调即 close；无晚到数据 |
| M20 | TLS / ALPN h2/h1 | 保留独立握手/协议/错误证据；不得以 200 替代 |
| M21 | 代理 TLS/HTTP2 | 指定 context 代理、失败分类、其它 context 不受影响 |
| M22 | 断连/空 body，增强 | headers 未 D 时 error 先 C，只 error；headers 已 D 则实际前缀后 error；加入已 Q/已 X 的错误窗口与三路径；空正常流仍 headers→end(0) |
| M23 | Set-Cookie 与 clear 并发 | epoch 隔离不变，不输出敏感值 |
| M24 | 回调抛异常，增强 | 异常隔离，不重复 terminal；前缀回调抛出视作已调用，不阻塞正常完成候选的收敛 |
| M25 | S1 页面停止负向对照 | 不取消仍投递；显式 cancel 后按 C 抑制数据；不宣称宿主已终止 |
| M26 | S2 后台/停止负向对照 | 不自动终止；cancelAll 后按 C 抑制；不改变 open/generation |
| M27 | S4 卸载负向对照 | 无卸载信号也由显式链关闸；不依赖 dlclose；不当作已终止证据 |
| M28 | kill -9 硬终止 | 必含无任何晚到回调、先拉日志再 kill、重启无旧活动；mock/真机分表 |
| M29 | close/reopen/generation，增强 | 幂等、拒绝 closed admission、旧数据不越代；终态豁免只投原接收者一次；M34 覆盖排队 close |
| M30 | 三种终态后注入，增强 | 分别覆盖 end/error/cancelled 的新入队、重复通知、在途项；无第二终态；C 后 headers/chunk 无 D；合法 end 用 M10 保证没有未交付正常前缀 |
| M31 | cancel/cancelAll/close/正常完成并发，增强 | 每操作先 C 者获胜；EOF 候选不算 C；结果/计数一致，重复取消不重复计数 |
| M32 | **cancel 排队窗口，新增** | 三路径 × WQ/WX/WG；未 D 的 headers/chunk 丢弃，唯一 cancelled(user)，cancel-requested 确认不早于 C；context 仍 open/generation 不变，其它操作正常 |
| M33 | **cancelAll 排队窗口，新增** | 三路径 × WQ/WX/WG；至少两个 stream 与一个 request；逐操作 C 后各自零非终态回调；默认 reason=app-lifecycle-end，并覆盖 user；计数/outcomes/幂等一致，request 恰一 reject，context 保持 open |
| M34 | **closeContext 排队窗口，新增** | 三路径 × WQ/WX/WG；唯一 cancelled(context-closed)，先停 admission 再 C/generation/closed；重复 close 不变；重开新 generation 不复活旧数据，唯一旧终态不串新接收者 |

M32/M33 另需与 M19/M31 联合覆盖：取消已经提交但终态未投递时立即 close，仍只产生先提交结果的一次通知。M34 不能仅检查 closed 状态一次就通过 WG；必须证明确实覆盖出队到调用窗口。

### 5.3 G1 增量映射

- 取消长流：M12、M13、M30、**M32、M33**。
- 显式终止链/generation：M19、M29–M31、**M32–M34**。
- 正常流与错误顺序：M08–M11、M14、M17、M22、M24；不能只验证 cancelled。
- GET/POST/Cookie/302/超时/并发/队列/代理/TLS 的原映射不变。
- M25–M27 的负向对照类别、M28 的硬终止与真机独立证据要求不变。新增排队测试不替代 M28。

## 6. 1B-ii 修复方向与重新进入 1C 的门槛

修复方向仅限定行为，不指定代码、锁、队列容器、线程模型或函数改写：

1. 将网络 EOF/正常完成候选与不可逆 C(end) 分开，完整响应前缀先交付；等待期间仍允许取消/错误获胜。
2. 三处闸门使用同一 operation 终态事实，尤其收紧最终检查到真实回调入口的并发边界。单加一个 terminal 判断而保持过早 end 提交不合格。
3. 三个显式入口不做前缀 drain，提交后立即逻辑抑制。闭包、桥消息、已出队局部批次都经过同一规则；不通过强制 closeContext 规避 cancelAll 保持 open 的要求。
4. 唯一终态、登记确认与最终 request settle 分清职责，保留安全引用与幂等；丢弃计量及释放不漏不重。
5. 修复后重跑 M01–M34 并更新实现报告/证据（另行授权的实施轮次）；旧对照脚本作为历史原件保留，为 r2 建新结果，不能改写旧失败为 PASS。

进入 1C 之前必须同时满足：两轮三路径三入口复测零违规，M32–M34 的 WQ/WX/WG 和已投递前缀分支全部有确定性证据，正常/错误/超时/背压回归通过，原 M01–M31 全量无回归，五件套无宿主兜底依赖。缺测试窗口或仍出现 `C < D(headers/chunk)` 就保持未通过，不得标记实现完成。

随后才可恢复 1C 工具链准备和真机 M20/M21/M28；真机尚无新增证据，阶段 2（PoW）未放行。

## 7. 证据边界与待验证

| 证据 | 当前可支持的结论 | 不能推出的结论 |
|---|---|---|
| `phase1c/preflight/gate-audit.json` | 已排队 headers/chunk 在 cancelled 提交后执行，原闸门缺口成立 | 不证明真实固件投递时序 |
| `phase1c/preflight/recheck-1.json`、`recheck-2.json`、`recheck-exit-codes.json` | 各 9 组/6 违规；三路径 cancel/cancelAll 失败，closeContext 三组对照通过；退出码均 2 | 不证明 r2 修复已通过，也不证明所有出队/检查窗口已覆盖 |
| `phase1c/preflight/normal-end-control.json` | 当前实现 EOF 提前提交 end 后才交付四字节正常前缀；不能只补闸门 | 不证明新候选状态、取消/EOF 竞态或真机线程同步已实现 |
| `phase1c/tests/gate-recheck.mjs`、`gate-normal-end-control.mjs` | 复现方法与断言边界可核对 | 延时 Node 测试不等价于确定性 WG/真实 native 多线程证明 |
| `docs/astra/05-phase1c-device-port.md` §3–§6 | 移植前一致性门停止；源码时序分析与反例对应 | 未构建/未安装不能写成真机失败或成功 |

表中 `phase1c/` 路径完整前缀为 `.probe/probe/`。详细 JSON 字段映射见 02e。

统一丢弃、EOF 候选和错误即时抑制是依据既有契约不变量与本地反例作出的**规范决策**，不是从证据猜测固件“会自动这样做”。其实际可执行性、所有线程竞态、释放峰值仍待 1B 修复验证；证据不足处不留另一种合法时序，而保留运行验收门槛。若实现无法证明本规范，停止并提交证据，不得暗改为终态后 drain。

02b §10 / 02c §3 的未决项继续保留，特别是卸载信号、postJSMessage 失败语义、同宿主重装、生命周期钩子和最后安全 JS loop 时刻。05 的工具链及 HTTP/2 依赖缺口、真机 M20/M21/M28 和 ①④⑤ 均待验证。本轮没有关闭这些问题。
