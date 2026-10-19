# 路线 C K1：固定页聚合与 backing 信用隔离原型

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收聚合原型。** 本轮验证了按流固定页聚合的局部收益，也取得了小池与立即交付/消费者保留之间的有限反例。**K1 整体未关闭，不接生产，不发布 r3，不解封 1C，不放行 G1。** 现行规范仍为 02d；02f 仍是草案，R3-C/U 生产数值与满额政策未批准。

## 1. 范围、来源与复核入口

独立证据根，下文 E：`docs/astra/evidence/h2-k1-pages-20261003-52c9e1/`。仅新增 E 与本报告；04e/02f/04f、02d、精确来源、04f 三组对照及 `semantic.patch` 已读取，旧原型、旧缓存、业务与契约均不写入。没有子 Agent、创建/联系会话、设备操作、Git 提交或暂存。结果由用户手动转交。

| 材料 | 本轮用途与隔离方式 |
|---|---|
| http2 0.4.21 | `.crate` SHA-256 `a6e23815f8ec982e1452e1d0fda921ec20a9187fb610ad003c90cc5abd65b2c4`；保持项目 lock 精确版本；`reference/pristine`、`reference/baseline`、`reference/patched` 复制04f三组源码，作为只读参考 |
| 新 plain 组 | 以04f patched为基线，即**已含空 DATA 补丁但不聚合**；新增相同 codec/backing 与 flow-release 观测 |
| 新 pages 组 | 相同基线与观测，加 `k1pages.rs`、队尾访问、接收聚合与 pop 发布；`empty-semantic.patch` 单独保留原8行补丁 |
| 新 hyper 组 | 精确 hyper2 1.5.5、相同 pages/http2；仅增加实验构造入口及 `ping::disabled` 的 crate 内可见性，运行原始 `Incoming::poll_frame` 分支 |
| 依赖 | bytes 1.11.1、tokio 1.52.3、tokio-util 0.7.18、slab 0.4.12；hyper 新增依赖也逐项对项目 lock，不升级；材料均来自旧证据副本或精确本地缓存，没有下载 |
| 构建 | 三组各自 manifest、lock、target；仅 E 内共享 vendor/cargo-home；`--offline`，显式 `x86_64-unknown-linux-gnu`，不继承业务 ARM64 target，不改全局 Cargo 配置 |
| features/环境 | http2 unstable；宿主 Tokio rt/macros/net/io-util/sync/time，current-thread；hyper2 client/http2。实际 tree/metadata/rustc 输出在各组 `*-metadata-*`。不是目标 wreq 完整 feature 闭包 |

**证据层级**：plain/pages 是原始 H2 对端加真实 http2 client driver 的明文 TCP 回环；hyper 是将真实 http2 `RecvStream` 放入精确 hyper2 `Incoming` 的**body 边界宿主**。后者实际执行 hyper2 poll/release，不是仿写分支，但**没有测试 hyper2 建连/完整 dispatcher、wreq、TLS/ALPN、解压、JS 或设备**。

复核入口：`run.py` 为每次运行创建唯一目录；`analyze.py` 独立校验输入/交付与线端差异；`extra_checks.py` 复核满额/真实 hyper 分支；`ledger_check.py` 复核页生命周期、复制与有限线端计数；`seal.py` 核对旧输入、精确 archive、版本、三份参考源码及差分。最新运行索引见 E 的 `final-index.json`，原始 stdout/stderr/command/source-hashes 都在各次 `results/` 下。不要重跑准备脚本覆盖材料。

## 2. 实验参数与停止条件

页大小固定 **16384 B**，仅是本原型参数。每进程明确 `K1_SESSIONS=1`、`K1_LIVE_STREAMS=2`，只创建 A/B 两条流；有效持有计数包括取消后仍存活的 body、页别名和退役 session，不以 active 归零冒充全资源退休。主矩阵页信用为8，另测1、2、4；未验证多 session 或更多流，未新增公共限制。

- 保持 stream window=6,291,456、connection window=15,728,640、header table=65,536、header list=262,144、push=false、默认 max frame=16,384，以及04f使用的 SETTINGS/pseudo/header-priority 顺序。没有缩窗口、满池 RST、禁 H2、丢字节或改变 admission。
- 测试 n 硬限128；批输入≤65,536 B、普通主段 payload≤34,816 B；边界例为16383+2+16384 B。跨 backing 为4个1B DATA，各后接8192B有限未知扩展帧。另有固定 headers/B/EOF/reset/PING 控制，不把 payload 限额写成线端总量。
- 每次发送以 PING ACK 确认 driver 经过此前帧；屏障2秒，用例8秒，外部 wall12秒，CPU10秒，地址空间512MiB，10ms采样 RSS 超128MiB停止，单日志文件16MiB硬限；编译单独300秒，不对编译器套测试内存限。
- 有限序列的总帧/字节另由 `ledger_check.py` 重建，预设复核上限512帧、131072 B。此次最大150帧、33224 B双向H2字节（含preface，不含TCP/IP），不是网络吞吐阈值。错误收尾可能未读完对端GOAWAY，非零退出包含已尝试发送但未确认处理的输入。
- **池满时 code=73 是实验进程停止，不是候选库运行政策。** stderr 明确输出 `source_already_acquired`、source allocation、queued/held/cap。不继续处理 B、不宣称正常取消清理、不把已取得数据重新命名为拒收。此结果只能判容量冲突，不能判满足正常输入/兄弟流推进。

## 3. 原型实现与所有权

接收修改仍在04f既有校验、connection/stream flow accounting、content-length、END_STREAM状态变更及 in-flight 记账**之后**。空事件补丁不动。非空 payload 只向本流队尾 `Event::Data(Page)` 追加，填满后取得下一页；不得追加到另一流或已发布页。没有计时器、延时批处理或等EOF发布条件。

`poll_data` 取出一个 Page 即调用 `publish()`，按当前有效长度构造 `Bytes::from_owner(Page)`，包括1B部分页。普通 DATA 的必要 `notify_recv` 仍调用；部分页测试先注册 Pending，后发第一个1B，消费者已返回时后续数据尚未发送、EOF也尚未发送。

| 边界 | owner / 信用动作 |
|---|---|
| acquire | 在 session Pool 的锁内先检查 `live < cap`，递增 live/queued 后才复用空闲块或申请固定16384B目的块；复制不能先于这一点 |
| 队列 | Page 唯一持有目的 `Box<[u8]>`、有效长度、流/id、Pool引用；**无原始 Bytes、source owner 或 codec 引用字段**；每流仅队尾可变 |
| publish | queued减1、held加1，live不变；owner交给 Bytes 的引用计数；返回后不再修改已发布页 |
| 最后别名drop | Page::drop 恰一次将块归还空闲池，held/live减1；clone、slice、取消、driver销毁均不提前退休仍活着的 owner |
| 队列取消/清理 | 未publish的Page drop令queued/live减1；保留既有 http2 flow清理，不凭页drop调用release_capacity |
| pool退休 | Recv与全部Page owner不再强持有时释放；活页为0而Recv仍存活时，free/capacity可保持；driver已销毁而别名仍活着时，Pool也继续存活 |

逐事件检查：`live=queued+held`、`allocated=live+free<=cap`、目的块申请大小=16384、reserve早于每次copy、publish前累计copy等于发布长度、retire不重复。Page自身、Bytes owner控制块、Pool/Arc、free指针数组和观测表**不是这16384B的一部分**。每个已发布页有独立owner控制对象；Bytes克隆不新建页，用户存储这些句柄的空间不纳入页payload公式。

目的页 payload backing 的条件硬界是 `cap*16384`（8页=131072B），并非整个进程/库的硬界。元数据存在另外的有界结构和分配，具体布局不承诺跨target相同；OOM也不是已批准异常政策。

## 4. 对照、字节与语义

主对照保留相同21例：空非END/空END/非空END、128×1B、64×17B、空/1B交错、跨backing、跨页边界、首片及时交付、直接消费保留、主动release后保留、6轮复用、A暂停、A取消、取消仍持有、remote reset、EOF后reset、content-length不足/超出、closed/idle流非法DATA。

首轮plain/pages均21/21进程code0，独立字节校验通过。源码冻结后的最终复跑plain为19/21、pages为20/21：plain small-64/mixed-64与pages pause-64触发原定2秒peer barrier timeout，code101；其余成功例独立校验通过，失败例标INCOMPLETE_NONZERO而不是PASS。两组矩阵并行运行可能引入调度/观测竞争，但本轮没有证明超时根因，不把它归罪于库或直接豁免。保留首轮成功与复跑失败，不扩大时限；**不宣称全部用例在当前资源条件下稳定通过**。

独立 Python 从 `WIRE_TX` 解帧，再按case自行生成预期字节，与早期交付及最终交付的长度/SHA-256核对；正常B必须得到 `B-prefix-suffix` 15B。取消/错误用例独立核对其允许前缀/错误，不把取消数据未交付算作完整成功。原始RST/EOF差异留在输出中。

| 代表用例 | 未聚合 plain | 聚合 pages |
|---|---:|---:|
| 128×1B，A暂停后恢复 | A 128个事件；Slab高水位256槽 | A 1个128B事件；Slab高水位4槽 |
| 64×17B | A 64事件；Slab128槽 | A 1个1088B事件；Slab4槽 |
| 空/1B交错64帧 | A 32事件；Slab64槽 | A 1个32B事件；Slab4槽 |
| 4×1B跨backing | A 4事件；Slab8槽 | A 1事件；Slab4槽 |
| 16383+2+16384 B | A 3事件，保持原帧块长 | A 3页，长度16384、16384、1，顺序/字节一致 |
| 首个1B立即poll | 后续尚未发时返回 | 同样返回，queued=0、held=1，不等满页/EOF |
| 6轮1B即取即drop | 完整交付 | 1页池完成，allocated始终1，free复用，不逐轮增长 |

必要唤醒、非空EOF、空END均保留；空END仍无body空事件。content-length两例仍PROTOCOL_ERROR；closed流仍RST(STREAM_CLOSED)，idle流仍connection错误。已测remote reset在已有R字节后返回CANCEL；EOF后reset则正常EOF，两组一致。取消A时B已经收到prefix但未EOF，A清理后B suffix继续到达，未暂停整连接。

竞态证据是current-thread调度下的确定顺序与引用生命周期，不是多线程全部交错证明，也不是Transport C/D规则的验证。padding、超大帧、更多错误排列、长期新流/多session轮换尚未覆盖；不得用这些21例关闭整个协议回归义务。

## 5. 内存分账：收益与反例

观测 allocator 申请大小与唯一allocation id，不是 malloc usable size或RSS。原04f Tracking 表32768×24B，DATA历史id表4096×8B，本轮另增codec历史id表4096×8B；观测成本不当作目标库预算。`CODEC_BACKING` 是本轮codec经过的allocation集合中仍活着的去重并集，可能同时被queue/consumer/codec引用，**不能与DATA源统计直接相加**。read指针落在allocation尾端时可能查不到当前块；没有声称穷尽所有codec瞬时扩容。

以下取第一轮相同主矩阵的A暂停点，只比较明确观测分项；最终复跑保留独立原件，数值不覆盖旧样本：

| 样本 | plain | pages | 判断 |
|---|---|---|---|
| 128×1B | DATA源并集8192B；暂停时Slab容量128=30720B | codec/源活并集8192B；目的页16384B；Slab4=960B | 此时这些可观测分项38912→25536B，改善；后续plain Slab还涨至256，而pages保留空闲页，不能拿不同时间峰值混比 |
| 4个跨backing 1B | DATA源4块32768B；codec历史活并集5块40960B；Slab4=960B | 目的页16384B；codec历史活并集1块16384B；Slab4=960B | 并集+目的页+Slab为41920→33728B；页不再钉住前三块source，但codec自己仍可持有最后块 |
| 边界32769B | codec历史活并集49224B；Slab4=960B | 3页49152B+codec8192B+Slab960B | 50184→58304B，部分尾页导致**变大** |
| 逐次取4个1B且保留 | 源/codec共享活块8192B，Slab4=960B | 4个held页65536B+codec8192B+Slab960B | 9152→74688B，**显著变大**；这不是队列页公式能覆盖的收益 |

这些和数均排除Bytes控制块、Pool/Arc/free指针数组、其他协议对象及allocator overhead，不是整库峰值。第一轮42个主对照进程10ms采样RSS最大4,472,832B，最长3.572秒，仅为观测；不得当生产内存/性能保证。

每次COPY保存source id/capacity、destination id/capacity及两者并存。第一轮最大单对重叠32831B（16447B源+16384B目的），1B常见24576B；**不是整个复制时全进程或全页池峰值**。其他排队页、空闲页、codec当前块还同时存在。源+目的不能因逻辑字节相同只算一份。

通常清空live=0后仍有free页，例如128×1B例留下2页32768B，边界例留下4页65536B；共享Slab live=0也仍有4槽960B容量。有限复用证实复用，不证明全历史Slab有同样高水位。Slab同时存headers/trailers，数据页cap不自动成为整个Slab cap。

## 6. flow credit 与目的页信用不是同一边界

聚合copy/pop/drop没有新增 `release_capacity`。原接收路径仍按payload累计in-flight。

| 消费方式 | 实际验证 |
|---|---|
| http2直接poll，不release | 4次1B分别poll时，used_capacity从1、2、3、4累积；每次pop前后相同。测试最后才显式release 4B，页仍held |
| http2直接poll，宿主每次显式release | 每次used回到0，4个held页仍live；仅作为直接消费控制，不冒称hyper |
| 精确hyper2 `Incoming::poll_frame` | 原始分支内部调用 `release_capacity(bytes.len())`，返回时used=0；宿主未代为release A。4个1B Bytes仍持有4页；A reset/drop后仍可读取原值，最后drop才退页 |
| hyper2即取即drop | 1页池6轮完成，证明页可复用；不证明无限保留也能完成 |

**真实页信用边界是验证后的recv路径中“目的页取得/分配前”，不是socket/TLS/codec读取之前，也不是02f的Transport A。** 源帧与codec read-ahead在此之前已分配/取得。本轮隔离了页对source backing的生命周期依赖并记录重叠，**没有实现源backing的预取得信用或其完整硬界**。此缺口不能被code73或分配后检查消除。

## 7. 满额、窗口承诺与容量推导

### 7.1 有限满额证据

| 实验 | 结果与含义 |
|---|---|
| 2页，A暂停64B，B继续prefix/suffix | PASS；A/B各一页，达到live=cap时B仍可追加自己的未满页，B EOF与A恢复完整。不需要全连接pause |
| 2页，A取消时B已在途 | PASS；A的queued页退休、B继续；不是依靠销毁session |
| 1页，A暂停64B后B prefix | **code73**；B的8B已被codec/recv取得，source backing8192B，而池内已有A的一页。无目的页可承接，不宣称B隔离通过 |
| 4页，直接消费并持有，n=5 | **code73**；前4个1B已发布占4页，第5个1B仍在6MiB窗口授权内，源已取得；未归还flow也不能保证4页够用 |
| 4页，真实hyper2消费并持有，n=5 | **code73**；前4次used已回0且held=4，第5个1B无法取得目的页。正常窗口与保留行为的冲突，不是非法输入 |
| 取消但保留clone/slice | 最后一份别名保留页与Pool；不能以取消、live operation减少或driver销毁来借走此信用 |

满额时能否继续取决于具体空间：若当前流仍有可追加的队尾则可copy；若需要新页而没有信用，原型只能停止实验。EOF/空DATA不需要页；取消可退**库内**页，但不能强制退休外部持有页。没有新增满池等待，因为在A DATA占据TCP前缀时停止读连接会连B一起堵住，不能冒充兄弟流隔离。

### 7.2 仅库内队列的可证明界

令P=16384，q_i为库内排队且未释放flow的payload，L为所有非空排队流数，H为已经pop但尚有owner/别名的页数；固定窗口Ws=6291456，Wc=15728640。前提是无adaptive/custom窗口调整，调用者不为尚未pop的排队内容提前release。每个库内队列除了唯一尾页外均满，因此：

```text
N_queue_i = ceil(q_i/P)
sum(q_i) <= Q = min(Wc, L*Ws)
N_queue <= min(L*384, floor((Q + L*(P-1))/P))   [L>0]
N_live_pages = N_queue + H
allocated_pages = N_live_pages + free_pages <= experimental_cap
```

第一式只针对队列。某页pop后立即退出该式，不能把它的稀疏洞带入“除尾页全满”的假设。

- 一个流、不保留已pop页，要覆盖整个6MiB排队窗口至少384页。两流同session、均可填6MiB，至少768页=12MiB目的payload；本轮1/2/4/8页从未具备这个保证。
- 三条及更多流受15MiB connection约束；L=3时最坏部分尾页分布可达962页=15,761,408B，而不是简单960页。额外页由各流稀疏尾产生，stream上限与connection上限不能重复相加。
- 在H个既有持有页之外，维持正常窗口承诺的保守池容量须至少 `H_max + max N_queue`，并另覆盖codec源/复制重叠/元数据。若A已用384页且B有6MiB仍获授权，需为B保留384页规模；一个“兄弟流应急页”只足够此次15B，不够整个窗口。
- 这是该封页算法的条件必要/充分payload槽推导，不是批准池规模，也不是整个栈物理预算。实际不能只计算已排队字节：仍未到达但窗口已授权的数据也必须有可履行的责任额度。

### 7.3 立即部分页交付造成的持有界冲突

即使http2直接消费**一直不release**，消费者也可逐次收1B并保留。一个6MiB窗口允许6,291,456个非空发布页，即本算法仅页payload就可达**96GiB**；两流完整12MiB可达192GiB，15MiB session可达240GiB。这是条件最坏构造，不是本轮灌入测试或建议配置。可见“流数小”不意味着外部持有页只有每流一个。

hyper2每次poll即release后，窗口不再限制H的跨轮累计：对任意有限cap，消费者保留cap个立即发布的小页，下一次正常字节就可能满额。数据量/寿命无另一个已批准上界时，**不存在只由6/15MiB窗口和固定session/stream数导出的有限H上界**。

本原型没有修改这个事实：没有等满页、延迟小片段、提前退页、改release、让已交付值失效或隐藏保留原始大Bytes。若改为向受限的独立consumer backing复制后释放页，必须先批准/证明该backing预算及复制重叠；不是把持有成本从报表删掉。支持不可变前缀与可变尾同时共享页则是另一种需要内存安全及并发证明的设计，本轮没有以unsafe实现偷偷引入。

## 8. 线端差分、失败与保护

第一轮21例主对照：逐帧 `WIRE_RX` 顺序与多重集均相同，包括SETTINGS、初始WINDOW_UPDATE、PING ACK、RST；输入/交付独立校验通过。聚合改变了DATA交付边界及release调用粒度，有限输入低于窗口更新阈值，**未测试因累计release跨阈值导致的后续WINDOW_UPDATE时序/分组**。不据profile字段未变宣称Chrome136指纹完全等价；没有TLS指纹证据。

最终复跑另有三项线端序列/多重集及交付不相等，恰为上述small/mixed/pause超时中断例；差异完整保留在最终`comparison.json`，不能删除后只给“全部相同”。剩余18个双侧成功例在该次记录中相等。汇总ledger覆盖94个测试尝试，逐页reserve/copy/publish/retire与有限帧计数校验通过；这包括对非零尝试未退休页的保留记录，**不是94个功能测试全通过**。

保留的非零原件：

1. `plain-test-122108-4699b0/one-128`：TDD负对照assert 128==1失败，code101；随后pages同断言code0。不是覆盖成PASS。
2. `hyper-build-122715-1ade97`：新增vendor清单误把清单自身纳入哈希，code101；只修新目录生成清单，修复前后哈希在`checksum-repair.json`，原archive未变。之后精确版本离线构建成功。
3. `pages-test-122912-ce4e26/pause-64`：1页不足承接B，code73。
4. `pages-test-122912-b24f0c/hold-direct-5`：4页不足承接第5个已授权字节，code73。
5. `hyper-test-123158-da3948/hyper-hold-5`：真实poll已release但页仍满，code73。
6. `plain-matrix-123652-947afe/small-64`、同目录`mixed-64`及`pages-matrix-123652-0cfc37/pause-64`：最终复跑的2秒屏障超时，code101，进程时间分别约3.03、5.89、4.31秒，保留全部日志。没有以较早成功覆盖这些失败。

此次没有用增加时限掩盖超时；04f的2048/512超时、旧strict FAIL等保持原样。初次plain构建期间宿主文件曾继续编辑，产生feature诊断及“构建前哈希与实际读入时点”局限；它只用于早期负对照，不作最终可复现二进制封存。后续源码冻结后重新构建，两组最终重跑另目录保留。最终cancel-held在两组均通过；pages记录driver已销毁时held=1、free=1，最后clone/slice drop后有效Pool数由1变0。所有上游lifetime、incremental hard-link回退和WSL启动诊断未当作功能通过或失败消除。

`protection-before.json`及最新seal的`protection-after.json`只核验相关既有输入；archive-source-check按精确archive逐文件核验新vendor，lock-check拒绝版本漂移；three-reference-check核验04f三副本；源码diff与二进制SHA可手动审阅。保护通过只说明范围/来源一致，不证明K1或生产预算通过。

本轮末次核验 `results/seal-57a1040a/`：3363个限定旧输入哈希未变，plain/pages各27包、hyper36包的lock版本匹配项目锁定；三参考副本全部MATCH，hyper/http2与pages/http2源码零差异。94个测试进程为87次code0、3次code73、4次code101（1次预期负对照与3次屏障超时）；全部尝试10ms采样RSS最大4,546,560B、进程时间最大5.888秒。此汇总不含编译失败，也不是94例功能通过。

## 9. 验收回答与下一决策

**聚合真的改善持有内存吗？** 对暂停小帧积压与跨backing样本，有真实减少Slab和源引用的证据；对边界尾页、持续取小块并长期保留，反而可能增加。空闲池保留也不能算释放归零。不能给“所有持有Bytes都省内存”的结论。

**哪些有证明？** 页目的payload容量、owner恰次退休、不提前release、仅库内队列的页数公式有源码不变量及有限ledger支持。codec backing完整上界、完整Slab/headers总额、所有target元数据/allocator、全部并发竞态及全栈内存尚未证明；采样峰值不是证明。

**信用在哪里生效？** 只在真实http2 recv中的目的页分配/复制前，已取得的source另计。它既不是源预取得信用，也不是Transport A；真实hyper2 release边界已单独验证，不能再拿窗口覆盖release后长期持有。

**满额与及时交付冲突吗？** 在本算法、小池、持续保留条件下冲突已被有限例确认。窗口已授权字节不因pool满而变成未取得；整连接pause不能保证B隔离。保留窗口与接收语义，需要窗口承诺的保留额度，加有界外部持有或独立backing转移责任。

**能否推进集成？** 可把本轮作为局部候选及反例验收；**不建议直接进入完整hyper2/wreq生产集成验证并预期通过预算**。下一最小审批应明确：已发布/退役持有物的有界责任与退休点；是否允许受限consumer-copy及其独立backing预算；为仍授权窗口和兄弟流保留的额度；满额时不破坏正常字节与隔离的可实施规则。涉及release/admission/新拒绝/延时等行为必须分别审批，不能默认批准。源codec上界与K2–K5、02d §6、原strict失败和设备门继续保留。

**最终结论：待总工程师验收聚合原型。K1整体未关闭。**
