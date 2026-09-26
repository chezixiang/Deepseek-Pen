# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.18] - 2026-09-25

### Added（调试网络抓取：禁言/风控第一手报文自动留痕）
- **`[server] net_capture` 配置项 + `server::net_capture` 模块**：开启后把发往
  上游（DeepSeek 全部端点 + HIF 分发服务 + 数美注册 + wasm/fp 静态资源）的
  全部 HTTP 往返逐条落盘 `$DS_DATA_DIR/logs/net-capture.jsonl`，格式与手工
  net-export jsonl 一致（每行一个事件：`request` / `response` / `response_body`
  / `error`，`id` 关联同一次往返），超 5MB 轮转保留 .1/.2。
- **SSE 流全量留痕**：completion 流用 CaptureStream 包装，累计至 256KB 截断，
  正常结束、出错、上层提前断流（drop）都会落盘已收到的部分——禁言等业务
  失败常在首帧 biz_code 里。
- **词典笔端联动**：设置页「启用调试日志」开关联动写入 `net_capture` 并自动
  重启后端；诊断日志弹窗新增「网络抓取」tab 可看尾部与清空。
  报文含 Authorization/Cookie 等真实凭据，外发前注意脱敏。

## [0.2.17] - 2026-09-25

### Changed（风控差异分析落地：对齐官方 web 客户端行为流）
基于 79MB 官方抓包（FULL.har/new.har/ban.har）与本实现的全量对比，消除"非人指纹"：

- **不再 create/delete 孤儿会话**：官方 79MB 抓包里 session/delete 仅 1 次（用户
  手动删），旧实现"登录验证 + 每次冷请求"都产生 create→delete 对，是聚类
  签名。登录验证环节整段移除；账号可用性由登录响应 mute 状态与首次真实请求验证。
- **拟真开屏序列**：官方登录后是 settings(did) → 会话列表 的浏览行为，旧实现
  登录后 0 静默请求直奔 completion（"登录即对话"指纹）。现在登录成功后补发
  `client/settings?did=…` → `fetch_page`，间隔随机 1-3s；did 从账号 device_id
  派生（稳定 UUID 形状，每账号不同）。
- **登录串行化 + 抖动**：13 账号并发登录改为串行、账号间随机 5-15s——
  "同 IP 同分钟 N 个新设备注册 + N 次登录"是典型批量特征。
- **completion 链路人速抖动**：create_session 后随机 300-1200ms（官方有
  人类间隔，旧实现机器速连发）。
- **completion payload 形状对齐**：补显式 `"parent_message_id": null`（首条）与
  `"action": null` 键（官方恒有；旧实现 skip 掉 None 少键）。
- **Referer 按会话定制**：completion 的 Referer 为 `{origin}/a/chat/s/{session_id}`
  （官方在会话页发），旧实现一律 `{origin}/`。
- **default_search_enabled 默认 false**：100% 对话都开搜索在真实用户分布里
  几乎不存在；联网需求由应用侧显式传 web_search_options。
- **禁言账号跳过周期重登**：mute_until 未到期时恢复任务不再 re_login
  （禁言期持续异常登录会延长上游观察期）。

## [0.2.16] - 2026-09-25

### Fixed（词典笔端 5 项 bug + 启动体验重构）
- **早绑定启动（启动慢）**：`server::run` 先绑定端口开始服务，wasm 下载 /
  PoW 编译 / 全账号登录移到后台任务；`/health` 新增 `ready` 字段
  （后台初始化完成才为 true），业务 handler 在就绪前统一返回
  503 `initializing`。应用侧（词典笔 startup 页）等待 ready 才放行进入聊天页。
- **云端消息树剪枝（编辑/重试堆叠）**：`history_messages` 实测字段是
  `message_id`/`parent_id`（均为数字，此前解析用 `id` 全部落空 → 整树平铺，
  编辑/重试的所有版本堆叠显示）。现在按树剪枝：只下发活跃链（每层数组最后
  一个子节点），被替换的兄弟版本放入 `CloudMessage.alt_texts`；应用侧映射为
  已有的版本切换 UI（revisions/attempts）。真机数据验证：一条含两次编辑的
  会话从 28 条平铺修正为 22 条活跃链 + alt_texts。
- **禁言识别与停止重试（延迟封号放大器）**：真机抓到禁言空流的真实形态是
  `biz_code:5` + `biz_msg:"user is muted"`（空格）+ `is_muted:1`——旧实现只认
  下划线形态 `user_is_muted`，漏检后被当"空 SSE 流"**重试 3 次**，每次白烧一个
  上游请求。现在禁言（空流/hint 两种路径）统一映射 `CoreError::Rejected`：
  不重试、带精确到期时间直达用户。
- **启动健康检查 completion 移除**：登录初始化不再发"test completion"健康检查
  （每账号每次冷启动省一次真实对话请求）；create/delete session 验证保留。
- **删除云端会话的逐账号尝试上限**：`delete_cloud_session` 最多尝试 3 个账号
  （原先打满全账号池）。
- **config.toml/stats.json 权限放宽 0644**：部分机型应用进程非 root，0600 的
  root 属主文件导致应用侧 fs.readFile 失败 → "无法读取 ds-free-api 配置文件"
  （10201）。
- **删除云端会话路由同时挂 POST/DELETE**：笔端 Falcon http 模块不支持 DELETE
  方法（405 的直接成因）；应用侧已改用 POST，DELETE 保留给标准调用方。

## [0.2.15] - 2026-09-22

### Fixed（限流被当成账号故障 + 可重试 → 账号被禁言）
- **上游限流不再走 `mark_error`**：旧实现收到 `rate_limit_reached` 就把账号标记为
  Error，而后台恢复任务 5 分钟后会去**重新登录**（登录本身也是上游请求），
  叠加 `v0_chat_cold` 的 3 次重试 + 适配器的 1 次重试（每次重试都新建 session），
  在短窗口内堆出请求洪峰 —— 上游据此判定异常客户端并升级为**禁言**。
- **新增 `CoreError::RateLimited`**（此前限流复用 `Overloaded`，语义与处理方式都不同）：
  - `check_hint` 把 `rate_limit` 映射为 `RateLimited`；
  - `v0_chat_cold` / `try_chat` 对限流**永不重试**，直接透传给调用方；
  - 错误码 `upstream_rate_limited`（HTTP 429），与"服务繁忙（overloaded）"分开。
- **账号级限流退避**（`AccountPool::mark_rate_limited`）：连续被限流时阶梯退避
  60s→180s→600s→1200s→1800s；退避中的账号
  - `get_account` 不分配；
  - `get_account_by_id`（会话亲和）**同样不放行**——否则用户连点重试会沿同一条
    会话持续冲击上游；
  - `get_account_with_wait` 在全池退避时立即返回，不再白等 30 秒才报错；
  - 重登成功时清除退避（`clear_cooldown`）。
- 新增回归单测：`check_hint_classifies_rate_limit_separately`、
  `cooldown_ladder_escalates_and_clears`、`cooldown_account_is_not_allocated`。

### Added（删除云端会话：`DELETE /v1/cloud-sessions/{id}`）
- 应用侧删除本地对话时同步删除云端会话 —— 否则下次「同步」会把这条会话导回本地
  （用户看到"删了又回来"）。
- `ds_core::delete_cloud_session`：会话是**账号作用域**的，多账号池下 cloudId 未必
  属于当前空闲账号，因此逐个空闲账号尝试删除，全部失败才报错；同时清掉本地
  复用缓存里指向该会话的条目，避免下次续聊撞到已删除会话。
- `AccountPool::account_count()` 辅助（有限轮询的循环上界）。

### Fixed（限流仍有两处漏网路径会放大请求量 → 禁言）
上一版把「限流不重试」做在了 `v0_chat_cold` / `try_chat`，但真机上"限流后紧接着重试"
仍会被禁言，复查发现两条路径没堵住：

- **会话复用的降级冷启动**：`v0_chat` 命中缓存后若 `v0_chat_reuse` 出错，旧实现**无条件**
  降级到冷启动路径——而冷启动会**新建一个 session**（还可能换到别的账号）。于是用户每点
  一次「重试」就多一轮上游请求，限流的洪峰被一次次续上。现在限流错误直接上抛
  （`Err(e @ CoreError::RateLimited(_)) => return Err(e)`），不再降级。

- **复用路径取不到目标账号时的 5 秒等待**：退避中的账号 `get_account_by_id` 返回 None，
  旧实现会一直等到超时再降级冷启动（同上放大）。新增 `AccountPool::account_cooldown_remaining`
  区分两种"拿不到"：在退避 → 立即以 `RateLimited` 返回（附剩余秒数）；账号已失效 → 才允许降级。

- **新增 `CoreError::Rejected`**（请求级确定性拒绝）：`input_exceeds_limit` 这类错误，
  成因不会因重试而改变，但每次重试都要新建 session + 重传文件，把 1 次用户操作放大成
  3 次上游请求。此前它复用 `ProviderError`，会被冷路径重试循环吞掉 3 次。现在
  `v0_chat_cold` 对它直接上抛。禁言（`user_is_muted`）**保持** `ProviderError`——它是
  账号级状态，换号是有效恢复手段，重试循环正是靠 `mark_error` 换号来救这一单。

- 新增回归单测：`account_cooldown_remaining_targets_one_account`；
  `check_hint_classifies_rate_limit_separately` 补充断言（禁言仍为 ProviderError、
  超长为 Rejected）。

## [0.2.14] - 2026-09-22

### Fixed（同一对话上下文丢失：续聊被误判成编辑重答）
- **`plan_conversation` 的 regenerate 判据用错了比较对象**：查找键是「除最后一条 user
  外」的上下文哈希，命中缓存后旧代码拿**本轮新消息**去比缓存里的 `last_user_text`
  （缓存记的是该上下文之后那条 user 消息），因此**每一轮续聊都判定为编辑**，
  走 `edit_message` 重写上一条提问并截断其后内容 —— 应用侧表现为"同一对话里模型只
  记得最新一条消息"。设备日志实证：14 次会话复用全部 `regenerate=true`，零次续聊。
- 改为对比「上下文里最后一条 user 消息」（新增 `context_last_user_text`）：
  续聊 → 上下文里已有该条（相等）→ Append；编辑 → 它已被改掉（不等）→ Regenerate；
  上下文里没有任何 user 消息（编辑/重试首条）→ 一律 Regenerate。
  补回归单测 `context_last_user_text_tracks_context_tail`（含纯图片占位符口径）。

### Added（下发云端会话 id，供应用侧去重同步）
- **`ChatResponse.session_id` / `persistent`**：把本次对话的 `chat_session.id`
  （即 `fetch_page` 侧栏里那条）从 `ds_core` 透传到适配器。
- **`ds_session_id`**：持久会话在流末尾追加一个尾随 chunk（形态与 `ds_title` 一致，
  空 choices）下发该 id，非流式响应亦携带同名字段。应用侧据此把本地会话与云端会话
  对上号，同步时不再把同一条对话重复导入。

## [0.2.13] - 2026-09-20

### Fixed（登录失败：上游为空值字段导致反序列化中断）
- **`ChatMute.mute_until` / `is_muted` 遇到 JSON `null` 时整个登录响应解析失败**：
  上游在账号**未禁言**时会显式返回 `"mute_until": null`，而 `#[serde(default)]`
  只在字段**缺失**时生效 —— 于是最常见的正常账号反而登录不了，账号池恒为
  `total: 0`、服务一直降级运行，应用侧表现为"账号密码都对但用不了"。
  实测报错：`invalid type: null, expected f64 at line 1 column 375`。
  改为 `deserialize_with = "null_to_default"`（null 当作字段缺失回落默认值），
  并补 4 个回归单测覆盖：null / 真实禁言时间 / 空 chat 对象 / 无 chat 字段。

## [0.2.12] - 2026-09-20

### Changed（设备凭据改为纯后端自动，用户零操作）
- **新增 `device_bootstrap` 模块**：启动时为所有缺凭据的账号自动 mint device_id
  并持久化（幂等：已有 `B`/`D` 前缀凭据跳过）；`try_init_account` 再兜一层
  `ensure_one` 覆盖运行时新增账号（应用/管理面板添加）
- `mint_device_id` 返回 `(device_id, smid)` 并自带 `B` 前缀，注册流程产出的
  smidV2 一并写入配置（保持 device_id + smid 双绑定与真实浏览器一致）
- `DsClient::user_agent()` 访问器（凭据生成复用同一浏览器身份）

### Removed（app 侧废弃的验证路径）
- **WPE 浏览器 navTo 方案**：`detectBrowserApp()` 用 app 沙箱读
  `/userdisk/secondary/miniapp/.../8001779591038449`，该目录权限 700（root 独占），
  沙箱读不到导致检测恒为 false → 浏览器分支永不执行（bug 报告 1 的根因）；
  且该浏览器 miniapp 并非所有机型都预装
- **手机扫码方案**：需用户手机 + 同一 WiFi + 理解成本高，被纯后端方案取代
- 设置页的"设备验证"子块（改为跳转专用登录页）

## [0.2.11] - 2026-09-20

### Added（纯 Rust device_id 生成：deviceprofile 注册协议逆向完成）
- **`ds_core/mint.rs`**：不依赖浏览器/JS 引擎，直接在 Rust 内完成数美
  deviceprofile/v4 注册并取得服务端签发的 device_id。协议全链路逆向自
  fp.min.js（方法见 docs/deepseek-verification-analysis.md §5d–5f）：
  - uid = UUID v4；**AES key = md5(uid)[..16] 的 ASCII 字节**（实证），
    iv 固定 `0102030405060708`，明文 = base64(gzip(81 键指纹 JSON))，
    AES-128-CBC + ZeroPadding → hex = `data`
  - `ep` = RSA-PKCS1v1.5(uid, 数美公钥)（服务器解出 uid 自行派生 AES key）
  - 请求体 7 字段：`appId/organization/ep/data/os:"web"/encode:5/compress:2`
  - 17 个 DES 逐字段加密（canvas/UA/时区/时间戳/uid 等），密钥为每字段
    独立的硬编码 8 字符串，密码学复用本地 sm_des crate
  - `ip` 字段 = DES(canonical 哈希)；canonical 语义为"顶层键排序、数字
    ×10000、嵌套对象不递归（[object Object]）、数组逗号连接"
- **启动时自动补齐**：账号 device_id 非数美签发格式（无 `B`/`D` 前缀）时
  自动 mint 并持久化（失败不阻断，沿用旧值）
- **调试辅助**：`DS_MINT_DUMP=<path>` 落盘 payload/body；
  `/device/fp-patched.js` 提供插桩版 SDK（同源）用于差分调试；
  `/device-id-capture/debug` 收集真实浏览器内部状态
- 实证：宿主 5/5 成功；笔上酸测 mint 的凭据通过设备校验（登录推进到
  账密环节而非 biz_code 11）
- 单元测试：canonical JS 语义、smid 格式、AES 分组、字段往返（共 166 项）

## [0.2.10] - 2026-09-19

### Added（纯笔内 device_id 方案：利用笔上 WPE WebKit 浏览器 miniapp）
- **设备验证辅助页** `src/server/device_capture.rs`：发现笔自带 WPE WebKit 浏览器
  miniapp（appid 8001779591038449，wpe4ydpv2），新增 `/device` 页面在其真实浏览器
  环境里运行 DeepSeek 官方数美 SDK（fp.min.js，organization/公钥来自 main bundle
  逆向），生成**真实** device_id + smidV2 后经 `/device-id-capture/submit` 自动写入
  config.toml 对应账号并重新登录——零伪造、零外部设备、纯笔内闭环
- **端点**：`GET /device`（辅助页）、`GET /device-id-capture/accounts`（掩码账号
  列表）、`POST /device-id-capture/submit`（写入 + 重登）；全部要求 key 等于已配置
  API Key，服务仅绑 127.0.0.1（浏览器在笔上，无外部暴露）
- **词典笔端**：设置页新增「设备验证」入口（builtin 模式），通过
  `$falcon.navTo('falcon://1779591038449/index', {url})` 拉起浏览器加载辅助页；
  登录因 RISK_DEVICE_DETECTED 失败时的日志提示已指向该入口
- 新增掩码/模板单元测试

## [0.2.9] - 2026-09-19

### Added（x-hif-leim 逆向突破：无需 JS 引擎，动态凭据直接拉取）
- **`ds_core::hif` 模块**：bundle（main.7d19d7e901.js）逆向证实 x-hif-leim /
  x-hif-dliq **不是本地 JS 生成**，而是页面内 poller 从 DeepSeek 分发服务
  （hif-leim/hif-dliq.deepseek.com/query）定期拉取的公开凭据——裸 curl 实测
  即可取得，无鉴权、TTL 600s。`HifManager` 后台任务按前端同款策略轮询
  （成功按 TTL 刷新、失败 1s 起倍增退避封顶 600s），leim/dliq 独立轮询
- **`completion()` 自动附加** `x-hif-leim` / `x-hif-dliq`（有值才发），与真实
  浏览器行为一致；此前两个头从未发送
- **配置**：`hif_auto_fetch`（默认 true）、`hif_leim` / `hif_dliq`（静态覆盖，
  仅调试实验用）
- 新增单元测试（端点常量、token 存取），共 161 项

### 结论
**无需嵌入 JS 执行器**：x-hif-leim 是纯 HTTP 动态凭据，Rust 原生实现即取即用，
取到的是真实有效 token 而非伪造值。此前 0.2.8 中"hif_leim 静态透传"升级为
动态拉取 + 静态覆盖。

## [0.2.8] - 2026-09-19

### Added（.probe/new.jsonl 抓包分析产物，详见 docs/deepseek-verification-analysis.md）
- **cookie store**：wreq 启用 `cookies` feature 并挂共享 Jar——抓包实证真实浏览器
  全程携带 HWWAFSESID/HWWAFSESTIME（华为云 WAF）、ds_session_id、smidV2（数美）
  等cookie，此前我们的请求链零 cookie 是明显的自动化特征
- **`Account.smid`**（可选）：数美 smidV2 Cookie 透传。登录请求同时携带 body 的
  device_id 与 cookie 的 smidV2（同一设备身份的两半），只发 device_id 与真实浏览器
  不符；从浏览器 Cookie 抓取后填入，同设备多账号共用一个值；留空 = 不发
- **`DeepSeekConfig.hif_leim`**（可选）：x-hif-leim 请求头透传。抓包实证仅
  /chat/completion 携带、页面加载级作用域（全会话恒定一个值）、前端混淆 JS 生成
  无法复现、服务端当前未强制；留空 = 不发
- **`examples/header_probe.rs`**：头指纹实测探针（httpbin.org 回显，验证
  UA ↔ client-hints 一致性）

### Fixed
- **sec-ch-ua-platform 与 UA 矛盾**：wreq Chrome136 emulation 默认发送
  `sec-ch-ua-platform: "macOS"`（profile 默认 OS），与我们的 `X11; Linux aarch64`
  UA 自相矛盾（httpbin 实测确认）；显式覆盖为 `"Linux"`

## [0.2.7] - 2026-09-19

### Added
- **每账号每小时请求配额**（`hourly_request_quota`，默认 60，0 = 不限制）：
  上游实测同一账号累计约 215 次/小时会被禁言（biz_code 5）且为延迟判定，
  配额用尽的账号本窗口内不再被分配（会话亲和的续聊请求除外，用量照常计数）；
  `AccountStatus` 新增 `used_this_hour` / `quota_exhausted` 字段
- **device_id 风控处理**（对齐上游 NIyueeE/ds-free-api v0.4.0 的实测结论）：
  - 登录返回 `RISK_DEVICE_DETECTED`（biz_code 11）时映射为带抓取指引的明确错误，
    不再盲目重试；`init_account` 对该错误短路
  - 多账号共用同一 `device_id` 时启动告警（设备级指纹被上游用于关联画像，
    共用显著提升连坐禁言风险）
  - `Account.device_id` 文档补齐抓取步骤（users/login 请求体 / `SMSdk.getDeviceId()`）
- **`default_search_enabled` 配置**（默认 `true` 保持历史行为；`false` 时未传
  `web_search_options` 即关闭搜索，减少 DeepSeek 侧系统提示词注入）
- **`input_character_limits` 配置**（与 model_types 等长校验，旧配置自动补齐，
  上游实测 2621440）
- **模型注册表裸名**：`default` 等裸 model_type 名可直接作为 model_id 使用
- **词典笔端（app/）**：
  - 调试模式出站代理：设置页可写入 `[proxy]`（Socks5/HTTP）并自动重启后端
  - Emoji 文字替换降级：设备不支持字体注册（无 weex/dom 模块）时，
    emoji 渲染为文字标签（如 [赞]），不再出现白块；字体注册成功则自动关闭替换

### Changed
- **浏览器指纹切换为 Linux aarch64 Chrome**：默认 UA 从 Windows 桌面
  Chrome/136 改为 `X11; Linux aarch64` Chrome/136（与 Emulation::Chrome136
  的 TLS 指纹同大版本、与词典笔真实硬件平台一致）；`fingerprint.rs` 重写为
  运行时动态采集（/proc/meminfo 内存、available_parallelism 核数、framebuffer
  屏幕、chrono 时区、系统 locale、/sys GPU 信息、machine-id 派生 canvas 替代
  哈希），配置可选逐字段覆盖
- **词典笔端自动修复**：`fixFingerprint` 会把历史 UA（Windows/x86_64/Android）
  就地改写为 Linux aarch64 Chrome 136，最小配置模板同步更新并写入
  `hourly_request_quota`

## [0.2.6] - 2026-05-05

### Added
- **Web 管理面板**：基于 Vite + React + shadcn/ui 的 SPA，含登录、Dashboard 概览页、配置编辑页。
  `PUT /admin/api/config` 统一替代旧 keys/accounts CRUD / reload / relogin 等 6 个分散端点。
  配置编辑支持 Server、DeepSeek、模型类型、工具调用标签、代理、账号、API Keys 七节编辑，
  账号和 Keys 常驻展开，其余默认折叠。
- **管理后台安全**：`auth.rs` JWT 签发/验证（HMAC + SHA256），管理员密码设置与登录，
  密码 bcrypt 哈希存储，登录频率限制。
- **Config 管理增强**：
  - 配置自动创建：配置文件不存在时自动生成最小配置写入磁盘
  - `Config::save()` 原子写入（tmp + rename + 0600 权限）
  - `Config` 改为 `Arc<RwLock<Config>>`，运行时可变，管理面板变更自动持久化
  - `DS_CONFIG_PATH` 环境变量，优先级：`-c` > `DS_CONFIG_PATH` > 默认 `config.toml`
  - 配置归并：`admin.json`、`api_keys.json` 合并到 `config.toml` 的 `[admin]` / `[[api_keys]]` 节
  - PUT 配置合并保护：密码/key 为 `***`/空值时自动保留当前值
- **Docker 部署**：`docker/Dockerfile`（alpine:3.21，musl 静态编译，~20MB 镜像）、
  `docker/docker-compose.yaml`、`docker/config.example.toml`（host = 0.0.0.0，空账号）。
  镜像发布到 ghcr.io。
- **重试全链路日志**：`try_chat()` 每次 Overloaded 退避重试输出 WARN 日志（含尝试次数和等待时间），
  重试成功输出 INFO，全部失败输出 WARN 终结日志
- **WAF 友好提示**：检测到 AWS WAF Challenge 时输出清晰的双语提示，替代原有的无意义错误
- **账号自动去重**：启动时按 email（优先）或 mobile 去重
- **`X-Client-Locale` 请求头**：DeepSeekConfig 新增 `client_locale` 字段，默认 `zh_CN`
- **代理配置**：`[proxy]` 配置项，支持 HTTP/HTTPS/SOCKS5
- **CI build-frontend 独立 job**：产物供后端 check/test 使用，确保编译嵌入真实前端文件
- **GPL-3.0 许可证**

### Changed
- **HTTP 客户端**：`reqwest`（rustls）→ `rquest`（BoringSSL + Chrome 136 TLS 指纹模拟）。
  替换后 TLS 握手指纹模拟 Chrome 136 浏览器，配合 Android 请求头绕过 WAF 指纹检测
- **默认端口**：`5317` → `22217`，避开 Win10 Hyper-V 动态端口保留区间（5000–6000）
- **默认请求头**：全面切换为 DeepSeek Android 客户端格式 ——
  `User-Agent: DeepSeek/2.0.4 Android/35`、`X-Client-Version: 2.0.4`、`X-Client-Platform: android`
- **wasmtime**：43.0.0 → 44.0.0，修复安全通告 RUSTSEC-2026-0114
- **`model_aliases` 类型**：`HashMap<String, String>` → `Vec<String>`，按 index 对齐 `model_types`
- **`/` 根路径**：从 JSON 端点列表改为 302 重定向到 `/admin`
- **stderr 彩色日志**：TRACE=紫、INFO=绿、WARN=黄、ERROR=红、DEBUG=蓝，仅终端连接时启用
- **handler/store 重构**：
  - `chat_completions` / `anthropic_messages` 统计日志提取为 `AppState::record_request()`
  - `admin_setup` / `admin_login` 从各 ~50 行压缩到 ~12 行
  - `admin_reload_config` 从 ~70 行压缩到 ~10 行
  - `StoreManager` 从读写独立 JSON 改为委托共享 `Arc<RwLock<Config>>`
- **CI 构建重构**：
  - `build-frontend` 独立 job，check/test 通过 `needs` 依赖前端产物
  - `cross` 升级到 0.2.5，aarch64-linux-gnu/musl 迁移到原生 ARM 运行器（`ubuntu-24.04-arm`）
  - `actions-rust-lang/setup-rust-toolchain` 替换 `dtolnay/rust-toolchain`
  - `just check-web` 新增前端校验命令（npm ci + build + lint）
- **过时内容清除**：
  - 移除 6 个分散管理端点（keys CRUD / accounts CRUD / reload / relogin）
  - 移除 `sse_stream()` / `SseSerializer`（流式响应全面改用 `inspect`/`map`/`TokenGuardStream`）
  - 移除 `StopStream` / repetition detection
  - 移除 `.dockerignore`、根目录 `Dockerfile` / `docker-compose.yml`
  - 移除 `web/config.toml` 等无用旧文件

### Removed
- `reqwest` 依赖
- `admin.json`、`api_keys.json` 独立文件（合并入 `config.toml`）
- 启动时 `accounts.is_empty()` 验证（无账号通过管理面板补充）
- `DS_CONFIG` 环境变量（由 `DS_CONFIG_PATH` 替代）
- `web/config.toml`

### Fixed
- **CI 幂等性**：`cargo install` 步骤添加 `command -v` 前置检查
- **client.rs 日志违规**：`print_waf_hint()` 中 11 条 `warn!` 补全 target 参数
- **stats.json 空文件**：不再触发 EOF 解析 WARN，降级为 INFO
- **e2e 端口硬编码**：runner.py / stress_runner.py 改为从 config.toml 动态读取端口
- **AGENTS.md 过时内容**：`/` 端点描述、`[[server.api_tokens]]` → `[[api_keys]]`、WASM 故障排查等

### Docs
- **README / README.en.md**：新增环境变量表格；设计哲学补充"非必要不引入额外运行时系统依赖"；管理面板截图
- **`docs/en/`**：英文文档目录，所有文档提供英文版
- **`docs/development.md` / `docs/en/development.md`**：构建、Docker、e2e 测试开发指南
- **Prompt injection 策略**：更新 README 中 DeepSeek 原生标签注入策略说明
- **CLAUDE.md / AGENTS.md**：架构描述精简，新增故障排除表、请求追踪 grep 示例、`#[allow]` 策略说明

## [0.2.5] - 2026-04-30

### Added
- **文件上传**：支持通过 API 上传文件/图片到 DeepSeek。OpenAI 端点的 `file` / `image_url` content part
  和 Anthropic 端点的 `document` / `image` content block 均可使用。内联 data URL 自动上传，
  HTTP URL 触发搜索模式，由模型自行访问
- **XML `<invoke>` 格式原生解析**：直接解析 `<invoke name="..."><parameter>` 格式的工具调用，
  无需触发修复管道，响应更快
- **流式工具调用保活**：模型生成工具调用期间（通常 2–10s），每 1s 发送空增量块防止客户端超时。
  OpenAI 端点为空 `tool_calls` delta，Anthropic 端点为 `"tool_calls..."` thinking 块
- **工具调用标签用户自维护**：`config.toml` 新增 `[deepseek.tool_call]` 配置项，
  用户可随时追加新发现的模型幻觉标签，无需等待代码更新

### Changed
- **Prompt 格式升级**：从 ChatML（`<|im_start|>` / `<|im_end|>`）全面迁移到 DeepSeek 原生标签格式。
  每次 `<｜User｜>` 前插入 `<｜end▁of▁sentence｜>` 闭合上一轮；工具结果改用 `<｜tool▁outputs▁begin｜>` 包裹；
  reminder 嵌入 `<think>` 块。与 DeepSeek 官方 chat_template 对齐后，模型遵循度明显提升
- **工具调用主标签变更**：从 `<|tool_calls_begin|>` 改为 `<|tool▁calls▁begin|>` / `<|tool▁calls▁end|>`
  （使用 ASCII `|` + `▁`）。模型输出这个标签的概率大幅高于旧标签，幻觉变体明显减少。
  默认回退标签覆盖已知变体：`<|tool_calls_begin|>`、`<|tool▁calls_begin|>`、`<|tool_calls▁begin|>`、`<tool_call>`
- **智能搜索默认开启**：搜索模式下 DeepSeek 注入的系统提示词更强，能提升工具调用遵循度

### Fixed
- **Anthropic 协议兼容性**：`message_start` 补回 `stop_reason: null` / `stop_sequence: null`；
  `message_delta` 始终携带 `usage.output_tokens`；usage 不再始终为 0。
  以上修复解决 Claude Code 等标准 Anthropic 客户端的兼容性问题
- **文件上传错误处理**：历史对话文件上传失败时自动回退为内联 prompt，不再静默丢失上下文；
  外部文件上传失败直接返回明确错误，不再静默跳过
- **修复模型准确度**：自修复请求现在自动携带工具定义列表和 JSON 转义提示，
  模型从破碎文本推测正确参数的能力明显提升

## [0.2.4] - 2026-04-27

### Added
- **历史对话文件化**：多轮对话历史自动拆分上传为独立文件，绕过 DeepSeek 单次输入长度限制。
  对适配器层完全透明，上传失败不影响主流程，自动退化为纯文本发送
- **临时 Session 生命周期**：每次请求创建独立 session，请求结束自动清理（stop_stream + delete_session），
  彻底杜绝 session 泄漏和 TTL 过期残留
- **工具调用自修复**：当模型输出的 tool_calls 格式异常时，使用 DeepSeek 自身修复损坏的 JSON/XML，
  流式和非流式路径均覆盖，大幅提升工具调用成功率
- **arguments 类型归一**：自动处理 arguments 为 JSON 字符串的异常情况，避免客户端双重转义解析失败
- **`input_exceeds_limit` 检测**：识别输入超长错误并返回明确错误信息，不再静默失败
- **全链路日志追踪**：`req-{n}` 标识贯穿 handler → adapter → ds_core 全层，
  `x-ds-account` 响应头标识处理账号，单次请求可完整 grep 追踪
- **TRACE 级别字节追踪**：流管道各层 TRACE 日志，可观察字节在 SSE 管道中的完整转换过程
- **`/` 端点**：免鉴权返回可用端点列表和项目地址
- **e2e 测试重构**：从 pytest 迁移为 JSON 场景驱动框架，场景独立存放，配置动态读取

### Changed
- **请求流程重构**：从"持久 session + edit_message"升级为"临时 session + completion + 文件上传"，
  每次请求独立生命周期，不再依赖预创建的持久 session
- **限流自动重试**：检测到 rate_limit 时以 1s→2s→4s→8s→16s 指数退避自动重试（最多 6 次），
  对用户透明，大幅降低限流导致的请求失败
- **Prompt 构建优化**：reminder 插入位置调整到最后一轮对话之前，确保模型优先遵循指令；
  工具描述的代码块格式化；工具调用结果的 Markdown 结构化展示
- **推理控制语义修正**：禁用思考时使用 `"none"` 替代 `"minimal"`，语义更明确
- **日志级别规范化**：账号池耗尽提升为 `WARN`，常规分配降为 `DEBUG`，
  新增 session/上传/PoW 等 debug 日志，health_check 合并为单条带耗时日志

### Removed
- 账号初始化不再按 model_type 管理 session，移除 session 持久化和 update_title 逻辑
- 移除旧 pytest e2e 测试目录（被 JSON 场景驱动框架替代）

### Test Results

#### py-e2e-tests
- **4 账号 + 3 并发 + 3 迭代**：17 场景 × 2 模型 × 3 次 = 102 次请求，成功率 100%，总耗时 5.5 分钟
- 覆盖场景：基础对话、深度思考、流式、标准工具调用，以及 10 种 tool_calls 损坏格式
  （XML/JSON 混合、字段名不一致、arguments 字符串、括号不匹配/缺失、
  name/arguments 互换、参数外溢等），修复管道全部正确兜底

#### claude-code 测试
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5317/anthropic
export ANTHROPIC_AUTH_TOKEN=sk-test
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-expert
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-expert
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-default
claude
```
- 基本稳定, 工具解析时会使得claude-code暂时卡住是正常现象, 部分情况可能出现模型不遵循指令导致工具调用指令泄漏
- 其他编程工具没有大量测试, 希望大家积极反馈

## [0.2.3] - 2026-04-24

### Added
- Tool call XML 解析增强：增加 `repair_invalid_backslashes` 与 `repair_unquoted_keys`
  宽松修复，当模型输出的 JSON 包含未引号 key 或无效转义时自动修复后重试
- 增加 `is_inside_code_fence` 检查：跳过 markdown 代码块中的工具示例，防止误解析
- 新增 Anthropic 协议压测脚本 `stress_test_tools_anthropic.py`，与 OpenAI 版对称
- 示例文件正交化：`examples/adapter_cli/` 下按功能拆分为
  `basic_chat`/`stream`/`stop`/`reasoning`/`web_search`/`reasoning_search`/`tool_call` 等独立文件
- 默认 adapter-cli 配置文件路径指向 `py-e2e-tests/config.toml`

### Changed
- 账号池选择策略：从**轮询线性探测**改为**空闲最久优先**，最大化账号复用间隔
- 移除固定的冷却时间常量，选择算法天然避免账号被过快重用
- 同步更新中英文 README，增加并发经验说明

### Stress Test Results

针对 4 账号池的 70 请求压测（7 场景 × 2 模型 × 5 迭代）：

| 策略 | 并发 | 成功率 | 平均耗时 |
|------|------|--------|----------|
| 轮询 + 无冷却 | 3 | 25.7% | 2.57s |
| 轮询 + 2s 冷却 | 3 | 97.1% | 10.46s |
| **空闲最久优先 + 无冷却** | **2** | **100%** | **10.14s** |
| **空闲最久优先 + 无冷却 (Anthropic)** | **2** | **100%** | **11.31s** |

结论：稳定安全并发 ≈ 账号数 ÷ 2，空闲最久优先策略可在不设冷却的前提下实现 100% 成功率。

## [0.2.2] - 2026-04-22

### Added
- Anthropic Messages API 兼容层：
  - `/anthropic/v1/messages` streaming + non-streaming 端点
  - `/anthropic/v1/models` list/get 端点（Anthropic 格式）
  - 请求映射：Anthropic JSON → OpenAI ChatCompletion
  - 响应映射：OpenAI SSE/JSON → Anthropic Message SSE/JSON
- OpenAI adapter 向后兼容：
  - 已弃用的 `functions`/`function_call` 自动映射为 `tools`/`tool_choice`
  - `response_format` 降级：在 ChatML prompt 中注入 JSON/Schema 约束（`text` 类型为 no-op）
- CI 发布流程改进：
  - tag 触发 release（`push.tags v*`）
  - CHANGELOG 自动提取版本说明
  - 发布前校验 Cargo.toml 版本与 tag 一致

### Changed
- Rust toolchain 升级到 1.95.0，CI workflow 同步更新
- justfile 添加 `set positional-arguments`，安全传递带空格的参数
- Python E2E 测试套件重组为 `openai_endpoint/` 和 `anthropic_endpoint/`
- 启动日志显示 OpenAI 和 Anthropic base URLs
- README/README.en.md 添加 SVG 图标、GitHub badges、同步文档
- LICENSE 添加版权声明 `Copyright 2026 NIyueeE`
- CLAUDE.md/AGENTS.md 同步更新

### Fixed
- Anthropic 流式工具调用协议：使用 `input_json_delta` 事件逐步传输工具参数
- Tool use ID 映射一致性：`call_{suffix}` → `toolu_{suffix}`
- Anthropic 工具定义兼容：处理缺少 `type` 字段的情况（Claude Code 客户端）

## [0.2.1] - 2026-04-15

### Added
- 默认开启深度思考：`reasoning_effort` 默认设为 `high`，搜索默认关闭。
- WASM 动态探测：`pow.rs` 改为基于签名的动态 export 探测，不再硬编码 `__wbindgen_export_0`，降低 DeepSeek 更新 WASM 后启动失败的风险。
- 新增 Python E2E 测试套件：覆盖 auth、models、chat completions、tool calling 等场景。
- 新增 `tiktoken-rs` 依赖，用于服务端 prompt token 计算。
- CI 新增 `cargo audit` 与 `cargo machete` 检查。

### Changed
- 账号初始化优化：日志在手机号为空时自动回退显示邮箱。
- 更新 `axum`、`cranelift` 等核心依赖至最新 patch 版本。
- Client Version 保持与网页端一致的 `1.8.0`。

### Removed
- 移除未使用的 `tower` 依赖。

## [0.2.0] - 2026-04-13

### Added
- 项目从 Python 全面重构到 Rust，带来原生高性能和跨平台支持。
- OpenAI 兼容 API（`/v1/chat/completions`、`/v1/models`）。
- 账号池轮转 + PoW 求解 + SSE 流式响应。
- 深度思考和智能搜索支持。
- Tool calling（XML 解析）。
- GitHub CI + 多平台 Release（8 目标平台）。
- 兼容最新 DeepSeek Web 后端接口。
