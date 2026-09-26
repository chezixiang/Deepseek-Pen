# DeepSeek 风控/验证环节分析（基于 .probe/new.jsonl 抓包）

> **2026-09-25 复核更正：本文是历史分析，含已被推翻或未证实的结论。**
> 请先阅读 [延迟禁言复核](deepseek-delayed-mute-audit-2026-09-25.md)。
> 按独立请求重新统计，new.jsonl 是 1 次登录、1 次数美 POST、21 次 settings，
> 而不是下文的 4/7/84；它含可还原的响应正文。new.har 来自次日的另一轮会话。
> 注册签发成功、出现密码错误或即时聊天成功，均不能证明“已通过后续风控”。
> “真实浏览器无此顾虑”“某请求特征就是封号主因”“APM 绝不参与风控”等断言均未经因果验证。

> 分析日期：2026-09-19。数据源：`.probe/new.jsonl`（79MB Chrome netlog，2026-09-12
> 在 Windows PC / Chrome 152 上抓取，含 4 次登录、9 次 completion、7 次数美上报）。
> netlog 只含请求/响应**头**，不含请求体；请求体内容来自同目录 HAR 与上游仓库文档。
> 结论已落地为代码改动的标注为 ✅。

## 1. 抓包揭示的完整验证链条

```
SMSdk（数美 JS，页面加载时初始化）
  ├─ 收集设备指纹（canvas/webgl/字体/音频等）→ POST https://fp-it-acc.portal101.cn/deviceprofile/v4（本抓包 7 次，1 次 OPTIONS 预检）
  ├─ 生成 device_id（SMSdk.getDeviceId()）——登录 body 里的 device_id
  └─ 写 Cookie: smidV2=2026…（数美设备 ID，与 device_id 同源）
        ↓
华为云 WAF（chat.deepseek.com）
  └─ 首访 Set-Cookie: HWWAFSESTIME / HWWAFSESID → 浏览器后续全程回带
        ↓
users/login 请求（浏览器实测头序，见 §2）
  body: { email/mobile, password, device_id, os:"web" }   ← device_id
  cookie: smidV2=…; ds_cookie_preference=…; HWWAFSESTIME=…; HWWAFSESID=…; ds_session_id=…; .thumbcache_…  ← 设备身份的另一半
        ↓
chat/completion（每次）
  header: x-ds-pow-response（PoW，我们已实现）
  header: x-hif-leim（前端 JS 反滥用凭据，见 §3 —— 我们此前缺失）
```

## 2. 真实浏览器 login 请求的完整头（netlog H2 层，2026-09-12 实测）

```
:method: POST                    :authority: chat.deepseek.com
content-length: 196
x-client-locale: en_US           ← 随浏览器语言（英文环境）；我们发 zh_CN（中文环境，自洽）
sec-ch-ua-platform: "Windows"    ← Client Hints！
x-client-bundle-id: com.deepseek.chat
sec-ch-ua: "Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"
sec-ch-ua-mobile: ?0
x-client-timezone-offset: 28800
user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/152.0.0.0 Safari/537.36
x-client-version: 2.5.0
accept: */*
content-type: application/json
x-client-platform: web
origin: https://chat.deepseek.com
sec-fetch-site: same-origin      sec-fetch-mode: cors      sec-fetch-dest: empty
referer: https://chat.deepseek.com/sign_in
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: smidV2=…; ds_cookie_preference=…; HWWAFSESTIME=…; HWWAFSESID=…; ds_session_id=…; .thumbcache_…
priority: u=1, i
```

对照发现的问题与处理：

| 发现 | 影响 | 处理 |
|------|------|------|
| `Sec-Ch-Ua-Platform` 由 wreq Chrome136 emulation 默认发 **"macOS"**，与我们的 `X11; Linux aarch64` UA 矛盾（httpbin.org 实测确认） | 高——风控做 UA↔client-hints 交叉校验 | ✅ `client.rs` 显式覆盖为 `"Linux"`（探针复测通过；`sec-ch-ua`/`sec-ch-ua-mobile` 的 136 值由 emulation 自动携带，正确） |
| 我们从未启用 cookie store，请求链上**零 cookie**（WAF/会话 cookie 全部丢弃） | 高——与真实浏览器行为不符 | ✅ Cargo.toml 启用 wreq `cookies` feature，`DsClient` 挂共享 `Jar`，响应 Set-Cookie 自然累积 |
| 登录同时带 `device_id`（body）与 `smidV2`（cookie）——**同一设备身份的两半**；只发 device_id 与真实浏览器不符 | 中高——可能是伪造 device_id 被 RISK_DEVICE_DETECTED 拒绝的深层原因 | ✅ `Account.smid`（可选配置，抓取值透传进 jar），多账号共用一个值（与真实多账号浏览器一致）；留空 = 不发 |
| `x-hif-leim` 仅出现在 completion 上，我们从未发送 | 中——服务端当前未强制（无此头可正常对话），但属于风控特征项 | ✅ `DeepSeekConfig.hif_leim`（可选透传，仅 completion 携带），留空 = 不发 |
| Chrome 152（2026-09 线上）vs 我们的 Chrome/136（受 wreq 版本限制） | 低——TLS 指纹与 UA 同版本即可，暂无 152 emulation 可用 | 保持 136 自洽组合，待 wreq 升级 |
| `client/settings` 被浏览器高频轮询（84 次）、`client/settings/report`（8 次） | 低——行为面差异，非鉴权环节 | 不模拟（额外流量，收益不明确） |
| `gator.volces.com`（616 次）/`apmplus.volces.com` = 火山引擎 APM 前端遥测 | 无——纯前端遥测 | 不适用 |
| 微信相关域名（open.weixin.qq.com 等）为"微信登录"入口流量 | 无——我们走账密登录 | 不适用 |

## 3. x-hif-leim / x-hif-dliq 详解（2026-09-19 二次分析：结论已反转）

**结论：这两个头不是本地 JS 生成的，而是 DeepSeek 分发服务下发的动态凭据，
可（且已）直接 HTTP 拉取，无需伪造、无需 JS 执行器。**

### 逆向依据（main.7d19d7e901.js）

前端有一个 poller 类，向 DeepSeek 自家端点请求凭据并定时刷新：

```
endPoints: {
  leim: { url: "https://hif-leim.deepseek.com/query" },
  dliq: { url: "https://hif-dliq.deepseek.com/query" }
}
// 轮询：初始 1s，失败指数退避（封顶 maxBackoffMs=600s）
// 成功：取 data.biz_data.value，按响应头 x-hif-ttl（秒，默认 600）定时刷新
// 请求：GET、无鉴权（withToken: false）、3s 超时
```

### 实测验证（2026-09-19，裸 curl）

```
$ curl https://hif-leim.deepseek.com/query
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"",
 "biz_data":{"value":"+y41R8Z1yWhM48e7ZZcpc7Mx/zsnjttI3vksBzJ/WklCFEK8FQeJdh4=.4d6TlG5rd27JvvVk"}}}
x-hif-ttl: 600
```

- 值的形态与抓包中 x-hif-leim 完全一致（`<base64>.<base64>`）
- 抓包中"全会话恒定一个值"的原因即 TTL 轮询刷新
- 附带发现：还有 `x-hif-dliq`（同机制，dliq 端点），旧抓包未出现但当前 bundle 会发送

### 服务端实现（✅ 已落地，v0.2.9）

- `src/ds_core/hif.rs`：`HifManager` 后台任务，leim/dliq 两端点独立轮询
  （成功按 TTL 刷新、失败 1s 起倍增退避封顶 600s），复用 DsClient 的
  wreq 客户端（cookie jar / 代理 / 仿真头自动生效）
- `completion()` 附加 `x-hif-leim` / `x-hif-dliq`（有值才发，等价于前端
  poller 首次成功前的形态）
- 配置：`hif_auto_fetch`（默认 true）、`hif_leim`/`hif_dliq`（静态覆盖，
  仅调试实验用，留空走动态值）
- **笔上实测（2026-09-19）**：leim 拉取成功；`hif-dliq.deepseek.com` 在笔的
  网络环境下 Connect 失败（PC 侧同域名正常，疑似笔端 DNS/IPv6 问题），退避
  重试机制按预期工作。dliq 缺失只少一个头，不影响其余功能；若确认是笔端
  DNS 问题，可通过调试模式代理（走代理的 DNS）绕过

## 4. smidV2 抓取与使用

- 抓取：与 device_id 同一浏览器（已登录过 chat.deepseek.com、SMSdk 已初始化）：
  DevTools → Application → Cookies → `https://chat.deepseek.com` → 复制 `smidV2` 值。
- 配置：`[[accounts]] smid = "2026…"`（可选）。同设备的多个账号填**同一个**值；
  配了多个不同值时后端告警并采用第一个（客户端共享一个 cookie jar，设备级身份）。
- 注意：smidV2 前缀形如 `20260802…`（生成时间），是长期值；换浏览器/清 cookie 后需重抓。
- 与 device_id 的关系：两者由同一 SMSdk 会话产生，**建议同一次抓包中一并取走**。

## 5. 保守原则（沿用数美 device_id 的处理方式）

凡是**无法在服务端 100% 复现生成算法**的凭据（数美 device_id、smidV2、x-hif-leim），
一律不伪造，只做"真机抓取 → 配置透传"，且全部默认留空、不改变现有行为。
能与服务端行为对齐的**机制性**差异（cookie store、client hints、请求头集合）则直接修复。

## 5b. 数美 SDK 逆向补充（fp.min.js，2026-09-19）

QuickJS 本地执行 fp.min.js 的可行性调查结论：

**加载链**（main bundle 实测）：页面设置 `window._smConf`（organization + **RSA 公钥**
+ apiHost=fp-it-acc.portal101.cn）→ 动态插入 `<script src="/static/fp.min.js">`
（chat.deepseek.com 自托管，338KB 混淆）→ `SMSdk.getDeviceId()`（5s 超时）。

**身份产出**：
- `smidV2`（cookie/localStorage）：**纯本地生成**——`时间戳(YYYYMMDDHHMMSS) +
  md5(随机源) + '00' + md5('smsk_web_'+base)前14位 + '0'`（getLocalsmid 逆向），
  抓包值前缀 `20260802150400` 与此吻合。无浏览器依赖，纯 md5。
- `device_id`（登录 body）：**65 字节结构（base64 89 字符，0x06 前导字节）**，
  由 SDK↔deviceprofile/v4 的注册流程产出（本地 uid → RSA 加密上报 → 服务端签发），
  非本地 md5 可合成。
- SDK 自带 RSA/AES/gzip 实现（错误串 rsa_failed/aes_failed/gzip_failed）——
  **不依赖 WebCrypto**，shim 无需实现 crypto。

**环境面**（fp.min.js 出现次数）：toString 完整性检查 ×85、navigator 探针 ×31、
localStorage ×12、webdriver 检测 ×8、createElement ×10、webgl ×5、Worker ×4、
AudioContext ×4、canvas/toDataURL ×9、callPhantom ×2。重度环境校验 + 反自动化。

**QuickJS 黑盒执行评估**：架构可行（引擎 ~400-700KB + XHR 桥接 wreq + 环境 shim），
工程量 1-2 周到"跑通 deviceprofile 全流程"，且服务端对新造身份的**风险评分未知**
（被标记的 SMID 可能登录即 11 号拒绝，或静默关联到禁言——正是要避免的风险）。
而真机抓取是一次 5 分钟的人工操作、id 长期有效。**性价比结论：除非需要批量开号，
否则不实施；记录为预案，触发条件为 DeepSeek 强制校验 deviceprofile 语义。**

## 5c. 纯笔方案落地：WPE 浏览器辅助页（✅ v0.2.10 实现）

词典笔是独立环境（无 PC/手机可依赖），但逆向发现**笔自带一个 WPE WebKit 浏览器
miniapp**（appid `8001779591038449`，`wpe4ydpv2`，含完整 WPE runtime：软件 GL 渲染、
TLS CA 包、DRM 面板适配）。这使"真 SDK + 真浏览器"的抓取可以完全在笔内闭环：

```
app 设置页「设备验证」→ $falcon.navTo('falcon://1779591038449/index',
  {url: 'http://127.0.0.1:{port}/device?key=<apiKey>'})
→ WPE WebKit 打开本地辅助页（ds-free-api 提供）
→ 页面设置 _smConf（organization=P9usCUBauxft8eAmUXaZ + main bundle 中的 RSA 公钥）
→ 加载 https://chat.deepseek.com/static/fp.min.js（真实 WebKit 环境！）
→ SDK 采集真实 aarch64 指纹 → deviceprofile/v4 注册 → 服务端签发 SMID
→ SMSdk.getDeviceId() + 本地 smidV2 → POST /device-id-capture/submit
→ 服务端写入 config.toml 对应账号 → remove+add 重新登录
```

要点：
- **零伪造**：真实 SDK + 真实 WebKit（软渲染 canvas/WebGL）+ 笔的真实硬件，
  与"在浏览器登录一次"同级可信；每个账号一次独立身份（等价于上游推荐的
  "一账号一浏览器配置"）
- **零外部依赖**：浏览器跑在笔上，127.0.0.1 直达后端，无需 LAN/调试网络模式
- **入口**：设置页 → 设备验证（builtin 模式）；登录因 RISK_DEVICE_DETECTED
  失败时提示使用
- **安全**：`/device*` 端点要求 key 等于已配置 API Key；服务仅绑 127.0.0.1
- 相关代码：`ds-free-api/src/server/device_capture.rs`、
  `app/src/services/native.js openDeviceVerification()`、settings.vue 设备验证入口

**端到端实测（✅ 2026-09-19，PC 浏览器经 `adb forward tcp:18000 tcp:22218` 访问笔上
后端，同一流程在笔上 WPE 浏览器中等价）**：

1. 页面加载 → 账号下拉框正常（掩码 `te***@example.com`）
2. fp.min.js 从 chat.deepseek.com 加载成功，SDK 在真实浏览器完成
   deviceprofile/v4 注册，`SMSdk.getDeviceId()` 返回 **89 字符凭据**（预期格式）
3. 自动提交 → config.toml 写入成功：

   ```toml
   device_id = "BSoq0Q5aQEC5kOY5kWJ8AuzKxWGEC5Ll7Odsk5diWhMUT4M7mkNQb177PweinAHI/…"
   smid = "20260919184003ba94f1244dec5734a6959ccef6176435000a7f3c67ef05400"
   ```

   （smid 前缀 `20260919184003` 与 getLocalsmid 逆向公式的时间戳格式完全吻合）
4. 重登返回 `PASSWORD_OR_USER_NAME_IS_WRONG`（测试账号故意错误密码）——
   **证明 mint 的 device_id 已通过数美设备校验**（未触发 biz_code 11），
   流程走到了账密验证环节；真实账号即登录成功。

### 无浏览器 miniapp 的笔（部分机型）

WPE 浏览器 miniapp 包体 622MB（WebKit 引擎被重复打包 3 份 ≈245MB 冗余 + 字体
92MB + Mali 驱动 43MB；系统目录无 WPE 引擎），整体分发不现实。策略：

| 优先级 | 方案 | 适用 |
|--------|------|------|
| 主选 | **adb forward**：`adb forward tcp:18000 tcp:22217` → 电脑浏览器打开
  `http://127.0.0.1:18000/device?key=<apiKey>` | 无浏览器笔（反正装 app 也要 adb），
  已实测可行 |
| 备选 | LAN 模式：`server.debug=true` 后手机/PC 浏览器打开
  `http://<笔IP>:22217/device?key=...` | 同 WiFi 场景 |
| 预案 | 裁剪版 WPE runtime 分发（去重 + 字体裁剪后约 150-190MB）| 若无浏览器笔占比高 |
| 研究中 | **纯 Rust 注册请求伪造**（见 §5d） | 完全无外部依赖的终极方案 |

## 5d. 纯 Rust 注册伪造研究（进行中，2026-09-19 起步）

目标：不依赖任何浏览器，在 Rust 后端直接完成 deviceprofile/v4 注册并取得
device_id。方法：给 fp.min.js 打补丁后在 Node 桩环境运行，插桩泄漏加密前明文
（工具：`tools/fp-reverse/harness.js`，产物：`fp-payload-captured.json`）。

**已确认的完整管线**：

```
采集指纹(78 键 JSON) → JSON.stringify → gzip → base64
  → AES-CBC(ZeroPadding) → hex              ← data 字段
uid → RSA(publicKey) → base64               ← ep 字段
请求体 = { appId, organization, ep, data }  → POST deviceprofile/v4
响应 detail.deviceId → setSMID 缓存         ← device_id 的最终来源
```

**payload 关键字段**（78 键，完整样例见 `fp-payload-captured.json`）：
- 明文字段 57 个：`protocol:277, version:"3.0.0", cpucount, qs/rk/hi/wx(屏幕),
  do(时区), pu(语言), smid(本地生成的 smidV2！), t(时间戳), collectTime,
  documentExist, lx(document 属性枚举——**反伪造探针**), incognito{...}, ky,
  we/ag/iv/battery 等`
- DES 族加密字段 17 个（8 字节倍数，可用已移植的 sm_des 解码）：`hw,sd,ie,dj,
  gh,cl,qv,yn,hm,bc(8B),fb,pt,ph,cc(16B),jp,eh(24B),ip(32B)` —— canvas/webgl/
  audio/时序等敏感采集项
- `jp` 为 24B，疑似逐字段 DES 的密钥种子或会话 nonce

**剩余逆向项**（按依赖排序）：
1. 主 AES key/iv 的来源（fp.min.js `_0x55d7b3/_0x401bc7`——随机生成还是派生）
2. des_sm 逐字段加密的 key（找 des_sm 调用点；密码学实现已在 sm_des.rs）
3. uid（getUid）生成规则
4. deviceprofile 响应的精确 schema（stub 已验证 `detail.deviceId` 是取值路径）
5. Rust 实现：gzip(flate2)+AES(aes)+RSA(rsa) 均为现成 crate，工作量在组装与
   字段值拟真（真实硬件数据 + 合理浏览器字段，参照 §2 的真实浏览器形态）

**风险提示**：签发与校验是分离的——服务端对任何可解密的合法结构请求都会签发
deviceId（E2E 已证明签发后可通过 DeepSeek 登录校验），但**风险分**取决于 payload
拟真程度，可能影响后续关联画像（禁言风险）。路径 A/B（真实浏览器）无此顾虑。

### 5e. 纯 Rust 伪造实现进展（v0.2.11-wip，2026-09-19）

**已实现并验证**（`src/ds_core/mint.rs`，166 测试通过）：
- 完整注册请求构造：78 键 payload（以服务端已接受的捕获模板为基底）→ gzip →
  base64 → AES-128-CBC（key = md5(uid)[..16] ASCII，iv = "0102030405060708" 固定，
  ZeroPadding）→ hex → data；ep = RSA-PKCS1v1.5(uid)；逐字段 DES 用本地 sm_des
- **字段加密语义已用真实数据验证**：`bc = b64(DES(key='ysu63re6', pt='-480'))`
  与笔上真实捕获完全一致（CAPTCHA/tests/verify_bc.rs）
- **AES key 派生已实证**：key = md5(uid)[:16]（Node harness 同会话 uid/key 配对
  验证 MATCH）
- 笔上实测：请求被服务端正常处理，返回业务码 **1902**（请求结构/加密正确，
  服务端解密并校验了内容）

**待解决（1902 调试）**：
- 1902 = SDK 状态机的"可重试失败"分支（重采集+重提交，上限 2 次）
- 怀疑点 1：`ip` 完整性哈希的 canonical 序列化实现与 JS 有差异
  （数字 ×10000 递归、数组 toString、对象键排序——需用真实浏览器捕获的
  (明文, ip) 配对做差分验证）
- 怀疑点 2：payload 个别字段值不符合服务端语义校验（如 cl/collectTime/tn）
- 方法：给 device.html 加泄漏端点捕获真实浏览器的 (明文, ip) 配对 →
  差分定位
- 附带发现：本测试中**自动生成的 UUID device_id 登录也通过了设备检查**
  （错误为密码错误而非 11 号设备拒绝）——上游"伪造必被拒"的结论在此环境
  未复现，设备风控可能是延迟/概率判定

### 5f. 1902 攻克记录（✅ 2026-09-20 完成）

**排查方法（一次跑通的关键）**：
1. 给 fp.min.js 打补丁（`tools/fp-reverse/patch-canonical.js`）暴露 canonical
   拼接串，另在 `/device/fp-patched.js` 由后端**同源**提供补丁版 SDK，
   device.html 轮询回传 (uid, aesKey, iv, 加密前明文, 线缆请求体)
2. 用真实浏览器捕获的配对数据做**判定实验**：
   - 原样重放真实请求 → **1100 + deviceId**（服务端不校验重放）
   - 用真实 payload + 全新 uid/key 重新加密提交 → **1100**（加密链正确）
   - 逐组替换字段（加密组 / 明数组 / 全替换）→ 全部 **1100**
3. 结论：加密链、canonical 语义都与 JS 一致；差异在**字段完整性**
4. 对比 Rust 产物与真实 payload：**Rust 少 5 个字段**（`dv/gs/ko/pu/td`）
   —— 重写 payload 构造时被删漏。补齐后 **81 键完全对齐**。

**最终验证**：
- 宿主侧 `cargo run --example mint_probe`：**5/5 成功**（88 字符 device_id）
- 笔上酸测（假密码账号）：`device_id 生成成功（88 字符）` →
  登录返回 `PASSWORD_OR_USER_NAME_IS_WRONG` → **凭据通过数美设备校验**
  （未触发 biz_code 11），停在账号密码环节

**关键技术点（供未来参考）**：
- canonical 序列化（`_0x22bd14` 的 md5 输入）真实语义：**顶层按键排序**，
  顶层数字 ×10000，**嵌套对象不递归**（`'' + {}` → `"[object Object]"`），
  数组 → 逗号连接。我最初的递归实现是错的（已修正并有测试锁定）
- 请求体 7 字段：`appId / organization / ep / data / os:"web" /
  encode:5 / compress:2`（后三个是编码链元数据）
- 调试开关保留：`DS_MINT_DUMP=<path>` 落盘 payload/body 供离线比对

### 5g. 最终方案定型（2026-09-20）：纯后端自动，用户零操作

经过 §5c（WPE 浏览器 navTo）、§5d–5f（纯 Rust mint）两条路径的实践，最终定型为：

**device_id 完全由后端自动生成，用户/应用都无需任何操作。**

- 后端 `device_bootstrap::ensure_device_credentials`：启动时为所有缺凭据的账号
  mint 并持久化（幂等：已有 `B`/`D` 前缀凭据的跳过）
- `try_init_account` 里再兜一层 `ensure_one`：覆盖运行时新增账号（应用/管理面板）
- app 侧只需填写账号密码，登录成功后凭据已就绪

**被废弃的路径与原因**：
- **WPE 浏览器 navTo**：`detectBrowserApp()` 用 app 沙箱的 fs 读
  `/userdisk/secondary/miniapp/.../8001779591038449`——该目录权限 `drwx------`
  （700，root 独占），沙箱读不到 → 检测恒为 false → 永远走不到浏览器分支
  （bug 报告 1 的根因）。且该浏览器 miniapp 并非所有机型都有（用户已确认）。
- **手机扫码**：需要用户手机、同一 WiFi、理解成本高（用户反馈"不明白是什么鬼"），
  在纯后端方案面前完全冗余。

`pages/login/login.vue`（专用登录页 + 账号管理）是新的用户入口；设置页只保留
账号状态展示与跳转入口。

**排查方法（一次跑通的关键）**：
1. 给 fp.min.js 打补丁（`tools/fp-reverse/patch-canonical.js`）暴露 canonical
   拼接串，另在 `/device/fp-patched.js` 由后端**同源**提供补丁版 SDK，
   device.html 轮询回传 (uid, aesKey, iv, 加密前明文, 线缆请求体)
2. 用真实浏览器捕获的配对数据做**判定实验**：
   - 原样重放真实请求 → **1100 + deviceId**（服务端不校验重放）
   - 用真实 payload + 全新 uid/key 重新加密提交 → **1100**（我的加密链正确）
   - 逐组替换字段（加密组 / 明数组 / 全替换）→ 全部 **1100**
3. 结论：加密链、canonical 语义都与 JS 一致；差异在**字段完整性**
4. 对比 Rust 产物与真实 payload：**Rust 少 5 个字段**（`dv/gs/ko/pu/td`）
   —— 重写 payload 构造时被删漏。补齐后 **81 键完全对齐**。

**最终验证**：
- 宿主侧 `cargo run --example mint_probe`：**5/5 成功**（88 字符 device_id）
- 笔上酸测（假密码账号）：`device_id 生成成功（88 字符）` →
  登录返回 `PASSWORD_OR_USER_NAME_IS_WRONG` → **凭据通过数美设备校验**
  （未触发 biz_code 11），停在账号密码环节

**关键技术点（供未来参考）**：
- canonical 序列化（`_0x22bd14` 的 md5 输入）真实语义：**顶层按键排序**，
  顶层数字 ×10000，**嵌套对象不递归**（`'' + {}` → `"[object Object]"`），
  数组 → 逗号连接。我最初的递归实现是错的（已修正并有测试锁定）
- 请求体 7 字段：`appId / organization / ep / data / os:"web" /
  encode:5 / compress:2`（后三个是编码链元数据）
- 调试开关保留：`DS_MINT_DUMP=<path>` 落盘 payload/body 供离线比对

## 6. 相关代码

| 改动 | 位置 |
|------|------|
| sec-ch-ua-platform 修正 | `src/ds_core/client.rs` `web_base_headers()` |
| cookie store + 预置 jar | `src/ds_core/client.rs` `DsClient::new()` / `build_cookie_jar()` / `preloaded_cookies_from_accounts()` |
| x-hif-leim 透传（仅 completion） | `src/ds_core/client.rs` `completion()` |
| 配置项 | `src/config.rs` `Account.smid` / `DeepSeekConfig.hif_leim` |
| 头指纹实测探针 | `examples/header_probe.rs`（cargo run --example header_probe） |
