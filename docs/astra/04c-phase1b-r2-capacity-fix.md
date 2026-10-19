# 1B-r2 容量计量与背压修复

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师验收。**

1C 仍阻断，G1 未放行；本文不宣称 r2 全项完成。不涉及设备、PoW、业务迁移或 Git 提交，无子 Agent、无会话创建/联系，未复用旧执行对话。

## 1. 起点与保护

- 唯一规范入口为 02d T1A.3-r2，继承 02b §5；02e 为修订记录。已读 04b、当前 native/bridge/测试实现及指定两端 accounting-large 失败。未恢复最初保护快照。
- HEAD 保持 `421e4d075fc5695e627b67b327299456359e5e9e`。既有 app/HOWTOBUILD.md 和 ds-free-api 的九个 tracked 修改不处理。
- 唯一结果根：`.probe/probe/phase1b/mock/out/r2-capacity-20261003T021651681Z-cd9d446c/`，下文简称 OUT。
- 修改 native 前，`protection-before.json` 记录 3190 个文件哈希、HEAD、完整 Git porcelain 状态；`before/` 保存 23 个潜在可修改文件的当前副本并核对哈希。覆盖 phase1b 历史结果、phase1c、docs/astra、重构计划，以及 app/ds-free-api 的 Git 已跟踪和非忽略未跟踪文件。未读取或写入永久归档/恢复目录，未运行恢复脚本。
- 原始 core 哈希：`761a1935216f1256fa0ac5baeadde3a4c2ef959f77b583299bb4e14016927974`。最终 core：`0647fe29e58a0768a5b8742942884f6592a51beb5863166ca21cff6585d03e87`。
- 保护工具首次 init 因 Git 转义中文路径失败，随后改用 NUL 分隔路径；失败产生的空唯一目录保留。成功快照之后才修改 native。新增保护脚本本身在成功快照中有副本。
- `pre-native-check.json`、`mid-check.json` 逐文件重算，范围外变动为零。命令记录器比较运行前后源码集合及哈希，发现变动即返回失败。本轮未发现并行变动。

## 2. 修复及容量语义

实际 native 内容变更仅 `iut/native/transport_core.mjs`。network_worker 曾试验定长 pull，但为避免把已取得数据移到 Node Readable 内部形成新的计量边界，最终撤回该试验，文件哈希与本轮起点一致。没有修改 ref、bridge、公共 API、错误码或契约数值。

1. **整批准入**：在输出拆分之前检查真实输入长度与所需事件数；不能只逐个 64 KiB chunk 检查。先将完整已接纳输入纳入 stream/global pending，再逐片转移到事件，转移不重复加账。
2. **局部持有物**：`ingress` 显式保存未转移的 payload/事件数。拆分过程中它与所有已入队、桥接、已出队未调用事件共同计量。清理 ingress 幂等，取消/错误不等待前缀投递。
3. **读取粒度与预留**：既有 `data` push 接口没有声明输入上界。可暂停源使用单流 1 MiB 的最大可接纳输入作为保守 headroom，并预留对应拆分槽，而非猜测下一次小于 64 KiB。实际输入仍独立检查。暂停更频繁；只有原严格低水位条件与下一批所需容量同时满足才 resume。没有改变 64/512 KiB、256/2 MiB 低水位数值。
4. **无法维持预算的输入**：1 MiB+64 KiB 单次不可分割推送、暂停后仍推送超预算数据，在保留副本或入队之前提交既有 ERR_BACKPRESSURE；不扩大上限、不留 backlog。输入调用栈上的源 buffer 此时仍存在，不能把“不接纳”说成“该分配从未发生”；见 §5 边界。
5. **事件与 terminal slot**：数据事件计数与全局 terminal 通知区分，128/512 数据事件硬上限不变，每 stream 保留一个既有 terminal slot。独立测试达到 512 数据事件后再提交四个终态，总 pendingEvents=516，其中 terminal=4，不把这四条当作额外数据容量。
6. **持有与分配**：每个输出 chunk 使用精确长度 Uint8Array 副本，不让短 subarray 跨异步等待保留大输入 buffer。丢弃事件置空 bytes，正常交付事件保持用户所有权；不会清空用户已收到的字节。pending 在实际交付入口或丢弃时恰扣减一次。
7. **终止收敛**：cancel/error/close 后不恢复源读取，唯一终态/前轮最终闸门不变；EOF 仍只是候选，完整字节交付后才 end。输入引用、网络引用、timer、callback 与事件持有物分别断言。

普通正常大响应不是错误：受控连续 192 KiB、重复 1 MiB、17 字节/1 MiB/192 KiB/1 字节/1 MiB 变粒度输入均完整交付。真实本地 HTTP 每流 3211264 字节，三路径各五流竞争，完整 SHA-256 与 end.totalBytes 一致。

## 3. 失败先行与留证

| 证据目录 | 结果与处理 |
|---|---|
| 旧 `out/r2-fix-20261003/accounting-large`、`wsl-accounting-large` | 原件只读；原 65536 backlog 漏计失败不改写 |
| `red-windows`、`red-wsl` | 新独立审计 FAIL：持有 1114112，账面 1048576，底层分配 2162688；子进程退出 2，记录器 1 |
| `dev-capacity-1` | 三路径连续 192 KiB 正常流误报错误；修复读粒度暂停预留 |
| `dev-capacity-3` | 三路径重复 1 MiB 在低水位过早 resume；增加容量可预留条件 |
| `dev-quantum-red` | 三路径粒度突变正常流失败；不再依赖历史粒度，改用无上界 push 源的保守预留 |
| `old-resources-check` | 原资源专项 4/5：旧全局测试无视 pause 继续推送，依赖未计量 backlog；保留失败 |
| `corrected-windows-resources`、`corrected-wsl-resources` | 修正隔离测试源驱动，先验证第五源被全局暂停，释放消费后恢复再送数据；原正常 end 断言不放宽。异常继续输入由新专项验证错误与释放 |

`green-audit-windows`、`dev-*`、`final-*` 为开发期间结果，含中间源码，不作为最终源码全量依据。`accepted-*` 只是最终源码结果目录标签，不表示工程师已验收。旧 accounting-audit 脚本完全未改，未在旧结果目录重跑。

## 4. 执行与结果

工作目录：`G:\youdao\Deepseek\.probe\probe\phase1b\mock`。Windows Node v24.18.1；WSL `/opt/node18/bin/node` v18.20.4。每条完整命令、args、cwd、开始结束时间、stdout/stderr、真实子进程 code 和运行源码哈希见对应 `*-command.json`，输出文件使用独占创建。

```text
node scripts/capacity-guard.mjs init
node scripts/capacity-run.mjs OUT LABEL node test-build/capacity-audit.mjs OUT/NEW_DIRECTORY
node scripts/capacity-run.mjs OUT LABEL node test-build/capacity-suite.mjs OUT/NEW_DIRECTORY
node scripts/capacity-run.mjs OUT LABEL node harness/run.mjs --all --iut native --out OUT/NEW_DIRECTORY
node scripts/capacity-run.mjs OUT LABEL node test-build/r2-suite.mjs OUT/NEW_DIRECTORY
node scripts/capacity-run.mjs OUT LABEL node test-build/r2-resource-tests.mjs OUT/NEW_DIRECTORY
wsl -e bash -c 'export PATH=/opt/node18/bin:$PATH; cd /mnt/g/youdao/Deepseek/.probe/probe/phase1b/mock && node scripts/capacity-run.mjs OUT LABEL node SCRIPT ARGS'
node scripts/capacity-evidence.mjs OUT evidence-summary-v2.json
node scripts/capacity-guard.mjs check OUT protection-final
```

上述 OUT/NEW_DIRECTORY 是说明性占位；实际路径/参数以 command JSON 为准。WSL 启动存在既有 Windows PATH/systemd 用户 session 警告，不据此宣称通过，记录中的 Linux 子进程实际退出码为依据。

| 环境 | 独立修复前审计 | 最终容量专项 | 基础 M01–M31 | 窗口第 1 轮 | 窗口第 2 轮 |
|---|---|---|---|---|---|
| Windows | FAIL，code=2 | 54/54，code=0 | 31/31，code=0 | 186/186，code=0 | 186/186，code=0 |
| WSL | FAIL，code=2 | 54/54，code=0 | 31/31，code=0 | 186/186，code=0 | 186/186，code=0 |

最终独立审计 `accepted-{windows,wsl}-audit` 通过，输入拒绝后独立持有量和账目均为零、唯一 ERR_BACKPRESSURE。最终容量专项为每路径 17 个受控用例，加三路径真实 HTTP 共 54 项。

54 项覆盖：单流硬上限前/恰好/超过及 1114112 单次输入；正常大响应、变化输入粒度；暂停/恢复/EOF；取消、网络错误、close；暂停后异常推送；全局 4 MiB 竞争与超过；128/512 事件和 terminal slot；容量压力下 WQ/WX/WG；小视图大 backing allocation；本地五路 HTTP 慢消费。正常流用输入/回调 SHA-256、字节数和 end 校验，不以实现 totalBytes 自证。

独立审计枚举入队事件对象、ingress 未转移数据和旧 backlog，建立 acquired/delivered/discarded/rejected 外部账本，逐阶段检查守恒、stream/global payload 与事件硬限、释放恰一次、终态唯一、严格低水位和 C 后无 resume。队列对象即使已进入桥接或局部调用等待仍保留在审计集合。副本分配另按唯一 ArrayBuffer 计量，不把 allocation 与 payload 混为一谈。

基础 M28 是专用 Node 宿主 Windows TerminateProcess / WSL SIGKILL 测试，不是设备。S1/S2/S4 仍为负向对照。本轮未修改基础矩阵/186 项窗口判据，最终 native 哈希与每条最终命令核对一致。

## 5. 容量结论与边界

- **严格取得口径仍 FAIL，不能宣称本轮容量修复完成**：`capacity-acquisition-boundary.mjs` 在 `_ingestData` 入口按“已有 pending + 此次实际输入”断言，独立于接纳账本。`strict-windows-acquisition` / `strict-wsl-acquisition` 留存此项；这是本轮未解决缺陷，不是把它重新定义成合法行为。54/54 只证明已接纳持有物与所列场景，不能覆盖此 FAIL。
- 本轮新增断言范围内，已接纳输入及所有异步持有物无未计量 backlog，转移不漏不重；硬限测试未通过扩大数值获得 PASS。正常守约暂停源完整，无法容纳的异常/不可分割推送按既有错误处理。
- **输入拒绝边界须明确**：旧 worker 将 Node `data` buffer 交给 core；超预算输入在同步检查中被拒绝持有，不计作成功接纳 payload。独立审计单独记录 offered/rejected。若验收要求把这一瞬间的源 buffer 也纳入“已取得 payload 硬上限”，则单次 1114112 已在进入 core 前超过 1 MiB，本实现不能宣称该瞬间满足硬限。需要网络层在分配/取得前具备可预留读取接口或更底层可证明的输入上界；不能以本报告私自修改契约所有权边界。此项提交总工程师审查，未被测试 PASS 消除。
- 接纳后拆分时源 buffer 与输出副本可短暂共存，因此真实分配可能大于 payload；准确长度输出副本只解决异步短视图保留，不承诺 RSS/堆峰值等于 1/4 MiB。旧 2162688 分配反例有明确记录；新测试小视图使用 2 MiB backing，验证队列不保留其 backing。
- 真实 HTTP 证明当前 Node/OS 下暂停恢复、完整传输和响应 close；服务端一次 end(3211264) 不等于客户端单次取得相同大小。实际接收粒度记录在 sourceRecords，不能由本机观察推导所有网络输入都小于 64 KiB。
- Node HTTP/TLS/Readable、socket 内核缓冲、GC 实际回收与线程退出未做全层堆/FD 审计；`maxReadableLength` 在 data 观察点的采样不能证明暂停期间库内峰值为零。以上不得用 pending=0 或 response close 冒称完全释放。
- 保守暂停带来吞吐代价，未定义或承诺设备性能阈值。受控同步模型不证明真实 Native 多线程所有权、原子性或 JSValue 生命周期。

具体冲突及方案：当前 `NetworkWorker` 返回 Node 响应对象，`data` 处理器收到输入时分配与取得已发生，没有分配前额度请求。任意不可分割 1114112 字节输入与 1 MiB 全取得硬限不能同时成立，事后错误不构成证明。保持契约的候选方案是在 worker/socket 输入分配前建立字节与事件 credit，只有得到 credit 才读取；所有网络库内部用户态 buffer 也必须纳入同一额度，并独立审计 TLS/HTTP2 等多层缓存。仅换成 `read(n)` 而遗漏 Readable 已缓存字节不合格。另一方案是把过大 `data` 输入定义为调用方所有、拒收不算取得，但这会改变所有权边界，**本轮没有授权也没有采用该解释作为契约通过依据**。当前停止在提交此冲突及方案，不自行修改契约或宣布完成；可保留本轮部分修复供审查。

## 6. 保护核验与剩余必测

`evidence-summary-v2.json` 汇总实际结果、最终源码哈希及语法检查；`protection-final.json` 记录最终变更集合。原始 `evidence-summary.json` 的 matrix 摘要字段读取错误，保留并由 v2 更正，不覆盖原记录。protectedHistory 逐项复核 2731 文件，最终 18 个 mjs 语法检查。

上述 v2 在追加严格入口审计之前生成，仅汇总接纳后专项。最终以 `evidence-summary-v3.json`、`protection-final-v2.json` 为补充核验：19 个 mjs 语法检查，两端严格入口审计各 FAIL、子进程 code=2，最终结论不由通过数量覆盖失败。

允许范围内变更：core、隔离资源测试、README、新容量测试/记录与核验脚本、新 04c；结果仅新增 OUT。保护清单中的旧报告/契约、phase1c、历史 out、app、ds-free-api、基线保持哈希一致；ref 与 network_worker 最终无内容变化。归档和恢复副本未作任何写操作。

仍需验收/补证：§5 的源取得瞬间与分配前预算、全部网络库缓存及实际释放；容量压力下真实 HTTP2/TLS/代理及 abort 分支更细资源证据；04b 已列出的 admission deadline、跨 context FIFO 穷尽、M18 各资源分支、延迟 CONNECT、终态回调抛异常、M30/M31 全排列等未因本轮通过而关闭。真实 Native/设备 M20/M21/M28、生命周期未决与 G1 门槛全部维持原状态。

**结论：待总工程师验收。**
