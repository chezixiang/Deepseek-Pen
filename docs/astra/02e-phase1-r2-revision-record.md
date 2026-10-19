# 阶段 1A-r2 修订记录：时序补全、证据映射与未决问题

- **日期**：2026-10-03（Asia/Shanghai）
- **唯一修复基线**：`02d-phase1-transport-contract-r2.md`（T1A.3-r2）。
- **范围**：新增 02d/本文件；02b 仅加头部替代标注，原文保留。不实现 Transport，不改 02c/04/05、业务代码、默认入口、基线或 `.probe/` 证据。
- **状态口径**：完成文档修订不等于修复完成。1B 待修复/复测，1C 一致性门仍未放行；没有新增真机结果。

## 1. 修订点（10 条）

| 编号 | 修订 | 02d 落点 | 依据 |
|---|---|---|---|
| R2-01 | 定义网络观察 N、入队 Q、出队 X、原子提交 C、真实调用 D、返回 R、终态通知 T | §2.1 | E1/E4/E5：旧记录混淆提交与交付 |
| R2-02 | 唯一选择：C 后已排队未投递 headers/chunk 全丢弃，含已出队/已 post/局部批次 | §2.2 | E1–E3；02b §2.3/§3.2/§7.5 |
| R2-03 | 正常 EOF 只是候选，完整前缀在 C(end) 前交付；等待期取消/超时仍可获胜 | §2.3 | E4；02b 正常流/字节完整/先提交者获胜要求 |
| R2-04 | error/cancelled 不等待 drain；错误只保留已实际投递前缀 | §2.4、§4.4 | E1/E4 揭示同类时序区分；02b 单终态、背压与错误规则，错误窗口运行仍待验证 |
| R2-05 | 入队、出队、实际调用前全部检查；C 与最终检查/回调入口必须确定先后，关闭检查后竞态 | §3.1–§3.2 | E5 的入队拦截不足；E2/E3 三路径一致反例；更细线程窗口待测 |
| R2-06 | 唯一终态通知不误杀，admission/控制 Promise 与数据区分；可见 seq 从 1 连续分配，丢弃项不消耗 | §3.3–§3.4 | 02b 事件/Promise/序号/终态豁免不变量；E1–E4 的投递顺序 |
| R2-07 | cancel/cancelAll 不先 drain；C 后统一抑制；close 保持停接纳/C/generation/closed 顺序 | §4.1–§4.3 | E1–E3；02b 九个 API 与幂等/隔离规则 |
| R2-08 | 出队未投递仍计量；丢弃恰释放一次；背压只允许已实际投递前缀 | §1.2、§4.4 | 02b §5；E1–E4 的 pending 记录，仅规范补全，不宣称资源测试通过 |
| R2-09 | 新增 M32–M34，增强正常结束/错误/竞态/背压矩阵；定义 WQ/WX/WG 必测窗口 | §5 | E2–E5，补原 M30 主要覆盖终态后新注入的不足 |
| R2-10 | 冻结唯一修复方向、明确 1B/1C 重新放行条件，保留未决与真机证据边界 | §6–§7 | E6/E7；04 历史结果不覆盖 05 反例 |

## 2. 1C 复测证据映射

以下 E1–E5 都是本地 Node IUT 证据，绝不标成设备 Transport 测试；全部只读核对，未重跑会覆盖原件的脚本。

| 编号 | 文件（仓库相对路径） | 可复核字段/事实 | 支持的修订与限制 |
|---|---|---|---|
| E1 | `.probe/probe/phase1c/preflight/gate-audit.json` | `before.pendingEvents=2`、`before.terminal=null`；`afterCommit.terminal=cancelled`；`lateNonterminal` 为 headers/chunk；`gateDrops=0`；`contractGateSatisfied=false` | 证明 Q 在 C 前、数据回调仍在取消后执行；需要 R2-01/02/07。不是入队之后新到网络包的问题 |
| E2 | `.probe/probe/phase1c/preflight/recheck-1.json` | `cases=9`、`violations=6`；各 `results[]` 的 deliveryPath/action/before/afterCommit/events/lateNonterminal/contractGateSatisfied | 三路径 cancel/cancelAll 失败；closeContext 通过。要求入口一致闸门，不能只修单路径 |
| E3 | `.probe/probe/phase1c/preflight/recheck-2.json`、`recheck-exit-codes.json` | 第二轮同样 9/6；两次 exitCode 均为 2；closeContext 每轮三组均仅 cancelled、gateDrops=2 | 支持可重复性，退出码 2 是契约失败而非脚本启动失败；对照通过不等于所有 close 竞态已测 |
| E4 | `.probe/probe/phase1c/preflight/normal-end-control.json` | `beforeAnyCallback.terminal=end`、`terminalDelivered=false`、`pendingEvents=3`；随后 headers/chunk/end，chunk=4 字节、end.totalBytes=4；回调时 terminal 均为 end | 当前正常流也先 C 再前缀；R2-03 不能省略。`normalBytesPreserved=true` 只说明旧数据完整，不是 r2 闸门合规 |
| E5 | `.probe/probe/phase1c/tests/gate-recheck.mjs`、`gate-normal-end-control.mjs`；`docs/astra/05-phase1c-device-port.md` §3.3 | 复测等待 pending≥2 且 events=0，取消后读取 terminal；05 定位入队检查与最终闸门缺失的差别 | 支持排队窗口缺口；脚本取消返回后设观察标志，尚无完整 C/D 原子追踪与确定性 WX/WG，须新增测试证据 |
| E6 | `docs/astra/04-phase1b-impl.md` §2.3/§3.2/§4；`05-phase1c-device-port.md` §2.5/§3/§6 | 04 的历史 31/31 是 mock/native-contract；05 明确 native 为 Node `.mjs`，未生成设备 .so；后续反例阻断一致性门 | 不能继承“已修复/可进阶段 2”；r2 必须修复后全量重跑 |
| E7 | `.probe/probe/phase1c/preflight/final-verification.json`；`05-phase1c-device-port.md` §4–§5 | devicePortBuilt=false、deviceInstalled=false、deviceM20/M21/M28=NOT_RUN、①④⑤=PENDING | 真机未执行；不推断固件、工具链、网络库或销毁行为 |

逐组合核对结果，两轮相同：

| 路径 | cancel | cancelAll | closeContext |
|---|---|---|---|
| handler | 违规：headers/chunk 晚到 | 违规：headers/chunk 晚到 | 对照通过：只见 cancelled |
| postjsmessage | 违规：headers/chunk 晚到 | 违规：headers/chunk 晚到 | 对照通过：只见 cancelled |
| jsoop | 违规：headers/chunk 晚到 | 违规：headers/chunk 晚到 | 对照通过：只见 cancelled |

**选择依据而非固件猜测**：02b 已规定终态后的非终态投递禁止、正常流字节完整、取消先提交即获胜。E1–E3 证明旧实现没有同时满足前两种时序；E4 证明只补闸门会破坏完整性。因此 02d 保持终态后统一丢弃，将正常完成的 C 延后到前缀交付之后。它不允许取消前 drain，也不把网络 EOF 赋予终态优先权。该规范不需要固件替我们丢队列；具体实现能否满足，保留为待验证门槛。

## 3. M 矩阵增量与验收边界

完整 M01–M34 规范位于 **02d §5**，不存在本文件另立判据的第二套矩阵。

| 新增项 | 覆盖 | 最低通过条件 | 本轮状态 |
|---|---|---|---|
| M32 | cancel 三路径的 WQ/WX/WG | C 后零 headers/chunk；唯一 cancelled(user)；幂等、open/generation 不变、其它操作不受影响 | 已定义，待实施；旧 WQ 类反例两轮失败 |
| M33 | cancelAll 三路径的 WQ/WX/WG，多 stream + request | 各 op 从自身 C 起零数据；reason/计数/outcomes 正确；request 恰一 reject；重复不增加计数；context 仍 open | 已定义，待实施；旧单 stream WQ 类反例两轮失败 |
| M34 | closeContext 三路径的 WQ/WX/WG、重开与组合链 | 先封禁；唯一终态，generation/幂等正确；旧数据不越代、不串新接收者 | 已定义，待实施；旧 WQ 类三组对照每轮通过，但不算完整 M34 PASS |

既有项增强：M10 正常 EOF/慢消费者；M13 EOF 与取消/重入竞态；M14 候选阶段 deadline；M17 背压丢弃/释放；M19 先 cancelAll 后立即 close；M22 error 排队/在途窗口；M24 异常隔离；M29 旧终态接收者；M30 三终态/多级队列；M31 批量竞态。其它旧断言继续执行。

待测时序边界（不是已通过结果）：

| 场景 | 02d 唯一期望 |
|---|---|
| Q(headers/chunk) → C(cancelled) → X/调用尝试 | 丢弃数据，只通知 cancelled |
| Q → X → C → 调用尝试 | 即使已出队也丢弃 |
| 检查通过 → C 尝试 → 实际调用入口 | 只能 D 先于 C，或 C 获胜不进入 D；禁止 C 先于真实 D |
| D(chunk) → 回调内 cancel 提交 C → 当前 R | 当前回调可结束，余下 chunk 全丢弃，随后唯一 cancelled |
| EOF → 正常前缀全部 D/R → C(end) → T | 完整 body 与唯一 end |
| EOF → 尚有未投递前缀 → cancel/error 先 C | 正常完成候选作废，剩余前缀全丢弃 |
| error 先 C，headers 只有 Q、尚无 D | 只观察到 error，不补发 headers |
| cancelAll C → close → 重开 → 旧消息尝试 | 无旧数据；唯一终态只投原接收者一次或安全丢弃 |

## 4. 未决问题

1. **r2 实现一致性待验证**：没有修改/运行新 Transport，没有 M32–M34 PASS。E1–E3 的失败仍是当前已知缺口；1C 不解封。
2. **正常 EOF 候选与取消/错误/deadline 的竞态待验证**：E4 只证明旧行为及机械修复风险，不能证明新顺序、重入与正常 body 完整性；必须执行增强 M10/M13/M14/M22/M24。
3. **真实并发原子边界待验证**：Node 延时复测没有证明出队后、检查后到实际 JS 调用入口的同步正确性。WX/WG 与多级桥接必须有确定性轨迹，真机线程验证另记；不得假设固件原子执行。
4. **背压/资源回收待验证**：原水位不变不等于释放账目已正确；M17/M32–M34 必须实测 pending、持有物释放和终态后不恢复读取。
5. **真机及历史未决保持**：05 的①卸载 JS 信号、④同宿主重装 generation、⑤生命周期钩子；02b §10/02c §3 的 postJSMessage 失败语义、unload 决策、最后安全 JS loop、依赖/错误映射/输入上限覆盖等均未获得新的设备证据。真机 M20/M21/M28、交叉工具链与 HTTP/2 依赖仍待落实。

不存在“终态后是否允许投递排队数据”这一待选项：答案已固定为不允许。未决的是实现/运行证据，不得以待验证为名恢复另一种合法语义。

## 5. 保护与文档验收

- 02b 的全部原文字节（移除新增头部标注后）应恢复到 SHA-256 `D6C3D55CD192DFF039EC1FB47C67586D7F4E07D65E4E31272F10F5C5619A4FBF`；原文件 UTF-8 无 BOM、LF 换行保持。
- 05 的起始 SHA-256 为 `DF28F2E56B8E84DDE061CD1DFA5B5F7AC0B6BF166747A57833A57D3A40445B9D`；02c/04/基线/三个业务文件/入口文件/四个 native IUT 文件按 1C 保护清单只读复核。
- `.probe/probe/phase1c/` 的 21 个文件保持原件。目录指纹：按相对路径排序，以每行“路径 + 空格 + 大写 SHA-256”、LF 连接（无结尾换行）的 UTF-8 内容取 SHA-256，值为 `4483E3D402DF64E8FFF06C201045D2883499D2E56FBF7C950EA17BCB4434DDA3`（路径采用本轮 `rg --files -uu` 在 Windows 输出的格式）。
- 文档核验须检查 M01–M34 编号完整、M32–M34 三入口/三窗口、10 条修订映射、所有引用文件存在及敏感值未泄露。文档可以使用 API 字段名，但不得写入真实凭据值。
- 不执行原 gate-normal-end-control 脚本覆盖历史结果；不改旧测试使错误“通过”。本轮只解析并交叉核对留存 JSON/脚本和文档，不宣称运行修复验证。

本轮实际文档验收结果（2026-10-03）：

| 检查 | 结果 |
|---|---|
| 02b 移除新增标注后的原文字节 SHA-256 | 与上述原始哈希一致；含原来的文件末尾格式 |
| 1C 保护清单中除 02b 外的 13 个文件 | 全部与留存哈希一致 |
| 05 与两份重构计划 | 与本轮开始时 3 个哈希一致 |
| phase1c 原始证据 21 文件 | 目录指纹一致，未覆盖、未新增运行结果 |
| 矩阵与修订编号 | M01–M34 共 34 行，无缺号/重复；R2-01–R2-10 共 10 行 |
| JSON 证据交叉核对 | 两轮共 18 组与 9/6 摘要一致，退出码均 2；正常结束对照四字节与记录一致 |
| 新文档格式与敏感赋值模式扫描 | 无行尾空白、围栏不平衡、表行边界错误或凭据赋值模式命中；并人工核对只引用字段/统计值 |
| 全仓 `git diff --check` | 非通过：既有 `app/HOWTOBUILD.md`、`ds-free-api` 文件存在行尾空白；不属于本轮，不修改；新增文档单独检查通过 |
| 新 Transport 测试/构建/设备测试 | 未执行，不报告 PASS |

**最终边界**：02d 的规范不再允许 C 之后开始任何 headers/chunk 回调；唯一终态通知与已开始回调收尾有明确边界。代码仍须修复并提供新证据，未达到 02d §6 就不能宣称 1B-ii 修复完成、1C 放行或 G1 通过。
