# 分层排查清单对照报告（指纹/TLS/节奏/device_id/批次关联）

日期：2026-09-26。对象：ds-free-api 0.2.18 当前工作区（词典笔部署分支）。
方法：纯代码取证，未连接笔、未发线上请求、未改任何行为。
上游背景：[2026-09-25 延迟禁言审计](../docs/deepseek-delayed-mute-audit-2026-09-25.md)（下称"9-25 审计"），本报告不推翻其任何结论，只把外部分层排查清单逐项映射到本架构的真实请求面。

## 结论先行

1. **清单第一层大部分不适用**：清单假设客户端是 Android 模拟器环境（传感器、Build 属性、QEMU IP、Frida）。本客户端请求面是**纯 web 身份**（登录 `os: "web"`，无数 Android 标识上报），"设备指纹"的真实表面只有两处：数美 deviceprofile/v4 的 91 键 payload + HTTP 头/TLS。
2. **第二层 TLS↔UA 交叉矛盾已被 0.2.18 修复**（清单前提过时）：wreq `Emulation::Chrome136`（BoringSSL 实现 Chrome 136 ClientHello/HTTP2 指纹）+ 同大版本 `Chrome/136 (X11; Linux aarch64)` UA + `sec-ch-ua-platform: "Linux"` 修正。但**残留一个真缺口：mint 客户端没开 emulation、不走代理**——注册请求的 TLS 指纹和出口 IP 与登录链路不一致。
3. **第三层 P0 的数据源已具备但默认关闭**：`server.net_capture = true` 后落盘 `logs/net-capture.jsonl`（双向、带毫秒时间戳），配合新写的 `anti-ban-toolkit/interval_analysis.py` 即可做间隔方差/突发密度分析。
4. **第四层有两个确定性缺口未修**（9-25 审计 §5 已记录，本轮逐行确认仍在）：运行时补齐路径丢弃 smid、新 device_id 不回写配置（重启→重新 mint→设备身份漂移）；mint 流量与主客户端代理/传输配置脱节。
5. **最高风险的结构性特征**（对接第五层）：同一台笔 mint 的 N 个 device_id 共享一套**完全静态**的指纹值（canvas/字体/电池/collectTime），且在启动时同一出口 IP 的时间窗内批量产生——这正是批次关联引擎按 `(time_window, egress_ip, fingerprint)` 分组聚类的输入形状。

## 第一层：设备指纹与硬件参数 —— 逐项判定

| 清单项 | 判定 | 依据 |
|---|---|---|
| 传感器列表完整性 / Frida hook 上报字段 | ⚪ 不适用（前提错位） | 请求面无 Android 传感器概念；91 键数美 payload 中不存在传感器列表字段。**不需要 Frida——mint 代码就是我们写的**（`ds-free-api/src/ds_core/mint.rs` `build_payload_fields`，91 键全部显式构造） |
| 传感器数据方差 | ⚪→⚠️ 转化为"全 payload 静态"问题 | 见下方"静态字段清单"：比传感器更广，canvas/字体/时延全部恒定 |
| 充电状态与电池曲线 | ❌ **确认缺口** | `mint.rs:206` `"battery": { "charging": 1, "level": 1 }` 恒为充电+满电，任何时间任何账号 mint 完全一致 |
| 屏幕分辨率与 CPU 组合罕见性 | ⚠️ 存在，且是有意取舍 | `280_936_24_1` 竖屏 + `X11 桌面 Chrome/136` UA + `cpucount: 4`（`mint.rs` 常量 PEN_SCREEN，`json!` 内 cpucount）。桌面 Chrome + 竖屏小屏组合真实世界罕见，但笔端真实采集（`fingerprint.rs` 动态采集）尚未接入 mint（9-25 审计 §5 已指出） |
| Build.FINGERPRINT/DEVICE/MODEL 自洽 | ⚪ 不适用 | 无 Android Build 上报面 |
| Android_ID/IMEI/OAID 缺失 | ⚪ 不适用 | web 身份不含这些标识；身份两半 = device_id（服务端签发）+ smidV2（cookie） |
| `/proc/cpuinfo` 系统调用痕迹 | ⚪ 不适用 | 无服务端可见伪影；真正可见的对应物是 `cpucount: 4` 硬编码（真实笔为 4 核，值碰巧正确，但它是常量而非采集值） |
| Wi-Fi MAC/蓝牙格式 | ⚪ 不适用 | 无上报面 |
| 10.0.2.15 QEMU 网关 | ⚪ 不适用 | 真机真 Wi-Fi |

**静态字段清单**（每台笔、每个账号、每次 mint 完全相同的值——批次关联的聚类输入）：
`battery` 恒充电满电、`connectionRtt: 100`（`mint.rs:209`）、`collectTime: 85`、`im` 中 `_2154_indexedDB:2154` 常量段（`mint.rs:212`，仅时间前缀变化）、canvas 摘要 `zd`/`hm`（由 UA+屏幕字符串派生，`fp-canvas-v1` 固定盐）、字体测量 `ag`、WebGL 串 `ANGLE (Arm, Mali (Bifrost)…)`、`dv: 8`（`mint.rs:267`；若 dv 语义为 deviceMemory，Chrome 桶上限 8 与低端笔硬件可能矛盾，**需对照 CAPTCHA 内 fp.min.js 逆向确认 dv 语义后再动**）。
另：`iv.maxTouchPoints: 0 / touchEvent: false`（触屏设备上报无触摸）与笔身份矛盾，但与"服务端已接受的捕获模板"一致——**动它之前先看第五层验证原则**。

## 第二层：网络层与 TLS 指纹 —— 逐项判定

| 清单项 | 判定 | 依据 |
|---|---|---|
| JA4↔UA 交叉验证 | ✅ 已对齐（清单前提过时） | `client.rs:676` `Emulation::Chrome136`；UA 同大版本 `Chrome/136.0.0.0 (X11; Linux aarch64)`（`fingerprint.rs:26`，且有单测强制同版本 `fingerprint.rs:513`）；`sec-ch-ua-platform: "Linux"` 已修（`client.rs:759`，httpbin 实测过 wreq 默认发 "macOS" 的矛盾） |
| GREASE/扩展顺序 | ✅ 仿真层负责 | wreq（reqwest-impersonate 血统）按浏览器档案生成 ClientHello，无需手改 OpenSSL |
| JA3+JA4 双算交叉 | ⚠️ 残余风险：仿真偏差 | wreq 对 Chrome136 的仿真是第三方逆向实现，与真 Chrome 的逐字节一致性无保证；**验证方式（可选）：笔上抓 ClientHello 算 JA4 与真 Chrome 对照**，属 P2 |
| TCP/IP 栈（JA4T、MSS、拥塞算法） | ⚠️ 无法本地验证，方向有利 | 笔的内核就是嵌入式 aarch64 Linux，TCP 栈与"Linux 设备"声称方向一致；与桌面 Chrome 用户必有差异但无法归因。P2：笔上 tcpdump 对照 |
| （清单未列）**mint 链路 TLS** | ❌ **本轮新确认缺口** | `mint.rs` 的注册 client 仅 `.user_agent(ua)`，**无 emulation** → deviceprofile/v4 的 TLS 指纹是 wreq 默认非浏览器指纹；同一 device_id 身份：注册=非浏览器 TLS，几秒后登录=Chrome136 TLS。层间矛盾（注册流量自己暴露） |
| （清单未列）**mint 链路出口 IP** | ❌ 缺口 | mint client 不取主 DsClient 的 proxy 配置（9-25 审计 §5 已记，本轮逐行确认未修）；配代理时注册与登录出口不同 |

已对齐、无需再查的第二层项：XHR 语义头（sec-fetch-site/mode/dest、accept、origin/referer、priority）、cookie jar（HWWAFSESID/HWWAFSESTIME/ds_session_id/smidV2 随 Set-Cookie 累积回传）、X-Client-* 五件套。
**注意**：`net_capture` 落盘的 out 头只含应用层显式头，不含仿真层默认头——**线上真实头序无法从现有抓包验证**，列为 P2（需外部对照）。

## 第三层：行为时序与请求节奏 —— 逐项判定

| 清单项 | 判定 | 依据 |
|---|---|---|
| 间隔方差过小 | ⚠️ 部分落地，待实测 | 步骤间人速抖动已注入：`human_delay_ms()` 均匀 300–1200ms（`accounts.rs:1132`）、登录后 1–3s / 0.8–2s（`accounts.rs:1087,1089`）、重试间隔 5–15s（`accounts.rs:386`）。**均匀分布本身是可检测的分布形状**（真人更接近重尾），但先有数据再改——进入 P0 实测 |
| 机器节奏/毫秒级稳定 | ✅ 主要周期源已对齐 | HIF 刷新按服务端 `x-hif-ttl`（默认 600s，`hif.rs:28`）+ 失败 1s 指数退避封顶 600s，与前端行为一致 |
| 突发/滑窗密度 | ✅ 已有机制 + 待实测 | 滑动窗口 3600s hourly_quota（`accounts.rs` WINDOW_SECS），限流退避绝不换号重试（9-25 审计 §4） |
| P0：封禁前 8–12h 间隔分布 | 🔧 **工具已备，数据待采** | `logs/net-capture.jsonl`（`main.rs:9`，`server.net_capture` 默认 **false**——`config.rs:491`）+ `anti-ban-toolkit/interval_analysis.py` |

固定间隔检查结论：业务链路无固定周期打上游的循环（completion 全部用户驱动）；唯一周期性是 HIF（设计内、与前端一致）和后台重登（有退避）。`completions.rs` 内数处 500/200ms 固定 sleep 属内部编排，不直接产生上游请求。

## 第四层：device_id 与账号关联 —— 逐项判定

| 清单项 | 判定 | 依据 |
|---|---|---|
| device_id 是否真实注册过 | ✅ | `mint.rs` 走数美 deviceprofile/v4，`code:1100 → detail.deviceId` 服务端签发（B 前缀）；伪造值路径从未使用。`is_issued` 仅查前缀的语义弱化保持 9-25 审计 §5 的记录不动 |
| 同一 device_id 挂多账号 | ✅ 已避免 | 每账号独立 mint（`device_bootstrap.rs:44-74`） |
| **反向关联：N 个 device_id 同指纹同 IP 短窗批量 mint** | ⚠️ 结构性特征，无解需认知 | 同机多账号启动时逐个 mint：同出口 IP、同静态指纹、时间窗集中 + 共享一个 smidV2 cookie。真实浏览器是"1 设备 1 device_id 1 smid，多账号复用"——我们是"独立 device_id + 共享 smid"的罕见组合。单账号场景无此问题 |
| device_id↔其他指纹环境一致性 | ❌ 两缺口 | ① `accounts.rs:946` `let (device_id, _smid)` ——运行时补齐路径**丢弃 smid 且不回写 config**：重启后该账号重新 mint 新 device_id（设备身份漂移），且登录 device_id 与 jar 里 smidV2 配对断裂；② mint client 代理/传输脱节（见第二层） |

## 第五层：服务端批次关联 —— 可做与不可做

Ban 层不可观测，只能用时间线数据验证假设：

- **00:00/12:00 UTC 窗口假设**：待验证。用户记录每次 `is_muted` 发现时间 + `mute_until`，反推对齐 08:00/20:00 本地（UTC+8）。9-25 审计 §6 的"封禁五要素"记录要求不变：最后成功时间、首次看到 is_muted、服务端 mute_until、实际请求数、有无后台重登/配置重载。
- **静态指纹聚类**（第一层结论的落地）：单账号 + 单笔时，风险集中在"跨账号复用同一指纹模板"；多账号场景下，同批 mint 的 device_id 天然成簇。
- 工具：`interval_analysis.py --mute-at <时间>` 输出封禁前 12h 的节奏画像与封禁后对比。

## 修订后的优先级（替代清单原 P0–P2）

> **2026-09-26 下午更新**：两个 P1 缺口已按 TDD 流程修复并部署笔端（0.2.19，宿主测试 220/220，真机 health ready、net-capture 落盘验证通过）。见 [ds-free-api/CHANGELOG.md 0.2.19](../ds-free-api/CHANGELOG.md)。

| 优先级 | 事项 | 动作 | 状态 |
|---|---|---|---|
| **P0** | 间隔方差实测 | 笔端 config 开 `server.net_capture = true`，正常使用 ≥24h，拷回 `logs/net-capture.jsonl`，跑 `anti-ban-toolkit/interval_analysis.py` | **已开启**（18:26 起落盘）；等数据 |
| **P0** | 封禁时间线 | 按 9-25 审计 §6 五要素记录下一次禁言 | **进行中**：本次禁言发现时刻 2026-09-26 18:26:34（登录即见）、mute_until 2026-09-27 00:35（+08:00）；待补：最后一次成功 completion 时刻 |
| **P1** | mint 链路一致性 | 注册 client 补 `Emulation::Chrome136` + 继承主客户端 proxy | ✅ 已修复（base_http_builder 单点共享，TDD 红→绿） |
| **P1** | 设备身份稳定性 | `try_init_account` 回写新 device_id+smid 到持久凭据，消除重启重 mint | ✅ 已修复（persist_account_credentials + set_smid_cookie） |
| **P2** | 静态字段真实化 | 方向：把 `fingerprint.rs` 笔端动态采集接入 mint payload（battery/touch/collectTime/im 序列），**不凭空捏造数值**（9-25 审计原则）；dv 语义先对照 fp.min.js 逆向 | 新证据：真机动态采集实测 memGB=**1**（mint payload `dv:8` 与真实硬件矛盾，若 dv 语义为 deviceMemory 则确认失真）；touch=0 同理（真机有触摸） |
| **P2** | JA4/头序实测 | 笔上抓包与真 Chrome 136 对照（wreq 仿真偏差、真实头序） | 可选 |

## P0 操作步骤（笔端）

1. `config.toml` → `[server]` 节加 `net_capture = true`，重启后端（miniapp_cli 部署注意先 `killall miniapp`）。
2. 正常使用 ≥24h（覆盖一个可能的 8–12h 禁言窗），期间不做任何变量变更。
3. 拷回 `$dataDir/logs/net-capture.jsonl`（连同 `runtime.log`）到本仓库 `logs/`。
4. `python anti-ban-toolkit/interval_analysis.py logs/net-capture.jsonl`（有禁言时间则加 `--mute-at`）。
5. 输出按端点类给出间隔统计/CV/滑窗密度/burst 标记——先看 CV 是否显著低于真人水平，再看 burst。
