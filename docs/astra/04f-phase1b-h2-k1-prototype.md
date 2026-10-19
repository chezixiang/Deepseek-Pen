# 路线 C K1：H2 接收事件有界性隔离原型

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收K1原型。** 空 DATA 静态反例已由有限回环实验确认；最小实验补丁消除了零 payload 的接收 DATA 事件积压，保留校验、EOF 和必要唤醒。**K1 整体未关闭，分层预算未通过，r3 未发布，1B 未完成，1C 仍阻断，G1 未放行。**

## 1. 授权与输入

本轮依据用户转交：04e 调查已接受，仅批准 K1 同栈隔离能力验证。现行规范仍为 02d 及其继承条款；02f 仍为 DRAFT / NOT APPROVED。R3-A/Q 仅作原型设计前提，R3-C/U 数值、对象上限及满额行为未批准。

已读取 04e、02f，核对 02d 不变项、04e `sources.json` 精确来源及当前项目 lock。只审计 K1 的 http2 recv/buffer/state、Slab 和 Bytes/codec 相关路径；未再次扫描无关依赖。本轮没有更改解压、headers 政策、连接池、控制 API 或 Transport 绑定，没有设备访问、业务迁移、Git 提交/暂存、子 Agent、会话创建或联系。用户手动转交本报告。

独立证据根（下文 E）：`docs/astra/evidence/h2-k1-20261003-a61f8c/`。新目录不与既有目录合并；每次构建/测试另建带时间和随机后缀的 `results/` 子目录，失败原件保留。

## 2. 精确栈与隔离

**实际测试层级是 http2 级宿主，不是 hyper2 级，更不是完整 wreq。** 接收端使用精确版本 `http2 0.4.21`，对端是最小 Rust 原始 H2 帧发送器，本机 `127.0.0.1` TCP 回环、明文 prior-knowledge。没有 TLS、ALPN、HTTP content decoder、wreq headers/cookies/pool 或 JS bridge。

| 项 | 固化证据与事实 |
|---|---|
| http2 来源 | 原始 `.crate` SHA-256：`a6e23815f8ec982e1452e1d0fda921ec20a9187fb610ad003c90cc5abd65b2c4`；与项目 lock、04e 来源记录相同；逐文件与04e调查副本匹配 |
| 三组源码 | `pristine/http2` 字节未修改；`baseline/http2` 仅观测插桩；`patched/http2` 同样插桩加 `semantic.patch`。原始调查副本及缓存未写入 |
| 构建隔离 | 三组各自 `Cargo.toml`、`Cargo.lock`、`target`；共用仅本实验的 `vendor`、`archives`、`cargo-home`。显式 `--offline`、`x86_64-unknown-linux-gnu`，不继承项目 ARM64 target |
| 依赖版本 | bytes 1.11.1、http 1.4.1、tokio 1.52.3、tokio-util 0.7.18、slab 0.4.12 等全部取自当前 lock；`dependencies-source.json`、`extra-dependencies-tracing.json`、各组 Cargo.lock 与 `lock-verification.json` 可复核 |
| 实际 features | http2 `unstable`：仅用于该版本隐藏 frame/config 类型可见性，非目标 hyper2 原 feature 闭包；不启用 http2 tracing/stream。Tokio 宿主 rt/macros/net/io-util/sync/time，当前线程 runtime；完整实际图与合并 features 见各 `*-metadata-*/tree`、`metadata` |
| 环境 | WSL Ubuntu，rustc 1.97.1 / LLVM 22.1.6，x86_64 GNU；dev/unoptimized+debuginfo。Cargo/rustc/uname/PATH/CARGO/RUST 等环境输出均封存。上游 8 个 lifetime 警告及 `/mnt/g` incremental hard-link 警告未修饰 |
| 解析材料 | 先缓存离线；缺 wasi 0.11.1+wasi-snapshot-preview1、windows-link 0.2.1、windows-sys 0.61.2，调用权限流程后在已启用网络权限下仅下载精确 crate 并验 checksum。没有网络测试目标或版本升级；这些平台包不等于实际 Linux 链接物 |

Cargo 为 path crate 解析还需可选 tracing 元数据，额外从缓存复制 tracing 0.1.44、tracing-core 0.1.36、once_cell 1.21.4、log 0.4.30。最初误将嵌套 http2 纳入 workspace 导致 env_logger 解析失败，随后只在宿主 manifest `exclude=["http2"]`，不删改上游 dev-dependencies。两次构建失败保留。Cargo “Locking 1 package”是 registry http2 替换成相同版本的隔离 path，不是升级。

H2 builder 明确保持 Chrome136 所涉设置：stream 6,291,456、connection 15,728,640；header table 65,536、header list 262,144、push=false，默认 max frame 16,384；相同 SETTINGS 顺序、HEADERS priority `(0,255,true)`、pseudo 顺序。未设置额外 max-concurrent-streams，未缩窗口。实际 SETTINGS hex：`000100010000000200000000000400600000000600040000`；初始 connection WINDOW_UPDATE=`00ef0001`。这不是 Chrome136 TLS/完整请求指纹证据；Accept-Encoding 在本层不存在，也未改业务配置。

## 3. 方法、停止条件与观测边界

每例独立进程、一个 session、两条在途流。A 停止 body 消费，driver 持续推进；B 在 A 尚未结束时接收 prefix，再在 A 暂停或取消后接收 suffix 并 EOF。发送后的 PING ACK 是 driver 已经过前序帧的屏障，非 sleep 推测。

- 初始空帧阶梯为 1、8、64、512、2048，程序硬上限 2048 帧；应用输入批次硬上限 65,536 B、逻辑 payload 34,816 B。早期完整对照空帧上限512，最后复跑收缩为128；1字节帧64/128、17字节帧64，加有限setup/结束/control帧。不把payload上限写成线端总量。
- 单屏障 2 秒，async 用例 8 秒，外部 wall 12 秒，CPU 10 秒；地址空间硬限 512 MiB，RSS 每10ms采样，超过128 MiB停止。两级 deadline 不能代替内存证明。构建独立300秒上限，不按测试进程内存限制编译器。
- 2048 空帧插桩例触发外部 wall 停止，code=-9；512 单字节插桩例触发屏障 timeout，code=101。保留原始日志，不增加时限追跑；最终矩阵收缩帧数。这些失败提示观测开销，不足以断定目标栈吞吐或目标库超时。
- 最后复跑512空帧也触发2秒屏障timeout，尽管早期同规模已有完整成功；继续保留失败，最终三组相同对照改用128空帧。报告不将该规模声称为稳定性能阈值。
- 原始 pristine 先运行，随后仅插桩 baseline 确认反例，再应用语义补丁。观测的 `DATA` 是实际即将入队，`BUFFER` 是 Slab insert/remove 后的真实 len/capacity。共享槽同时容纳 headers/trailers，不能把任何 BUFFER 行都叫 DATA。
- `k1probe.rs` 用 System allocator 外包固定分配记录表：32768条×24B=786432B，历史 DATA allocation ID 表4096条×8B=32768B（另有锁/计数）；只服务实验追踪，不是库对象cap。表满会中止观测进程，本轮未触发，不发布为运行政策。
- backing ID 按实际活分配地址区间识别，记录 allocator **申请字节**，不是 malloc usable size/RSS，也不包括 Bytes 共享控制块或全栈其他分配。零长度指针若落于可识别区间也记录；空视图位于 allocation 尾端时可能无法匹配，所以不据此给所有空视图 backing 硬界。Slab 最后一个槽 pop 后 `backing_id=0`只是无可查询活槽，**不表示 Slab 分配归零**，capacity 仍记录。

独立 `analyze.py` 从 `WIRE_TX` 解出输入 DATA，另按 case 生成预期字节，再校验 `RESULT delivered`、长度与 SHA-256，不让生产者期望数组兼任唯一校验器。`comparison.json` 比较真实收到的客户端帧，包括 SETTINGS、WINDOW_UPDATE、PING ACK、RST、GOAWAY；原始顺序及多重集均保留。

## 4. 有限基线与补丁结果

完整早期基线：`results/baseline-matrix-115456-197f9e/`；补丁：`results/patched-matrix-115932-c0ac82/`。两边相同16例、独立字节校验通过；最新同源码复跑索引见 `final-runs.json`，不覆盖早期结果。原始 pristine 首轮17例包括2048空帧通过，但无内部观测，不冒称该例 Slab 峰值已测。

最后复跑是 pristine `120759-a6882f`、baseline `120805-8cb356`、patched `120817-f1b4e9`，各16例（空帧上限128），独立输入/交付校验均通过；同一空事件断言baseline仍FAIL、patch为PASS。`finite-run-summary.json`记录本轮最终主矩阵双向H2字节最大2044B，额外backing例33224B（含preface/control，不含TCP/IP开销）；10ms采样RSS最大4,276,224B，仅是有限进程采样，不是已证明峰值/目标内存预算。

下表是 body 暂停点，未把后续兄弟流/EOF 瞬时槽加进这个时点：

| A 输入 | baseline活DATA / Slab容量 | patched活DATA / Slab容量 | payload / 唯一payload backing（本样本） |
|---|---:|---:|---:|
| 1 空非END | 1 / 4 | 0 / 4 | 0；baseline保留1块8192，patched无DATA引用 |
| 8 空非END | 8 / 8 | 0 / 4 | 同上 |
| 64 空非END | 64 / 64 | 0 / 4 | 同上 |
| 512 空非END | 512 / 512 | 0 / 4 | 同上；baseline Slab申请122880B |
| 空/1B交错64帧 | 64 / 64 | 32 / 32 | 32B / 1块8192B |
| 64×1B | 64 / 64 | 64 / 64 | 64B / 1块8192B |
| 128×1B | 128 / 128 | 128 / 128 | 128B / 1块8192B |
| 64×17B | 64 / 64 | 64 / 64 | 1088B / 1块8192B |

**因此空 DATA 静态反例被有限实验确认，不只是理论增长。** `empty-non-end-gate.json` 在 baseline 为 FAIL（退出2），patched 为 PASS（退出0）。本宿主 Slab 元素申请折算为240B/容量槽；512例由于随后 B 仍要入队，Slab容量最终到1024，即245760B，清理到live=0后仍为1024。这是样本观测，不据此宣称跨target对象大小或峰值固定。

| 语义用例 | 对照结果 |
|---|---|
| 空非END | baseline消费者被唤醒并累计空事件；patched不入队、不产生无意义唤醒，仍Pending，窗口不变 |
| 空END_STREAM | baseline返回一个空body事件后EOF；patched返回0个body事件，EOF=true；先注册Pending的自定义waker从0到1，证明必要唤醒保留 |
| 非空END_STREAM | `Z`准确交付，非空事件不被消除，EOF保留 |
| 空/非空交错 | 非空字节与顺序相同；事件数只减少空项 |
| content-length不足/超出 | `content-length:1`+空END，及`content-length:0`+`Z`END均为PROTOCOL_ERROR；未把空END提前吞掉 |
| remote-closed流再次空DATA | 实际RST_STREAM(STREAM_CLOSED=5)，不误要求整连接退出；最初错误断言的超时原件保留 |
| idle stream 5 空DATA | connection PROTOCOL_ERROR/GOAWAY路径仍到达；未旁路流状态校验 |
| pause A / B在途 | A保留64B未消费时，B准确交付`B-prefix-suffix`15B并EOF，随后A恢复完整结束 |
| cancel A / B在途 | A RST(CANCEL=8)+drop，清理A槽，后到`late`不交付；B仍15B并EOF。这里是http2 reset/drop，不冒称Transport C确认 |

取消时共享 Slab 活槽从 A+B 减至只有 B；最后清空live=0但容量128保留。DATA曾引用的共享backing在A取消/全body清空时可能还由B或codec持有，driver drop后追踪到的DATA backing活数归0。错误/idle路径也显式等待/取消任务并释放引用；没有把进程退出或kill当作正常取消清理证明。

## 5. 最小补丁的精确范围

`semantic.patch` 只有 `recv.rs` 入队前8行：在既有 `stream.in_flight_recv_data += sz` **之后**，`sz==0`时只对END_STREAM调用 `notify_recv`，然后返回；非空路径完全保持。

原始顺序保持：流状态/本地reset分支 -> connection flow消费 -> stream window检查 -> content-length递减 -> END长度归零校验及 `recv_close` -> 已释放接收者处理 -> stream flow记账 -> in-flight记账 -> 空payload消除/非空入队。它不是入口return；已有错误及关闭语义均先执行。EOF由stream state保存，不依赖一个空DATA槽，`poll_data -> schedule_recv -> ensure_recv_open`仍能返回None。补丁不引入对象cap、拒绝策略、额外窗口限制或聚合。

修复：零payload DATA事件及其引用可造成的无窗口约束积压（包括空END自身不再占槽）。**没有限制**非空小帧数量效率、Slab历史容量、源Bytes backing大小、codec瞬时分配、headers/trailers活数、session总数及上层已释放credit但仍持有的Bytes。也未解决空帧输入CPU/公平性/速率问题。

`baseline-instrumentation.diff`/`patched-instrumentation.diff`记录相同观察修改，`k1probe.rs`是独立新增观测模块；不把插桩当作8行语义补丁。原型不接入生产构建，不复制回ds-free-api，不发布依赖patch。

可定位源码：E中 `pristine/http2/src/proto/streams/recv.rs:581`起为原接收校验，`:675`为原事件生成，`:1109`/`:1154`为poll/schedule；`patched/http2/src/proto/streams/recv.rs:678`为新消除分支。`pristine/http2/src/proto/streams/buffer.rs:47,81`分别insert/remove；`vendor/slab-0.4.12/src/lib.rs:1091,1166`为底层push/remove；观测入口为`baseline/http2/src/proto/streams/buffer.rs:33`及`k1probe.rs:27,33`。

## 6. 小帧、backing、Slab：证明范围

有限跨backing样本：`baseline-test-120140-477a53` 与 `patched-test-120209-f4e8e3`。4个1B DATA之间分别插入一个8192B未知扩展帧(type=0xfe)，共4个DATA+4个extension、输入批次32844B；这是合法忽略帧、有限回环，未改接收政策。两边暂停点均4个DATA、4B payload、**4块8192B backing合计32768B**，不是1块；扩展帧内容本身不占DATA credit。baseline末尾空END还可能保留第5块；patched消除该空事件。完整输出和独立SHA相同。

### 6.1 已能证明的条件化子界

补丁后每个排队DATA有至少1B，令 `q_i` 为仍在http2队列且尚未release credit的payload：

```text
N_DATA_i <= q_i <= 6,291,456
sum_session N_DATA_i <= sum_session q_i <= 15,728,640
N_unique_payload_backing <= N_DATA_queued
```

最后一式只限由这些队列Bytes保留的非空payload backing，每个Bytes指向一块，别名去重；不含codec自己的当前块、控制块、header对象、已pop持有者。这是真正的有限**数量**子界，不是可接受的物理预算。不能算成窗口/16384，也不能认为所有流都填满窗口且独立占session。

仅按本平台观测240B/槽，6MiB个1B事件的槽规模已约1.40625GiB；一个15MiB session的槽规模约3.515625GiB，尚未计Vec扩容余量、backing和其他资源。**这是条件化理论算例，不是已测峰值、批准值或可用内存承诺。** 不能把6MiB窗口改小来掩盖这一点。

Slab由 `Vec<Entry<Slot<Event>>>` 自动增长，remove归还槽但不shrink；容量取决于该session历史高水位及运行时分配策略。所有live DATA受窗口约束不等于共享Slab整体已受同一个界约束：headers/trailers共槽、旧终态持有者、跨session数量还需有效存活约束。有限回放只量得特定历史，不提供全部历史上界。

backing逻辑路径：http2 codec max frame限制帧逻辑长，tokio-util LengthDelimited `split_to` 与 BytesMut `freeze` 共享底层allocation；read-ahead、offset、reserve/growth、共享控制块和保留视图使payload.len与allocation容量不同。单块8192是本样本，不作为所有输入的Bmax。本轮未完成该路径全部分配状态归纳，也没证明全target allocator请求/扩容重叠上界，不能填一个猜测常量。

**回答“非空小帧/Slab/backing能否形成可证明的有限预算”：非空排队DATA数量已有窗口导出的条件有限界；完整共享Slab+backing物理预算仍不能由本原型证明。** 已观测放大足以说明单独消除空事件不是K1关闭证据。

### 6.2 下一步有界聚合设计（未实现、未批准）

候选仅是保持字节/窗口的同栈内部聚合，不设任意对象cap或新拒绝行为：按流将验证后的DATA拷贝进预留的固定容量页，最多一个可追加尾页；发布页/EOF/错误保持原顺序。页大小b、有效持有流数L、共享页池信用、满池可继续推进兄弟流的规则必须先审批。页必须有明确owner及退休点，不允许由空DATA分配页。

若每流除最后一页外全满、不存在共享稀疏洞，则候选证明义务为：

```text
N_pages_i <= ceil(q_i/b)
sum N_pages_i <= floor(sum q_i/b) + L
payload_page_capacity <= sum q_i + L*(b-1)
```

这是条件推导，不是选定b或L。若把b=16KiB仅作为算例，单流6MiB需384页；必须另计队列元数据、终态/headers、复制时源+目的重叠和codec backing。实际池规模及瞬时credit要在**分配/复制之前**预留；不能读完整未知源后事后拒绝来宣称有界。聚合不能提前release flow credit，否则上式失去q对应关系；hyper2现有poll后release的语义需要专门映射。

不建议在本轮追认任意对象cap或满额RST。优先申请“固定页聚合+源backing/credit责任”的下一轮隔离设计验证；若完整有效存活数/源界不足而需要满池异常、新拒绝、限流或改变公开admission，则停止并分别申请R3-C/U明确政策。部分满页的EOF/取消、同session公平性、低延迟交付与copy cost都需测，不能按平均帧长证明。

## 7. 网络变化与失败原件

16例同条件baseline/patch采样中，对端记录的客户端帧顺序完全相同，包含相同SETTINGS/WINDOW_UPDATE及RST原因；输入/交付SHA相同。idle错误的driver返回相同GoAway(PROTOCOL_ERROR)，但对端可能在读取该帧前被测试收尾终止，所以不冒称其GOAWAY线端原件完整捕获。线端frame是否完全相同仅限这些固定回环记录，时间戳/packet分段/TLS均未证明。

明确发生的内部可观察变化：空非END不触发body事件及其无意义唤醒；空END不再返回空Bytes，仍唤醒并EOF；非空帧边界本补丁不聚合。由调度变化可能影响后续poll和control时序，不能因profile字段没改就宣称全网络行为或Chrome136完全等价。

失败与修正记录保留：

| 原件 | 状态与处置 |
|---|---|
| `preparation-offline-failure.txt` | 初始缺wasi的工具输出逐字转录，明确不是自动原始stdout文件；源工具输出保留在本聊天。只补精确材料 |
| `pristine-build-114251-c4d1c0` / `114425-0df323` | tracing/env_logger解析失败；修正隔离材料/workspace，不改上游代码 |
| `pristine-matrix-114751-5dd39e/closed-0` | 误期望连接关闭，实际RST_STREAM=5；修正测试，失败保留 |
| `baseline-matrix-115222-13f218/empty-2048` | 12秒外部停止；部分观测日志不是完整用例峰值 |
| `baseline-matrix-115346-9fe16c/one-512` | 2秒屏障timeout；收缩测试数量，未放宽停止条件 |
| `baseline-matrix-120456-8b9b07/empty-512` | 最后复跑同规模屏障timeout；保留早期成功与本次失败，最终三组缩到128空帧 |
| baseline `empty-non-end-gate.json` | 刻意保留FAIL，patch另目录PASS，不篡改旧断言或旧strict FAIL |

这些均在新目录，04c Windows/WSL strict FAIL（1114112>1048576）原件未改，不用本轮换取得边界将其改判。

## 8. 手动验收与下一最小决策

建议总工程师只验收两项实证：有限空DATA反例成立；8行原型在已测条件消除空事件且保留EOF/错误/兄弟流。**不据此验收完整K1或分层预算。**

下一最小决策：是否授权下一轮“有界页聚合与backing信用责任”的隔离设计/验证，先明确页大小选择范围、有效接收持有流/session退休约束及满额可行性；R3-C/U仍不得默认获批。若不授权聚合，保留本最小补丁候选及数量子界，不把数百万槽的理论上限写成可交付预算。

原型纳入目标栈前仍需：

1. hyper2级映射：空Bytes消失、poll/release_capacity时机、body/trailers、reset/drop生命周期、多线程调度及队列持有与credit守恒。
2. 完整wreq精确features/构建：正常H2字节完整性、目标Chrome136 TLS/ALPN/SETTINGS及实际请求字段/时序差分；本轮未测TLS，不可继承“相同指纹”。
3. K1局部边界补测：更广帧分割、padding、最大帧/flow-control错误、HEAD响应、reset与EOF竞态、长期多流轮换、backing扩容/共享控制块/Slab高水位；需按批准设计制定有限测试，不无界灌入。
4. 若聚合获批：源+目的重叠、页池满额下B继续推进、部分页交付/取消/EOF、跨流共享归属、无隐式window/SETTINGS变化和非空DATA正常字节不变的证明。
5. K2–K5、02d §6、M矩阵与G1其余责任完全保留；设备验证必须另行授权。

`final-runs.json`定位最后对照，`protection-after.json`核验既有输入，`source-differences.json`限定源码改动，`lock-verification.json`限定版本，`artifacts-sha256.json`封存非target证据。复跑入口是新唯一结果目录的 `run.py`；不要在已有准备目录重跑prepare/instrument覆盖材料。`initial.py`/`baseline_stages.py`是历史阶段脚本，不是幂等安装程序。

末次保护核验：838个限定输入哈希未变；原缓存使用过的archive checksum复核一致；pristine逐文件等于精确vendor原件；baseline/patch各自只有lib模块注册、观测模块、buffer插桩及recv文件四处源码差异，两者间语义差异只有`semantic.patch`。既有Git tracked改动保持原样，不归本轮。无生产构建或安装。

**最终结论：待总工程师验收K1原型。**
