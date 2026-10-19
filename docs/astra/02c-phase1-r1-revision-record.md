# 阶段 1A-r1 修订记录：契约修订点 · P4c 证据映射 · 未决问题

- **修订日期**：2026-09-30（Asia/Shanghai）
- **修订对象**：`docs/astra/02-phase1-transport-contract.md`（T1A.1，2026-09-27 冻结）
- **本轮产出**：`docs/astra/02b-phase1-transport-contract-r1.md`（T1A.2-r1，阶段 1B 的唯一有效契约）；原文件追加“被替代”标注
- **修订依据**：阶段 0 · P4c 真机验证——`docs/astra/01-phase0-p4c.md`、`.probe/probe/p4c/EVIDENCE.md`、`p4c/device/*`（S1–S4、Q1、回滚）、`p4c/mock/out/*`（mock 三态）
- **范围声明**：仅文档修订。未实现 Transport；未修改 `ds.js` / `native.js` / `backend-blob.js`；未切换默认入口；未修改 `重构计划/00-baseline.md`；未改动证据文件（`VERIFY.md`、`p4c/**` 原样只读）。

---

## 0. 一句话结论

P4c 证明“宿主销毁会停止回调 / 释放上下文”的隐含假设在本固件不成立：**onStop、切后台、停止小程序、卸载之后，native 线程与 JS 回调都继续工作**；只有 `kill -9` 能真正终止。1A-r1 因此把 Transport 生命周期改为**显式终止链**（`cancel` / `cancelAll` / `closeContext` + 终止闩锁 + 投递闸门 + generation 计数），并将 `kill -9` 定为唯一受认可的“硬终止”验收证据。

---

## 1. 修订点清单（R1–R10）

| 编号 | 修订内容 | 落点（02b 章节） | 依据（P4c 证据） |
|---|---|---|---|
| R1 | 新增“宿主销毁不构成终止”的生命周期原则 P1–P4 与事实 F1–F5；删除原 §4.2“宿主开始销毁 runtime 时自动取消”的前提 | §4.2 | `01-phase0-p4c.md:10-24`、`:171-187`；`device/s1-result.txt`、`s2-result.txt`、`s4-result.txt`、`s3-result.txt`、`post-reboot-*` |
| R2 | `contextId` 新增显式 `open/closed` 状态与 generation 计数；Native 每次投递前必须检查（状态、generation、终态、已投递标记）；closed 未重开时新操作 reject `ERR_CONTEXT_CLOSED` | §2.1、§2.8、§2.9、§6.5、§7.5 | `01-phase0-p4c.md:202-211` 第 1 条；S4（卸载后回调仍执行 → 必须由 Native 侧自行栅栏）；S2（实例驻留） |
| R3 | `cancel` 明确为 JS 主动触发、不依赖宿主生命周期；新增上下文级 `cancelAll`（默认 reason `app-lifecycle-end`）；三者构成显式终止链 | §2.4、§2.10、§4.3 | P4c 四场景“宿主均不停止”+ S3“kill -9 才停”：取消是 JS 唯一可用的主动停止手段 |
| R4 | `openStream` 终止收敛唯一路径：终止闩锁（end/error/cancelled 任一提交后后续投递全丢弃）+ 投递原因白名单 + 投递闸门强制 | §2.3、§3.2（11–13）、§7.5 | S1/S2/S4 晚到投递事实（宿主不会替调用方停止投递） |
| R5 | 五种销毁场景（onStop / 切后台 / 停止小程序 / 卸载 / kill -9）的 JS/Native 责任划分表 | §4.4 | S1、S2、S4、S3 原始文件 |
| R6 | 卸载专门处理：固件无“所属 App 已卸载”信号（`ignore dlclose`）→ JS 必须在 App 生命周期结束时主动 `cancelAll`（+`closeContext`）；残余风险与 Native 责任同节写明 | §4.5 | `device/s4-log.txt`（`appDestroyed`、`ignore dlclose`、`mkdir failed`）、`s4-result.txt`、`s4-late-hit.json` |
| R7 | 矩阵更新：M19 重定义（显式终止链触发）；新增 M25–M31（S1–S4 对应场景 + generation + 终态闩锁 + cancelAll 并发）；G1 映射与放行要求更新；kill -9（M28）为唯一硬证据 | §8 | S1–S4 逐场景；`EVIDENCE.md:41-51`（mock 对照） |
| R8 | 1B 进入条件修订：显式终止链为硬性实现项、不得依赖宿主兜底；销毁验收必须含 kill -9 且断言“无任何晚到回调”；S1/S2/S4 不得作为“已终止”证据 | §11 | R1–R7 全部 |
| R9 | 未决问题更新：卸载信号（待验证）、`postJSMessage` 返回值语义（设备成功=1）、`jsapi_check_unload` 设计决策、同宿主重装未测、生命周期可得钩子梳理 | §10 | `01-phase0-p4c.md:202-211`；`EVIDENCE.md:68-70` |
| R10 | 证据来源更新：P4c 文件级映射（Q1/S1–S4/mock/回滚）；说明 `VERIFY.md` 中“P4c 未测”状态已由 p4c 目录关闭 | §9.2、§9.4 | `EVIDENCE.md:6-13`、`:53-67` |

---

## 2. P4c → 契约 证据映射（逐场景）

| # | 事实 | 原始证据文件 | 契约落点 |
|---|---|---|---|
| E0 | 设备重启后模块不会自动加载、`custom_init_jsapis` 不会被调用；手动 `miniapp_cli start` 后正常 | `p4c/device/post-reboot-dynamic-load-lines.txt`、`post-reboot-maps-probe.txt`（空）、`after-reboot-probe-result.txt` | F5（§4.2）；§4.3“上下文必须显式建立” |
| E1 | S1 退出页面：仅 `onStop`、无 `onDestroy`；30 s 延迟回调在“已停止”页面执行并写 `p4c-late-hit.json` | `p4c/device/s1-destroy.txt`、`s1-result.txt`、`s1-log.txt` | F1；M25；§4.4 第 1 行 |
| E2 | S2 停止小程序/切后台：实例驻留、探针 `.so` 3 s/45 s 后仍在 `/proc/221/maps`；晚到回调仍执行 | `p4c/device/s2-destroy.txt`、`s2-state-after-stop.txt`、`s2-result.txt` | F2；M26；§4.4 第 2、3 行 |
| E3 | S3 `kill -9 221`：native 标记止于 `scheduled`，无 `deadline`、无 JS 写入；新宿主（pid 4053）无旧模块活动 | `p4c/device/s3-destroy.txt`、`s3-result.txt`、`s3-state-after-kill.txt`、`post-kill-log-grep.txt` | F4；M28（唯一硬终止）；§4.4 第 5 行 |
| E4 | S4 卸载挂起事件：完整标记链 + JS 写入 `/tmp/p4c-late-hit.json`；日志 `ignore dlclose`、`mkdir failed` | `p4c/device/s4-destroy.txt`、`s4-result.txt`、`s4-late-hit.json`、`s4-log.txt` | F3；M27；§4.5 |
| E5 | mock 三态（alive/drop/survive）可区分“不销毁 / 销毁并丢队列 / 投递到已释放上下文”；设备 `postJSMessage` 成功=1；S4 未崩溃因框架未真正释放 | `p4c/mock/out/mock-{alive,drop,survive}/*`、`EVIDENCE.md:41-51` | §4.4 补充对照；§7.2；M28 的 mock 等价说明（S3≈drop） |
| E6 | 宿主重启会删除旧日志（需先拉取）；`miniapp_cli uninstall` 会清理暂存 amr | `01-phase0-p4c.md` §2 表（设备日志特性）、`:74-110`（关键命令）、`device/s1-cycle.txt` | M28 执行约束（§8.2 M28 行） |
| E7 | 回滚证据：卸载后旧宿主仍以 `(deleted)` 形式映射探针 `.so`；重启宿主后无映射 | `p4c/device/rollback-mapped-before-kill.txt`、`rollback-final-after-host-restart.txt` | §4.5 残余风险；M29 的“同宿主重装待验证”背景 |
| E8 | 同页面重复 `start` 不重跑 `created()` | `VERIFY.md` N2；P4c 再次确认（`01-phase0-p4c.md:202-211` 第 5 条） | §10 第 5 项（生命周期可得钩子待梳理） |

---

## 3. 未决问题（待验证 / 设计决策，未固化）

1. 固件是否向 JS 暴露 App 级销毁 / 卸载回调 —— **待验证**；1A-r1 按“不可依赖”设计（补充测项）。
2. `postJSMessage` 失败/拒绝时的返回值语义 —— **待验证（部分）**；设备成功=1；不得用 0/1 判定成败。
3. `jsapi_check_unload` 是否导出及语义 —— **设计决策（1B）**；不得作为唯一清理依赖。
4. 同一宿主进程内“卸载后重装并再次启动”同 appid 的行为 —— **待验证**（P4c 未覆盖；generation 机制为兜底设计，需要真机补测）。
5. 页面生命周期可得钩子（`onHide`/`onUnload` 等）的完整梳理 —— **待验证**；影响“最后一个可得生命周期节点”的实现位置。
6. 显式终止链执行期间“最后一个安全 JS loop 时刻” —— **待验证**；已按闸门丢弃设计，不依赖该时刻精度。
7. TLS/HTTP2/ALPN/代理库在 JSAPI 进程的稳定性（继承 T1A.1 §10）。
8. `ERR_BACKPRESSURE` 硬上限在“读取不可暂停”实现中的可执行性（继承）。
9. 代理/TLS 错误的 code 映射（继承）。
10. 16 MiB / 8 MiB 上限对阶段 3 业务输入的覆盖性（继承）。

---

## 4. 不受影响的继承项（防止隐性破坏）

- **接口命名**：`request`、`openStream`、`cancel`、`setProxy`、`clearCookies`、`getCookies` 与返回形态不变；1A-r1 仅新增 `openContext`、`closeContext`、`cancelAll` 三个操作，并新增错误码 `ERR_CONTEXT_CLOSED`。
- **取消幂等**：`cancel()` 的原子性、重复调用返回 `already-cancelled` / `already-terminal`、竞态“先提交者获胜”不变；`cancelAll`/`closeContext` 复用同一规则。
- **背压水位**：§5 表格（32 / 64 / 8 / 16；16 MiB / 8 MiB / 64 KiB；128 / 64 / 1 MiB / 512 KiB；512 / 256 / 4 MiB / 2 MiB）逐项保持 T1A.1 原值。
- **上下文隔离**：Cookie Jar / 代理 / epoch / 计数隔离不变；`contextId` 仍为不透明句柄。
- **HTTP 语义**：401/429/4xx/5xx 仍是可观察响应；redirect/超时/队列错误 code 不变。
- **矩阵既有行**：M01–M18、M20–M24 语义不变；M19 仅重定义触发方式（显式终止链），不再引用“宿主销毁自动触发”。

---

## 5. 任务覆盖自检

| 要求 | 覆盖位置 | 结论 |
|---|---|---|
| 1. contextId 显式 closed 状态与 generation；Native 投递前检查 | 02b §2.1 / §2.8 / §2.9 / §6.5 / §7.5 | 已覆盖 |
| 2. cancel 可由 JS 主动触发、不依赖宿主生命周期 | 02b §2.4（强化）、§2.10、§4.3 | 已覆盖 |
| 3. openStream 终止唯一路径：end/error/cancelled 后投递全丢弃 | 02b §2.3、§3.2（11–13）、§7.5 | 已覆盖 |
| 4. 五种场景 JS/Native 责任划分 | 02b §4.4 | 已覆盖 |
| 5. 卸载专门处理：无信号 → JS 主动 cancelAll | 02b §4.5 | 已覆盖 |
| 6. 销毁验收断言：含 kill -9 且断言“无任何晚到回调”；其他场景不得作为“已终止”证据 | 02b §8（M28、M25–M27）、§8.3 放行要求 | 已覆盖 |
| 7. 更新 M01–M24 矩阵并补充 S1–S4 场景 | 02b §8（M19 重定义 + M25–M31） | 已覆盖 |
| 8. 更新 1B 进入条件：显式终止链、不依赖宿主兜底 | 02b §11 | 已覆盖 |

| 验收项 | 结论 |
|---|---|
| 契约中不再存在“宿主销毁即停投递”的隐含假设 | 通过：02b §4.2 明确删除该前提；原 02 已标注被替代 |
| 每种销毁场景有明确 JS/Native 责任划分 | 通过：02b §4.4 五行责任表 |
| kill -9 是唯一被认可的“硬终止”证据 | 通过：02b §4.4 / §8.2 M28 / §8.3 放行要求第 2、3 条 |
| 原契约接口命名、取消幂等、背压水位不被破坏 | 通过：02b §1.4 与 §4 继承项清单；数值逐项对照 T1A.1 §5 |

- 禁止项自查：本轮的写入范围仅 `docs/astra/` 下三个文档（02b 新增、02c 新增、02 追加标注）；`ds.js` / `native.js` / `backend-blob.js` / 默认入口 / `00-baseline.md` / 证据文件均未触碰；所有引用的固件行为均来自 P4c 证据路径；文档不含 token、密钥、Cookie 与设备凭据。