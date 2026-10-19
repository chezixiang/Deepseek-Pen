# 04p-r1：去探针组合的外部取消唤醒闭合

日期：2026-10-05（Asia/Shanghai）。单执行者；仅隔离 WSL Ubuntu x86_64 宿主；未接生产、未操作设备、未提交/暂存 Git、未使用子 Agent 或创建/联系其它聊天。

**结果：已形成原实现确定性红灯，完成最小通知修复，并在 plain/observer 的真实 decoder 任务中验证 source 满额、copy 满额及 Restore Pending 的外部取消推进。指定完整回归与负控已实际执行。**

**结论：待总工程师验收取消唤醒闭合。** 本报告不是任何后续阶段或生产放行。

## 1. 基线、唯一修订与保护

唯一证据根 E：

    G:\youdao\Deepseek\docs\astra\evidence\k2-cancel-wakeup-r1-20261005-a0ec52

临时根：`/home/aquavie/k2-cancel-wakeup-r1-20261005-a0ec52`（实测 ext4）；E 的 WSL 视图为 9p。下文日志编号和短证据名均以 E 为根。

以本轮任务输入为准：A 已获**冻结宿主范围限定验收**；B 的真正 Pending 后外部取消通知未闭合。旧04p中B“成立”的文字不作为本次通过前提，旧文、旧seal和结果均不回写。

直接核验 delivery→旧报告→seal；旧 seal 的 **7,863项**与本轮开始实际 hash 全相等。结束对 **34,590文件 / 2,079,645,813 B**重新哈希，0改变；Git HEAD/status/diff/staged原文相同，HEAD仍为 `421e4d075fc5695e627b67b327299456359e5e9e`，用户原9个tracked修改保留。见[输入链](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/baseline/input-chain.json)、[最终保护](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/protection-final.json)。

**A 的36个能力场景和997项原Bytes测试，本轮均未重跑。** 私有Bytes的50个文件与04p冻结源码完全相同；原decoder、宿主Cargo.toml/lock、原handoff/decode的8192 B驱动保持同hash。A仅作继承，不记成本轮新PASS，不重开Bytes路线。

## 2. 原实现的确定性失败

### 首次偏离与遗漏分支

- 原 `Pool::cancel`（冻结 `k2credit.rs:37`）提交cancelled、取走登记Waker后，只执行`drop(old)`，未通知已经Pending的任务。
- `poll_acquire`成功会移出原Waker。source已预留后，任务若在copy或Restore内层Pending，source CancelHandle对应槽没有登记该任务。因此只修source信用满额的wake仍不够。
- 旧 `handoff.rs:106/112` 由驱动在Pending分支自行返回`Ready(Err("cancelled"))`，随后drop decoder，只能检查清理，不能证明外部取消唤醒。旧用例保留为回归，不重新算作外部通知证据。

### 红灯方法与防止假阳性

新 `external-cancel` 将decoder放入独立Tokio任务，另一独立任务负责取消。真实`poll_frame`返回Pending、目标等待登记完成后才允许取消；旧holder不先释放。

初版007暴露了不合格假阳性：先前`scheduler_only` wake仍排队，恰好促使原实现取消后再poll。程序虽exit0，控制器按“应exit24”的断言拒绝它；原源码、二进制、输出保留。随后外层`SettledPending`只在一次真实执行器task poll返回Pending且本次没有新wake时发出屏障；已有通知可自然消费，但不额外wake、不主动补poll、不sleep。

监督timeout只poll **JoinHandle**，不包裹decoder future。超时仅以exit24判失败，失败时不先drop decoder或释放holder救活。保持原Pool/BoundsSource/Restore时，003账本红灯为2项失败/exit101，实际组合如下：

| 构建 | 停驻位置 | 日志编号 | 取消时poll | 监督结束poll | 原实现结果 |
|---|---|---|---:|---:|---|
| plain | source满额 | 014 | 8 | 8 | exit24；live=2，未drop/未释放holder |
| plain | copy满额 | 015 | 11 | 11 | exit24；copy live=2，未drop/未释放holder |
| plain | Restore Pending | 016 | 3 | 3 | exit24；未兑现source仍占用 |
| observer | source满额 | 020 | 8 | 8 | 同上，exit24 |
| observer | copy满额 | 021 | 11 | 11 | 同上，exit24 |
| observer | Restore Pending | 022 | 3 | 3 | 同上，exit24 |

六例是**预期失败**，不是六次取消成功。红绿 `external-cancel.rs` 完全同hash；原IUT身份已由完整bootstrap+delta、全树核对和完整红灯归档确认。见[红灯gate](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/red-gate.json)、[红绿扩展核对](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/external-extended-verification.json)。

## 3. 最小修复

机制修改仅E内三处：

1. [k2credit.rs](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/source/work/codec-http2/src/k2credit.rs)：显式cancel在原State mutex下提交资格、移出Waker，**锁外wake**；重复取消幂等。Waiter detach/Drop只注销，不唤醒销毁中的自身。`register_cancel`与原`poll_acquire`共用同一仲裁；Waker clone、移出后的wake以及incoming/displaced/注销Waker析构都在该锁外。
2. [live_source.rs](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/source/work/host/src/live_source.rs)：Restore返回Pending时，用**现有source WaitKey**登记取消兴趣；取消已先赢得仲裁则走取消清理终态，不丢通知停驻。source信用满原已有`poll_acquire`登记；新登记覆盖copy/Restore/recv等内层Pending。
3. [k1bounds.rs](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/source/work/codec-http2/src/k1bounds.rs)：Restore销毁时detach copy waiter，区分自身销毁与外部取消通知。

另三项源码差异均为测试：新增external-cancel、信用回归/竞态用例、WakeAudit纯读取wake_count。没有改私有Bytes、owner完成ticket、原decoder/8192 B驱动、接受行为、网络窗口/配置、依赖版本；没有增加credit、4个WaitSlot或通知队列。网络fixture原文、State/Slot结构定义一致，见[来源核对](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/provenance-revision.json)、[最小差异](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/minimal-fix.patch)。

cancel不调用complete/retire，不归还owner信用。未兑现source仍先完整销毁Restore再归还reservation；已兑现source/copy仍由未修改的私有Bytes post-owner-free回调归还。已进入完成批次的旧Waker允许迟到；完成不重置cancelled，WaitKey generation保护复用槽。

继承的有限scheduler_only调度不改，也不承担本轮取消推进证明。未采用decoder任务abort方案；末尾网络driver/peer的abort只是继承的宿主连接收尾。

## 4. 真实取消推进与迟到owner

plain 032/033/034、observer 039/040/041全部exit0，实际顺序为：

    静止Pending → 独立任务cancel（再次重复cancel）
    → CANCEL_WAKE（锁外）→ REAL_WAKE（重入两个账本snapshot）
    → decoder一次真实poll → 原decoder实际Ready终态
    → decoder析构 → task future析构/固定Box释放 → JoinHandle结束
    → 检查旧holder仍占信用 → 跨线程释放holder → 恰一次退额

| 停驻位置 | 两构建取消后实际decoder poll | 已交付前缀 | join后、late release前 | late release退额增量 |
|---|---:|---:|---|---|
| source满额 | 各1次 | 29,991 B | source live=1，copy live=0 | source +1，copy +0 |
| copy满额 | 各1次 | 44,991 B | source live=0，copy live=1 | source +0，copy +1 |
| Restore Pending | 各1次 | 0 B | 未兑现预留按清理顺序归还 | 无固定holder，不替代前两例 |

source/copy两例的原decoder实际返回UnexpectedEof错误；Restore例实际返回Ready(None)/eof（0 B）。终态均来自真实poll，保留原decoder接受语义，**不是驱动造Ready**。Restore例用继承的pause_after_partial形成真实内层Pending，不冒充所有网络时序矩阵。取消后的source poll用于观察资格，不是继续读取：核对器拒绝C后新增OUTPUT、DEST_RESERVE、RESTORE_POLL/RESTORE_BLOCK；source/copy输出必须仍为原60,000 B数据的正确前缀。

observer将实际ALLOC_COMMIT与OWNER/COPY_BIND对齐；逐个核对System.dealloc返回后的FREE_DONE先于信用归还。source检查outer，copy同时检查独立payload和outer。迟到holder的FREE_DONE必须位于GATE_DROP_BEGIN/RETURN之间、早于唯一retire。账本Arc、slot backing、holder/WakeAudit Arc、测试future Box另行检查物理释放，不从live=0推断。共享页归free池仍计P×16384，不冒充页面allocation已释放。

plain仅证明相同非探针算法和真实执行器推进，**不伪称测量物理零**。两构建各7项取消trace变异负控、共14项均被拒绝；初版007假阳性也被独立核对拒绝。见[plain](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/check-external-green-plain.json)、[observer](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/check-external-green-observer.json)。

## 5. 本轮回归与未执行项

| 组 | 每种构建新执行 | 结果 |
|---|---:|---|
| 原28对A/B/C | 28 capture + 84 decoder =112进程 | C/A差异0；旧B/A的12对差异保留 |
| 新44对 | 88客户端执行 | 块长/次序/空项、wire/位图、headers、输出、ERROR、EOF前窗口差异0 |
| handoff | 17例 | 原11、Pending恢复/取消/错误、unread tail、cap0/1均保留 |
| F2/空块/布局 | 3+5+1=9项 | 原门控保留；物理metadata清理由observer核对 |
| 原固定holder | 4例+1 fixture进程 | source/copy正常唤醒和旧取消/迟到释放回归 |
| 新外部取消 | 3例+1 fixture进程 | source/copy/Restore真正Pending取消，不靠owner释放推进 |

共享信用算法独立冻结执行一次：**28/28（原15+新增13）**。覆盖重复取消、登记前后、source/copy、cap0/槽耗尽、取消与完成竞争、旧代取消、析构锁外重入、迟到通知及槽复用，共128轮barrier竞争，另有定序尾部barrier。旧“显式取消不通知”错误预期改为恰一次通知，竞争断言由`<=1`强化为`==1`，不是删旧测试换PASS。

保留的B/A差异：`br-multi, br-tail, br-unread-tail, deflate-multi, deflate-tail, deflate-unread-tail, gzip-multi, gzip-tail, gzip-unread-tail, window-log28, zstd-page-split, zstd-tail`。另新执行8个旧二进制负控，原缺陷全部仍可观察/拒绝（含2个预期exit101）；其失败不记为功能通过。

宿主plain/observer Clippy均exit0，各有31条`warning:`日志行；信用测试Clippy exit0、0条该类行。警告原文保留，无--fix批量改库。

**A 36/997只继承，未重跑。** 未执行Miri/Loom/sanitizers/Valgrind、全仓/M01–M31、ARM64/设备/生产、H1/TLS/K3/K4全审计、04l性能及其历史四个超时。有限多等待者不是通用公平性、无饥饿或生产C/D仲裁证明。见[完整覆盖](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/coverage-final.json)。

## 6. 成本与在途责任

| 对象/观测 | 04p → 本轮 |
|---|---|
| source / copy outer | 88 / 72 B → 不变，copy payload独立相加 |
| 每类账本Arc / cap2 slot backing | 360 / 48 B → 不变，两类合计816 B |
| WaitSlot / Waiter / CancelHandle / Ticket | 32 / 24 / 24 / 24 B → 不变，WaitSlot仍4项 |
| Restore / BoundsSource | 216 / 296 B → 不变，后者含前者，不重复相加 |
| 原holder / WakeAudit Arc | 72 / 64 B → 不变 |
| 新测试future Box | 新增固定296 B，observer逐个实际free；非库内owner成本 |
| tagged请求字节并集峰值 | 原回归矩阵103,592 B；新增取消用例103,888 B |

这不是进程RSS/allocator实占，也不能推出完整增量只有296 B。等待copy/Restore时额外的source取消Waker复用已有槽，却带来任务强引用和持有期；同一task allocation按身份计一次，最后引用消失前仍须计责。

cancel锁外调用期间持有移出Waker；登记栈incoming/displaced、完成dispatcher固定批次、旧代通知与新代owner可重叠。barrier实际记录`waiting=0 owner_notify_tail=0 cancel_returned=false old_waker_refs=1 owner_live=1`，并证明旧通知尚未返回时新代owner已复用。**计数归零或cancel返回都不等于所有引用、运行时任务分配和回调/析构尾部已释放。**

固定槽不限制外部线程数量。任意阻塞/异常Waker、递归生产者、运行时task allocation、channel backing、编译器栈/析构尾部、allocator resident overhead及原K2/K3/K4等仍有外部责任，未完整实测的项目不填零。S=1、X=1、P=4仍仅实验值。见[成本核对](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/cancel-cost-audit.json)、[责任条件式](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/design/cancel-cost-responsibility.md)。

## 7. 冻结、失败与资源

最终两构建输入同一**4,338文件**；完整[源码归档](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/snapshots/green-complete-source.zip) SHA256为`7e4aad75711c97f7f71ee32476224e4ee286456b6b43425da1349ff2a9c5af63`。最终16个组合二进制及共享信用测试二进制另冻；两种依赖图各9条直接consumer边均解析到同一私有bytes。plain不含allocator/Weak注册表，nm完整输出与判据保留。

- plain external-cancel：`cc5d8a1d20df9dd6e0b094e0d0d180abe94e263a37f9a1e4da2850356a1b8047`
- observer external-cancel：`5617ae6b337d94e2ade3b573a697226fad213ed333ce9060bb9ebc3a84268ee5`
- 原decoder：`b280580f531df9e177e8b4049b74df728615f2c2c6bd81af03add442cfa77cee`
- 原宿主lock：`c85381694ea72304054b4b2cf512ab1a0093ed603c54b6911c24472f3ec23238`

Rust/Cargo1.97.1、x86_64 GNU/Linux，实际工具hash和版本前后相同；Cargo全程offline+locked，无全局Cargo配置或旧缓存写入。实际argv/cwd/env/限额/exit/raw hash见[invocations](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/invocations.jsonl)和各logs。543条主调用的2,424个原始文件重新哈希，0差异；本地/持久源码和最终二进制另核对。

必须保留的失败/偏差：

1. 003、014–016、020–022为修复前红灯；522/523为旧plain负控，非零exit均保留。
2. 007的exit0排队wake假阳性被拒绝；009测试局部bool遮蔽AtomicBool导致E0599/exit101，修正测试变量名后才建立合格红灯，当时IUT未改。
3. 025归档、532组合身份、533单构建身份审计均触发原40s监督/exit -9，**未改记成功、未加时限、未宣称找到共同根因**。025在写出完整身份JSON后留下未完成zip，原件保留。534带阶段标记在16.24s核对全源hash与plain 8个binary，但未复现旧停顿；随后Windows完整核对/归档、observer本地hash和逐binary nm分别补齐同判据身份链，不关闭失败记录。
4. 530成本V1错误比较cap2-only的[48]与完整cap1/cap2矩阵[24,48]，exit1；V1保留。V2仍要求完整矩阵前后相等，另明确外部source/copy cap2均48 B；不改IUT或成本数据。
5. 继承run.tree通用target过滤漏4个合法vendor/cc/src/target/*.rs；红灯由完整bootstrap+delta/全树hash补证，旧清单保留。green prebuild/freeze已完整覆盖4338文件。其它读取截断/路径误判、补丁空格断言、文档生成引号准备错误及WSL user-session告警记录在preparation-events，不隐藏成无失败流水线。

主账**11 build /489 case /43 audit**；最长构建63.022s、用例2.428s。原计划仍为总wall240分钟，build≤24/case≤600/audit≤100；build600s/CPU480s/AS3GiB/jobs2；case12s/CPU8s/AS512MiB；audit40s。三项审计超时不宣称“限额内成功”。保护、Windows持久核对和封存等额外动作另记，不混成测试。封存前临时+持久apparent bytes为3,371,583,123 B；预留64MiB文档/seal后仍低于12GiB；不是RSS。见[资源与失败总账](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/results/closure-summary.json)。

04l四个历史超时和04p旧失败继续保留，未重跑、未归因关闭。[自审](G:/youdao/Deepseek/docs/astra/evidence/k2-cancel-wakeup-r1-20261005-a0ec52/design/final-self-review.md)是单执行者自审，不冒充第二人审查。

## 8. 交付顺序与未放行边界

本报告完成后生成全新的`results/seal-04p-r1-a0ec52`并只读核对；最后**单独写入**`delivery-04p-r1-a0ec52.json`。精确报告、源归档、seal与hash以delivery为准。本目录交付后只读，后续修订另建版本；旧04p报告、封存和结果不回写。仅供用户手动转交，不自动联系其它聊天。

02d有效；02f仍为草案。**不得据此宣布K2、1B、r3、1C、G1、生产或阶段2通过。** 外部任务/通知尾部完整预算仍待总工程师裁定。

**最终结论：待总工程师验收取消唤醒闭合。**
