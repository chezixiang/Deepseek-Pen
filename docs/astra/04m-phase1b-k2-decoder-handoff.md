# 路线 C K2：K1 源交接与解码链组合验证

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收K2组合证据。组合不保持当前接受行为；存在输入分片语义变化，必须单独裁定。K2剩余项尚未收窄为H1及纯外部参数。** K1固定范围条件关闭不变；04l条件工作区包络及原驱动后受限转移方向按已接受处理。02d有效、02f草案、r3/1C/G1未放行，不宣布K2整体或生产通过。

证据根 E：`docs/astra/evidence/k2-handoff-20261003-d19e72/`。只新增E及本文；原项目、原型、契约、报告、缓存和历史证据只读。无子Agent、其它会话、生产接入、设备操作、Git提交、依赖升级或无关Node全矩阵。用户手动转交。

## 1. 首要门槛与最小决策

**门槛失败是具体可复现的行为冲突，不是“还需更多测试”。** 相同编码字节、成员配置、原8192 B FramedRead驱动、相同宿主Pending规则及17 B后置目的复制，仅改变实际客户端取得的输入块序列，结果如下。错误字符串与原始输出分别保存在每例日志及`.out`，不是只比较退出码。

| 输入 | 原源实际块长 | K1实际块长 | 原源结果 | K1结果 |
|---|---|---|---|---|
| gzip 首成员 + `TAIL` | 294,4 | 298 | 输出512 B后尾随错误 | 接受，输出同512 B |
| gzip 双成员 | 294,294 | 588 | 输出首512 B后尾随错误 | 接受，只输出首512 B |
| br 首成员 + `TAIL` / 双成员 | 257,4 / 257,257 | 261 / 514 | 输出512 B后尾随错误 | 接受，只输出首512 B |
| zlib 首成员 + `TAIL` / 双成员 | 282,4 / 282,282 | 286 / 564 | 输出512 B后尾随错误 | 接受，只输出首512 B |
| zstd 正常帧 + `TAIL` | 521,4 | 525 | 输出512 B后 `Other: Unknown frame descriptor` | 输出同512 B后 `UnexpectedEof: zstd stream did not finish` |
| zstd 已知FCS512、window=256 MiB | 7,516 | 523 | `Other: Frame requires too much memory for decoding`，输出0 | 接受，输出512 B |
| skippable16300 B + 上述zstd帧 | 16300,523 | 16384,439 | 接受，输出512 B | 相同window错误，输出0 |

前三类尾随错误是wreq模块直接调用`error::decode("there are extra bytes after body has been decompressed")`，不是io::ErrorKind；生产应为Kind::Decode，不能把宿主`non_io`标签变成新增公开错误码。其他错误经`decode_io`包装；本轮保留底层kind/message，但生产Error装箱边界未完整链接，见§3。

主矩阵`tests-a0d2a847/results.json`共24对，16对接受/拒绝、错误和完整输出相同，8对不同；正常、截断、13 B碎片、四编码多成员、legacy4/7及legacy5→现代→legacy6均包含。追加`boundary-1daf353f`四对中，跨页zstd给出**原接受→新拒绝**，其余三对给出带未消费尾部的独立反例。总计28个不同输入，其中12对行为不同；这不是通过率指标。最终退休宿主重放不消除这些差异。

精确小反例入口：

- `tests-a0d2a847/gzip-multi/input.bin`，SHA256 `19a4b7475f885999a7187d62038d7fdc696d41c93faeda8ef00d1149021ddf03`；原分片`original.chunks`，K1分片`k1.chunks`。
- `tests-a0d2a847/window-log28/input.bin`，SHA256 `2dda3abb0ee406f2b45356eb8880fa9f12696a0bbb817483a7c3bf1239194e56`；原字节头`28 b5 2f fd 40 90 00 01`，FCS512，完整frame523 B。
- `boundary-1daf353f/zstd-page-split/input.bin`：小端skippable magic `0x184d2a50`、payload长度16292及相同523 B帧，总16823 B；不是GiB输入或GiB工作区压力。
- 正常原文为独立定义`bytes(range(256))*2`，512 B，SHA256 `110009dcee21620b166f3abfecb5eff7a873be729d1c2d53822e7acc5f34eb9b`。双zstd及三frame legacy分别期望重复2/3次。

### 1.1 根因

04k `codec-http2/src/proto/streams/recv.rs`的`recv_data`将DATA追加到尚未发布队尾页，满16384 B才换页。它既会合并原块，也会在页边界切开原块。原wreq `vendor/wreq-5.3.0/src/client/decoder.rs:418`尾随检查绕过StreamReader当前chunk，直接poll内部Peekable；同块内未消费尾部与后续块并不等价。没有在本轮“修复”这个既有行为。

zstd源码`zstd_decompress.c:2185`先检查当前输入含完整frame且外部目的够FCS时的single-pass捷径，`2230`附近才检查流式window；K1合并能开启捷径，跨页切割能取消捷径。单保留8192 B输出驱动不足以保证行为：**输入形状也必须保持，或明确批准改变**。任意按页恢复/重组不等于原分片，没有为通过测试人为重新拼帧。

### 1.2 提交裁定，不代批

**M1：是否批准K1聚合后的解码输入分片语义？** 保留聚合至少包含上表的接受扩张、接受收缩、错误kind/message变化以及输出前缀从512变0；不能描述为“只更宽松”或“错误文案变化”。建议总工程师先作这个单独决策，本轮不实施政策。

若不批准M1，需另立有限边界保留方案：在聚合前保存原取得分片边界并让decoder看到相同可读区间/顺序，再证明边界metadata与页跨界owner的界。边界数量可能随大量微小DATA增长，不能每页只算一个，也不能直接继承04k无此metadata的结论；当前没有这种实现或预算证明。不得统一拒绝多成员、改错误语义、禁编码、强制capwindow或把输入重新拼完整frame来“消除”反例。

## 2. 输入来源与证据强度

准备时验证04k/04l报告、各自delivery、封存清单及其列出的相关文件，共6890项；`protected.json`记录哈希，末次封存再核对。只复制相关vendor、04k codec/页/metadata及hyper2原型、04l语料和Linux-only jobserver适配到E；旧target/cargo-home不写，构建使用新E内target/cargo-home。版本保持bytes1.11.1、http2 0.4.21、hyper2 1.5.5、tokio1.52.3、tokio-util0.7.18、async-compression0.4.42、compression-codecs0.4.38、四编码及zstd legacy defaults。路径包换源不是版本升级。

捕获链：loopback明文H2 peer → 真实原版registry http2 RecvStream（original），或04k受限codec/页/清理调整 → hyper2 `Incoming::k1_from_recv`（K1）。两路均同一固定窗口、push=false、H=262144，F默认16384。peer发送DATA后PING；等客户端driver处理并回ACK、peer确认后才poll响应body。保存完整WIRE和CLIENT_CHUNK字节、顺序及屏障，二进制`.chunks`是`u32LE length + bytes`重复记录。**从未拿server write大小代替client chunk大小。** 原源是实际RecvStream返回，不是完整原wreq网络客户端；完整hyper2 dispatcher未覆盖。

解码链：重放上述客户端块，逐块逐字节不改 → 与生产相同ResponseBody类型别名 → **直接include归档原始wreq decoder.rs** → Pending/Peekable/StreamReader → 真实async decoder → 原FramedRead/BytesCodec/Fuse → 17 B目的copy。仅zstd multiple_members=true，其他false；探测优先级、空body逻辑、尾随路径全部来自原模块。

每源首poll和块间插入相同一次Pending；保存实际执行日志。没有重放原网络时间间隔，所以这是**真实捕获分片+真实模块重放**的组合反例，不是网络全栈端到端或调度等价证明。模块直接链接强于手工复现，但不能冒称完整wreq已验证。

## 3. 解码外壳布局与错误责任

`runs/layout-e65818a2/stdout.txt`，与主冻结同构建、x86_64 Linux、rustc1.97.1，size/align均实测。不是`Box<dyn BodyRead>`替代物。

| 实际模块类型 | size / align B | 计量规则 |
|---|---:|---|
| Decoder / Inner | 24 / 8，各自 | 同一内嵌值，不相加；若上层已计包围对象不得再单列allocation |
| Pending | 72 / 8 | 一个Box请求72；包括Peekable+DecoderType |
| IoStream / ResponseBody | 16 / 8，各自 | 同一封装/BoxBody句柄；不是body具体装箱对象大小 |
| PeekableIoStream | 64 / 8 | 内嵌；包括缓存的Result状态，不再另加一份Bytes句柄 |
| PeekableIoStreamReader | 96 / 8 | 内嵌；含Option<Bytes>；不是源payload/owner |
| Fuse<FramedRead<GzipDecoder<reader>,BytesCodec>> | 264 / 8 | 一个具体Box；含codec值和reader、framing状态 |
| 对应br / zstd / zlib具体Box | 176 / 8；192 / 8；200 / 8 | 各选一个，非四层同时相加 |

Pending转为具体Inner时，新Box及workspace已创建，旧Pending Box要在`self.inner=inner`替换时才释放。因此构造过渡外壳保守取`72+H_selected`，稳定态`H_selected`；同时临时empty ResponseBody的具体装箱/错误包装仍在以下外参。FramedRead的8192 B payload不在上述结构体size内，工作区另加。

**具名未决，不填宿主数字：**

- `H_response_impl`：生产ResponseBody中具体body/timer包装/Incoming装箱、源桥接对象及其生命周期。本轮Source+File+Arc是探针，不是生产布局；源背后的K1/H1对象按其原域去重。
- `H_error_inner(target)`：原wreq Error为Box<Inner>，Inner含Kind、Option<BoxError>、Option<Url>。本轮未链接完整error.rs及其Url/util/tower依赖；宿主Error是声明的shim，无Url/Inner。真实Error句柄源码为一个指针，但不据此声称整个error仅8 B。
- `H_error_source`：io::Error自有包装、动态message/box source、可能透传的上游错误链；`decode_io`会解包既有wreq Error，不总是新增一层。固定decoder错误与网络错误分别由K2/K3/K4责任接口给界，不能从一次message长度推上界。
- `H_pending_empty`及构造栈：空body临时具体Box、构造期间移动/栈帧的target布局，不能把shell稳定态当全构造峰值。

宿主error shim保持decode/decode_io/into_io转发形状及底层错误，原decoder源码未改；其内存计量只证明宿主释放，不证明生产Error布局。本轮不扩展完整H1、TLS或全部allocator审计。

## 4. 源交接：单槽不闭合，显式换块额度是有据候选

### 4.1 空owner重叠与提前退休试验

原StreamReader `consume`仅advance；len=0的Bytes仍持完整owner，下一次`poll_fill_buf`先poll源、后替换旧chunk。因此原源`7,287`的gzip正常输入已经观察到peak=2，旧owner在第二块acquire之后才退。`ownership-f4caab42`四编码normal/multi/truncated/tail共16个单槽负对照均source_blocked；它们是有意停止实验，不是库返回的新错误，不能算解码拒绝或超时。

仅在新`retire-tokio-util`副本调整两处：consume正好用尽时drop空chunk；fill_buf发现无可读chunk时，在poll下一块前置None。未修改输入字节、可读块边界、decoder/成员/错误。最终`retire-tests-301120d7`：24对×两源×槽数1/2=96例，加四编码cancel/fault共8例，共104进程code0。槽2的48例接受、错误及输出均与原reader重放相同；槽1有6个K1尾随/多成员source_blocked，不是104例“组合通过”。

**关键反例：提前退休空owner不是全路径解法。** gzip/br/zlib首成员结束后，reader chunk还留尾随字节；原wreq尾检查绕过reader，故该owner非空、不可用“退休空owner”释放。即使后端只是EOF，单槽预留规则也不允许无额度poll去探测EOF。`boundary-1daf353f`另用原源`[gzip+X,TAIL]`等分片证明下一块确实存在而非只有EOF；最终`boundary-replay-e11629ef`精确重放，单槽blocked，槽2恢复原尾随错误。擅自drop非空余块不是本次许可的空owner调整，不实施。

### 4.2 所选候选及K1账目变化

选择**显式换块额度**作为后续组合候选，非已批准生产配置：每个有效持有decoder允许当前完整源owner加一次串行换块/尾检查owner，共至多2；source Pending预留不能提前借出，EOF/error无返回owner时退预留，实际owner直到外层Box释放后才退。不是偷偷把既有单流1槽改成2槽。

若原常规全局槽为S，换块额度为X，decoder集合由K4给有效持有界L（包括retiring）：

```text
h_owner <= S + X
h_pages <= min(2*L, S+X)          # 不再用04k的min(L,S)
P_s >= sup_u[Nq(L_s(u)) + min(2*L_s(u),S_s(u)+X_s(u))]
owner请求 <= 56*(S+X)
```

页payload仍`16384*P_s`，free索引`16*P_s`、池104 B、Slab式保持原责任；不能另加`2*16384*L`再重复算页。若沿用旧P/S数值却不重验上述条件，组合预算不闭合。已占常规槽的旧owner等待换块时，应有预留X或显式公平串行换块仲裁；不能让全部额度被旧owner占满再期待唤醒解决。X的值、归属及仲裁由K4/组合负责人验收，不能把32 active填进L/X。

**成立范围**：真实decoder模块重放+同allocation计量宿主证明最多2源owner的局部串行账、恰一次退休；K1网络捕获独立证明实际聚合页/owner退休。**尚未把真实K1页owner、源reservation和decoder串在同一实时任务**，因此不能宣布“真实K1源槽交接已闭合”。接受门槛已有冲突，本轮不绕开M1去修改已条件关闭的K1适配器。M2待验收项是按上述式子落实显式X及真实页owner token关联，或另授权非空尾部退休设计；不是再泛做全矩阵。

### 4.3 退休时点审计

第一版宿主Owner::drop先释放payload后退信用，仍早于bytes `Owned<Owner>`外层Box释放；保留该版结果为接受行为及payload证据，不把它当owner-box退休证明。最终host-retire在AsRef定位实际外层allocation，allocator在System.dealloc完成后记退休，下一次source poll或最终drop才reap信用。日志`owner_box_deallocated=true`，不按len/消费量退完整源信用。

最终104例及16个边界重放所有owner acquired=retired、live=0，所有被跟踪Rust/native allocation最后归零。旧owner、源payload、外层Box为不同账目层级，不能因Bytes长度0漏掉。探针静态主表262152 B及owner登记表、日志/文件/宿主等独立于业务预算。

## 5. 目的信用、D/J与取消

保留原FramedRead实际输出块（最大8192 B），只在取得块后分成17 B目的copy。每块处理中目的无信用的三次模拟调度均不poll decoder/source；逐段预留bytes/event/allocation后复制，D把同一目的allocation移入J并退目的信用，随后J实际释放。源输出与目的地址/身份不同，copy期间必须相加；D后移交同一allocation给J则不能双加。不得用源输出已经取得来冒称P之前无U。

这里是串行宿主调度，不是完整Transport budget仲裁。`DEST blocked`日志及独立checker证明这个宿主分支没有继续消费下一解码块；没有实现多任务公平性或生产信用等待器。J每段立即释放，本轮未证明任意用户持有数量界；`J(t)`继续为独立外参。

source Pending、EOF、尾检查、truncated错误、注入ConnectionReset及首输出后cancel均有执行日志。取消C只记意图，不poll、不复用持有workspace；最后drop才归零。例如最终zstd cancel中native1537848 B在C-held仍存在，Rust输出/外壳也仍持有，retired才全部0；gzip C-held仍含43296 B inflate状态。源提前退净也不意味着decoder/workspace可复用。

局限：未模拟同步decode正在执行期间另一线程提交C，未做cancel-at-source-Pending的真实任务交接、取消投递闸门或生产C/D/generation；这一退休时间与存活集合仍由K4负责。首输出cancel的宿主没有交付该被取消块（`.out`为空），日志total是解码取得量，不是用户已接收量，不混淆两者。

## 6. 条件预算与去重

04l源码条件包络沿用，不以本轮小样本峰值改写：gzip/zlib各43296 B；br1077113226 B；zstd含现代与一个legacy历史并存269339913 B。本轮br/zstd没有GiB并发压力。特定BytesCodec输出界仍为每backing8192及共享控制最多40 B，单outstanding输出保守`O<=2*(8192+40)=16464 B`；它是源码包络，不以本轮512 B输出代替。

```text
Heap_request(t) <= UniqueUnion(K1_source_pages_metadata(t; P,S,X),
                               H1_source_other(t), decoded_output(t),
                               destination(t), bridge(t), J(t), response_impl(t))
                  + sum(i in N_dec_live(t)) [W_encoding(i) + H_shell_i(t) + H_error_i(t)]
                  + named K3/K4 other responsibilities
```

`H_shell`稳态选一个具体Box，构造过渡另含72 B Pending和具名临时；Decoder24 B通常内嵌在上层，已计包围对象则不再加。codec值在shell内，不再加04l的96/32等字段size。K1输入页/owner已计K1，即使被reader持有也只改变归属边；宿主重放file分配的Box payload不是生产新增K1副本，不能套进页池数字。

完整编码源、decoder工作区、解码输出、目的17 B、D后J分开计；生产若为了边界保留做真正copy，该副本必须另外加，不能内容相同就去重。EOF/error/cancel后仍活着的decoder都进入N_dec_live；32 active不是这个集合的界。Stack_decode、allocator实占/碎片/arena及共享rodata仍为04l具名外参，当前式子不是RSS或设备RAM承诺。

最终计量宿主的native malloc/calloc/free仅拦截zstd编译单元，Rust GlobalAlloc单独计；只是请求allocation与释放证据。未将realloc回调后的单地址冒充libc内部搬迁峰。生产Error/ResponseBody装箱尚未求完整布局，所以K2局部式仍有明确非零未决责任。

## 7. 有限测试、失败与冻结

先写`resource-plan.json`后构建。输入<=2 MiB、输出<=4 MiB、压缩frames<=8，capture输入<=65536 B、H2<=256帧/524288 B；单case wall12 s、CPU8 s、AS512 MiB、文件16 MiB、poll<=100000；内部PING屏障2 s。构建wall300 s、CPU240 s、AS3 GiB、jobs2。不同case串行，无32路decoder压力，无设备。实际最大新增捕获输入16823 B；主矩阵输入最大1567 B，不用于关闭04l大样本性能失败。

| 证据 | 结果与边界 |
|---|---|
| 主冻结`freeze-v2` | build-k1-15874752、build-original-e15a663e均code0，35.10/17.38 s；原reader/decoder未改 |
| `tests-a0d2a847` | 24对，48次真实网络捕获+48次解码，均正常结束；8个行为差分，不是组合通过 |
| `ownership-f4caab42` | 42进程，含16个预期单槽blocked及空body/空chunk差别；旧宿主仅payload信用边界 |
| `freeze-retire-v3` / `retire-tests-10bfaf67` | 提前退空owner初版，104进程；保留为前期结果，不作为最终owner Box退休证明 |
| `boundary-1daf353f` | 4对捕获、原reader及退休reader共24次重放；发现反向zstd差分及非空尾部单槽阻塞 |
| 最终`freeze-retire-final` | build-retire-ebf2441d code0，31.28 s；只改新宿主计量，真实owner Box释放后退信用 |
| `retire-tests-301120d7` | 104进程，48个槽2等价重放；6个槽1尾部blocked保留；最终Rust/native归零 |
| `boundary-replay-e11629ef` | 最终宿主对既有成功客户端分片的16次重放；未重组输入，单槽不足结论不变 |

独立`check.py`不导入宿主或旧checker：从WIRE frame解析输入，逐字节核对CLIENT_CHUNK和`.chunks`，独立原文oracle核对输出/前缀，逐事件核对owner acquire/retire、目的→J所有权移动、源目的地址不相同，验证K1捕获的Page/owned allocation全部退休；最终日志必须出现Rust/native零及owner_box_deallocated。结果每次另建checks目录；最终核对入口`checks-aba4a0f3/summary.json`。`metadata-features-d92c7463`确认legacy/arrays/zdict_builder合并；`metadata-toolchain-7124f3bb`保存rustc/LLVM精确输出。

**失败不删除、不改判：**首次include路径错误code101；首次K1捕获未启用04k Tracking触发断言code101；退休构建a0eeba7f、8636c362两次300 s超时kill；一次WSL CreateVm ERROR_TIMEOUT发生在Python运行前；后续同限增量705d91f9成功17.69 s不等于冷构建通过。第二次构建采样记录p9_client_rpc/folio等待，定位存在DrvFS等待但不归因全部耗时。最终边界重捕获`boundary-b483db9b`的K1进程在原2 s屏障超时code101；不计有效输入，改用已成功的既有捕获作退休重放而非延时重试。原04l四次raw/short-17超时原样保留，未重测、未以512 B小样本成功关闭。

## 8. 验收边界与交付

| 问题 | 本轮结论 / 具体下一责任 |
|---|---|
| 组合保持当前接受行为？ | **否。** 已有双向接受域及错误差分；总工程师裁定M1，不代批 |
| 源槽交接是否闭合？ | 原单槽否；提前退空owner仅局部成立；显式换块额度有源码/台账依据，但真实K1页token直连及S/X/P条件待M2验收 |
| 外壳/工作区/输出与K1重复计量？ | 给出实际模块布局和union；页/owner不双加，工作区/输出/目的复制必须独立加；生产Error/具体ResponseBody仍具名未决 |
| K2只剩H1及外部参数？ | **否。** M1分片语义决策、M2真实交接落实、Error/ResponseBody精确外壳责任仍在；其后才谈H1源界与K4存活/退休参数 |

最小下一步不是扩展H1/TLS/K3/K4全审计：先裁定M1；若允许K1输入形状，授权按M2明确X和页条件的最小实时组合及完整错误包装链接；若坚持旧接受行为，先批准有限边界保存设计与metadata责任，不能带着现有反例声称保行为。当前独立预算与退休证据可以保留，不抵销首要门槛失败。

本文完成后核对保护输入、最终冻结源码/lock/binary、独立checks，生成新seal及差分；最后另写一次delivery，记录本文及seal清单哈希，不回写索引、本文或旧证据。以E内最后delivery为手动交付入口。

**结论：待总工程师验收K2组合证据。K1固定范围条件关闭不变；K2未整体关闭，02d有效、02f草案、r3/1C/G1未放行，生产未通过。**
