# 1B-ii 按 r2 修复与复测交付

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**状态：待总工程师验收。部分修复已验证，容量计量审计仍 FAIL；不宣称 r2 全项完成，不解封 1C，不宣布 G1 通过。**

## 1. 基线、授权与保护

- 开工授权来自本轮用户转交：总工程师已独立只读验收保护材料，不再申请开工。
- 保护材料：`G:\youdao\Deepseek-handoff-archives\2026-10-03-pre-1b-r2\PROTECTION-REPORT.md`、`source-before.json`、`pre-1b-r2.zip`。归档及恢复目录仅只读访问；未运行其中保护/恢复脚本。
- 修改前逐项核对源清单：1776 文件、33534512 字节，内容、大小、时间、属性、链接及目录集合零差异；`04b` 当时不存在。首次校验命令退出 0。随后落盘 `protection-before.json` 时已新增本轮三个脚本及 test-build 目录，added=4，不是保护输入漂移。
- ZIP SHA-256：`6C7C3FDF2B3509B67E230C293FCD42566A58B9446084FC43B9056328E81DED4B`。
- HEAD：`421e4d075fc5695e627b67b327299456359e5e9e`，main；未提交、暂存、回退或清理 Git。既有 9 个 tracked 修改保持。
- 唯一规范入口：02d T1A.3-r2；按 §1.1 继承 02b，02e 只作修订记录。核对 03、旧 04、05、两份重构计划、00-baseline、phase1b 当前代码及 phase1c 三路径反例和四字节正常结束对照。旧 31/31 不作为本轮结果。
- 无子 Agent、无新会话或会话联系，无设备操作、设备库构建、网络栈选型、业务接口接入、PoW 或业务迁移。

以下证据路径除另注外，均相对本轮唯一结果根：

`G:\youdao\Deepseek\.probe\probe\phase1b\mock\out\r2-fix-20261003\`

## 2. 已知阻断与停止

**容量计量仍不满足 02d §4.4 / 02b §5。** 隔离受控源单次交付 1114112 字节（1 MiB + 64 KiB），当前 `_ingestData` 拆分到水位后暂停，余下 65536 字节进入 `pausedBacklog`，但未纳入 `pendingBytes/global.pendingBytes`。这是实现及测试注入边界上的实际反例，不是固件行为推断。

Windows：`accounting-large/result.json`，`accounting-large-command.json`，子进程退出 2，记录器退出 1。WSL 的 `wsl-accounting-large/result.json` 同样复现 65536 字节未计量，子进程退出 2、记录器退出 1。

1 MiB 输入的 `accounting-audit/result.json` 为 PASS，不能抵消更大输入的失败；源取得的单次 buffer 大小不是公开 chunk 上限，不能把 64 KiB 输出上限解释成可忽略大输入的理由。未放宽水位、未修改该断言或契约。

依据 02d §7“无法证明本规范则停止并提交证据”，发现此项后停止扩大实现修复，保留当前代码和全部失败记录，仅继续证据整理与保护核验。需总工程师评审已取得字节、backlog、网络读取粒度与硬上限之间的完整计量方案。当前不得把 M17/资源验收整体标成 PASS。

## 3. 变更范围

| 文件（mock 根下） | 本轮改动 |
|---|---|
| `iut/native/transport_core.mjs` | EOF 候选与 C 分离；pendingData/回调返回后尝试 end；deadline 保留至 C；统一 eligibility、唯一终态身份；可见 seq 在真实投递分配；释放一次计量；取消通知完成后 outcome；不可调用时丢弃清理；解绑 stream 监听器与引用；全局暂停/恢复 |
| `iut/native/network_worker.mjs` | 显式 abort 结束 headers 等待；取消后拒绝后到 CONNECT；HTTP2 off 支持；晚到 abort error 使用不持有操作引用的监听器 |
| `iut/native/libjsapi_ds_transport.mjs` | 绑定规范标识改为 T1A.3-r2，无新增公共 API |
| `harness/cases/m25_31.mjs` | M29/M30 在终态通知已经完成后精确要求 already-terminal，补 notification-completed 断言；不是放宽成二选一 |
| `harness/run.mjs` | 结果目录已存在即拒绝，防覆盖 |
| `test-build/r2-*.mjs` | 隔离屏障、失败复现、186 项组合、真实 HTTP 对照、资源与容量审计 |
| `scripts/r2-*.{mjs,ps1,sh}` | 命令/退出码/源码哈希记录、WSL 包装、只读保护核对、证据交叉审计 |
| `README.md` | r2 状态、运行方式和容量阻断提示 |

ref 实现、bridge 实现、host-sim、旧结果目录、phase1c 原件、旧报告/契约/基线、app/**、ds-free-api/** 均未改写。新报告仅本文件。未增加 release 公共探针；现有 testAPI 机制仍是历史 test-build 模型，不宣称已生成可发布二进制。

## 4. 失败先行与修复记录

| 顺序 | 失败证据 | 修复/复测 |
|---|---|---|
| 1 | `red-windows/result.json`：三路径 × WQ/WX/WG/EOF 共 12 FAIL；C 后 headers 实际入口、EOF 提前提交均复现 | `green-smoke-windows/result.json`：同场景 12 PASS |
| 2 | `windows-dev1/result.json`：174 项中 3 个不可调用分支 FAIL | `windows-dev2/result.json`：174/174；终态安全丢弃后标志和引用收敛 |
| 3 | `windows-native-dev1/summary.json`：29/31，M29/M30 旧 outcome 判据不符合 r2 | 明确按 r2 §1.2 修订测试；原失败保留；最终 IUT 31/31，ref 仍失败 |
| 4 | `resource-red/result.json`：response listeners 未解绑 | `resource-green/result.json`：3/3 |
| 5 | `worker-red/result.json`：取消 headers 等待返回 ERR_NETWORK | `worker-green/result.json`：4/4，显式取消内部等待返回 ERR_CANCELLED |
| 6 | `global-red/result.json`：其它可暂停流在全局满队列时误报 error | `global-green/result.json`：5/5；全局暂停和低水位逐存活流恢复 |
| 7 | `accounting-large/result.json`：65536 字节 backlog 未计量 | **未修复，保留 FAIL，停止并报告** |

最初三次直接 exec（red-windows、green-smoke-windows、windows-dev1）未经过命令记录器：工具可见退出码分别为 1、0、1；脚本对断言失败设置 `process.exitCode=2`，但没有独立 child-close 记录，不能把工具的 1 冒称已捕获的 Node 2。后续命令记录器同时记录真实子进程码（失败为 1 或 2）并自身将非零归一为 1。

## 5. 执行命令和分表结果

工作目录：`G:\youdao\Deepseek\.probe\probe\phase1b\mock`。Windows Node v24.18.1；WSL Linux Node v18.20.4。WSL 启动曾有 Windows PATH 转换/systemd 用户 session 警告，未把警告当作通过；具体子进程退出码及输出在 command JSON。

通用命令形式（OUT 必须为结果根下从未存在的目录，RECORD 为新文件）：

```text
node scripts/r2-run.mjs RECORD node harness/run.mjs --all --iut native --out OUT
node scripts/r2-run.mjs RECORD node test-build/r2-suite.mjs OUT
node scripts/r2-run.mjs RECORD node test-build/r2-resource-tests.mjs OUT
node scripts/r2-run.mjs RECORD node test-build/r2-network.mjs OUT native
node scripts/r2-run.mjs RECORD node test-build/r2-accounting-audit.mjs OUT 1114112
wsl -e bash /mnt/g/youdao/Deepseek/.probe/probe/phase1b/mock/scripts/r2-wsl.sh RECORD node <script> <args>
```

| 环境/对象 | 输出目录 | 结果 | 子进程退出码 |
|---|---|---|---:|
| Windows IUT M01–M31 | `final-windows-matrix` | 31/31（旧非时序回归加已修订 outcome） | 0 |
| WSL IUT M01–M31 | `final-wsl-matrix` | 31/31 | 0 |
| Windows IUT 窗口第 1/2 轮 | `final-windows-round1`、`final-windows-round2` | 每轮 186/186，其中 M32–M34 为 144 组合 | 各 0 |
| WSL IUT 窗口第 1/2 轮 | `final-wsl-round1`、`final-wsl-round2` | 每轮 186/186，同样 144 组合 | 各 0 |
| Windows/WSL IUT 资源专项 | `final-windows-resources`、`final-wsl-resources` | 每环境 5/5，但不覆盖并抵消独立容量反例 | 各 0 |
| Windows/WSL IUT HTTP 增强 | `windows-network`、`wsl-network` | 每环境 15/15，三路径 M06/07/08/09/22 | 各 0 |
| Windows ref M01–M31 | `windows-ref1` | 29 PASS，M29/M30 FAIL | 1 |
| WSL ref M01–M31 | `wsl-ref` | 同上 | 1 |
| Windows ref HTTP 增强 | `windows-ref-network` | 15 FAIL，旧 EOF 提前提交 | 2 |
| WSL ref HTTP 增强 | `wsl-ref-network` | 15 FAIL，与 Windows 相同旧 EOF 缺口 | 2 |
| ref M32–M34 | 未执行 | ref 没有三种真实 dispatcher；不能用 native 探针冒充 ref | NOT_RUN |
| Native C++/QuickJS/设备 | 未执行 | 本轮禁止构建设备库/操作设备 | NOT_RUN |

每条命令的完整 args、cwd、开始结束时间、stdout/stderr、code 在对应 `*-command.json`。最终 `final-*` 命令另含 sourceHashes；`evidence-audit.json` 汇总并独立核对四轮窗口、C/D 次序、释放与 M28。所有开发失败目录均保留，不覆盖旧结果。

## 6. M01–M34 逐项判定

下表 IUT Win/WSL 的“通过”仅对应已执行断言；有缺口则明确“部分”，不汇总为 34/34。M01–M31 基础证据分别为两套最终 matrix 的 `case-Mxx/result.json`。

| ID | Win/WSL 当前结果 | 增强证据/边界 |
|---|---|---|
| M01 | 通过 | 精确 GET、request 无流事件；唯一 settle |
| M02 | 通过 | string/Uint8Array echo |
| M03 | 通过 | headers 时 Cookie 可见；无真实凭据 |
| M04 | 通过 | context/epoch 隔离 |
| M05 | 通过旧断言 | 代理快照；排队期间变更代理的增强未新增 |
| M06 | 通过 | network 三路径 follow，前缀 D 时 terminal=null |
| M07 | 通过 | network 三路径 manual，同上 |
| M08 | 通过 | 三路径 401 正常前缀/end |
| M09 | 通过 | 三路径 429，旧无重试断言 |
| M10 | 通过已执行增强 | enhanced-normal；资源专项真实 HTTP 四字节三路径；R < C(end) < T |
| M11 | 通过 | 原始 UTF-8 字节及 64 KiB 输出 chunk 上限 |
| M12 | 通过已执行增强 | 原长流 + M32 窗口 |
| M13 | 通过已执行增强 | EOF 候选取消、end 后取消、回调重入、admission 前取消 |
| M14 | 部分 | 原网络 timeout + EOF 后原 timer；真正 admission 队列内 timeout 增强未补齐 |
| M15 | 通过 | 重复 ID、并发 settle |
| M16 | 部分 | 32/64、8/16、96 请求及单 context FIFO 通过；跨 context 全局 FIFO 的穷尽断言未新增 |
| M17 | **FAIL** | 旧慢消费者/不可暂停 PASS；新增全局恢复 PASS；大 buffer 未计量 backlog FAIL，不能认定资源门通过 |
| M18 | 部分 | 原上限错误/settle PASS；所有超限分支的真实 socket/监听器终止快照未穷尽 |
| M19 | 通过已执行增强 | 原 request+stream；M32/M33 close-now 与 close-after-T 保留先提交 reason |
| M20 | 通过本地模型 | TLS/ALPN h1/h2 独立证据；无设备结论 |
| M21 | 通过本地模型 | TLS/HTTP2 proxy/隔离；CONNECT 取消新增代码缺真实延迟隧道专项复测 |
| M22 | 通过已执行增强 | 三路径 error-Q/X、已有 headers+chunk 的 Q/X/WG；空流正常 |
| M23 | 通过 | Cookie clear epoch |
| M24 | 通过已执行增强 | 原异常隔离 + EOF 前缀回调抛出后正常 end；终态回调抛出专项未新增 |
| M25 | 通过负向对照 | S1 不自动停止，显式 cancel 有效；非硬终止 |
| M26 | 通过负向对照 | S2 同上，cancelAll 不关 context |
| M27 | 通过负向对照 | S4 显式链；不依赖卸载/dlclose |
| M28 | 通过专用 Node 宿主 | Win TerminateProcess / WSL SIGKILL 分开；设备 NOT_RUN |
| M29 | 通过已执行增强 | 旧 generation、幂等及 M34 重开后旧终态只投原接收者 |
| M30 | 部分 | 三态新入队/重复终态拒绝、取消/错误在途通过；end 后人为在途非正常项的专项未穷尽 |
| M31 | 部分 | 原并发/计数 + EOF 取消/close 组合通过；完整多操作正常完成与批量入口排列未穷尽 |
| M32 | 通过已执行窗口 | 三路径 × WQ/WX/WG × 零/已有前缀 × plain/close-now/close-after-T；每轮 54 组合 |
| M33 | 通过已执行窗口 | 两 stream + request；三路径三窗口两前缀；default/user/close-now/close-after-T；每轮 72 组合 |
| M34 | 通过已执行窗口 | 三路径三窗口两前缀、closing→C→gen、重复 close、拒绝 admission、重开新接收者；每轮 18 组合 |

M32–M34 尚非所有组合的穷尽证明：同 context 未被 cancel 的另一个在途操作隔离、user reason 与 close 的交叉、强制多级局部批次所有排列及独立真实 Native 线程 WG 均未覆盖。不可调用分支单独测试，不伪称每一个 M32–M34 组合都重复不可调用子分支。

## 7. 确定性轨迹与线性化边界

探针使用同一 Node loop 单调逻辑序号：terminal 属性实际写入记录 C，真实用户回调函数第一条语句记录 D/T，finally 记录 R。不是把 gate 检查、出队或 post 时间冒充 D。WQ 拦住实际 bridge post，WX 拦住出队后的 deliver，WG 在 `_gate` 已返回成功的窗口同步发起控制调用；真实入口仍重查 `_eligible`。无 sleep 用作 WQ/WX/WG 成功证据，until 的 5 秒只是失败上限。

`evidence-audit.json` 的 handler 示例（order）：

- WQ 零前缀：barrier 4 → C(cancelled) 10 → headers/chunk release 28/31 → T 37；没有 D。
- WX 零前缀：barrier 10 → C 12 → headers/chunk release 28/31 → T 37；没有 D。
- WG 零前缀：成功检查后 barrier 12 → C 14 → headers/chunk release 18/21 → T 38；没有 D。
- 正常：D(headers)14/R15 → D(chunk)21/R22 → C(end)23 → T32。
- 重入：D(chunk)20 → C(cancelled)21 → 当前 R25 → T31；终态没有嵌套进当前数据回调。

每轮 144 个 M32–M34 组合均校验窗口确实到达、C 早于控制确认、C 后无 D、admission 早于所有事件、连续 seq、唯一 terminal、pending 归零、acquired=released、无重复 release、无 C 后 resume。WX 初版包装未延长 deliveryChain 的完成等待，后续探针已修正为返回屏障 Promise；初始失败只作缺口证据，最终两轮均用修正版。

此线性化只成立于当前 Node 模型的同步调用栈；不能证明原生 worker 与 QuickJS 线程之间的锁、内存序、失效 JSValue 或真正 postJSMessage 失败语义。未调整冻结判据。

## 8. 资源、M28 与残余风险

- 独立记录：C、通知、R、release、pending、pause/resume、源 destroy；timer 清空、callback 引用清空、backlog 清空、active/queued 归零均有受控模型断言。
- `pending=0` 不等于 socket 已 close。真实网络测试证明响应行为，当前没有每分支完整 close-event/FD/线程/堆引用快照；不宣称真实 Native 资源完全释放。
- 大输入 backlog 仍不计量；该 FAIL 优先于所有旧 M17 和资源专项 PASS。全局 terminal slot 与数据事件合并统计的极限交叉、暂停期间重复异常源输入的容量边界也需补齐。
- 最终 matrix 的 `case-M28/kill9/` 保存 control、pull-before-kill、kill、restart 四组。四套 Win/WSL IUT/ref 均 control_late_hit=true、kill9_late_hit=false、trampoline=0、frozen=true、host_exited=true、restart_old_dir_untouched=true；未操作设备。kill 目标仅脚本 Start-Process 返回的专用宿主对象/POSIX `$!`，没有按进程名杀其它应用。
- M28 现有脚本的等待使用计时是晚到观察期，不是 WQ/WX/WG 窗口覆盖证据。S1/S2/S4 始终保留 negative-control 类别。
- ref 未改成 r2：不能作为通过 oracle。其所谓三路径参数实际仍是单 dispatcher，network 报告明确记录 actualPath；M32–M34 ref 为 NOT_RUN。
- 本轮源码为未发布的 Node 模型；JS context 最后安全时刻、同宿主重装、postJSMessage 失败、设备 TLS/HTTP2/代理和 M28 均保持待验证。

## 9. 最终保护与回滚

`protection-after.json` 逐文件重新哈希；`scope-audit.json` 核对允许变更、新增路径、业务文件哈希与 HEAD。历史 out 和 phase1c/契约/旧报告/基线不在可写范围。最终校验结果另见下节追加的实测摘要。

回滚方式仅供总工程师审批后执行：先另存本轮改动与证据，再以保护归档清单核对的原版本逐文件恢复本报告 §3 中的已存在文件；新测试/报告/结果保持留证。不得直接覆盖当前后来改动，不得对整个工作区做 reset/clean，不得在永久只读归档/恢复目录内写入或运行恢复工程。本轮未执行回滚。

### 最终核验实测摘要

- `r2-protection.ps1 -After` 退出 0：1776 个原文件重新核验，允许范围外内容差异 0；其中 6 个既有文件发生本轮允许修改，名单与 §3 一致。目录修改时间因新增材料变化，不把这类变化误报为原文件内容漂移。
- `node scripts/r2-scope-audit.mjs` 退出 0：新增路径越界 0，业务哈希前后一致，HEAD 一致；13 个 `.mjs` 语法检查通过。
- 最终 Windows/WSL matrix 及四轮窗口命令的四个 Native 模块哈希与交付源码比较共 24 项一致。probe/报告后续审计脚本变化不冒充这些运行已使用后续脚本。
- 容量失败的 Windows/WSL command JSON 均独立确认子进程退出 2，未把预期失败改成成功码。
- `evidence-audit.json` 在 WSL ref HTTP 增强最终结束前生成，其 commands 是当时已落盘的快照；缺失该项不表示未执行，以 `wsl-ref-network-command.json` 及 result 为最终记录。
- `scope-audit.json` 使用 `protection-after.json` 的文件集合快照；随后新增的本审计脚本、scope-audit 结果与本报告末节均在允许路径内。没有对归档或恢复目录做写操作。

**停止位置：1B-ii r2 部分修复、容量计量仍失败，待总工程师验收。1C 不解封，G1 不通过，阶段 2 不开工。**
