# 04o：路线 C K2 / M2 去探针信用生命周期——所有权接口门与阻塞证据

日期：2026-10-05（Asia/Shanghai）。

**结果：本轮未完成去探针组合实现，停止在可复现的所有权接口门；已形成隔离宿主最小实验、独立核对器、具体限制和最小替代能力建议。不能将本报告理解为 source/copy 信用生命周期已通过。**

**交付结论：待总工程师验收去探针信用生命周期。**

唯一实际阻塞是：固定 bytes 1.11.1 的 Bytes::from_owner(T) 只把 T 的析构交给所有者，没有在其外层 Owned<T> Box 完成释放后通知当前信用账本的入口。在 T::Drop、显式释放内部 payload 之后或最后字段 Drop 中归还，仍早于外层 allocation 的 FREE_DONE；不归还则需要旧 allocator 注册表和主动 reap 才能收敛。没有用改名、忽略外层 owner、池归还冒充物理释放或改变 F1 来制造通过。

本轮依用户明确允许的“现有所有权接口无法满足时交付具体限制与最小替代方案”分支收尾；没有擅自修改 decoder 或扩展库接口以跨过该门。此结论不证明所有可能实现都不可行；它限定于当前冻结接口和本轮不越界的实验。

## 1. 基线、目录与保护

本轮唯一证据根 E：

    G:\youdao\Deepseek\docs\astra\evidence\k2-credit-lifecycle-20261005-66c73c

本文 E 下的相对位置都以此根为准。唯一新增报告为本文；未创建或联系其他聊天，子 Agent 数为 0，全部由主执行者完成。

规范仍为 02d T1A.3-r2；02b 仅按 02d §1.1 继承，02e 为记录，02f 仍为草案。“方案 B＋保留解码输入边界”不变；旧聚合 B 仍只作负控。04n-r1 的冻结 x86_64 F1—F4 限定验收按本轮用户给定基线承认，未回写其“待验收”报告、索引或 delivery。K1 原固定范围条件关闭不扩大；K2/1B 整体、r3、1C、G1、生产和阶段2均未放行。

已通读指定六项输入，并由旧 delivery 定位 source manifest、构建关系、raw 和独立核对器；未另开 H1/TLS/K3/K4 或全栈调查。主要核验：

- baseline/input-verification.json：旧 delivery→report→seal、冻结 source 及继承保护集合初核，26,398 文件，required/historical mismatch 均为 0，无缺件。
- results/protection-end.json：对同一 26,398 文件、1,204,795,225 B 最终重哈希，0 差异；八个固定分批各自受原 40 s 上限约束，全部 exit0。
- Git HEAD 为 421e4d075fc5695e627b67b327299456359e5e9e，main；原有 9 个 tracked 修改保持 205 insertions / 58 deletions，结束逐字对照相同。未提交、暂存、reset、clean 或操作设备。
- 原 wreq decoder SHA-256：b280580f531df9e177e8b4049b74df728615f2c2c6bd81af03add442cfa77cee。
- 原完整宿主 Cargo.lock SHA-256：c85381694ea72304054b4b2cf512ab1a0093ed603c54b6911c24472f3ec23238。

旧实现、旧原型、旧报告/归档/封存/缓存与用户修改只读。本轮 Rust 代码、manifest/lock、target、日志及结果独立保存；新 lab 的两包 lock 不冒充原完整宿主 lock。

## 2. 原探针依赖与首次偏离

完整路径和行号解释见 design/ownership-gate.md。旧输入根是 k2-boundary-preserving-r1-20261004-d78e57，以下路径位于其 work 内。

| 位置 | 实际责任/依赖 |
|---|---|
| host/src/credit.rs，Ledger::reserve/reap | source 槽先预留；reap 查询 k1probe.released(outer)，扫描固定槽并退账 |
| host/src/live_source.rs，BoundsSource | Restore.poll_block 前预留；BlockOwner 经 Bytes::from_owner 进入原 decoder；poll/drop 也主动 reap |
| codec-http2/src/k1bounds.rs，CopyLedger/BoundsCopy | 跨页 copy 先预留再分配；同时绑定 payload 与外层 owner；reap 读取二者 released |
| 同文件 CopyStatsHandle::snapshot | 并非纯观察：snapshot 先 reap，再返回汇总 |
| codec-http2/src/k1probe.rs:113-118 | System.dealloc 完成后记录 FREE_DONE 并发布 released；该状态被实现用于正确性决策 |
| host/src/bin/handoff.rs:90-104,136-139 | noop waker＋重复 poll；结束主动 source.reap 和 copy snapshot，不能证明真实唤醒 |

存在两个不同的首次偏离，均保留 fresh 记录：

1. **直接不安装 Tracking allocator**：source/copy ledger 构造时标记 24 B 固定槽 backing，但 allocation 返回 0，frozen_probe.rs:95 的 len==0 断言失败。logs/039、040 两个 plain 子进程都 exit101，尚未进入正常生命周期。仅关闭日志不能消除这条依赖。
2. **保留观察器但不让测试主动 reap**：logs/027 的 source outer 已 FREE_DONE，仍无归还事件；logs/028 的 copy payload 与 outer 均 FREE_DONE，仍无 COPY_RETIRE。精确旧代码抽取 raw 状态分别仍为 live=1、retired=0；独立判定依据是“实际释放已完成而返回事件不存在”，不是相信该汇总。

logs/029 特意单次调用旧 reap，才出现 source retire；该接口无 Context/Waker 登记入口。logs/030 特意调用 snapshot，才出现 COPY_RETIRE。两者是明确标注的**探针驱动负控**，没有作为通过用例的收尾补救。旧接口不具备等待者登记能力的结论还来自其字段/签名和真实调用链；这里不伪称完成了一个已登记 Waker 的原实现竞态测试。

## 3. 所有权释放顺序的最小实验

### 3.1 固定源码事实

固定 bytes 1.11.1 的 src/bytes.rs:250-285 先创建 Box<Owned<T>>，再调用 T::as_ref；:1107-1111 的 Owned<T> 包含 refcount 与 T；最后引用在 :1153-1168 执行 drop(Box::<Owned<T>>::from_raw(...))。

T::Drop 和 T 的字段析构都处于外层 Box 释放之前。把完成动作放在 T 的最后一个字段中也不会跨过外层 Box 的 deallocation。原 decoder 的 ResponseBody/IoStream 则固定为 Data=Bytes（原 host/src/lib.rs:5；原 decoder.rs:525-530），不能直接接收一个外部 guard 而声称 decoder 未改。

### 3.2 关键 raw 顺序

所有行号均指本轮对应 stdout.txt，判据仍为 source outer，以及 copy payload＋outer 的 FREE_DONE 早于归还。

| 实验 / raw | 观察 | 判定 |
|---|---|---|
| logs/007-observer-source-after-data | 页归池后，LAB_RETURN 在第15行，source outer FREE_DONE 在第18行 | 提前归还；共享页仍由池计费 |
| logs/015-observer-copy-after-data | copy payload FREE_DONE 第11行；return 第13行；outer FREE_DONE 第16行 | payload 释放不能代替 outer 释放 |
| logs/008、016，最后字段 Drop | 字段通知仍早于外层 owner FREE_DONE | 不能以析构次序包装成通过 |
| logs/009、010、017 | clone 非最后释放时返回数为0；最后持有者在当前/另一线程释放时，内层回调仍早退 | 最后相关持有者与外层释放须同时成立 |
| logs/011、012、018 | 空源、取消后释放、as_ref 构造 panic 仍暴露同一外层顺序缺口 | 未通过换输入绕过 F1；panic 例 exit101 |
| logs/019、020，不设归还回调 | 真实 allocations 已释放，但没有 return/wake；无唤醒就不再 poll | 漏归还/缺通知，不靠测试反复 poll 救活 |
| logs/021—024，外部 stack guard | drop(bytes) 返回后才 return；登记后释放有真实 Wake，登记前释放可直接 Ready；取消例不返回可交付结果 | 仅是局部机制正控，不是可接入 decoder 的实现 |
| logs/025、026，把外部 guard 再包进 Bytes | 内层 owner 已释放，但新添的外层 48 B owner 尚未释放时已 return | 再包装不能消除外层责任 |

### 3.3 证据层级不能混用

本轮 35 次串行子进程是**所有权能力实验**，不是原 H2→K1→Restore→decoder 的新组合矩阵：

- 25 次 observer：21 个预期 ownership/probe 负控、4 个外部 guard 机制正控。
- 10 次 plain：8 个不使用 allocator 观察的同算法实验，其返回/唤醒/取消结果与 observer 对应运行相同；2 个精确旧账本路径在无 Tracking allocator 下失败。
- legacy 部分从旧 credit.rs、BlockOwner、CopyLedger/BoundsCopy/CopyStatsHandle 原文抽取；构造器用于最小化验证，**未把它说成完整 BoundsSource 或 Restore**。
- 其它 owner 实验使用真实冻结 Bytes 与真实 allocator 释放顺序，但 page pool 是最小模型，不是真实 K1 网络页池。
- LAB_READY / LAB_CANCEL 是实验 Future 的局部标记，不是 02d 的生产 C/D 或 Transport 回调证明。

本轮没有形成可用的去探针信用算法。Counter/Waiter 示例只有一个 token/一个 waiter，用于控制和观察顺序；它**不是**原子登记竞态、多等待者或代际槽复用实现，不可部署。

## 4. 独立核对器及真实通知边界

scripts/check_ownership.py 不接受 live=0、retired 计数或“physically_released=true”自报作为 F1 证据；它按 allocation 身份重建 OWNED_ACQUIRE/FREE_DONE 与 token return 的先后。copy payload 责任由已知 owner 结构确定，不因日志将 payload_required 改成 false 而省略。共享 allocation 去重，独立 copy 仍相加。

- logs/041-strict-source-order-red、042-strict-copy-order-red：严格核对器均 exit2，准确拒绝早退；用例进程 exit0 不等于信用通过。
- logs/043-external-mechanism-positive：严格核对器 exit0，仅证明该外部 guard 的物理顺序。
- logs/044-complete-capability-audit/audit/result.json：35 例分类与预期一致；10 个 **synthetic mutation** 均被识别，包括提前/重复/漏归还、遗漏 outer/payload FREE_DONE、重复物理释放、丢失/提前唤醒、取消后 Ready、漏计 copy payload。synthetic 与真实运行分开，不覆盖原 raw。

机制正控的 Wake 来自实际 Wake::wake 实现，包含锁外重入检查；测试只在观察到真实 wake 后允许第二次 poll。没有 wake 的路径不再 poll；没有固定 sleep、定时扫描、无限重试或每次释放新建任务。线程用同步通道确定最后 holder 的释放时机，而不是依赖延时。

这只覆盖几个有限的 before/after 与顺序取消窗口。多个竞争等待者、登记与释放真正并发交错、取消竞争、迟到 owner/槽复用，以及对应完整链路仍未验证；不能推导通用公平性或已修复共享连接进度。

## 5. 必须保留的回归与未执行项目

完整逐项状态在 results/coverage.json。没有合规候选后，依停止条件未继续开展组合实现或把旧成功填成新 PASS。

| 项目 | 本轮状态 |
|---|---|
| 原28对、原B/A的12对差异 | 旧 sealed raw/index 哈希保留；没有重新运行新候选 |
| 新增44对、17例信用交接 | 旧限定验收基线保留；不是本轮新通过 |
| F2 页面/metadata 配对与清理 | 原实现未修改；没有新候选回归 |
| 真实 K1页 token→Restore→原decoder→受限目的存储 | 新去探针组合实现未形成，未执行 |
| EOF、非空尾部、Pending、错误、取消的完整 source/copy 清理 | 原 r1 证据未改；本轮局部 Drop/空源/panic 实验不能替代完整覆盖 |
| 多等待者、槽复用、取消登记竞态、共享连接恢复 | 未验证；不得称公平性通过 |
| 旧四个 fresh binary 负控 | 旧输入与结果完整保留，本轮未重跑这些旧二进制；不要和当前原文抽取负控混同 |
| 04l 历史四个大样本超时 | 保留、未重跑、未加时限、未关闭 |

baseline/inherited-results-index.json 从旧 delivery 指向的六组最终 checker 输出建立只读索引：abc=28/C-A差异0/B-A差异12，f3=44，handoff=17，gates=9，cost=226，旧 binary red=4。这是核对旧封存原件的摘要，不是重新验收或新的性能结果。

## 6. 状态与责任模型、最小替代方案

design/ownership-gate.md 给出 reserved、fulfilled、retiring、reusable 与取消清理的责任表。关键不变量不变：

- source 额度承担逻辑 outer owner；共享页 payload 由页池承担，页归 free 后仍计池物理预算。
- copy 同时承担独立 payload 和 outer owner；二者未完成前不能复用额度。
- 未兑现预留在 Restore 的实际部分页/metadata 等持有物清理后才归还；它不替 Source/Restore 的包围 Box 结账。
- 取消交付资格与资源责任分离；取消不能让尚未释放责任提前退账，后续退额也不能复活数据交付。

**下一条最有价值的动作是一个窄裁定，而不是继续加用例或放大额度：**是否允许下一独立宿主版本在固定 bytes 1.11.1 私有 fork 中增加 post-owner-free 完成能力，保持 Transport 公共 API/错误码、原 decoder、8192 B 驱动、成员/尾规则、编码协商/window、admission 不变。

候选应在最后引用路径把有限 ReleaseTicket 移到 owner Box 外，销毁 payload/T/整个 outer allocation 后再完成票据；完成记录、固定槽/代号、等待者登记、取消与锁外 wake 统一设计。通知本身的持有物与 tail 也须入账。不能用实验 allocator 注册表、allocation/Weak 扫描、无界完成队列、重试或新建释放任务代替这个边界。

本轮**未实现这个私有 fork、未新增库接口、未改原 decoder，也未裁定其正确性**。直接改 decoder 接收 TrackedBuf 或靠非稳定 Bytes/vtable 布局拼装，不在本轮执行。外部 guard 正控只证明所需后置边界的意义，不是已批准的替代实现。

## 7. 局部成本责任

没有新组合实现，所以不覆盖 r1 F4 的原成本或宣称生产预算减少。仅记录本轮实际受影响的实验对象：

| 对象 | 本轮实际请求/归属 |
|---|---|
| 原文 source owner / copy owner | 56 B / 40 B，仍另计 copy payload 523 B |
| 原文固定 slot，实验 cap=1 | 各24 B backing，存活归零不等于该 backing 释放 |
| 用于内层回调反例的 LabOwner | 72 B；不是新生产 owner 布局 |
| 再包装外层 owner | 48 B，独立相加；不能藏在通知开销中 |
| 模拟共享页 payload / page owner | 16384 B / 32 B；归池后的16384 B仍占预算 |
| Counter/Waiter/Signal | Arc/Mutex/两项 AtomicUsize/AtomicBool/Option<Waker>、Box、Arc/Weak 分别有责任；未实测包装布局不填0 |

候选新增的通知对象、Waker 槽、固定 slot、retiring 记录及历史 capacity 尚无获验布局，不能写成0或套用本实验72 B。下一次局部式至少须包含：固定 slot capacity、内嵌/独立 retiring、等待槽与其任务引用去重、通知池 Arc/Mutex、每个 outer 内的票据、copy payload、构造/增长旧新重叠与取消后 callback tail。不能用无界完成队列替换旧 registry。

observer 使用冻结 k1probe；plain 不安装 Tracking allocator，但为了运行旧无 allocator 负控仍链接 probe 模块，**不宣称清除了全部静态探针成本**。plain 的非 legacy 路径不读该注册表作为正确性状态。r1 的 pool、metadata、Restore.pending/Slab 历史 capacity 与增长重叠、K2 工作区以及 K3/K4 未决继续保留。S=1、X=1、P=4 不是生产配置。本报告不提供完整进程内存上限。

## 8. 精确版本、命令、失败与资源

平台为 WSL Ubuntu、x86_64-unknown-linux-gnu，rustc 1.97.1 (8bab26f4f)、Cargo 1.97.1、LLVM 22.1.6；Python 3.14.4。精确可执行文件哈希、挂载和源码—二进制对应位于 baseline/environment.json 与 logs/045-toolchain-source-binary-link/link.json。

临时根 /home/aquavie/k2-credit-lifecycle-20261005-66c73c 实测为 /dev/sdc ext4；E 的 /mnt/g 实测为 9p。source、target-plain、target-observer、cargo-home、frozen 均在新根内，不使用旧 target 或写旧缓存。该临时根保留用于复核；持久源码、二进制和所有 raw 已在 E。不是凭目录名字推断挂载。

本轮 crate 仅依赖精确 bytes 1.11.1；50 个 vendored 文件与旧输入逐项相同，未升级依赖。58 个最终源码/配置文件与 results/freeze.json 完全一致。最初与最终 Rust 源码相同；首次准备失败之后仅调整新 Cargo.toml 的 source 定位，并新增局部 .cargo/config.toml、生成 Cargo.lock，然后才完成两次成功编译。

| 冻结二进制 | SHA-256 |
|---|---|
| binaries/ownership-order-plain | ae708f7faad54f60892c0230c11dd5a8c9974e58236db01c1a03151a8fbafaf5 |
| binaries/ownership-order-observer | bb210df051b589efcb94c915b915f8f7222f7f0743b967d0759c0a579dd9b540 |

actual argv/cwd/selected env、features、退出码、wall limit、stdout/stderr SHA 全在 results/invocations.jsonl 与 logs/001—045。入口为 scripts/run_lab.py 的 setup/build/freeze/cases，以及 scripts/check_ownership.py、scripts/final_audit.py。构建使用 --offline --locked，plain 为 --no-default-features，观察构建为 --features observer；初始 lock 生成使用 --offline。RUSTC 显式绑定 /home/aquavie/.cargo/bin/rustc，jobs=2，没有修改全局 Cargo 配置。

冻结源码和二进制后，35 个实验子进程串行运行；严格核对与整体分类随后串行执行。两个 features 仅在实验观察代码和 Tracking 安装上有条件差异，使用同一 main.rs（SHA-256 56b327f0c5b16724d5faa3f315c7404b64af029e84ec9bff5b359187f9b7b279）。它们共享的是局部实验逻辑，不是一个已完成的信用算法。

| 类别 | 实际 / 初始上限 | 实际最长 wall |
|---|---|---|
| 构建/lock准备尝试 | 5 / 12；含2次失败，2次实际成功 Rust 编译 | 6.633 s |
| 实验子进程 | 35 / 260；其中3次预期 exit101 | 2.974 s |
| 主账独立核对/源码对应 | 5；其中严格红灯2次 exit2 | 10.706 s |
| 最终保护复核 | 8个固定分批，均 exit0 | 12.097 s/批，原上限40 s未增加 |

原计划还限制总 wall180 min、每实验 wall40 s/CPU8 s/AS512 MiB、构建 wall600 s/CPU480 s/AS3 GiB、单文件32 MiB、新磁盘10 GiB。资源抽样仅说明当次文件逻辑体积：临时根55,119,567 B、持久E 18,651,167 B（报告/封存前），不把它当RSS或生产内存。未运行全仓测试、Clippy、ARM64、设备或生产集成；编译中的5项 dead-code 警告保留，不宣称 lint 无警告。

所有准备失败/执行偏差保留：

1. logs/001 exit101：path dependency 解析要求离线未具备的 optional portable-atomic；改用与旧宿主一致的局部 directory source，不联网、不升级版本。
2. logs/003 exit101：隔离环境未解析到 rustc，编译器未执行；只为子进程设置已验证的绝对 RUSTC。
3. 初始保护审计耗时79.752 s，未受统一40 s包装器控制。这是执行监督偏差，**不计为限额内通过**；原结果保留。最终改为8个事先固定分区，各自保持40 s上限，不延长任何用例时限。
4. 初次宽泛 Git stdout 被截断，随后改为有界摘要与文件记录；文档模板一次 Node 解析失败时没有代码执行/文件写入。WSL 路径转换告警，以及一次 user systemd session 启动告警保留为环境现象；实际子进程退出码独立记录，没有借此修改环境或归因历史四个超时。
5. logs/018 的构造 panic、039/040 的无 allocator 失败，以及041/042的严格红灯是故意保留的失败证据，不算修复成功。

详见 baseline/preparation-events.json。缺口不因实验进程 exit0、某次 guard 正控或最终 hash 一致而被关闭。

## 9. 修改范围与封存顺序

新增范围仅 E 下的最小 Rust lab、vendored 原件副本、manifest/lock、runner/checker、raw、保护清单、设计记录与本报告。没有新合规 source/copy 组合实现，没有业务代码、现行契约、公共 API/错误码、网络/编码/window/成员/admission 的改动。

源码/二进制冻结与35例分类核对已完成；报告完成后再生成 results/seal-04o-66c73c，最后单独写 delivery-04o-66c73c.json。以最后成功核验的 delivery 中 report/seal/hash 为准。delivery 后不回写本文、封存索引或结果；后续修订另立证据版本，不能直接运行硬编码脚本修改本交付。

当前交付是**所有权能力门的阻塞证据与下一最小能力裁定建议**，不是去探针实现通过。完整原28/新44/17、F2、多等待者/取消/槽复用与真实 K1组合仍是后续义务；K2整体、1B整体、r3、1C、G1、生产均未放行，阶段2不开工。

**最终结论：待总工程师验收去探针信用生命周期。**
