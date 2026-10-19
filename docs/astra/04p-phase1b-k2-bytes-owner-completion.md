# 04p：路线 C K2 / M2 私有 Bytes 完成能力与去探针组合验证

日期：2026-10-05（Asia/Shanghai）。单执行者，隔离 WSL Ubuntu x86_64 宿主；未创建或联系其他聊天、未使用子 Agent、未操作设备/生产、未提交或暂存 Git。

**结果：A 私有 post-owner-free 能力、B 去探针 source/copy 组合，在本报告限定的冻结宿主、特征与责任约束内成立。原有回归与新增真实唤醒/取消用例已实际执行；这不是 K2、1B 或生产放行。**

**最终结论：待总工程师验收私有完成能力与去探针组合。**

## 1. 唯一证据根与保护

本轮证据根 E：

    G:\youdao\Deepseek\docs\astra\evidence\k2-bytes-owner-completion-20261005-9ab41e

以下相对路径均基于 E。新临时构建根为 /home/aquavie/k2-bytes-owner-completion-20261005-9ab41e，实测 ext4；持久 E 的 WSL 视图为 9p。没有在 04o、04n-r1 目录中修改或重跑脚本；旧二进制复制到本轮目录、核验 hash 后才执行。

已通读用户指定的 04o、delivery-04o-66c73c.json、ownership-gate.md、04n-r1，并由 delivery 定位冻结源码/日志/继承基线。baseline/delivery-chain-verified.json 直接核验两份 delivery→report→seal 及 04o 的58个冻结源码文件。对同一 **26,723 文件、1,223,547,015 B** 保护集合开始/结束重新哈希，0差异；每轮8个固定分区各守40秒上限。results/protection-final.json 另确认 Git HEAD/status/diff/staged 原文相同，HEAD仍为421e4d075fc5695e627b67b327299456359e5e9e，原9个tracked修改保留。

02d仍有效，02f仍草案；04o阻塞证据已验收但旧去探针生命周期未通过这一输入裁定不回写。其余未放行状态、K1原范围边界、r3/1C/G1/阶段2限制均不扩大。

## 2. A：私有 Bytes 完成能力

### 2.1 根因与最小改动

04o的缺口是 T::Drop／最后字段 Drop 仍先于外层 Owned<T> allocation 释放。本轮先用原库形成红灯：logs/004 中 payload FREE_DONE 后出现 COMPLETE，但 outer FREE_DONE 更晚；logs/005 独立核对器 exit2 拒绝，不把用例自身exit0当通过。

仅在固定 bytes **1.11.1** 新副本加入显式 feature **private-owner-completion** 和 **Bytes::from_owner_with_completion**，使用独立 CompletedOwner<T,F>/vtable。原 from_owner 和原 Owned vtable 原文相等（results/a-independent-audit/result.json）；Bytes仍是原类型，decoder不变。库内完成机制是通用 FnOnce()+Send+'static，不包含K2预算、槽位、Waker或业务状态。

最后引用路径：Release减计数→最后引用Acquire同步→只将 ManuallyDrop<F> 从owner字段取出到栈guard→drop(Box<CompletedOwner<T,F>>)→guard调用F。**T不在as_ref后移动；T及其字段销毁、整个outer allocation释放后才完成；free后不访问owner地址/字段/借用。** 构造仍先把T放到最终堆地址并装好Bytes/vtable，再恰一次as_ref，最后设置ptr/len。新增unsafe依赖库内自身类型，不在库外推测Bytes/vtable布局。

T/F只要求Send而不要求Sync：共享阶段只读字节，最后线程经引用计数同步独占销毁T/F。clone/slice/split以及Vec/BytesMut转换均进入同一最后释放实现，不仅修普通drop。转换产生的独立副本不因原owner完成而消失，仍由转换调用者承担。

### 2.2 异常、证据与限制

18类测试在observer/plain各执行一次（共36个子进程）：普通drop、最后clone、slice、两种split、空owner、Vec、BytesMut、保留clone的转换、try_into_mut拒绝后释放、跨线程最后释放、并发clone、inline地址稳定、clear、as_ref panic、部分构造后as_ref panic、T析构panic、正常完成动作panic。

观察构建的18例均由实际System.dealloc返回记录独立核对payload/outer先于完成；10个synthetic篡改负控均被拒绝。构造及T析构的**单次unwind**同样先完成Box清理再调用F。正常路径F panic在owner已释放后传播，Option先take避免再次完成。已有unwind时F及其捕获物析构不得再次panic；双panic、OOM/abort、故意泄漏、任意外部共享payload持有不能冒充正常清理保证。

可用原bytes源码/测试通过同源离线harness运行：**997项通过，0失败**。harness只避免解析当前vendor缺失的dev/optional包，不代替消费者依赖图。private开启/关闭两次no_std宿主编译检查通过。Miri、Loom、ASan/TSan、Valgrind未运行；serde_test、portable-atomic特征、rustdoc矩阵和原MSRV 1.57未验证，不宣称形式化安全或所有T/F组合均穷举。

A前置结果在 results/gate-a.json 落盘后才进行B；没有绕过前置门。

## 3. B：真实信用生命周期

### 3.1 同一去探针算法与有限仲裁

source和copy共用 source/work/codec-http2/src/k2credit.rs。固定credit槽（本轮cap0/1/2对照，正常cap2）以池内slot+单调generation标识，区分reserved、fulfilled、retiring、reusable；4个固定WaitSlot另有代号和取消资格。检查可用性、登记/替换Waker、取消移除及归还提交在同一mutex仲裁；Waker clone/旧值drop和wake不在该锁内执行。

每池只允许一个通知dispatcher，使用固定4项栈批次；并发完成只合并pending位/固定等待槽，不建无界完成队列，不每次释放创建任务，不扫描allocator/address/Weak来归还额度。资源归还不重置取消位；旧owner或旧waiter代号不能影响新代。snapshot只读，不调用reap/complete/notify。

source在Restore.poll_block前预留；未兑现预留先drop Restore及其实际持有物再归还。已兑现owner的Drop只标retiring，真正退额由私有Bytes后置ticket完成。copy同时承担独立payload和outer；信用满时Pending并保留最后页，唤醒后恢复同一块，不吞块或改变空/EOF语义。诊断pause也用一致锁和真实Waker，resume/fail在锁外唤醒。

15项共享算法测试通过，含两组各32轮真正barrier并发交错、登记前/后释放、多个等待者、取消竞争、旧代/重复完成、waiter槽复用、跨线程最后释放、cap0、等待槽满额、纯snapshot、构造前/后兑现失败以及旧通知尾部仍在而新代owner已复用信用。修复前090缺唤醒、091丢失未兑现状态均exit101；修复后096为15/15。fulfilled单独保留，避免retiring抹掉构造失败责任。

### 3.2 真正组合而非只测账本

实际链路为 **K1页token→Restore→source/copy账本→原wreq decoder→受限17 B目的copy/J存储**。原8192 B驱动、成员/尾检查、空块语义和网络设置不改。handoff及empty-gate不再用noop反复poll推进解码，也没有测试末尾reap。

新增固定holder组合在两种构建各4例：source等待、copy等待，以及二者的取消/迟到完成。使用一个固定持有引用及一条预创建释放线程；实际等待已登记后才跨线程drop最后holder，产生真实Tokio Waker。Wake对两个账本重入snapshot，实际证明锁外wake。正常两例输出均为完整60,000 B；取消例只交付29,991/44,991 B前缀，C后无新读取、Restore poll或目的交付。取消后先销毁decoder，再释放迟到holder，不能借取消提前归还。

独立核对除了FREE_DONE早于credit，还将OWNER/COPY_BIND身份与GlobalAlloc实际ALLOC_COMMIT配对，核验J归还在目的allocation实际free之后、未兑现归还前Restore.pending backing清理。固定池/slot、holder Arc、WakeAudit Arc逐个另验FREE_DONE，不能用owner live=0推断它们或任务已释放。详见 results/check-observer-actual/result.json、results/physical-binding-audit.json。

plain不安装Tracking，且不编译主allocator表及POOLS Weak注册表；nm和源码核对见 results/provenance-audit.json。observer与plain共享相同credit算法及私有Bytes源码。观察器只能记录；plain日志中的ID=0是“未观测”，不是物理存活/预算为零。页池observer快照已取消retain清扫，仍可短暂升级Weak进行观察，相关观察保留另计，不参与信用算法。

### 3.3 去探针附带修复边界

v1 plain在115因HPACK既有allocation诊断将两个未观测ID 0比较而panic。v2只对那段owned/query/assert诊断加observer条件编译；HPACK的copy/advance原文不变，不伪造非零ID，不改协议接受/错误。原压缩decoder文件完全未改。这不是扩大为HPACK/K3全审计。

## 4. C：实际回归与未执行项

以下每一项均在**冻结v2的observer和plain分别新执行**，不是把旧成功填成新PASS：

| 组 | 每种构建实际执行 | 独立结果 |
|---|---:|---|
| 原28对A/B/C | 28次capture+84次原decoder重放 | C/A差异0；原B/A的12对差异集完整保持 |
| 新44对 | 88次原客户端/恢复客户端执行 | 取得块长度/次序/空项、wire、位图重放、headers、输出、ERROR、EOF前窗口均无差异 |
| 真实交接 | 17例 | 原11例、Pending恢复/取消/错误、unread tail、cap0/1对照保留 |
| F2/空块/布局 | 9项 | legacy churn、混流配对、页额度及空记录满额恢复/取消/错误/关闭均通过 |
| 新固定holder真实等待/迟到释放 | 4例+1次fixture生成 | source/copy均验证真实wake；取消不恢复交付 |

plain的F2实际配对/行为已验，**物理metadata清理由observer实际allocation证据核对，plain不伪称也测得物理零**。F3有限阶段step重放用于边界/接受比较，不拿其noop窗口观察冒充新信用唤醒证据；真实唤醒由handoff、empty-gate及固定holder组合证明。

旧聚合差异仍为gzip/br/deflate tail与multi六对，zstd-tail、window-log28、zstd-page-split及gzip/br/deflate unread-tail六对。额外新运行8个旧二进制负控：旧F1早退、F2积压/混流、F3丢空块，以及04o source/copy内层提前完成、plain legacy两次预期101。其余04o旧封存原件只读保留，未伪称全部35例重跑。

**历史04l四个超时仍开放，未重跑、未加时限、未归因关闭。** 未执行全仓/JS Transport M01–M31、H1/TLS/K3/K4全审计、04l性能轮次、ARM64/设备/生产集成。有限多等待者测试不是共享连接通用公平性/无饥饿或生产C/D/J仲裁证明。

## 5. D：新增成本与待裁定责任

详表及条件式见 design/cost-responsibility.md、results/cost-audit.json。

| 对象 | 本轮值/责任 |
|---|---|
| source outer / copy outer | 88 / 72 B，相对原56/40各增32 B；copy另加独立payload |
| 每类账本Arc / credit slot | 360 B / 24 B；cap2时48 B backing，不随live归零消失 |
| WaitSlot / Ticket | 32 B，4项已内嵌State；Ticket24 B已在outer内，不能再加一份独立堆对象 |
| 两个cap2账本+slot合计 | 816 B；旧336 B，固定堆责任增加480 B |
| Restore / BoundsSource | 216 / 296 B，后者包含前者，不重复相加 |
| pending历史backing | capacity4×Held64=256 B，len=0不等于释放 |
| 测试holder/WakeAudit Arc | 72 / 64 B，另于业务owner计责 |

共享页按实际allocation去重，归free池仍计P×16384；独立copy与原页并存相加。copy payload实际523/15000/15009 B。Slab本轮观察960/1920 B历史容量；增长保留旧+新条件责任，不能把realloc后日志冒充瞬时重叠已测。带tag请求并集峰值103,592 B只覆盖观察域，不是进程RSS/完整生产上界，也不与旧小样本直接作性能结论。

构造旧/新owner、页/copy、F从heap移到stack guard的重叠必须保留。callback body计数归零不代表Ticket参数、Arc、Waker任务或栈尾已消失；每池固定登记/移出批次外，活跃poll栈的incoming/displaced Waker和释放线程的嵌套ticket仍有责任。外部任务体、编译器构造/回调栈、实验channel/线程运行时、allocator实占及原K2/K3/K4包装/workspace等未完整实测，**不填零**。任意外部线程、递归产主者/异常Waker、日志sink失败和生产取消仲裁不在本宿主上界承诺内。

S=1、X=1、P=4仍为实验值。采用私有fork、进一步安全工具/目标验证、生产总预算及外部责任界限均待裁定。

## 6. 冻结、命令、失败与资源

Rust/Cargo1.97.1、LLVM22.1.6，x86_64-unknown-linux-gnu。精确版本/挂载及实际toolchain可执行文件hash在 baseline/environment.json、results/runtime-identity-final.json。全部Cargo准备/编译使用offline，锁具备后locked；依赖未升级，全局Cargo配置和旧cache不写。

最终候选：results/freeze-integrated-v2-observer.json、freeze-integrated-v2-plain.json，分别关联119/120构建；两份源码清单相同，共4,337文件，源码归档为 snapshots/integrated-v2-source.zip。14个最终二进制完整SHA都在freeze中；handoff示例：

- observer：5bd2a63df8107c3c93eb6ca23a6a140ab1831834e213a125c7e1e908df11e784
- plain：08cddd043d5735400df1eaa9f57ab03f99a0ce5fe396914f87851abf00be63f6
- 原wreq decoder：b280580f531df9e177e8b4049b74df728615f2c2c6bd81af03add442cfa77cee
- 原完整宿主lock：c85381694ea72304054b4b2cf512ab1a0093ed603c54b6911c24472f3ec23238

私有bytes仅4文件差异，原包checksum仅作上游归属，不冒充修改后源码hash。results/private-changes.patch和provenance-audit.json列出隔离源码26项变化；results/final-consumer-graph.json确认两种构建的9条直接consumer边均解析到同一私有bytes，防止双Bytes类型。results/final-integrity.json及persistent-integrity.json核对源码、二进制和raw哈希；信用测试源码与最终算法、A源码与最终私有bytes一致。

完整actual argv/cwd/features/env/退出码及stdout/stderr hash在 results/invocations.jsonl、logs/*/result.json。主要入口为scripts/run.py、matrix.py、run_checks.py、capability_matrix.py及独立cost/provenance/physical_binding审计；不在旧目录执行脚本。测试先冻结再串行，无每次释放创建任务、定时reap或重试救活。

原有限计划不变：总wall240分钟；build最多24、case最多600、audit最多100；build wall600s/CPU480s/AS3GiB/jobs2；组合case wall12s/CPU8s/AS512MiB；能力case wall30s/CPU16s；audit wall40s；单case文件16MiB、新磁盘12GiB。最终主账 **14 build / 543 case / 65 audit**；构建最长101.216s，用例最长4.514s。保护/持久化/封存等额外closure动作另列，不混成用例。两个40秒同步超时是失败，不是限额内成功。临时树测得2,246,135,272 B；持久树和最终closure统计见results/closure-audit.json，不当作RSS。

必须保留的失败/偏差：

1. 005严格红灯exit2；090/091修复前账本测试exit101；617/618旧plain负控exit101，均为预期失败证据。
2. 首次9p全树同步没有统一超时监督，见到PID602在p9_client_rpc后定向TERM，外层exit15，明确监督偏差；080同步wall/-9及首次stdin对照wall/124原件保留。后来同hash/ext4+有限WSL保活对照成功，不证明旧失败同因，不关闭历史超时。保活不参与任何信用状态，已按PID/boot id核对后停止。
3. 115 plain HPACK观察断言exit101为真失败，v1源码/二进制/raw保留；v2最小诊断隔离后复验通过。
4. 140独立核对器因JS替换字符串破坏Python正则而SyntaxError/exit1；失败脚本保留，修复生成并AST预检，IUT及物理判据不变，141/142通过。
5. WSL启动告警、准备路径误判、长输出截断后分段重读、两次Node解析失败未执行均记录在baseline/preparation-events.json。无删除失败原件、加时限或伪造退出码。

selected-host和private-bytes Clippy均exit0但有保留警告；没有--fix批量改动、不宣称lint零警告。单执行者自审见design/final-self-review.md，不冒充第二人审查。

## 7. 交付顺序和判定边界

本报告完成后新建 results/seal-04p-9ab41e；最后单独写 delivery-04p-9ab41e.json，以delivery列出的报告、seal与hash为准。delivery是本轮最后写入；此后任何修订另建证据版本，不回写旧交付。

A/B为本冻结宿主条件内的机制/组合结论；C如上区分本轮执行、继承保留和未执行；D仍有明确未裁定责任。**不得据此宣布K2整体、1B整体或生产通过。**

**最终结论：待总工程师验收私有完成能力与去探针组合。**
