# 延迟禁言复核：证据、后端修复与尚未证实的原因

日期：2026-09-25。范围：词典笔分支的后端、离线抓包和上游公开 issues。
没有修改 app 前端，没有连接词典笔或用真实账号发送实验请求，没有部署二进制。

## 结论先行

**现有证据不能证明缺少某一个验证头就是 8–12 小时后禁言的原因，也不能证明本次修复能免除三天禁言。**
可以确认的是：旧分析混淆了两次抓包，重复计数网络层事件，把“设备注册成功/账密校验被执行”
过度解读成“通过设备风控”，并且后端确有禁言后的流量放大和状态错误。

原生客户端模拟的设备画像仍然是高优先级待验证项，但没有服务端评分或控制变量实验，不能下因果结论。
本轮不追加伪造遥测或猜测性的验证字段；先修复确定的状态和资源管理缺陷。

## 0. 故障版本定位

用户确认使用「0.1.3 的最后一次构建」。本地保留的
app/8000000000182376.0_1_3.amr 清单版本为 0.1.3，包内 BUILD_NUM=76，
文件修改时间为 2026-09-23 17:47:52（本机时区）。

- 安装包 SHA-256：0573e34a27b91e460ef683b0b0a2b339f23f6ef27f28e10c86b26caf1c1b02fe。
- 包内 ARM64 后端：4,826,016 字节，SHA-256 为
  5e3716203fc38cdb9ddbe22d90b3bfb47caa223a18ba765c1a7cef91d17f9883。
- 包内 BACKEND_SHA=5e3716203fc38cdb，与独立解码计算结果一致。
- 审计时当前待打包后端摘要为 dd3a5d6caefe83d1715e95b09ef01743938358738efdc33db57bdfccd3a37db6，
  当前源码应用版本 0.1.4、Cargo 版本 0.2.17；它们不能代替故障包的后端身份。

只离线解码了包内后端并解压 UPX，未执行二进制。旧包能检出 x-hif-leim/x-hif-dliq
和「health_check 完成 model_type=」日志常量；未检出「user is muted」空格形式常量。
这些只能说明旧包包含相关字面量，不能证明运行时实际调用、请求频率或完整分支逻辑。
二进制里的依赖版本字符串也不能当作后端版本号。目前尚不能可靠映射到唯一源码提交。

因此，下文「已移除健康检查」「已存在限流/会话复用」等源码观察，均指当前工作区，
不能据此排除 0.1.3 Build 76 的旧行为。包内摘要可用于后续与设备上实际运行文件比对；
尚未连接设备确认覆盖安装是否更新了运行中的后端。

## 1. 可复核的抓包事实

统计工具：tools/audit_deepseek_captures.py。按 URL_REQUEST_START_JOB/source 关联请求，
不把 SEND_HEADERS、HTTP2_HEADERS 等同一请求的不同事件算成多次请求。

| 项目 | .probe/new.har | .probe/new.jsonl |
|---|---:|---:|
| 请求开始时间范围（UTC+8） | 2026-09-13 08:46:22–09:00:48 | 2026-09-12 20:35:10–20:43:26 |
| 请求数 | 483 | 439 |
| users/login POST | 1 | 1 |
| chat/completion POST | 9 | 9 |
| chat_session/create POST | 6 | 6 |
| chat_session/delete POST | 1 | 1 |
| client/settings GET | 21 | 21 |
| client/settings/report POST | 2 | 2 |
| 数美 deviceprofile/v4 POST | 1 | 1 |
| 数美 OPTIONS（另计） | 1 | 1 |

两份记录不是同一轮流量，不能直接用 HAR 的请求体配对 JSONL 的凭据和响应。
旧文档的“4 次登录、7 次数美上报、84 次 settings”不是独立 HTTP 请求数。

JSONL 共 244551 个网络事件，其中 11459 个 FILTERED_BYTES_READ 事件携带正文 bytes。
所以“netlog 只含头，不含响应正文”不成立。请求体是否可还原需要另行确认，不能由响应正文推出。
两份抓包都可离线还原 main.d69e3d8c16.js；其内容包含 HIF 分发端点和 TTL 处理。

HAR 里缺少 Authorization/Cookie，JSONL 的 9 次 completion 均带 Authorization、Cookie、
x-hif-leim。两者不能据此判为同一次请求漏头；HAR 可能经过导出脱敏。
JSONL 的 x-hif-leim 只有一个不同值，这只反映这一段约八分钟观察窗，不能证明长时间有效。

额外核验 .probe/ban.har：2026-09-06 16:16:42 的 login 返回 biz_code=0，
同时 user.chat.is_muted=1 并给出 mute_until；紧随的 users/current 也确认禁言。
**这是“登录成功不等于允许聊天”的本地直接证据。** 此文件较早，不能当成本次运行的完整禁言时间线。

## 2. 上游反馈及与本分支的差异

公开材料读取于 2026-09-25，通过 GitHub API 只读获取：

- [#112](https://github.com/NIyueeE/ds-free-api/issues/112)：2026-09-18 报告四个账号各请求两次、间隔 6–10 秒，
  一个十分钟内、两个十二小时内被封。四个账号注册 IP 相同，属于用户报告，未提供受控实验。
- [#102](https://github.com/NIyueeE/ds-free-api/issues/102)：2026-09-13 评论称新提示词跑完 70 请求后仍被禁言约三天；
  9 月 17 日仍有人报告快速被禁言。
- [#98](https://github.com/NIyueeE/ds-free-api/issues/98)：评论明确承认不同账号、不同时点不足以证明提示词改动的因果；
  会话删除、请求间隔等只是待检验假设。
- [#113](https://github.com/NIyueeE/ds-free-api/issues/113) 和
  [PR #114](https://github.com/NIyueeE/ds-free-api/pull/114)：是复现实验征集、滑动窗口及日志工作，不能当成解决封禁的证明。

| 维度 | 本分支实际情况 | 对排查的影响 |
|---|---|---|
| 用途 | 词典笔交互聊天；已有持久会话、续聊和重答 | 不能直接套用上游编码 Agent/工具调用标签的解释 |
| 会话 | 已有会话缓存与原生 parent_message_id 路径 | “所有请求都新建并立刻删除”不适用于正常缓存命中 |
| 设备 | 后端自动生成数美 payload，再取得服务端 deviceId | 与从真实浏览器导入 device_id 的实验不同 |
| 初始化 | 当前源码已移除真实 completion 健康检查；0.1.3 旧包仍含相关日志常量 | 不能用当前源码排除故障版本的初始化流量，实际调用须查运行日志 |
| 请求限制 | 有限流退避，但原配额为固定窗口且续聊绕过 | 本轮修复；仍解释不了两次低频请求的封禁 |
| HIF/Cookie | 已有 HIF 获取和 cookie jar | “再加一个已经实现的头”没有排查价值 |

## 3. 已发现哪些验证/状态机制

| 机制 | 直接可观察证据 | 能证明什么 / 不能证明什么 |
|---|---|---|
| PoW | create_pow_challenge 与 x-ds-pow-response | 存在请求级工作量校验；不能说明账号长期可信 |
| 数美设备注册 | deviceprofile/v4，响应 code=1100/detail.deviceId；登录使用 device_id | 签发格式被接受；不能推出画像可信或不会事后关联 |
| WAF/会话 Cookie | JSONL 中 HWWAFSESTIME、HWWAFSESID、smidV2、ds_session_id 等 | 浏览器会带这些状态；抓包不能展示服务端风险评分 |
| HIF | main bundle 的 leim/dliq 分发与 x-hif-ttl；JSONL 的 leim 请求头 | 已有获取机制；具体评分用途、是否 IP 绑定仍未知 |
| 账号禁言 | ban.har 的 is_muted/mute_until；业务错误 biz_code=5 | 与登录有效性分开，必须持久阻止调度 |
| CAPTCHA | 本地 client/captcha_bridge 有交互验证通路 | 与持续禁言不能混为同一个验证步骤 |
| 配置上报/遥测 | settings/report、gator/APM 请求存在 | 不能证明它们“必不可少”，也不能证明“绝不参与风控” |

bundle 里的 x-ds-trace-id 用于读取响应跟踪标识，x-ds-sse-heartbeat-timeout-secs 用于流超时处理，
不能把看到的每一个 x-ds 字段都当成漏发的鉴权签名。

没有证据表明需要在回答结束后再发送某个“完成验证”请求。用户观察的“结束后 8–12 小时才发现禁言”
与异步账号限制相容，但也可能是下一次查询才观察到已发生的限制；现有短抓包无法确定精确生效时刻。

## 4. 本轮已修复的确定缺陷

### 账号状态与拒绝路径

- 登录返回禁言仍初始化为 Idle；重登也无条件写回 Idle。现在保留受限状态，拒绝分配。
- completion 的 mute_until 没写回账号，导致恢复任务不知道禁言何时结束。现在读取 JSON/SSE 中的期限，
  小数秒向上取整；未知期限记为内部 -1，暂停自动重登，状态接口对外返回 null。
- 用户主动重登可以检查未知期限限制；明确的未来 mute_until 到期前不自动重试。
- 同一禁言，JSON 空流路径返回 Rejected，SSE hint 却返回 ProviderError 并换号重试。
  现在统一为 Rejected，复用路径也不再把 Rejected/忙碌状态降级成新建会话。
- 不假设第一个 SSE 事件一定是 ready；hint + close 同样识别。
- 不再把 biz_code=50 或普通回答里提及“禁言”的文本误判成账号禁言。
- 状态接口增加 is_muted 和 mute_until，保持原有 state 字段取值兼容。

### 本地配额

- 固定窗口改为单调时钟滑动窗口；每条分配记录满一小时才过期。
- 续聊/重答也遵守额度；已绑定账号达额度时明确返回本地限流，不换账号重建。
- 配额判断与记账在同一个锁内完成，防止并发越过上限。
- 额度仍统计账号分配，可能包含会话查询等操作；并非“上游 completion 的精确计费量”。
- 不改现有配额数值，不声称任何数值能防封。

### HIF 生命周期

- 旧后台任务强持有状态，配置重载后旧任务不会停止。现在由最后一个客户端句柄释放时取消。
- 原缓存没有过期约束，刷新失败仍永久发送旧值。现在自动缓存按 TTL 到期失效。
- 静态 hif_leim/hif_dliq 配置仍是显式覆盖，无法自动推断其有效期；排查时应核对是否留有旧值。

这些更改能停止部分无效请求、落实本地配额并纠正状态；**不能倒推出它们是首次禁言的原因。**

## 5. 尚未修复成“真实采集”的画像差异

mint.rs 的 build_payload_fields 是显式合成：canvas 摘要由 UA/屏幕字符串派生，
WebGL、字体测量、采集耗时、触摸与部分浏览器环境字段是固定值。
这不是浏览器实际执行 canvas/WebGL/font 探针所得的测量。
fingerprint.rs 的另一个“动态采集”对象被记录到日志，也不等于这些结果被用于 mint payload。

device_bootstrap.rs 的 is_issued 只检查 B/D 前缀；D 在代码注释里还是本地加密包，
因此函数名不能作为“已获服务端低风险认证”的证明。

另有需要独立设计、测试的身份一致性问题：

- 启动时逐账号 mint 不同 smid，而 DsClient 的共享 jar 取第一个非空 smid；多账号时配对关系不完整。
- try_init_account 的运行时 ensure_one 返回值原本丢弃 smid，也未将新 device_id 写回持久凭据。
  本轮仅让开屏请求使用实际登录所用 device_id，未将这套共享客户端改造成每账号隔离环境。
- mint 使用独立 wreq client，未显式采用主 DsClient 的代理和传输设置。
  有代理配置时出口一致性尤其需要核对，不能默认注册与登录走同一路径。

这些是代码层事实；“服务端因它们而封号”仍是待验证假设。继续修改若干合成字段直到登录成功，
不会填补“签发成功”和“长期无禁言”之间的证据缺口。

## 6. 验证方式与下一步

离线摘要（不输出账号、密码、Token、Cookie 值、设备 ID、聊天正文）：

~~~powershell
python -X utf8 tools/audit_deepseek_captures.py --har .probe/new.har --netlog .probe/new.jsonl --output .probe/delayed-mute-audit.json
python -X utf8 -m unittest discover -s tools -p test_audit_deepseek_captures.py -v
wsl -d Ubuntu -- bash /mnt/g/youdao/Deepseek/ds-free-api/run-host-tests.sh
~~~

新增回归覆盖：滑动窗口边界、并发额度预留、续聊配额、禁言登录/重登、guard 释放、期限提取、
hint 顺序、错误码前缀和普通文本误报、HIF 过期及取消、抓包去重和脱敏。
2026-09-25 实际结果：Rust 宿主单元测试 208/208 通过，Python 审计测试 2/2 通过。
首轮发现并修复了「只有 data:、没有 event: 的旧式禁言 SSE」兼容失败。
按 CRLF 文件规则执行的定向 git diff --check 通过。编译仍有既有未使用代码及共享盘
hard-link 缓存警告；本轮未进行 ARM64 发布构建、重新打包或真机部署。
这些结果验证本地状态与解析逻辑，不能代替持续 24 小时的线上观察。

线上因果验证仍缺：**同一故障运行中，从最后一次成功到第一次明确禁言的后端日志/响应时间线**，
以及设备上实际运行二进制与上述 0.1.3 包内摘要的一致性。只靠这两份正常浏览器短抓包无法补出缺失的 8–12 小时。

下一轮应记录最后成功时间、首次看到 is_muted 的时间、服务端 mute_until、实际请求次数、
是否发生后台重登/配置重载，避免把“发现时间”当成“生效时间”。保留同一身份、网络和会话，
一次只改变一个变量。先被动记录正常使用，不增加 completion 保活/压测，不轮换身份来继续撞限制。

如需比较真实浏览器 SDK 与合成画像，必须清楚标注环境差异，并观察到用户所述最长窗口之外（至少 24 小时）；
“即时能聊”“假密码报错”“短时压测通过”都不是长期验证结果。本轮未执行这类线上实验。
