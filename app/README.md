# Deepseek（词典笔版）

对标官方 DeepSeek App 的聊天客户端，运行在有道词典笔 **X7 Pro** 上（Falcon 小程序框架）。
通过 **ds-free-api**（OpenAI 兼容接口）免费使用 DeepSeek 网页端模型，无需官方 API Key。

## 功能

- **专用登录页**：账号登录 / 切换 / 退出都在独立登录页完成（首次启动自动进入），
  设置页只保留入口与状态展示。布局对标 Lumo 邮箱（左侧 Logo，右侧表单），
  右侧内容放在 `scroller` 里可上下滚动，并关闭了左滑返回手势（本页是应用入口页）。
  设备凭据（device_id）由后端**自动生成**，用户无需任何操作。
- **多对话**：会话抽屉，可新建 / 切换 / 删除，全部持久化到本地 storage。
- **模型锁定**：一个对话一旦开始，模型模式（快速 / 专家 / 识图）不可中途切换，避免上下文错乱。
- **三种模型**：快速模式（`deepseek-default`）、专家模式（`deepseek-expert`）、识图模式（快速模型 + 图片附件）。
- **识图模式**：输入框最左侧出现「图片」按钮，从相册 `/userdisk/Pictures` 选图，以图片附件随消息发送。
- **深度思考 / 联网搜索**：每个对话独立可配置开关，映射到 `reasoning_effort` / `web_search_options`。
- **SSE 流式输出**：默认开启，逐字显示回复；可在设置中关闭。
- **重试 / 修改**：类似官方 App，可「修改」上一条消息（重新生成），或对回复「重试」；旧版本不会覆盖，可通过 `< 1/2 >` 切换。
- **Markdown 渲染**：支持标题、列表、代码块、引用、分隔线等常见 Markdown 展示。
- **人性化错误**：网络失败 / 限流 / 鉴权 / HTTP 状态码 均转为友好中文提示。
- **思考过程**：专家/深度思考模式返回的思考过程折叠展示，可在设置中指定默认展开/收起。
- **Emoji 文字替换**：设备不支持动态字体注册时（无 weex/dom 模块），emoji 自动
  渲染为文字标签（如 [赞]），不再出现白块；`emoji-subst.js` 纯显示层替换，
  不改动消息原文。
- **调试模式出站代理**：调试模式下设置页可为本机 ds-free-api 配置 Socks5/HTTP
  代理（`config.toml` 的 `[proxy]` 段），保存后自动重启后端，留空恢复直连。

## 目录

```
app/
├── app_icon.png                  # 应用图标（DeepSeek 风格）
├── package.json
├── tsconfig.json
├── scripts/patch-cli.sh          # postinstall 自动给 aiot-vue-cli 打补丁
├── api-mock/                     # 浏览器/web 预览用 mock（原生模块 stub）
└── src/
    ├── app.js                    # createApp
    ├── app.json                  # 路由表：startup / login / index / settings
    ├── pages/
    │   ├── startup/startup.vue   # 启动页（部署后端 → 按是否已登录分流）
    │   ├── login/login.vue       # 登录页（左 Logo / 右表单，账号管理都在这）
    │   ├── index/index.vue       # 主聊天页
    │   └── settings/settings.vue # 设置页
    └── services/
        ├── http.js               # $falcon.jsapi.http / fetch 统一封装
        ├── ds.js                 # ds-free-api OpenAI 兼容客户端
        ├── store.js              # 会话/消息/设置 持久化（storage KV）
        └── images.js             # 相册读取 + base64（Shell）
```

## 数据存放位置

| 内容 | 路径（`$dataDir` = 应用包内 `data/`） |
|------|----------------------------------------|
| 会话 / 消息 / 设置 | `$dataDir/ds_settings.json`、`ds_conversations.json` 等 |
| 框架 storage 副本 | `$dataDir/sharedpreferences/preferences.json` |
| 后端与账号真源 | `$dataDir/ds-free-api/config.toml`（`[[accounts]]` 段） |

> **卸载会清空 `$dataDir`**：`miniapp_cli uninstall` 删掉整个应用包目录，
> 账号与设置一并丢失，重装后需重新登录。同版本 `install` 覆盖安装则保留 `data/`。

## 升级后 401 / 配置丢失（v0.1.2 修复）

覆盖安装或重装后如果出现「同步对话 HTTP 401」「未认证」或
「无法读取 ds-free-api 配置文件（路径 …）」，成因是两个后端生命周期问题：

1. **僵尸后端占端口**：覆盖安装/重装后旧 `ds-free-api` 进程仍在运行，它的工作目录
   已被替换（`readlink /proc/PID/cwd` 带 `(deleted)`），却仍用**旧 config 的旧 api_key**
   占着 22217。应用健康检查按端口优先命中它 → 拿 config 里的新 key 请求旧进程 → 401。
   旧代码用 `pkill -9 -x ds-free-api` 清理，但实测本机 busybox 的 `-x` 匹配不上进程名
   （返回 1，进程杀不掉）。现在改用 `fuser -k -9 <port>/tcp` 按端口杀（向内核查谁占端口，
   不依赖进程名），并在 `ensureBackendRunning` 开头先检测僵尸、把"必须重启"钉死。
2. **config.toml 不会重建**：重建逻辑原本放在 `deployBackend()` 末尾，而该函数前面的
   快速路径（二进制摘要匹配即 return）会跳过整段 —— 配置一旦丢失就永远补不回来。
   现在 `ensureDsConfig()` 提到快速路径**之前**执行，且 `updateDsFreeApiAccount` /
   `clearDsFreeApiAccount` / `updateDsFreeApiProxy` 三个入口都经过 `readConfigOrRepair()`
   兜底自愈。

## 发消息后 App 闪退 / 像"设备重启"（build 50 修复）

**症状**：一发消息（或回复开始出现文字）App 就整个退出、看起来像设备重启；
重新进入 App 后只要渲染到那条消息，**立刻**再崩一次——因为崩溃发生在渲染阶段，
而消息此时已经落盘，每次进入都会重放同一段坏渲染。

**根因**：`index.vue` 里助手气泡的 Markdown 行内渲染把 `<text>` 套在了 `<text>` 里：

```html
<!-- ❌ 每个 span 一个 <text>，里面再套一个 emoji run 的 <text> -->
<text :class="spanClass(s)"><text :class="emojiRunClass(s, r)">{{ r.t }}</text></text>
```

Falcon 的布局引擎（Yoga）给 `<text>` 节点挂了 **measure 函数**，带 measure 函数的
节点**不能有子节点**；一旦有，`libfalcon.so` 直接走到断言并 `abort()` **整个框架进程**：

```
Cannot add child: Nodes with measure functions cannot have children.
dmp: /userdisk/corefile/4.9.9/miniapp-*.dmp
Aborted
```

这是 abort 而不是 JS 异常，所以应用层 `try/catch` 完全兜不住，页面上也看不到任何报错。
崩溃证据在 `/userdata/applog/DictPen_*.log`（框架输出）与 `/userdisk/corefile/<版本>/*.dmp`。

**修复**：两层 `<text>` 合并成一层——`mdRuns()` 把「markdown 行内 span」与
「emoji 区段」一次性拍平成 `[{ text, bold?, italic?, code?, emoji }]`，
模板用**平级**的 `<text v-for>` 渲染（同级兄弟节点是安全的，思考过程那两块本来就是这么写的）：

```html
<!-- ✅ run 之间平级，没有父子关系 -->
<text v-for="(r, ri) in mdRuns(block.text, !m.pending)" :key="ri" :class="runClass(r)">{{ r.text }}</text>
```

> **给后续维护者**：本设备上 `<text>` **不能有任何元素子节点**（不只是不能再套 `<text>`）。
> 需要拼接样式片段时，一律用同级 `<text>` + 父级 `flex-direction: row; flex-wrap: wrap`
> （`.md-p` / `.md-li-row` 已经是这个布局），不要用嵌套表达"父样式 + 子样式"。

**防回归**：`npm run audit:template`（`scripts/audit-text-nesting.js`）静态扫描所有
`.vue` 模板里「`<text>` 带元素子节点」的写法，并已挂到 `build-wrapper.js` 打包前，
审计不过直接中止构建——这类错误在模拟器/构建期不会暴露，只能上机才炸，必须静态拦截。

## 四个已修复的 bug（build 55，均已真机验证）

### 1. 同一对话里上下文丢失

**症状**：同一个对话里追问，模型像没看过之前的消息——只认最新一条。

**根因**（后端 `ds-free-api`，两处叠加）：
1. **`regenerate` 判据用错比较对象**：查找键是「除最后一条 user 外的上下文哈希」，
   命中缓存后旧代码拿**本轮新消息**去比缓存里记的 `last_user_text`（那是这个上下文
   之后那条 user 消息），于是**每一轮续聊都被判成编辑**，走 `edit_message` 重写上一条
   提问并截断其后内容。设备日志里 14 次复用全部是 `regenerate=true`，一次续聊都没有。
2. **缓存条目不刷新**：`insert_conversation_multi` 对「已存在的键」直接跳过，
   于是条目一直保留最早的 `last_user_text` 与过期消息锚点——即使判据改对，
   第二批之后仍会读到陈旧值。

**修复**：判据改成「上下文里最后一条 user 消息」与缓存记录的对比（新函数
`context_last_user_text`）——续聊时上下文里已有那条消息（相等）→ Append；
编辑时它已被改掉（不等）→ Regenerate；上下文里没有任何 user 消息时一律 Regenerate。
同时缓存写入改为**覆盖已存在的键**（`apply_conversation_insert`，附单测）。

真机验证：连续两轮追问答出第一轮给的名字、日志 `regenerate=false`；
编辑历史消息时日志 `regenerate=true`，编辑后追问答的是**编辑后**的分支。

### 2. 无法渲染 LaTeX

**症状**：模型返回的 `$x^2$`、`\frac{a}{b}` 原样显示成源码。

**根因**：Markdown 渲染层完全没有处理 LaTeX。

**修复（两阶段）**：

1. **第一版：Unicode 近似**（`latexToText()`，`src/services/markdown.js`）——
   `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 定界、常用符号命令、`\frac`、`\sqrt`、
   上下标转成 Unicode（`E = mc²`、`∑ᵢ₌₁ⁿ`、`α ≤ β`、`a/b`）。消息原文不变（发回模型的仍是原 LaTeX），
   行内代码里的反斜杠保持原样，`my_file.txt`/`snake_case` 这类标识符不会被误改。
2. **第二版：原生真排版**（build 66）——设备固件其实**自带 LaTeX 排版引擎**：`libfalcon.so`
   内有 `JQuick::latex`（`LatexView` / `WXLatex`）与 `clatexmath` 资源
   （`/etc/miniapp/resources/latex/res/`，含 Computer Modern 字体族），
   Falcon 的 `<richtext>` 支持子节点 `<latex value="…">`。用它可以排出**真正的**分式、求和号、
   根式、积分号（不再是 `a/b`、`∑ᵢ₌₁ⁿ` 这类近似）。

**真机实测结论**（X7 Pro，这些限制决定了集成方式）：

| 行为 | 实测结果 |
|------|----------|
| 属性名 | `value`（`src`/`content`/`text`/`formula` 等都渲染为空） |
| 放哪里 | 必须是 `<richtext>` 的**子节点**；裸放在 `<div>` 里不渲染 |
| `$…$` | 原生也认（斜体行内），`$$…$$` 会**居中**显示 —— 但 `$100 和 $200` 也会被它当公式吃掉 |
| `\text{中文}` | 支持，中文能正常排 |
| `\\` 换行 | 支持，排出多行公式 |
| **超长公式** | **截断（不换行）**——实测 896px 宽 / 30px 字号下约 50 字符排满，再长右侧被裁 |
| **括号不配平** | 渲染为空（0×0），如流式中间态 `\frac{a}{` |
| 动态更新 | `:value` 绑定与 `v-for` 都正常，200ms 高频改值连续 60 次不崩 |

**集成方式**（`splitMathSegments` / `canTypesetMath`）：把文本切成「普通文本 / 数学」两段，
数学段交给 `<richtext><latex>` 排版，但**只在满足两个条件时**才走原生：

- **消息已定稿**（`!m.pending`）——流式中间态多为残括号，排出来是空白，会一闪一闪；
- **`canTypesetMath()` 通过**——长度 ≤ `MATH_TYPESET_MAX`(48) 且花括号配平。

其余（超长 / 残括号 / 流式过程）一律回退第一版的 Unicode 转换：宁可朴素，也不要显示
半截公式或空白。块级公式（`$$…$$`、`\[…\]`）单独成一个 `math` 块**居中**渲染，同样适用上述回退。

回归用例：`npm run test:latex`（含分段、可排版判定、货币不误判）。

> **给后续维护者**：`<text>` 依旧不能有元素子节点（会 abort 框架进程）。数学片段用的是
> **与 `<text>` 平级**的 `<richtext>`，不是把 `<latex>` 塞进 `<text>` 里——后者必然触发该断言。
> `scripts/audit-text-nesting.js` 已在打包前静态拦截这类写法。

### 3. 本地对话与云端对话同步时被重复记录

**症状**：本机新建的对话在云端也有一条，点「同步」后抽屉里出现两份（云端那份是空占位）。

**根因**：应用只在拿到 `cloudId` 后才认得出「这条已经在云端了」，而 `cloudId` 原先只在
**导入**云端会话时才写入——本机自己建的对话永远没有它，于是每次同步都按标题再导入一遍。
设备上积累了 578 条会话、大量同名重复。

**修复**（两处）：
- **后端下发云端会话 id**：持久会话的 `chat_session.id` 随流末尾的 `ds_session_id` 尾随 chunk
  发给应用（与 `ds_title` 同形态），应用在 `generate()` 里记进本地会话——
  从此新对话第一次回复就带上 `cloudId`，同步按 id 去重；
- **同步时按标题认领**：历史遗留的、没有 `cloudId` 的本地会话，同步时按标题（加更新时间
  最接近者优先）认领对应云端条目并标记 `cloudLinked/cloudLoaded`，不再新增重复项。

真机验证：同步 575 条云端会话 → 「新增 0，关联 0」（幂等）；首次发送后日志出现
`记录云端会话 id => …`，再同步仍是「新增 0」。

### 4. 修改消息时输入法不显示原有内容

**症状**：点「修改」后输入框里能看到原文（页面自己的 draft），但一点输入框弹出的系统输入法
是空的，等于要从头再打一遍。

**根因**（真机取证）：预填充文本的字段名不对。设备上的 IME 是有道输入法 2.9.12，
SDK（`@dictpen/core`）把预填充值放在 config 的 `contents` 里，但实测**只有 `text` 生效**——
按候选字段逐个打标记（contents/defaultText/inputText/value/… 各一个字母）上机，
只有 `text` 的值出现在编辑框里。

**修复**：`src/services/native.js` 不再转调 SDK 的 `openTextEditor`，改为自己订阅
`textEditFinished`（Global 信号 + `$falcon` 事件双通道）并调用 `global.startTextEdit`，
config 里把值放在 `text`（同时保留 `contents` 兼容按该名字实现的固件）。
真机验证：编辑消息 → 点输入框 → 键盘带出原文「你好」。

> 三个 Rust 侧改动（bug 1 的两处、bug 3 的会话 id）需要重新交叉编译后端：
> `wsl -d Ubuntu-24.04 -- bash -c 'cd /mnt/f/youdao/Deepseek/ds-free-api && bash build-aarch64.sh'`
> （脚本会 cargo build + UPX 压缩 + 拷进 `app/backend/`；随后 `npm run build:prod`
> 会自动内嵌新二进制）。宿主机跑 Rust 单测用 `bash ds-free-api/run-host-tests.sh`
> （`.cargo/config.toml` 把默认 target 钉在 aarch64，需显式覆盖才能在 x86 上跑）。

## 另外三个已修复的 bug（build 60）

### 1. 服务器繁忙／被限流时继续发消息会被禁言

**症状**：出现"服务繁忙"后用户自然会再点发送，几次之后账号变成"已被禁言"。

**根因**（后端 `ds-free-api`，是多重放大的叠加）：
- **限流被当成账号故障**：收到上游 `rate_limit_reached` 时调用 `mark_error`，
  账号进入 Error → 后台恢复任务 5 分钟后去**重新登录**（登录本身也是上游请求）；
- **限流可重试**：`v0_chat_cold` 最多 3 次 + 适配器 1 次重试，每次重试都**新建 session**
  再撞一次上游；
- **应用侧话术诱导重试**：429 一律显示"请稍后重试"，且"重试"按钮无任何拦截；
- **账号池不看退避**：被限流的账号立刻又被分配出去继续撞。

上游风控看的是短窗口内的请求密度，这几股流量叠加就是禁言的直接原因。

**修复**：
- 新增 `CoreError::RateLimited` 与错误码 `upstream_rate_limited`（HTTP 429），
  与"服务繁忙（overloaded，只是暂时没空闲账号，可重试）"彻底分开；
- 命中限流**不再 `mark_error`**（不触发重登），改为让账号进入**退避窗口**
  （`mark_rate_limited`，阶梯 60s→180s→600s→1200s→1800s），退避中的账号
  不被分配、**会话亲和也不放行**（`get_account_by_id` 同样检查），
  且 `get_account_with_wait` 在全池退避时立即返回而不是白等 30 秒；
- `v0_chat_cold` 与 `try_chat` 对限流**永不重试**，直接透传；
- 应用侧：`error-classify.js` 统一识别限流（新模块，可在宿主单测），
  提示语改为"请等待…连续发送会被判定为异常客户端，可能导致账号被禁言"，
  并在"重试"按钮上拦截（不再向后端发请求）。

回归用例：Rust 侧 `check_hint_classifies_rate_limit_separately`、
`cooldown_ladder_escalates_and_clears`、`cooldown_account_is_not_allocated`；
应用侧 `npm run test:ratelimit`（含"服务繁忙不能被误判成限流"这一条）。

### 2. 进入账户管理页面会掉登录

**症状**：从主页/设置进登录页（管理账号）时，有时被判定成"未登录"。

**根因**（两处，都会让已登录用户被判成未登录）：
- **读不懂后端写的 config.toml**：账号真源是后端写的 `config.toml`，而 toml crate 会
  按值的内容挑字符串字面量——值里含 `"` 或 `\` 时写**单引号字面量**
  （`password = 'has"quote'`）、含换行时写**多行字符串**。应用侧只用双引号正则去读，
  于是把这类账号读成"未配置" → `dsConfigured=false` → 进登录页/主页都被弹走
  （实测：`cargo run --example toml_strfmt_probe` 复现，`has"quote` 直接让判定翻转）；
- **退出确认弹窗会穿透**：Weex 里未绑定点击的容器不拦截触摸，弹窗的遮罩/空白区
  没有消费点击，点上去会穿透到下层按钮（同类问题此前在会话抽屉上修过一次）。

**修复**：
- 新增 `src/services/toml-config.js`：兼容基本/字面量/多行（基本与字面量）四种字符串
  形态，按段取值（不会跨段误匹配），并有 `npm run test:config` 覆盖，含
  **以后端实测输出为基准**的用例；
- `readLocalDsConfigured` 改为"有账号标识且有密码"才算已配置，并区分
  **"这次读不到配置"与"确实没账号"**：前者（后端正在重写/部署中）用应用侧账号缓存兜底，
  不再一次瞬时读失败就把用户踢去登录页（`loadSettings` 里落地）；
- 退出确认弹窗的遮罩/弹窗/按钮行都消费点击（新增 `noop`、`cancelRemove`）。

### 3. 删除对话没有同步删除云端对话

**症状**：删掉的对话，下次「同步」又回来了。

**根因**：删除只做了本地（`saveConversations` + `deleteMessages`），云端会话仍在，
而「同步」按标题/cloudId 把云端会话导回本地。

**修复**（新增一条完整链路）：
- 后端新增 `DELETE /v1/cloud-sessions/{id}` → `ds_core::delete_cloud_session`，
  逐个空闲账号尝试删除（会话是**账号作用域**的，多账号池下 cloudId 未必属于当前
  空闲账号），并顺手清掉本地复用缓存里指向该会话的条目；
- 应用侧新增 `deleteCloudSession()`，`deleteConversation` 在删完本地后调用；
  云端删除失败**不阻断**本地删除，只把原因写进抽屉提示
  （"本地已删除，云端删除失败：…（下次同步可能重新出现）"）。

协议面已用假上游端到端验证（宿主 x86 后端 + 本地 mock）：
删除请求确实到达上游的 `/chat_session/delete` 且带上正确的 `chat_session_id`。

## 构建

```bash
cd Deepseek/app
npm install            # 自动执行 aiot-vue-cli 补丁
npm run build:prod     # 产出 8000000000182376.0_1_3.amr（文件名 = appid + package.json 的 version）
```

> 构建需 Node 18（`build:prod` 脚本已通过 `npx node@18` 自动处理，无需本机装旧版）。
> 构建日志里的「未找到以下模块: storage,langningchen,fs」属正常——这些是设备端原生模块，运行时解析。
>
> 版本号有两处，发布前一起改：`package.json` 的 `version`（决定 amr 文件名与 manifest）
> 和 `src/services/store.js` 的 `APP_VERSION`（设置页/登录页显示的 "0.1.4 build N"）。
> build N 由构建脚本自动 +1，不用手改。
>
> 完整构建（含 qjsc 预编译）约 15 分钟，13MB 的 store bundle 预编译最耗时，期间看起来"卡住"是正常的。

## 安装到词典笔

```bash
adb push 8000000000182376.0_1_3.amr /userdisk/Favorite/
adb shell "miniapp_cli install /userdisk/Favorite/8000000000182376.0_1_3.amr"
adb shell "miniapp_cli start 8000000000182376 index"
```

> appid 为 `8000000000182376`（安装名可去掉前导 `800` 写成 `182376`，两种都能 `miniapp_cli start`）。
>
> **升级请用 `install` 覆盖安装**，别先 `uninstall`：`uninstall` 会删掉整个应用包目录，
> `data/` 里的账号、设置、会话全部丢失（详见上文「数据存放位置」）。

## 后端（ds-free-api）

本应用默认请求 `http://127.0.0.1:22217` 的 OpenAI 兼容端点。可选两种部署方式：

**A. 在词典笔本机运行**（推荐，无外网依赖）：

- 仓库已带 aarch64 二进制：`../ds-free-api/ds-free-api-v0.2.6-linux-aarch64-musl/ds-free-api`（静态 musl，无 .so 依赖）。
- 推到笔上运行，配置账号后监听 `127.0.0.1:22217`。
- 本应用默认地址即可直接用。

**B. 自建服务器**：

- 在 PC/服务器运行 `ds-free-api`，在「设置」页把服务地址改成 `http://<服务器IP>:22217`。

账号配置见 `../ds-free-api/ds-free-api-0.2.6/config.example.toml`，或启动后访问 `http://<host>:22217/admin` 在面板里配置。

## 设置项

| 项 | 说明 |
|---|---|
| 服务地址 | ds-free-api 的 OpenAI 端点（默认 `http://127.0.0.1:22217`） |
| API Key | 可选，ds-free-api 面板里创建的 Key（空 = 无鉴权） |
| 默认模型 | 快速 / 专家 / 识图 |
| 默认深度思考 / 联网搜索 | 新对话的初始开关 |
| 默认展开思考过程 | 新对话中思考过程默认展开还是收起 |
| 流式输出（SSE） | 是否使用流式逐字输出 |

## 依赖的原生能力

| 能力 | 模块 | 用途 |
|---|---|---|
| 网络请求 | `$falcon.jsapi.http` | 调用 ds-free-api |
| 本地持久化 | `storage`（官方系统模块） | 会话 / 消息 / 设置 |
| 相册文件 | `fs` + `langningchen.Shell` | 列出 `/userdisk/Pictures`、读图转 base64 |

> 识图模式的图片读取依赖 `langningchen` 原生扩展（设备需装有 miniapp 的 jsapi）。
> 纯文本对话不依赖该扩展，缺失时仅「图片」功能给出友好提示，不影响聊天。
