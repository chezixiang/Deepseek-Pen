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

## 构建

```bash
cd Deepseek/app
npm install            # 自动执行 aiot-vue-cli 补丁
npm run build:prod     # 产出 8000000000182376.0_1_2.amr（文件名 = appid + package.json 的 version）
```

> 构建需 Node 18（`build:prod` 脚本已通过 `npx node@18` 自动处理，无需本机装旧版）。
> 构建日志里的「未找到以下模块: storage,langningchen,fs」属正常——这些是设备端原生模块，运行时解析。
>
> 版本号有两处，发布前一起改：`package.json` 的 `version`（决定 amr 文件名与 manifest）
> 和 `src/services/store.js` 的 `APP_VERSION`（设置页/登录页显示的 "0.1.2 build N"）。
> build N 由构建脚本自动 +1，不用手改。
>
> 完整构建（含 qjsc 预编译）约 15 分钟，13MB 的 store bundle 预编译最耗时，期间看起来"卡住"是正常的。

## 安装到词典笔

```bash
adb push 8000000000182376.0_1_2.amr /userdisk/Favorite/
adb shell "miniapp_cli install /userdisk/Favorite/8000000000182376.0_1_2.amr"
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
