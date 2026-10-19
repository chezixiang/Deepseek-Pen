# 路线 C K1：组合验证与收口判定

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收组合证据并裁定K1状态。** 本轮完成同一冻结隔离构建中的空 DATA 消除、页聚合、受限 Adapter 和 bounded codec 组合验证，补到一次真实后续流级 WINDOW_UPDATE。建议关闭下表限定的机制验证子项，**不建议关闭完整 K1**。现行规范仍为 02d，02f 仍草案；r3、1C、G1 均未放行，不宣布生产预算通过。

## 1. 交付范围与组合基线

独立证据根，下文 E：`docs/astra/evidence/h2-k1-composed-20261003-f3a842/`。只新增本报告及 E，未改已有实现、旧原型、契约、历史证据、缓存、业务或全局 Cargo 配置；未使用子 Agent、创建/联系会话、提交/暂存 Git或操作设备。手动转交结果。

| 输入 | 本轮核验与依赖关系 |
|---|---|
| 04g | 核对两份 delivery-check，最终报告 SHA=`fae34a17…823b`、当前 final-index=`d6c01555…9248`；seal 中旧 index=`633cd418…cf4` 的差异继续保留。移除当前 index 的 seal 字段可精确重建旧哈希，不改旧索引 |
| 04h | `delivery-112f1983.json` → `seal-bf199193`，最终报告 SHA=`3ef2f0cb…e91b`；3072 项相关源码/依赖与 seal 匹配 |
| 04i | `delivery-1ce7c566.json` → `seal-76d984b5`，最终报告 SHA=`4406593c…f32`；3008 项相关源码/依赖与 seal 匹配 |
| 空 DATA/页聚合 | 04g `empty-semantic.patch` 及 pages.patch 继承到 04h diagnostic/pages；当前 recv 的校验、flow、END_STREAM 转移之后才跳过零 payload，非空仍同步复制到页 |
| 04i 真正基线 | **04h diagnostic/pages，不是 Adapter。** 04i before/http2 比 diagnostic/pages/http2 仅多改 `src/k1probe.rs` 源取得/退休观测；其 before→after 语义差分恰四个 codec/HPACK 文件 |
| 新组合 | 04h adapter 宿主/精确 hyper2 + 04i after/http2，经新 manifest 的 path 与 `[patch.crates-io]` 接到**同一份 `codec-http2`**；未把两个报告的结果相加冒充组合 |

`audit/deliveries.json`、`audit/baseline-71a59ac6/checks.json`、`audit/chain-d6e01270/checks.json`保存核验与差分。保护清单覆盖3272项相关输入，不扫描无关业务树。初始化曾误要求 before 与 diagnostic 逐字相同，因上述观测器差异退出1；已保留 `audit/preparation-failure.md`，未重跑覆盖输出。

依赖精确为 http2 0.4.21、hyper2 1.5.5、bytes 1.11.1、http 1.4.1、tokio 1.52.3、tokio-util 0.7.18、slab 0.4.12、http-body-util 0.1.3、futures-core 0.3.32。35个依赖包加宿主，均对当前项目 lock 的版本/checksum；增加直接 futures-core 只是调用既有 Stream trait。完全离线，无下载、升级或旧缓存写入。

WSL Ubuntu，rustc 1.97.1 `(8bab26f4f68e0e26f0bb7960be334d5b520ea452)`，LLVM22.1.6，x86_64-unknown-linux-gnu dev；http2 unstable、hyper2 client/http2、Tokio current-thread，完整 feature tree/metadata 已封存。E 内 manifest/lock/vendor/cargo-home/target，构建与测试串行。保留上游 lifetime、unused-mut、DrvFS hard-link 回退和 WSL 启动诊断。

**实际层级**：真实 TCP 明文 H2 peer → http2 客户端握手/driver → bounded codec → 固定页 → hyper2 原 `Incoming::poll_frame` → Adapter。沿用 `k1_from_recv` 实验入口，**没有运行 hyper2 完整 handshake/dispatcher、wreq、TLS、解压、QuickJS/ABI或设备**；hyper2 建连配置传递和运行期 setter 是本轮精确源码核查，不冒称其完整运行证据。

## 2. F/H 生命周期核查与停止依赖边界

以下源码均指 E/codec-http2 或 E/composed/hyper2，与最终封存补丁关联。

| 生命周期位置 | 核验结果 |
|---|---|
| `codec/mod.rs::with_max_recv_frame_size` | LengthDelimited builder 暂有默认 F=8388608，FramedRead 暂有 H=16777216；构造内先 setter F=16384，**BoundedRead 尚未 poll、尚未申请 frame/Partial**，不能把构造中默认值遗漏，也不能说该时刻已经按大值申请 |
| `client.rs::handshake2` 约1371行 | 创建 codec 后，在发送初始 SETTINGS、交还 driver 之前显式设置 builder 的 H=262144；本宿主没有额外 max-frame 配置，F 保持16384。实际日志顺序为 F 8388608→16384、H 16777216→262144，然后首个 `BOUND_ALLOC capacity=16393` |
| 初始 SETTINGS ACK | `proto/settings.rs::recv_settings` 只将本地 WaitingAck 配置应用到接收 F/H；本 profile 不携带 MAX_FRAME_SIZE，H=262144→262144。实际 ACK 日志证实无 Partial 时重复同值 |
| 对端普通 SETTINGS | `poll_send` 中对端 max-frame 改 `set_max_send_frame_size`，不是接收 F；对端 header-table 改发送表，不改变接收 H。不得把方向混淆 |
| http2 Connection 公开运行期 API | client 的 `set_target_window_size`、`set_initial_window_size` 改 flow/window，不改 F/H；本实验未调用它们改变窗口 |
| hyper2 配置链 | `proto/h2/client.rs::new_builder` 将显式 max-frame/header-list传入 http2 builder；运行期 BDP 分支只调两个 window setter。默认 adaptive=false；默认 header-list=None，**默认 hyper2 不可继承 H=262144 的数值证明** |
| Codec 公开 setter | `set_max_recv_frame_size`/`set_max_recv_header_list_size` 可由外部直接调用，且 F 文档允许下一帧生效；不是不可变 API。固定配置子界不适用于任意直接 Codec 调用者 |

最终所有小额回环实际读取期间 F=16384、H=262144；未改 Chrome136 SETTINGS 或 flow window。不能推广为任意 hyper2 默认配置、server、公开 Codec 或未来配置变更路径的全生命周期常量。

**负向复现**：同一 codec-check 二进制先 poll Pending，使 reader 按旧 F 申请16393B；调用公开 setter F=32768，然后输入合法32768B DATA。`setter-growth` 在 `bounded_read.rs:61` 的 `need <= spare.len()` 断言失败，code101。两次原件均保留。这是04i局部原型的配置迁移兼容性缺口，**不是批准 FRAME_SIZE_ERROR、RST、拒收或把 assert 当政策**。此调用序列立即停止依赖 T=16393 界，不计入通过数。

最小处理方案分两种，需明确选定：固定 profile 专用 driver 只能在首 poll 前完成配置并证明随后无 F/H 变更，范围外调用不得声称支持；若要求保留公开 setter 兼容性，应在内部加入配置 epoch/帧边界迁移，旧帧按旧界完成，新帧按新 F 取得已核算 backing，Partial 的配置变更也需定义重预留及旧新重叠。不能只增 assert、改 Chrome136 或静默冻结 setter。本轮未实现这项迁移，也未发现当前显式 profile 的正常 client driver 路径会中途增大 F/H。

## 3. 同一 allocation 台账及退休点

新观测扩展仅标记目标域 allocation，使用现有 Tracking allocator 的递增 id；dealloc 回调以固定栈缓冲记退休，不在 allocator 内做分配格式化。`check.py`逐行重建并集，保存每次变动的 timeline、U归属、页queue/held/free、目的信用和J；不是局部峰值相加。

| 域 | 身份、信用与退休 |
|---|---|
| codec frame / Partial | 新块在空len、offset0时登记，容量16393或360448；read、当前frame、DATA、HPACK编码输入若同id只算一次。SOURCE_EVENT retire 在最后allocation释放时发生；EOF/Pending但对象存活仍计入 |
| 页 queue/held/free | 页payload独立16384B，`PAGE_ALLOCATION`关联页租期与allocation。同一allocation可多次复用；publish只是queue→held，Page::drop是held/queue→free，**不是物理释放**。Pool最终drop后 OWNED_RETIRE 才消失 |
| Adapter U | 每流至多一个源动作/余块，全局实验源槽2；U记录逻辑余量与held页allocation。它已经包含在页集合中，不加第二份16384B。Pending 槽可占信用而无真实页 |
| 目的 P/E/A | 先锁内预留 `[逻辑bytes,1,固定backing]`，再分配、copy。OWNED_ACQUIRE→copy之间的目的存储也计入；源页与目的不同id，不能因为内容相同去重 |
| 模拟 D 后 J | D 只将同一目的allocation的责任由A移到J，退P/E/A reservation，不释放backing。用户持有物最后drop才 OWNED_RETIRE；本轮不是实际JS D闸门 |
| 非D丢弃 | 实际drop目的backing先于destination_retire；cancel标记不退仍在外部Delivery中的目的信用。源先drop页owner再退source token |
| HPACK独立字符串 | `take`先copy到独立Bytes，记录HPACK_COPY的source/output不同id；动态表/伪头保留的独立值不再持源；最后引用释放记退休 |
| shared recv Slab | 从首个活slot定位其真实allocation；空Slab的最后pop不抹掉旧id，直至realloc/drop才退休。仅日志backing_id=0绝不视为归零 |

守恒包括 `received_U=copied_A+source_discard+remaining`、目的reservation三维和物理先退后信用、`live=queue+held`、`allocated=live+free<=cap`，以及flow release不超过真实stream/connection in-flight。reserve日志早于页allocation关联的短暂区间另标`page_reservation_pending`，free暂记null，不伪造负空闲数或提前分配。成功例源、页、目的、J和已标记Slab/字符串最终均退休；非零进程只核对可得前缀，不把清理或完整交付补成通过。

| 同一时点样本，最终组 | 已标记申请容量并集及含义 |
|---|---|
| headers-transition 峰值 | 376841 source +32768页 +24 J +960 Slab +40001 HPACK字符串 = **450594B**；U余17B只引用其中held页，不再相加 |
| window 峰值 | 16393 source +262144页 +16384目的 +32768 J +3840 Slab = **331529B**；此刻页held=1、free=15、queue=0，U为B的15B；目的P=15、E=1、A=16384 |
| partial/continuous | 第一个1B未等后续/EOF即D；连续16个独立8B输出仍被用户保留，页held回0，网络页可复用 |
| boundary | 三片16383+2+16384，页含尾部，观测并集峰82889B；不是“聚合总会更省”的证明 |

**并集边界**：以上不是整个库或进程峰值。未标记普通HeaderMap最终复制、Huffman工作区、Bytes/Arc/Page控制块、free指针向量、协议对象、allocator usable size/碎片、日志及宿主输入等。Slab的System.realloc内部旧新短时重叠不可由返回后的id日志穷尽；这正是尚未关闭的元数据增长责任，不能填0。观察表固定容量只限制本次探针，不成为生产对象cap。采样RSS不能代替任何硬界。

## 4. 条件化子界与保留的04g反例

固定F/H且真实driver同步处理一帧再取下一帧时，继承04i源码归纳：

```text
T = 16384 + 9 = 16393
K = max(5, floor(H/F) + (floor(H/F) >> 2)) = 20
C = (K+2)*F = 360448
单串行接收codec源payload申请并集 <= T+C = 376841 B
```

DATA不可穿插未完成CONTINUATION；页copy同步不await，不保留codec Bytes。合法DATA阶段无Partial时源只有T；不同协议阶段的局部最大值不能全部宣称同时达到。最终header-transition实测在同一进程组合达到T+C，同时仍持Adapter源页，证明不是跨两轮结果相加。

session=1、有效持有流数L=2明确是实验事实，取消后尚持body、owner、retiring对象仍计入；未产生其它会话或流。保持Ws=6291456、Wc=15728640，无adaptive/custom窗口调整、无为尚未pop队列提前release时：

```text
Q = min(Wc,L*Ws)
N_queue <= min(L*384, floor((Q+L*(16384-1))/16384))
H_held <= min(L, Adapter source slots) = 2
条件算例 cap = 768+2 = 770 pages
```

free也占已分配payload，池cap限制allocated总数；懒分配不取消尚授权窗口的责任。770页=12615680B只是该L/窗口/受限消费者前提下的payload算例，**不是设备配置，不是完整窗口已灌满，不是生产数值**。多session、retiring总数不在本轮填值。

目的小额规格 `[16B,2events,16B backing]`、每块8B保持04h；阈值规格在同一Adapter以构造参数固定为每块16384B、`[32768,2,32768]`，同一预留/复制/退休代码。新增单测先证旧实现只预留8B失败，改为显式sized预算后2/2通过。参数只为有限测试，不改02d的1/4MiB、128/512，也未批准R3-A。

04g的收益和失败边界保持：暂停小帧积压可显著减事件/Slab；页尾、部分发布及free保留会增加容量。任意直接消费者长期持小页仍不受flow release限制。组合二进制以4页运行真实hyper2直接hold，第五个已授权1B仍code73，先前4页held且used_after_poll=0；不是RST或正常取消。Adapter的用户独立输出解除了J→网络页引用，但J自身没有因此取得全局硬界。没有缩窗口、满池RST、admission、连接池或任意生产对象cap。

## 5. 组合行为与HEADERS转换

最终 `small-153105-64e44e6b` 13/13进程code0；其中11类走真实hyper2 Adapter，mixed/boundary走同一组合二进制中的直接http2聚合控制分支，不冒称后两例也经Adapter。

| 组合验证 | 结果 |
|---|---|
| partial/continuous/held | 注册Pending后首1B及时返回，后续与EOF尚未发；保留全部独立输出，driver销毁后字节仍有效、Pool有效数0 |
| budget | 两个8B未D输出满额；两次Blocked不增加poll，A余9B仍在U，另到2B在queue；D退额后27B完整 |
| eof | 25B按8/8/8/1输出，前缀不等EOF；末余块复制后退源，下一poll正常EOF |
| cancel/sibling-cancel | 25B先copy8B未D，取消只退源17B，仍持Delivery占[8,1,8]直到实际drop；迟到late不D，B完整15B |
| error/reset-eof | INTERNAL_ERROR→真实hyper2 Err；CANCEL保持原库EOF映射；不改库迎合测试 |
| sibling-pause | A保留源余块时，B已先交付prefix，后续suffix仍推进，不靠销毁整连接 |
| mixed/boundary | 空/非空交错不产生空body事件；原有END_STREAM与32769B跨页顺序保持 |
| headers-transition | 合法响应40000B非Huffman头跨HEADERS+两CONTINUATION→25B DATA→trailing HEADERS+两CONTINUATION；B在途照常推进；用户保留初始HeaderMap直至driver销毁仍正确，codec源已归零 |

codec-check同一manifest/同一http2编译图覆盖prefix、stitch、maximum、mixed、padding、continuation、continuation-limit、header-alias、huffman、cancel、truncated、oversize，最终12/12预期功能code0；另setter-growth是预期兼容性反例code101，不计通过。header-alias直接保留pseudo/动态表输出并销毁codec，验证源别名切断；它是codec图测试，不冒充合法client响应。Partial未完成时drop、截断EOF和超大帧只读3字节等行为保留。

独立HPACK输出并不免费：其字符串、HeaderMap、动态表及Huffman workspace归02f `U_header/U_protocol` 未决项，主要归K3；不从codec源账删除后就声称不存在。共享Slab承载DATA及headers/trailers，其allocation只能归一次 `U_protocol/recv metadata`；DATA节点和页控制元数据属于K1局部责任，头部节点数量/表示依赖K3、有效持有数量依赖K4。页cap并不自动成为Slab cap。本轮不审计整个Tokio或全部allocator。

## 6. 后续WINDOW_UPDATE：输入推导、有限成功与两次失败

`proto/streams/flow_control.rs:94–107`真实条件为 `unclaimed >= floor(current_window/2)`，不是初始窗口的一半。持续接收并归还N且尚未发更新时，`unclaimed=N, current_window=Ws-N`，首次流级门槛为2097152B。选择128×16384=2MiB，远小于6MiB初始流授权，不需缩窗口或违规超发。

预设计划在`audit/resource-plan*.json`：每次DATA总量2MiB、双向H2上限3MiB/1024帧；最终8批、每批16帧262288B；session1/流2/770页；屏障2秒、async8秒、外wall12秒、CPU10秒、AS512MiB、10ms采样RSS>128MiB停止、每日志16MiB。先有计划再运行，不无界灌入。

| 尝试 | 原件、停止点与判定 |
|---|---|
| 单帧屏障、磁盘hex日志 | `window-152236-a7069b6c` code101，wall8.284秒；完成704512B，未更新。serial44于7901558us完成；serial45 host8010445、peer8023002、PING写8071681us，随后8秒case截止，无其driver/ACK/resume。不是2秒屏障超时 |
| 16帧批次、验证后压缩日志、磁盘落盘 | `window-153230-21974139` code101，wall8.659秒；完成1048576B，未更新。serial6 host7932382、peer7933520、PING写7948545us，未完成driver/ACK/resume即case截止。旧失败不改判 |
| **同一冻结二进制/批输入/全部时限，仅日志先入受限tmpfs** | `window-153653-1ca98b10` code0，wall1.750秒；独立checker重建2097152B DATA及B15B完整，实际双向H2 2098926B、164帧，收到流1增量`00200000`，A仍open |

最终每批wire descriptor是在检查实际发送buffer的每帧头及每个payload字节都等于对应重复字节后才记录，checker独立展开并核对128帧顺序；不是省略输入证据。成功试验用两份匿名 `/dev/shm` 临时日志，各受RLIMIT_FSIZE=16MiB，总责任32MiB，子进程退出后只写一次归档。tmpfs属于额外宿主日志责任，不算入子进程RSS或目标库预算。

仅改变日志落点而成功，支持“当前磁盘观测路径影响可完成性”的定位；没有probe-off、调度控制或统计基准，不能断言全部延迟只由探针CPU或磁盘造成。第一、二次失败都是全例duration，非页满、目的预算阻塞或协议异常；不因此关闭04g旧三项超时。

成功时三种信用明确分开：每批先有16页queue，逐次hyper2 poll按16384归还flow；Adapter取得目的reservation后copy，源页归free，目的在D才退信用；J持有首/末输出不钉网络页。接收累计2MiB后流窗口发真实更新2097152，connection只见初始`00ef0001`，**未覆盖后续connection级阈值、完整6/15MiB压力、多session或长期公平性**。这次证据关闭“只测初始窗口”的局部缺口，不证明更新时序与原栈逐包等价或生产吞吐。

## 7. 冻结、独立检查及失败账

最终构建 `build-152738-0f6f2418`、单测`unit-153019-8593880b`；最终小额`small-153105-64e44e6b`、codec`codec-153348-93f89bef`、负对照`negative-153501-edb04dbd`、成功阈值如上；feature/工具链`metadata-153600-ffee5aff`。每组记录source-freeze、binary SHA；`results/audit-5005abbf/summary.json`核对最终测试与当前源码/二进制相符。测试中无被测Rust源码编辑或并行构建/网络测试；Windows只读分析可与测试并行，不把宿主其它活动说成受控。runner/checker后续审计改动不影响已冻结二进制，具体干预计划另列。

最终完整独立检查为 `results/checks-e8d80e27/`，覆盖全部57次网络/codec进程：51次code0、4次code101（两次setter反例、两次阈值duration失败）、2次code73（4页hold反例）。**不是57例全通过**。最大采样RSS5296128B，最长wall8.659秒，仅为本宿主观测；单测和构建不计57次。首次单测1/2失败、后续2/2通过；checker一度把codec mixed误分类为回环，StopIteration及不完整`checks-2d1f8ce1`保留，修正分类后重建全部57次台账，并从原始INPUT独立重建codec DATA（含padding）。

最终屏障用同一单调时钟，逐serial保留 `host_enqueue → peer_command → peer_ping_written → driver ping_received → peer_ack_read → host_ack_resumed` 全部原始行；checker核对完整成功屏障及driver时点。最初构建driver原点独立，只可比较本时钟内差值，不能伪造统一时间。失败缺失时点保持缺失。

Chrome136 SETTINGS原hex及初始connection WINDOW_UPDATE均未变；不以字段相同声称TLS/ALPN、packet分段、时间或完整指纹等价。04g旧 `plain small-64`、`plain mixed-64`、`pages pause-64` 三项2秒失败仍**未关闭**；本轮未重跑或改判。04f更早失败、strict FAIL、02d §6及其它门槛不变。

## 8. K1收口表与最小下一步

| 类别/子项 | 本轮可收口程度 | 条件、剩余项及归属 |
|---|---|---|
| 空DATA事件消除 | 已在组合构建验证，可验收机制子项 | 继承校验/END_STREAM/必要唤醒，不等于全部协议排列或整库预算 |
| 非空页聚合、立即部分页发布 | 已组合验证，可验收机制及已知反例 | 只对未发布队列尾追加；保留04g有收益也有变大、小池失败的结论 |
| 受限Adapter、目的前置三维信用、源余块退休 | 已组合验证，可验收机制子项 | body-poll与D分离，A暂停/取消时B推进；实际Transport C/D/generation、QuickJS未验证 |
| 用户独立输出不钉源页 | 已组合验证，可验收所有权子项 | J仍真实占内存，用户生命周期不由flow或页cap约束 |
| bounded frame/Partial与HPACK断源 | 已组合验证，可验收固定配置源码/引用子界 | 单串行codec、固定读取期F/H才有376841B；直接setter变更有复现缺口，不能批准通用替换 |
| 一次真实后续flow阈值 | 已在同一最终二进制覆盖，可关闭该局部证据缺口 | 流级2MiB，受限tmpfs日志；两次失败保留；非完整窗口、非连接级更新等价 |
| 条件页/Adapter子界 | 可接受条件公式，不批准数值 | session1/L2/槽2/无adaptive/无提前release，770仍算例；有效数量来自K4，不在本轮创造限制 |
| **共享recv Slab及页/Bytes控制元数据** | **K1具体剩余局部容量责任，未关闭** | 需从既有DATA页及header/trailer节点生命周期导出最大同时节点数，核算预留容量、增长旧新重叠和退休；本轮4/16槽观测不是通用界，不能任填对象cap |
| **固定配置支持范围/setter兼容性** | **验收裁定项；通用codec替换仍阻断** | K1实现边界由总工程师裁定。固定profile专用范围有证据；要保留动态setter则需上文epoch迁移，不能把assert当政策 |
| 三项旧超时 | 未关闭历史证据项 | 原诊断归属保留，不因组合成功宣称根因消失；需要关闭它们时沿冻结屏障/观测路径取证 |
| H1/解压单块及workspace | K2原未决项 | 本轮不新开同义K1任务、不审计解压 |
| 独立headers/HPACK表、Huffman、TLS/证书压缩输出 | K3原未决项 | 源已断开不等于目的有界；预算责任U_header/U_protocol，不能挪回codec源伪关闭 |
| session/live/retiring、控制/连接池生命周期与满额政策 | K4原未决项 | 不用active代替有效持有数，不改admission/连接池；生产OOM/满额政策仍须批准 |

**一项可执行的最小下一步**：在总工程师先确认“固定Chrome136 profile、受限Adapter专用组合”的验收范围后，只补一个独立的共享 `Buffer<Event>`/页owner元数据闭包：基于现有状态机逐项证明每个有效持有流可同时存在的响应头/trailer节点数，与已证N_queue联立，按本精确Slab/Vec布局计算reserve或增长的旧新峰值及退休；加入一个合法“headers仍排队、DATA页边界、trailers已到、A取消而B在途”的有限测试。交付必须给出条件容量公式及其allocation账，不是再列“需更多测试”，不新增拒收、RST或任意对象cap。若裁定要求通用公开Codec，则优先改为实现上文setter epoch迁移及负例转正，这属于明确替换范围变化，不能在固定profile验收中偷过。

该最小补项不承诺关闭K2/K3/K4或生产总预算。完整K1是否允许以条件子界加明确外部依赖收口，由总工程师裁定；本报告不代为放行。

## 9. 封存与手动delivery

报告正文完成后运行E/seal.py：重核3272项保护、精确lock/archive/vendor、最终源码/二进制关联，生成新的`results/seal-*`及codec/adapter相对冻结输入的patch、report、artifacts清单。未完成seal保留，不冒充成功。随后最后另写一次`delivery-*.json`关联最终报告SHA、seal路径和清单SHA；**不回写已封存索引或报告**。最终位置以该只写一次delivery为准。

**结论：待总工程师验收组合证据并裁定K1状态。完整K1尚不宣布关闭，02d有效、02f仍草案，r3/1C/G1未放行，未接入生产。**
