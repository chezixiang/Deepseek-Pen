# 04n-r1：保留解码边界方案的定向修复与组合验收

日期：2026-10-05（Asia/Shanghai）；本轮始于2026-10-04，本文完成接续交付。

**结论：待总工程师验收 04n-r1。** 本轮隔离实现的F1/F2修复、F3空块保留及有限背压，在冻结矩阵中通过独立原始记录核对；F4补齐实际布局、allocation身份与条件责任式。原28对C/A差异为0，原B的12对差异完整保留；新增44对真实客户端/恢复路径比较差异为0。四个重新运行的旧二进制负控仍准确暴露原缺陷，不靠退出码0或live=0宣布修复。

本结论不宣布K2整体、r3、1C、G1或生产通过。02d T1A.3-r2仍是现行规范，02b只按02d §1.1继承，02f仍草案。预算方向仍为“B＋保留边界”；三路比较中的B只是原聚合负控，不是批准M1。原wreq decoder、8192 B驱动、成员与尾检查、编码/压缩窗口、网络配置、Transport公共API/错误码/admission均未修改。本轮有限输入未发现需要改变接受域的冲突，未提出或实施新的拒收政策。

## 1. 交付位置、保护与证据强度

本轮唯一证据根E：

`G:\youdao\Deepseek\docs\astra\evidence\k2-boundary-preserving-r1-20261004-d78e57`

以下相对位置均相对于E。接续时只读取指定聊天最新两轮及其初始任务附件，没有通读中间历史；实现与裁定以本地源码、冻结输入和实际运行结果为准。

- 原始04n delivery→report→seal初核9438项、04m链6186项、映射输入6044项：`audit/input-verification.json`。旧结果只作只读基准。
- 接续前与结束时对**同一19409项、528487359 B保护集合**重新哈希，均0差异：`audit/continuation-protection-start.json`、`audit/continuation-protection-end.json`。清单本身SHA-256为`a4d0f0eb7f928b06364a5ad233ffe96b15db8eb5ab470c7b5b8018bacea652db`。
- 两棵隔离源码树各4321文件与最终freeze相等；原decoder与Cargo.lock均未变：`audit/final-source-integrity.json`。
- 321次已登记调用的1802份原始结果文件与各自复制哈希一致：`audit/final-run-integrity.json`。失败原件没有覆盖。
- 业务代码、旧04n报告/封存/delivery/归档/缓存、全局配置及用户已有修改未写入。Git结束时仍是原9个tracked文件、205 insertions/58 deletions；没有提交、暂存、reset、clean或设备操作。

证据层次：A/B/C是**冻结取得序列＋原模块重放**，只证明行为；handoff、focus和empty-gate才是本轮真实loopback H2/页池组合。均非完整生产wreq/Transport、设备或ARM64验证。

## 2. F1：退信用早于实际释放

### 复现、首次偏离与修复位置

新运行旧`handoff-diag`：`runs/309-red-f1-cross-page-2da8fe`。独立核对发现4个提前退信用事件：

| token/责任 | 退信用行 | 实际FREE_DONE行 | allocation请求 |
|---|---:|---:|---:|
| source owner 1 | 111 | 119 | 56 B |
| source owner 2 | 224 | 231 | 56 B |
| copy 1 payload | 225 | 227 | 523 B |
| copy 1外层owner | 225 | 229 | 40 B |

首次偏离在旧Drop入口减少live/退休信用，而数据字段及外层Bytes owner Box尚未析构完成；旧allocator退休记录又早于System.dealloc。修复放在所有权和实际分配器完成边界，而非在最终汇总处补日志：

- `work/codec-http2/src/k1probe.rs`：先真实System.dealloc，后FREE_DONE并发布released状态；realloc失败不撤销旧身份。完成记录与状态发布同步，reaper不能先打印退休。
- `work/host/src/credit.rs`、`work/host/src/live_source.rs`：固定槽源账本；read reservation先于Restore.poll_block；每个已兑现token绑定外层逻辑owner allocation，完成后才复用。
- `work/codec-http2/src/k1bounds.rs`：copy token同时绑定payload与外层owner，两者均完成释放才退信用。未兑现源预留先清理Restore持有物，再归还。

逻辑长度归零、引用解除、页payload转回free池、allocation真正free和信用可复用是不同事件。Source token负责其逻辑owner，不代替页池负责共享payload；页归free后仍全额占池物理内存。Source/Restore包围Box也不由一次临时read token代表。

### 回归与限制

`runs/318-final-handoff-80dc4e91-4e147c/check/result.json`核对17例：原11例全部覆盖，另加真实部分跨页持有后的确定性Pending/resume/cancel/error、非空unread tail及源cap=0/1不足对照。正常cap2源峰值为2；cap0不poll Restore、不分配逻辑owner；cap1保持source_blocked，而非提前退额或改成新协议错误。

`ALLOC_BEGIN/COMMIT`由真实GlobalAlloc调用产生，核对Source/Copy/Page/Destination实际counter reservation在先，而非仅相信“reserve”字样。网络取得有独立的一槽INGRESS预留，页分配有页信用；不把上层source reservation说成先于所有网络读取。

取消标记先于drain。首输出取消时日志total=512代表已解码且held，`.out`为0 B；未把它冒充已交付前缀。Pending取消时预留与实际部分页一直保持到drop。其Pending是保留真实部分页后由显式探针停车，不冒称自然网络调度必然出现该窗口。C/D/J也是宿主局部控制标记，不是生产终态仲裁器。

完成通知依赖本轮allocator探针机制，不是可直接去探针发布的生产实现；生产通知方案和去探针布局仍须另验。

## 3. F2：连接级bounds_out积压与错配

旧二进制本次重跑：

- `runs/310-red-f2-legacy-churn-65a4ee`：同流6轮legacy消费/释放后，6个检查点仍有真实metadata allocation存活。
- `runs/311-red-f2-mixed-ef4d57`：两流混用时，stream3长度5拿到ends=[2]而非[4]；stream1长度11拿到[4]而非[10]。另有4个释放后metadata滞留检查点。

根因是旧poll_data发布的位图进入连接级FIFO，只有新接口取走；页面、metadata与流身份脱钩。现在在同一stream锁下把页面和其Arc<PageBounds>直接一起移出，legacy入口立即释放不需要的metadata引用；不禁用旧入口、不吞配对错误。修改位于`proto/streams/recv.rs`和`streams.rs`，而非靠调用者调整消费次序。

`runs/319-final-gates-80dc4e91-a81f3b/check/result.json`：legacy6轮、两流交错各检查点的**实际page_bounds allocation**均退净，结束仍为0；新返回的bounds allocation身份、stream_id与字节边界全部配对。Page::drop减少的只是bounds_page_refs，实际存活以allocation完成事件核对。

这证明选定Restore/legacy调用链，不授权其它调用者无限保存裸Arc；额外metadata/页持有量在F4以E_meta/H_other单列，不默认为0。

## 4. F3：空块、EOF前交付及有限表示

### 真实空输入反例与修复

`runs/312-red-f3-empty-final-10e3a6`再次复现：相同gzip头、Content-Length absent和一个END_STREAM空DATA，原客户端取得`[0]`并报UnexpectedEof；旧恢复路径取得`[]`却accepted。不是文件重放推测。首次丢失发生在旧recv_data的sz==0提前返回。

新实现保留非空位图，增加固定四项ZeroRun(gap,count)，空记录也占真实页/metadata责任。Restore逐个返回Some(Bytes::new())，不把空块当None；页尾gap在EOF前消费。counter默认u64::MAX，测试降到2时走相同满额判断，等待发布/归还后重用，不丢项或新增拒收。

connection只有一个inline pending DATA槽，先预留再poll codec。满页/空记录满额时持有该帧并Pending，不再读下一帧；storage预检与原recv_data提交在同一锁内，在窗口、Content-Length、END_STREAM状态修改前完成。已无效/需报错的帧仍走原校验路径。publish/page return登记与唤醒有明确机制。

### 新增矩阵

`runs/317-final-f3-80dc4e91-227eda/check/result.json`：**88次运行、44对、0差异**（19对完整capture＋25对原decoder）。从wire解padding、实际客户端取得序列、独立位图/空记录重放、精确ERROR和输出重建，未只比较拼接字节。

| 情形 | 实际取得/行为（A与C相等） |
|---|---|
| 无DATA空流，gzip，无CL或CL=0 | []，accepted |
| 一个END_STREAM空DATA，gzip，无CL | [0]，rejected / UnexpectedEof |
| 同一空DATA但CL=0 | [0]，accepted；保持原Decoder::detect语义 |
| PADDED空DATA | 按实际客户端payload判断，不把padding长度字节当源内容 |
| 空DATA后继续有效数据 | coalesced与明确屏障分阶段发送，序列/输出/接受结果一致 |
| 完整gzip块暂缓EOF | phase1取得294 B压缩块并已交付512 B输出；WINDOW为Pending；phase2空DATA/EOF发生在其后 |
| 连续空块、多gap、middle empty | 空项数量、位置、顺序不丢失 |
| br/deflate/zstd空流及单空块 | 无块accepted；单空块rejected，与原客户端一致 |
| zstd跨页并在前/中/后夹空块 | [0,16300,0,523,0]，完整512 B输出，accepted |

确定性压力另见319：count耗尽、四个gap槽耗尽、释放后恢复、满额时cancel/error/close、同连接另一流存活；另有held=2/queued=2/P=4的页信用等待与真实唤醒恢复。各例没有用sleep制造窗口。

**明确连接级进度限制**：阻塞DATA后面的wire PING/另一流不能越过它；门控先证明ACK18尚未到达，再由消费/取消释放后恢复。测试证明本地取消与已排队的控制可推进，不承诺无限未消费空DATA下仍无条件穿越后继控制帧。这不被伪装成全局公平性或生产admission结论。

## 5. 原28对与真实交接的组合结果

最终独立A/B/C核对：`runs/316-final-abc-80dc4e91-9b028f/check/result.json`。

- 28次新capture＋84次解码：wire DATA、恢复块、独立页位图重放逐块相等；新物理页序列仍等于封存k1.chunks。
- A重放original.chunks、B重放k1.chunks，各28例都重现封存接受/错误/输出；C/A差异0。
- B/A差异集合仍是12对：gzip/br/deflate的tail和multi共6对，zstd-tail、window-log28、zstd-page-split、gzip/br/deflate-unread-tail共6对。
- 原11例同任务页token→Restore→源预留→原decoder→目的copy得到accepted3/rejected7/cancelled1；fault是rejected的一例。新增6例和失败/取消清理见§2。没有把预期rejected当作测试失败，也没有统一拒绝多成员或尾部消差。

A/B/C文件重放宿主的旧观察性owner/目的日志仅用于行为比较，不作为F1的新物理退休或真实预留证明；F1判定使用handoff/shared BoundsSource及实际GlobalAlloc事件。

## 6. F4：完整条件成本、历史容量与未关闭责任

详见`design/f4-exact-cost-20261005.md`及`runs/320-final-cost-80dc4e91-d4c3c2/check/result.json`。实际target/features布局和allocation：

| 项目 | 本轮值 |
|---|---:|
| PageBounds对象 / 含Arc控制块请求 | 2136 / 2152 B |
| Pool State / Mutex / 含Arc请求 | 120 / 128 / 144 B |
| 发布页Bytes owner | 64 B |
| 逻辑source owner / copy owner | 56 / 40 B |
| Source账本Arc / Copy账本Arc | 136 / 104 B |
| 两类固定slot | 24 B/项，cap2时各48 B |
| Restore / BoundsSource（前者已在后者内） | 152 / 184 B |
| Held / pending Vec历史backing | 64 B/项 / 实际capacity4即256 B |
| Event / Slot<Event> | 224 / 240 B |
| inline ingress Option<Data> | 40 B，另有连接字段与padding责任 |

独立allocation身份重建覆盖最终226次运行。实测页payload最多4份=65536 B，PageBounds最多4份=8608 B，逻辑source owner最多2份；一次跨页真实副本523 B加40 B外层owner。带tag责任域的单例同时请求量峰值91865 B，**不是完整进程内存或生产预算**。

本轮Slab实际capacity最高4/请求960 B，未重跑04k的大节点增长场景。容量不随live归零减账；完整条件式保留240(C_old+C_new)增长重叠，checker对960→1920/重叠2880另有明确标为synthetic的自测，不冒充本轮真实增长运行。Restore.pending的len可回0但256 B backing一直占用到drop。Arc控制块、copy/page重叠、已pop仍持有物均按真实身份去重，同内容的独立副本相加。

原04n的min(2L,S+X)不能直接代表所有页持有：还须加入Restore当前页/pending/取页局部变量，零字节尾页每流至多一个。详文给出Q_page、H_page、未兑现预留、H_pub与实际B_meta的条件式；禁止以bounds_page_refs或live=0代替它们。

具名保留而非填零：K2 shell构造重叠、8192输出及04l各codec工作区/历史workspace；K3头内容/HPACK/Huffman；K4 live/retiring对象数量、response/source/error包装、connection字段、Waker/任务、E_meta/H_other/drop-tail、socket/TLS及取消仲裁；目的/J与用户保留；allocator实占/碎片/栈/内核缓冲。

探针也有真成本：四个主静态表950312 B，thread-local expected32 B/线程，weak registry本例backing32 B＋静态头32 B；辅助静态/日志格式化/宿主输入输出另列。97个过程末仍有32 B registry backing；28个capture过程还有144 B pool weak控制块，均明确登记为观察者保留，不宣称所有allocation归零。它们不等于页面payload、metadata或source/copy token泄漏。长期注册表历史容量、去探针实现和其它target仍须验证。

## 7. 独立核对、资源计划与全部失败记录

最终checker组：`results/final-abe58586/checks-80dc4e91.json`，6个进程均exit0：abc、f3、handoff、gates、cost、fresh old-binary red。保留8个synthetic正控、14个synthetic负控，以及4次本轮新运行的旧二进制负控；两类证据分开。

原冻结计划SHA-256：`2f2f8aab159318c8754833010bf818f47326c58ecd7b00f05ea486f3494c72f0`，未修改。

| 类别 | 实际 / 上限 | 实际最大wall |
|---|---:|---:|
| 构建（含冗余尝试） | 9 / 16 | 66.975 s |
| 串行用例（含红灯复现） | 295 / 320 | 4.286 s |
| checker（含失败） | 17 / 40 | 13.075 s，失败项见下 |

构建保持wall300 s/CPU240 s/AS3 GiB/jobs2；用例保持wall12 s/CPU8 s/AS512 MiB/单文件16 MiB，输入≤2 MiB、capture≤65536 B、输出≤4 MiB、H2≤524288 B/256帧、内部PING2 s、poll≤100000。用途分配在`audit/final-budget-allocation-note.json`，没有事后调大总数上限。所有raw逐文件复制回E并核对SHA。

保留的非零退出/准备错误：

1. 034、050、051、053 checker exit1：修复前F1/F2/F3反例和负控原件。
2. 039 case exit101：原diagnostic WIRE日志逐字节format!在带探针allocator下令当前线程PING2 s屏障超时；CPU4.25 s、state R。旧二进制/源码/日志保留，后续只改该宿主hex格式化为预分配nibble编码，不延长超时；不是04m/04l归因结论。
3. 313 checker exit1：生成Python正则时JS replacement的dollar-apostrophe替换语义破坏字符串，import即SyntaxError；失败脚本在`snapshots/checkers-47312f15`。改用函数替换并做AST预检，未改IUT或判据。
4. 315 checker exit-9/wall：最后CPU0.42 s，D/p9_client_rpc；12.023 s采样发出终止，D态退出至13.075 s，明确是失败，不改写成12秒内通过。之后同checker/输入逐文件哈希复制到已登记tmpfs，限额不变，F3为1.024 s；输入视图、实际挂载、Python路径/SHA/版本、参数、raw与采样在`audit/checker-freeze-80dc4e91.json`和316—321各run。此新对照不证明04m旧失败同因。
5. 初期prepare映射前缀、Windows反斜杠镜像核对、WSL空闲重启丢失tmpfs等准备失败，以及062/063不重叠但冗余的构建，均保留audit记录并计入适用账目，没有删除现场。WSL启动的PATH翻译告警保留，未以其替代退出码判断。

历史“tmpfs8/8、DrvFS5/5”的完整命令/结果集合，在给定旧封存范围内未找到，只有空probe日志：`audit/historical-io-search.json`。该历史数字未验证，未重造。04l四个大样本raw/short-17超时没有重跑、关闭或加时限。

## 8. 构建、精确修改与复核命令

平台：WSL2 Ubuntu，x86_64-unknown-linux-gnu；rustc1.97.1 (8bab26f4f)、Cargo1.97.1、LLVM22.1.6；精确uname和features在`audit/final-active.json`。注册临时根`/tmp/k2-boundary-preserving-r1-20261004-d78e57`实际tmpfs，E对应/mnt/g为9p；没有把目录名称本身当挂载证据。构建与测试全offline/locked；未升级依赖。

源码链：构建前`audit/integrated-prebuild-e8f3370b.json`与最终4321项manifest逐项一致；构建`runs/081-continuation-final-bdce30` exit0。最终source manifest SHA-256：`5a357fae4380473ff45d56220f8e76ede27d1529812be899c11beef861ffaa47`。`audit/final-build-link.json`给出完整source/lock/binary对应。

- wreq decoder.rs：`b280580f531df9e177e8b4049b74df728615f2c2c6bd81af03add442cfa77cee`
- Cargo.lock：`c85381694ea72304054b4b2cf512ab1a0093ed603c54b6911c24472f3ec23238`

最终6个二进制位于`binaries/final-abe58586`：

| 二进制 | SHA-256 |
|---|---|
| handoff | f897cc2599d7e6c81037106641beee64064ecb0a1903bebd7edf3b18623ba9f3 |
| capture-bp | 3e8de7d9bad5477eb8bbbbf6c1d657e66d6366a82996cf4ab1771b0798a927ba |
| decode | 96d799f0cbda5607b7ef92430564615351c312349deaf74d96116a38ea189121 |
| pairing | bd2caf088c9a49c5f20be242cfa9cdf2a2e15e081489157a0f66e3946387ae0e |
| focus | 0233bee7c7c6e2a64dc8ab6c8505f680890c9ab7f47f50e8c58e7dd00a83ffba |
| empty-gate | cf9de555c9934a9a7daaa143a8558e326d9a8d7b3193c1192cc1d3a4bcaa7787 |

相对原04n输入的隔离Rust源码共15项；清单、前后SHA及patch为`audit/final-changes.json`、`audit/isolated-r1.patch`：

- 修改：codec-http2/src/k1probe.rs、k1pages.rs、k1bounds.rs、proto/connection.rs、proto/streams/{recv,streams}.rs；host/src/lib.rs、bin/{handoff,capture-bp}.rs。
- 新增：host/src/{credit,live_source}.rs；bin/{empty-gate,pairing,handoff-diag,focus}.rs。
- 本次接续没有再次改F1/F2/F3核心算法，只补focus的编码/跨页空块覆盖、capture审计输出、精确布局和allocation身份探针，并完成最终矩阵、独立核对器、成本说明、报告与封存。

实际执行入口（参数/limits/环境/退出码逐项见audit/invocations与runs/result.json，不只列示意命令）：

```text
sync_integrated.py
run_r1.py build continuation-final cargo build --offline --locked --bin handoff --bin capture-bp --bin decode --bin pairing --bin focus --bin empty-gate
final_matrix.py freeze
final_matrix.py abc
final_matrix.py focus
final_matrix.py handoff
final_matrix.py gates
red_recheck.py
final_checks.py
final_audit.py
```

前述入口经WSL python3 -B运行；最终checker使用冻结记录中的真实Python绝对路径。回放会产生新目录并继续消耗剩余计划预算；不应在交付后就地修改/重跑封存目录，应另立修订副本。已经通过build完成相关Rust类型检查；未运行全仓Node矩阵、Clippy/rustfmt批量修复、H1/TLS/K3/K4全审计、ARM64/设备/生产集成，这些不在本轮白名单与有限计划内。

## 9. 分工、未决项与交付顺序

主执行者负责核心整合、所有构建/用例/最终验收。历史F3侧审文稿保留于`design/f3-scope-review.md`，其角色和开始时间在`audit/agents-resume.json`；没有可靠的独立进程结束时间就不补造。此次接续新开一名F4静态审计sidecar，唯一写入范围为design/f4-continuation-review.md；服务端429重试上限导致其退出，未产出文件，已关闭，工作由主执行者完成。开始/结束和互斥范围见`audit/continuation-20261005.json`、`audit/continuation-sidecar-end.json`；最高同时活动数2，没有嵌套代理。

待总工程师裁定的边界：本轮只提交隔离主机证据；有限测试不证明无限输入/任意外部Arc持有、通用多线程公平性或生产取消仲裁；源信用仍依赖实验allocator完成通知；完整K2/K3/K4、生产参数与去探针方案、历史超时和真机部署均未关闭。S=1/X=1/P=4不是生产配置。没有新增接受域或M1审批请求。

正文完成后生成新seal，最后单独写一次delivery，记录本文与seal清单SHA；delivery后交付内容固定，后续修订另建版本。新seal：`results/seal-r1-0ceeb34c`；新delivery：`delivery-r1-0ceeb34c.json`。必须以最后生成并核验的delivery索引为准，不能用先前04n的delivery代替本轮。

**交付结论：待总工程师验收 04n-r1。**
