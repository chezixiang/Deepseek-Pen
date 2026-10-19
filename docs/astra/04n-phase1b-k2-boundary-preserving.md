# 路线 C K2：保留解码输入边界与真实源交接的有限验证（04n）

日期：2026-10-04，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收 04n。** 在本轮冻结限额内，边界保留方案在 04m 全部 28 对输入上恢复了原始取得序列并消除了接受/错误/前缀/完整输出差异；真实 K1 页 token、源 reservation 与原始 wreq decoder 已在同一任务闭合，S=1+X=1（读侧 cap 2）、P=4 全部为实验值。本结论不宣布 K2 整体、r3、1C/G1 或生产通过；02d 仍为现行规范，02f 仍草案，M1（批准 K1 聚合分片语义）仍未裁定，04l 四个历史超时原样保留。

证据根 E：`docs/astra/evidence/k2-boundary-preserving-20261004-f9cac7/`。本轮只新增 E 与本文；既有项目、原型、契约、报告、缓存、归档、旧证据（含旧未完成目录 `k2-boundary-20261004-6c2a91`）只读。无生产接入、无设备操作、无 Git 提交、无依赖升级、无全局 Cargo 配置修改。用户手动转交。

## 1. 输入、边界与目标

本 = 04m §1.2 所述"若不批准 M1，另立有限边界保存方案"的有限验证。输入边界：K1 固定范围条件关闭（04k）与 04m 的 28 对实际捕获（24 主矩阵 + 4 跨页反例，`tests-a0d2a847`、`boundary-1daf353f`）是唯一行为基准；04l 条件包络沿用；04m 的旧聚合差异保持负向对照，未修改输入或旧结果。目标：相同上游取得序列下，聚合存储不改变 decoder 可见字节、逻辑块边界与顺序；随后把真实 K1 页 token、源 reservation 与 decoder 串在同一任务。本方案不改 decoder：不统一拒绝多成员或尾部、不改 window/编码协商/错误/API/成员政策、不加满池 RST/admission、不做无界逐帧对象队列——本轮零冲突，无需最低行为变更提案。

副本来源：从核对后的封存目录建立新副本（`prepare.py` 校验 04k/04l/04m 三条 delivery→report→seal 链后，逐文件对 `seal-e629f703/artifacts.json` 断言哈希，6044 项全部通过；codec 四个关键文件与 b7e409 封存互证、`vendor/wreq-5.3.0/src/client/decoder.rs`（sha `b280580f…`）与 c84a16 互证）。旧 6c2a91 只有 `prepare.py` 与空 vendor，未作为基线，仅保留。

## 2. 方案（候选实现，非预先批准）

**区分物理页与逻辑源块。** 存储 = 04k 页池原样（p=16384；`recv_data` 聚合、`Bytes::from_owner(Page)` 发布、池恒等式 `live=queued+held`、`allocated=live+free` 不变）。逻辑源块 = 每个 DATA 帧负载；采集位置 = 04k codec `recv.rs` `recv_data` 的 append 循环（对应关系：客户端窗口 6291456/15728640 ≥ 帧长，每帧恰好产生一个原始 RecvStream 返回块——封存 original.chunks 与 WIRE DATA 帧逐帧一致，04m check.py 已证，本轮 checker 复核），不拿服务端 write、压缩 frame 或页边界代替。

**边界 metadata（位图候选，本轮实施；紧凑偏移候选仅分析）。** 每页恰一个固定 `PageBounds { bits: [u64; 256] }`（2048 B）：bit i ⟺ 页内字节 i 是某逻辑块末字节；随页信用在分配前取得（`BOUNDS op=acquire`），与页同生共死。跨页续块 = 页 fill 末字节无 end bit（fill==p 且 bit p-1 为 0 的唯一语义），无跨页指针。1 B 块最坏情形不需要逐块对象；紧凑 u16 偏移候选最坏 32 KiB/页且需扩容路径，最坏界劣于位图，未实施。`Page` 增加 `Option<Arc<PageBounds>>`（48→56 B，实测）；`Event`/Slab 槽实测 240 B 不变（Headers 变体主导），04k Slab 公式常数在本 target 继续有效。

**恢复（`k1bounds::Restore`，codec 副本内新公开模块；`poll_data` 等既有路径零改动）。**
- 单页块：`page.slice(pos..=e)` 零复制视图，owner 仍是页（引用计数，popped-but-held 由池账本计量）；
- 跨页块：在下一页找到 end bit 后按已知总长**一次**分配连续副本（无 realloc），预算计数器在分配前检查（超限 exit 73，沿 04k 有界停止约定），重叠成本记录（源页仍 held + 副本并存，相加不去重）；末页剩余部分继续作为当前页（不丢块）；
- 部分页立即消费：首个 poll 即发布队首页并交付其中完整块；不等满页、不等 EOF、不收集完整响应、不拼完整压缩 frame（zstd 单遍捷径的输入形状与原始路径逐块相同）；
- EOF 无悬空续块（不变量，违反即 panic 停止，不静默）；每交付一块 `release_capacity(len)`，与封存 original 路径的逐块 release 对齐。

## 3. 阶段 1：三路对比（28 对，全部成立）

每对三路（复用封存捕获，不重捕旧路径；`decode` 宿主与封存调用形状逐参一致：原 tokio-util 0.7.18、cap=2、原 8 KiB 驱动、原成员设置与尾检查、17 B 目的复制；decoder.rs 一字未改）：

| 路径 | 输入 | 结果 |
|---|---|---|
| A 基线 | 封存 original.chunks | 28/28 复现封存 original RESULT/ERROR/输出 sha（`A_matches_sealed` 全 True；构建环境健全） |
| B 负向对照 | 封存 k1.chunks | 28/28 复现封存 K1 结果；A/B 差异集合 = 封存 12 对（gzip/br/deflate-tail、-multi、zstd-tail、window-log28、zstd-page-split、三个 unread-tail），`CONTROL-B-VS-A-MATCHES-SEALED True` |
| C 边界保留 | 新捕获恢复序列 restored.chunks | **28/28 与 A 全等**（status/total/ERROR 行/输出 sha256/字节数；`DIFFERENCES-C-vs-A []`） |

恢复正确性的三重核对（全部通过）：
1. `capture-bp` 在进程内从真实页+位图恢复，`RESTORED` 块序列与封存 original.chunks 逐块逐字节相等（28/28）；
2. `PAGE_AUDIT`（每页 fill + 256×u64 位图）由独立 checker 只用 fill+位图重放块序列，与封存 original.chunks 全等（28/28）——与恢复实现无关的独立路径；
3. `PAGE_FILL` 页序列（实际存储状态）与封存 k1.chunks 逐块相等——聚合行为与 04m 的 K1 一致，证明捕获可复现（28/28）。

覆盖形态：单页多块（fragmented 13 B 碎片，最多 41 块/页）、跨页源块（zstd-page-split：块 2 = 页 1 尾 84 B + 页 2 首尾 439 B → 一个 523 B 连续副本，**未拆成两个 decoder 块**）、部分页立即消费（全部用例）、多成员/尾随/截断/zstd 大 window 与 legacy 4/7/mixed。新捕获 28 次、解码 84 次（28×3），全部 exit 0，最大用例 wall 5.8 s（限额 12 s）。

**仅拼接后字节相同不构成证明**：判定使用块级序列相等 + 行为四元组（接受/错误/前缀/完整输出）相等，且恢复来源是本轮的真实 K1 页池与元数据，不是从 original.chunks 反拼。

## 4. 阶段 2：真实源交接（11 例，全部成立）

不再文件重放：同一 current_thread 运行时内，loopback peer → 04k codec（真实页 token：`PAGE reserve/publish/retire`）→ `Restore` → 实现 `hyper2::body::Body` 的读侧（每交付块一个 owner 对象，单页块零复制包裹、跨页块为副本）→ `lib.rs` 同一 `client::decoder`（含原 wreq decoder.rs）→ 8 KiB 断言 → 0 信用三次调度访问检查 → 17 B 目的复制（`DEST reserve → D move_to_J → J retired` 链）。

用例（11）：gzip-normal、gzip-fragmented、gzip-multi、br-tail、deflate-multi、zstd-tail、window-log28（FCS512/大 window 声明）、zstd-page-split（跨页）、gzip-truncated 九个 normal + gzip-normal cancel + zstd-normal fault。结果：accepted=3 / rejected=7 / cancelled=1 / fault=1（rejected），source_blocked=0，全部 exit 0，最大 wall 1.85 s。每例：
- 读侧 owner 账本 acquired==retired、结束 live=0，**峰值恰为 2 且从未超过**（S=1 当前持有 + X=1 换块/尾检查；达界 Pending，外层按有界停止观察——本轮无任何用例触达 blocked）；
- 页池收尾 `POOL live=0 queued=0 held=0 free==allocated bounds_live=0 bounds_acquired==bounds_retired`；
- 跨页副本仅 zstd-page-split 1 例（523 B）：`COPY_ACQUIRE/RETIRE` 恰一次、`COPY_FINAL acquired=1 retired=1 peak=1 live=0`；
- cancel：C 只记意图（`C held=true credit_reused=false`），持有块未交付（.out 为空前缀），final drop 后全部账本归零；fault：注入 ConnectionReset 在源 EOF，已输出前缀先交付，错误恰一次。

S/X/P 显式记录（**实验值，不批准为生产数值**）：常规槽 S=1、换块额度 X=1（读侧 cap=2，与 04m §4.2 `h_owner <= S+X` 一致）；派生页 P=4（K1_PAGE_CAP，沿 04m）；副本 cap=2/流。取消提交 ≠ 已释放：全部非超时用例以真实 dealloc 后账本归零为释放证据；逻辑长度归零（Bytes advance）、入空闲池（PAGE retire）、物理释放（Tracking 台账）分别记账。

## 5. 条件成本（实测常量；条件式，不是生产预算）

x86_64 Linux 宿主（WSL2 Ubuntu，rustc 1.97.1，dev/debug=1）实测：

| 项 | 实测/条件上界 |
|---|---|
| `Page'` | 56 B（48+8，`Option<Arc<PageBounds>>`）；`Event`/Slab 槽 240 B **不变** |
| `PageBounds` | 2048 B/页，恰一次分配/退役；live ≤ 页 live ≤ cap |
| `MetaB_s(t)` | ≤ 2048 × P_s（本轮峰值 2 页 = 4096 B） |
| 跨页副本 | 每跨页块一次连续分配，分配前取预算，≤ 块长（本轮全局仅 1 次 523 B；流 cap 2） |
| 并持（视图） | 单页块零复制共享页 owner；池不变量每例核验 |
| `BoundsCopy_s(t)` | ≤ live_copies × 65536（本轮输入 ≤65536 的条件界） |

更新后的条件式（在 04k/04m 基础上新增两项，**04k 未含边界记录的容量结论不用于本方案**）：

```text
h_owner <= S+X（实验 2）；h_pages <= min(2L, S+X)
P_s >= sup_u[Nq(L_s(u)) + min(2*L_s(u), S_s(u)+X_s(u))]          # 04m §4.2 原式
K1_bounds_total_s(t) <= 376841 + 80 + 16384*P_s + Meta_s
                        + 2048*P_s                                # 位图（新）
                        + sum(live cross-page copies)             # 跨页副本（新）
```

仍不含 K2/K3/K4 包围对象、目的/J、allocator 实占/碎片，不是生产总预算；Slab/owner 常数仅对本 target 有效。

## 6. 有限验证、失败账与根因修复

限额（`resource-plan.json`，实施前冻结；唯一修订：捕获次数 24→28，因 4 个边界用例有独立输入，修订发生在首个实验前并记录）：构建 ≤6 次实际 8 次（含 5 次编译失败与修复后重建，见下）、用例串行、单用例 wall 12 s/CPU 8 s/AS 512 MiB/文件 16 MiB/poll ≤100000、捕获输入 ≤65536 B、PING 屏障 2 s、无 GiB 压力、不把 32 active 当存活 decoder 数。04l 四个 raw/short-17 超时未重跑、未关闭、未加时限。

独立核对器 `check_bounds.py`（2352 行，不 import 封存 checker；自测 9 正样本 PASS + 5 负样本恰命中目标 FAIL）：最终 `summary` 123 任务全部 PASS（`checks-5f8d4a35/summary.json`），覆盖 WIRE/CLIENT_CHUNK/.chunks 三方一致、位图独立重放、账本恰一次、D/J 链、池收尾。

失败不删除、不改判（全部 run 目录保留）：
1. 构建 101 ×5：`recv_init` 绑定丢失（补丁脚本写回缺陷）、指针类型、`Arc` 导入、`PageObserver: Send + Sync`——逐个修复并保留失败运行；
2. 阶段 1 首跑：capture-bp 输出目录 NotFound（驱动未先建目录）→ 二进制内 `create_dir_all` 修复；
3. 阶段 1 次跑：驱动脚本 KeyError（封存字段双形状）→ 兼容修复；
4. **阶段 2 两次 2 s 屏障超时（zstd-page-split）**：首个假设（冷页入）被受控重跑证伪；进程采样 `wchan=p9_client_rpc`（D 状态）+ tmpfs 8/8 过 vs DrvFS 5/5 挂的对照定位根因——Rust 行缓冲 stdout 每行一次 9p RPC，日志落 DrvFS 时屏障预算被写日志吃光（04m `boundary-b483db9b` 同款失败同根因）。最小隔离修复：run.py 先落 /tmp（tmpfs）再复制回 E（日志字节相同、证据位置不变，纯 harness 修复，不触及被测行为）；修复后同用例同限额通过并全程复跑。**未加大 2 s 时限**；
5. 核对器三处契约歧义按实现/文档裁定（位图 u64-LE 序、boundary outcomes 回退、cancel 的 OUTPUT=解码量 vs .out=交付量），并在其判断清单中留痕；checker 同时发现宿主 `COPY_FINAL acquired` 计数缺失（`stats.acquired` 未增）→ 修复后 123/123。

## 7. 验收边界与交付

| 问题 | 本轮结论 |
|---|---|
| 边界恢复是否成立？ | **成立（28/28，冻结限额内）**；覆盖单页多块、跨页源块、部分页立即消费；不含不同网络调度等价、完整 wreq 网络栈、H1/TLS |
| 接受/错误/前缀/完整输出差异是否消除？ | **C vs A 全部消除（0/28 差异）**；旧聚合 12 对差异原样保留为负向对照 |
| metadata/跨页复制/并持成本？ | §5 条件式 + 实测峰值；位图 2048 B/页、跨页副本 1 例 523 B、owner 峰值 2；均为候选实现条件成本，非容量证明或生产数值 |
| 真实 K1 源交接是否闭合？ | **本轮隔离前提内闭合**（页 token+reservation+decoder 同任务、恰一次退休、cancel/fault 覆盖）；S/X/P 为实验值；K4 多流退休仲裁、生产 Error/ResponseBody 布局仍开放 |
| 可继续实施，还是需要哪项行为变更审批？ | **无需任何 decoder/上游行为变更**（本轮零冲突）。可继续的下一步：①总工程师验收本证据后裁定"边界保存"为 M1 之外的处理方向；②按 §5 条件式授权候选 metadata 进 M2 级实施（生产数值另批）；③授权后续轮次处理 04l 大样本性能（历史超时仍开放）与 K4 显式换块仲裁 |

产物索引（E 内）：`design/01-design.md`（冻结设计）、`resource-plan.json`、`prepare.py`/`audit/copy-manifest.json`（6044 项哈希核对）、`apply_bounds_patch.py`+`audit/bounds-isolated.patch`（481 行差分）、`bounds_tests.py`/`handoff_tests.py`（驱动）、`results/bounds-tests-550e9b47`+`results/handoff-d9b6ad7c`（最终结果）、`check_bounds.py`+`checks-5f8d4a35/summary.json`（123/123）、`audit/binary-source-hashes.txt`、`runs/metadata-toolchain-9dce7bb9`+`metadata-features-d2de4005`、失败账 runs/bp1-…、bp2-…（屏障超时两次）、probe-*。旧 `6c2a91` 只读保留。

本文完成后已核对保护输入与冻结产物并生成 seal；delivery 最后另写一次，记录本文与 seal 清单哈希；不回写索引、旧报告或旧证据。

**结论：待总工程师验收 04n。** K1 固定范围条件关闭不变；K2 未整体关闭；02d 有效、02f 草案、M1 未裁定、r3/1C/G1 未放行、生产未通过。
