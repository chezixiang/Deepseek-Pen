# 路线 C K1：受限消费适配器与页所有权解耦验证

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收。** 本轮仅交付材料勘误、三项旧超时的有限串行诊断，以及真实 hyper2 body 边界的隔离宿主适配器结果。**不宣称完整 K1、库内预算或 r3 通过；1C 继续阻断，G1 未通过。** 现行契约仍为 02d 及其继承条款，02f 仍为草案。

## 1. 范围与复核入口

读取并核对 02f、04f、04g，以及其 http2/hyper2、页池、观测器、宿主、runner、独立校验和封存源码；核对 04g 最终三项失败、旧 final-index、seal 和两次 delivery-check。未改旧实现、旧原型、契约、报告、缓存或历史证据；未接生产、发布 r3、操作设备、提交/暂存 Git，未使用子 Agent、创建或联系会话。结果由用户手动转交。

本轮独立证据根，下文 E：`docs/astra/evidence/h2-k1-adapter-20261003-9d2c70/`。除本报告外，新增源码、依赖副本、构建缓存、二进制、日志、校验及补丁全部在 E。`frozen/` 保存逐字源码副本及旧原二进制；`diagnostic/` 只做屏障观测；`adapter/` 实现获准的受限消费实验。Cargo 使用 E 内 vendor/cargo-home/target、`--offline --locked`，不触碰旧缓存、不下载或升级依赖。

主要材料：

| 材料 | 路径（相对 E） |
|---|---|
| 索引勘误、精确重建、旧清单复核 | `audit/index-erratum.json`、`reconstructed-sealed-index.json`、`current-index-copy.json`、`old-seal-verification.json` |
| 冻结与保护基线 | `audit/frozen-copies.json`、`audit/protection-before.json` |
| 原二进制串行重放 | `results/replay-125624-7a82c6/` |
| 诊断串行重放 | `results/diagnostic-130445-df47a3/` |
| 超时诊断汇总 | `results/timeout-analysis-6c616455/diagnosis.json` |
| 适配器首轮及失败原件 | `results/adapter-130851-fee99b/` |
| 冻结后最终适配器三轮 | `results/adapter-133048-717405/` |
| 同 4 页负对照与适配器对照 | `results/negative-133234-778b8c/`、`small-adapter-133345-e2bd17/` |
| 最终独立复核 | `results/independent-check-da816702/` |

`runner.py` 每次创建唯一结果目录并先记源码哈希；`check.py` 独立重建字节/页/信用/线端；`diagnose.py` 保存旧失败与本轮屏障推进；`seal_new.py` 生成新的不可覆盖封存尝试。不要重跑 prepare/stage 去覆盖既有目录。封存尝试只有完整产生保护、patch、lock、archive、binary、artifacts 和 report 记录后才算完整；未完成尝试不冒充通过。

## 2. 材料勘误：索引确有变化

旧 `seal-57a1040a/artifacts.json` 中 final-index 的 SHA-256：

```text
633cd418133fc8ee90f9fa2ba7a00661cbcb5d8f34839ccd77c23e78e0d42cf4
```

当前 final-index 的 SHA-256：

```text
d6c015553bec5dce3ea84f565baf3d12a2fec7862881e76cb899f3753e3e9248
```

只读复核旧清单中的全部列项，唯一哈希差异为 `final-index.json`，没有缺失项。**不是“索引无变化”。** 将当前 JSON 仅移除 `seal` 字段，以 indent=2、LF、末尾一个换行、无 BOM 序列化，精确得到旧哈希。差异因此被定位为新增：

```json
"seal": "results/seal-57a1040a"
```

其他索引内容，包括 `seal_discovery`，存在于可精确重建的旧版本。重建文件明确是本轮导出的重建件，不冒称找到历史原件；原索引、原 seal、原日志没有覆盖。

时间线（本地 UTC+8，原 JSON 同时保存 UTC）：

| 观测 | 时间/内容关系 |
|---|---|
| `delivery-check-dd07ea80.json` 修改时间 | 12:42:14，记录旧索引哈希 `633c…`，旧报告哈希 `0e0b…` |
| 当前索引及 04g 修改时间 | 12:43:20；索引当前为 `d6c0…`，报告当前为 `fae3…` |
| `delivery-check-d6be07b8.json` 修改时间 | 12:43:32，记录当前两个哈希 |
| seal 的 artifacts.json 创建/修改时间 | 12:43:51.62 / 12:43:52，但其内容仍记录旧索引哈希 |

seal.py 先遍历/计算散列再写 artifacts；以上关系与遍历期间索引追加字段相容。但文件时间不是操作审计，**没有证据确定改写进程、操作者或精确写入调用顺序**，不能声称全过程一致。04g 报告本身也在两份 delivery-check 之间变更；本轮没有找到其旧正文以精确重建，不能将两份报告哈希说成同一内容。旧 artifacts 不封存其父目录的 04g 正文。上述已解释范围与未解释范围均保留。

## 3. 三项最终超时：保留失败，不作默认归因

旧失败原件保持：plain `small-64`、plain `mixed-64`、pages `pause-64`，分别在 04g 最终矩阵中 code=101，stderr 为原定 2 秒 `peer barrier timeout`。旧 stdout 末端可见 codec 已经过本次数据并观测到后续 17B 帧，但旧 CODEC 行位于 dispatch 前，没有单调时间，不能证明 ACK 已写出、已被 peer 读取或在 deadline 前恢复。

先冻结副本并串行运行旧原二进制，对 small/mixed/pause 三种输入各跑 plain/pages，3 轮共 18 次，全部 code=0；没有改源码、帧数或时限。随后另建诊断副本，加入 `host_enqueue -> peer_command -> peer_ping_written -> driver ping_received -> peer_ack_read -> host_ack_resumed` 记录，冻结/离线重建后再串行跑相同 18 次，全部 code=0。测试阶段没有本任务并行测试或构建；机器其他活动并未被控制。

| 记录 | 原二进制串行 | 诊断副本串行 |
|---|---:|---:|
| 网络尝试 | 18 | 18 |
| 最长进程 wall 秒 | 1.996 | 1.316 |
| 10ms 采样 RSS 最大 B | 4,288,512 | 4,308,992 |
| 子进程 user+system CPU 总秒 | 1.621 | 1.532 |
| runner 采样段累计 wall 秒 | 3.451 | 3.746 |
| 新诊断内最长屏障间隔 | 未加时间点 | 654,406 微秒 |

每个原重放 stdout 为 198–375 行，含 171–348 行原探针；诊断增加每例 30 行，其中 driver 记录 5 次 PING，其余为两端推进。原重放所见 loadavg 的 1 分钟项约 2.24–2.51，诊断约 2.13–2.33；完整 CPU ticks/RSS/loadavg/日志增长在 `process-samples.json`。观测段耗时明显不是零，但它包括调度/文件系统等待，**不是观测器 CPU 开销，更不是全部插桩开销**。Tracking 固定表、线性扫描、锁、字符串格式化与 stdout 文件 I/O 保持存在；没有 probe-off 匹配对照，不能从两个不同时段的均值相减得出因果。

原时限未变：屏障 2 秒、async 用例 8 秒、外部 wall 12 秒、CPU 10 秒、地址空间 512MiB、RSS 128MiB 停止、每日志 16MiB。新适配器最终一例进程 wall 达 8.413 秒但 code=0；async deadline 不是硬实时 wall 保证，进程调度/退出与计时边界不同，本轮没有将这例当作稳定时延承诺。外部 wall 保留，没有盲目加时。

**诊断结论：本次重复串行重放未复现旧三项超时，根因仍未关闭。** 未删除用例、未以首轮/单次成功替代旧失败，也未归因于“并行”。如需关闭，需要在冻结版本上捕获失败时完整屏障时间、调度和观测对照；当前仅足以缩小“旧日志不能区分的阶段”。

## 4. 精确栈与新适配器边界

继续使用 http2 0.4.21、hyper2 1.5.5、bytes 1.11.1、http 1.4.1、http-body-util 0.1.3、tokio 1.52.3 等项目精确 lock 版本。http2 `unstable`、hyper2 `client/http2`、宿主默认 `pages` 加 `observed`；Tokio `rt/macros/net/io-util/sync/time`，current-thread。WSL Ubuntu，rustc 1.97.1 / LLVM 22.1.6，`x86_64-unknown-linux-gnu` dev。完整实际 feature tree、metadata、编译日志与 binary SHA 另封存。保留上游 lifetime、旧宿主 unused-mut、WSL 路径/用户 session 诊断及 DrvFS incremental hard-link 回退警告，不视为功能证据。

真实路径为原始明文 H2 loopback peer -> 真实 http2 driver/既有固定页 recv -> 真实 hyper2 `Incoming::poll_frame` -> 新宿主 `Adapter`。沿用旧 `k1_from_recv` 构造入口；**未测试 hyper2 完整建连/dispatcher、wreq、TLS/ALPN、解压、QuickJS/线程桥或设备**。hyper2 body 源码未改；原来在 poll 内 `release_capacity(bytes.len())` 的行为保持，不新增提前归还 flow credit。

新代码在 `adapter/src/lib.rs`。页产生端每次返回一个独占发布的 `Bytes::from_owner(Page)`，payload backing 固定 16384B，无 codec alias。该生产者源码不变量是 poll 前源页额度依据；返回后的长度断言只是核验，**不是用事后检查证明未知源已有上界**。codec 在产生该页之前的源 allocation 仍是未解决的另一子账。

| 阶段 | 责任与实际动作 |
|---|---|
| poll 前 | 每流只容纳一个 source action/余块；全局实验源槽 2，每槽覆盖 1×16384B 页；先取得槽，Pending 保留，不增加第二动作 |
| 无目的额度 | 不开始新 poll，连 EOF 探测也不豁免；已有源余块继续计 U，不重新 poll；返回内部 Blocked，由宿主交付退额后再驱动 |
| poll 返回 | hyper2 可能已归还 flow；Bytes 仍是内部 U，不是 A 或 D；源页 owner 仍真实存在 |
| A 前 | 全局锁内同时取得目的 byte/event/allocation 三维 reservation；再 `Box::new([u8;8])`，再 copy；不足不分配、不复制 |
| 部分转移 | 每次最多 8B，独立目的固定 backing 8B；原 Bytes+offset 保留，完整 16KiB 源 backing 继续计量 |
| 源退休 | 最后余块复制完或取消/drop 时，先 drop 源 Bytes，让 Page::drop 退页，再退 source token；不以部分复制/flow release 退页 |
| 模拟 D | 独立 Box 所有权转到 UserOutput，P/E/A token 退休，backing 转归 J；不是把仍存活的用户 backing 说成已释放 |
| 非 D 丢弃 | 先 drop Box，再退目的 reservation；取消标记本身不借走仍在外部局部变量中的 Delivery 信用 |

实验目的上限 `[16B, 2 events, 16B backing]` 是有限宿主测试参数，不替换 1/4MiB、128/512 或 admission。8B 是 ≤64KiB 的测试 transfer，不是生产配置。跨两流同一锁避免全局超售；没有在此实现生产流级水位、严格低水位、调度公平性、generation 或 C/D 闸门。控制结构/Bytes owner 元数据、allocator overhead 不包括在 payload backing 数内，不能说总内存就是 16B。

源槽满/目的满不阻塞 driver；没有全连接 pause、满池 RST、新错误码、数据拒收、延迟合并、等满页/EOF、窗口缩小或 admission 改动。既有小池 code=73 仍是**实验停止**，不是新增运行政策。

## 5. 池规模与未到达的窗口责任

保持 stream window=6,291,456，connection=15,728,640，页 P=16384；session=1，全部存活/持有流 L=2，含已取消尚持有对象。只创建 A/B 两流，driver drop 后仍核验持有物；没有将 active 归零当作资源退休。

复用 04g 队列条件推导：每流除尾页外全满，队列 q 未退 flow，故每流最多 384 页。两流 Q=min(15MiB,2×6MiB)=12MiB，最坏队列 768 页。适配器每流最多 1 个已发布源页，H≤2，故主实验 cap=770，payload capacity=12,615,680B。这个容量预先为**当前尚未到达但已获窗口授权的 A/B 数据**保留责任，不只按样本已到字节计算。page allocation 懒分配，但 cap 不等于仅承诺已分配页。

770 是由本实验 session/L/queue+held 推导，不是把旧 4 页失败扩大后宣称修复。也不是声称已实际灌满 12MiB：运行输入仍有限，全部 111 次尝试最大双向 H2 2044B、86 帧（含 preface/control，不含 TCP/IP）。完整窗口可履行性在此是**条件化页槽推导**，没有完成实际完整窗口、allocator/OOM、codec/metadata 或多 session 总预算证明。

另外同一 4 页配置保留负向对照，并执行适配器机制对照。4 页仅验证有限失败机制及其所有权差别，**不覆盖完整 6/15MiB 窗口**。实际页高水位、free、codec 并集在独立 checks 中逐次记录，不能将 cap×P 说成每次实占或 RSS。

## 6. 验收覆盖与失败保留

| 覆盖 | 最终 770 页三轮结果与证据 |
|---|---|
| 部分页及时交付 | partial：先注册 Pending；第一个 1B 返回/模拟 D 时后续尚未发送、EOF 尚未发送 |
| 连续小片段 | continuous/held：16 轮 1B，逐片交付并始终保留旧独立输出；每次网络 held=0，源页可复用 |
| 用户持续持有 | driver 销毁后仍核对 A/B 旧值；有效 Pool=0，输出仍可读；不是 QuickJS 验证 |
| 目的满额 | budget：两个未 D 输出占 `[16,2,16]`；两次 Blocked 不增加 poll；A 余块9B仍占源页，新到2B在网络队列计量；D 退额后完整得到27B |
| 源余块与 EOF | eof：25B 分成8/8/8/1，前缀不等EOF，最后源引用释放才退页，随后正常 EOF |
| cancel/迟到收尾 | cancel/sibling-cancel：A source=25B，复制8B未D；取消后目的 `[8,1,8]`仍有效，实际drop才退；17B源退休；迟到`late`不交付，B继续 |
| 错误 | error：远端 RST(INTERNAL_ERROR=2) 到真实 hyper2 Err；已有源余块按 body 消费顺序结束，源token退休 |
| reset映射 | reset-eof：RST(CANCEL=8) 按原 hyper2 返回 EOF，不擅改库映射 |
| A暂停/取消时B在途 | B先交付prefix；A暂停持余块或取消后，B suffix继续并完整15B，不依赖销毁连接推进 |

最终10类×3轮=30/30 code0，独立字节与守恒通过。4页适配器5类×3轮=15/15 code0；4页任意消费者原页保留3轮均在第五个已授权1B处 code73，已有4个页仍held，used_after_poll=0。该负对照证明保留路径仍在；同样的小池下适配器不再因为用户每持有1B就累积一个网络页。**这不证明用户 J 总内存有界。**

新增失败原件不覆盖：目的三维前置预算单测先失败 code101，实现后相同断言通过；首次27次适配器尝试中3个 error 用例 code101，是误以为 hyper2 对 CANCEL 返回 Err，源码确认原映射后保留这3例，新增 reset-eof 对照并以 INTERNAL_ERROR 覆盖 error。没有为通过而改库/删除错误路径。首次其余24次通过也保留。

网络尝试汇总111次：105次code0、3次错误预期失败code101、3次预期满池停止code73；不包括单元测试与构建。不是“111例功能全通过”。最终完整独立检查保留所有失败，非零尝试只核对可得前缀/未退休对象，不冒称已正常清理。

## 7. 独立守恒、分账和线端

check.py 不复用宿主 expected 数组，从 WIRE_TX 解帧，并另按 case 生成字节，与最终交付/SHA-256比较；逐 reservation/copy/D/retire 重建目的账，从 source_received/remainder/retire 重建 U。每流核对：

```text
source_received = copied_A + source_discard + source_remaining
copied_A = delivered_D + destination_discard + destination_live
page_live = page_queued + page_held
page_allocated = page_live + page_free <= cap
```

成功收尾 remaining/live 均为0；页最后引用的 retire 先于 source token retire。核对每次 flow release 不超过 stream/connection in-flight，累计 release 与真实 hyper source_received 一致；源余块尚未转移时，flow 已可能归还，这部分差额明确保留在 U/H，不偷偷抵销。取消A的25B=8B复制后丢弃+17B源丢弃，B的15B完整D；迟到4B属于reset流协议收尾，不进入新适配器D账。

复制时可见 source allocation=16384B、目的 allocation=8B，id不同；单对最大重叠16392B。两者共存明确保留，不是整进程峰值。队列页、held源页、free页、Slab容量、codec曾见仍活allocation并集均分项保存。codec并集可能包含共享来源，不能再与同一来源DATA并集相加；其指针/历史追踪仍有04g记载的盲区，不能充当codec完整源界。D后每个用户输出仍持有8B payload backing，另有handle/容器，归J，不钉住网络Pool。

18个plain/pages成功重放配对线端顺序相同；4页适配器与770页相同case的90个有限配对比较顺序、多重集相同（含首次成功样本）。保留 SETTINGS hex `000100010000000200000000000400600000000600040000`、初始 connection WINDOW_UPDATE `00ef0001`；没有缩窗口。负向对照在第五字节停止，与正常适配器后续控制/交付当然不同，不要求或伪称相等。

以上输入未跨后续 WINDOW_UPDATE 阈值，**没有证明不同 poll/release 粒度在跨阈值时的窗口更新时序等价**；没有 TLS、ALPN、Chrome136 完整指纹、packet分段/时间等价证明。三项旧失败对应的旧线端差异仍保留，不用本轮成功覆盖。

## 8. 未决限制与手动验收结论

建议本轮只验收以下局部材料：索引差异已经精确定位且追加勘误；旧三项超时的冻结串行复核有记录但不关闭；在真实 hyper2 body 分支与固定页生产者条件下，受限独立复制解除 D 后用户数据对网络页的持有，并保持有限输入字节、前置目的信用及源退休顺序。

仍未解决：

1. codec/read-ahead/扩容/共享控制块的完整源上界，以及源帧到固定页复制前的 U；此适配器只约束 body 返回页，不证明 socket/TLS/decoder 前置额度。
2. 生产 N_session/N_live/N_retiring、headers/trailers/Slab/metadata、OOM及池满政策；L=2是实验事实，不是新的admission限制。
3. 完整窗口压力、多session、多线程、长期轮换、flow-update阈值、padding/更多协议排列及公正调度；有条件公式不等于这些动态实证。
4. Transport流/全局水位、低水位、generation/epoch、取消先C、最终D闸门、唯一终态及控制推进。尤其远端reset在适配器持有余块时只在下次body poll可见；本原型不将该可见时点冒称Transport C，未验证C后投递抑制。
5. 真实QuickJS/ABI所有权、用户J与request聚合/bridge复制、wreq完整feature、K2–K5和设备证据；旧strict FAIL及02d/G1门槛均不改判。

没有发现本次有限实验必须改变未批准行为才可运行的冲突，因此未使用缩窗口、增加旧小池去改判、满池RST、丢正常数据、admission修改或提前退flow/page credit。若将来声称生产可用必须靠上述任一行为，应先提交具体容量/生命周期冲突并停止，而不是由本报告追认。

**最终结论：待总工程师验收。完整K1未关闭，库内预算未通过，r3未发布，1C与G1继续阻断。**

## 9. 封存交付补记

首个完整封存 `E/results/seal-5919ebff/` 核验 6,984 个保护文件哈希未变，冻结副本及三组旧二进制匹配；diagnostic plain/pages 各27包、adapter 36包与项目lock精确版本匹配。patch仅包含新副本配置、诊断时间点、适配器宿主和实验页cap可选值；hyper2源码、recv聚合/flow逻辑零新增语义修改。最终主样本 live页高水位：连续/持有/partial为1，余块/取消/B推进为2，目的满额加新队列为3；这些样本量不是770页窗口压力验证。

保留两个未完成封存尝试：`seal-2c787458` 在WSL `p9_client_rpc` 等待约五分钟后停止；`seal-c6df41d0` 在Windows默认GBK读取UTF-8上游文本时失败。改用Windows `python -X utf8` 在新目录成功，未修改历史材料或加大协议测试时限。这些失败与旧三项网络超时无因果结论。原始工具异常的文字转录及进程观察在 `E/audit/*seal*.md`，不是冒称自动捕获的原始stderr文件。

本补记晚于首个完整seal的report哈希；首个seal仍只代表其当时的报告修订。交付前另建完整seal及只写一次的delivery记录，重新核对最终报告和所有封存列项。**不回写旧索引，不向已封存索引事后添加seal字段，不覆盖任何旧seal。** 最终定位以E中新建的 `delivery-*.json` 为准，其中明确关联最终报告SHA、完整seal目录和该清单SHA。
