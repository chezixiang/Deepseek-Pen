# Deepseek（词典笔版）

对标官方 DeepSeek App 的聊天客户端，运行在有道词典笔 **X7 Pro** 上（Falcon 小程序框架）。
通过 **ds-free-api**（OpenAI 兼容接口）免费使用 DeepSeek 网页端模型，无需官方 API Key。

## 功能

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
    ├── app.json                  # 路由表：index / settings
    ├── pages/
    │   ├── index/index.vue       # 主聊天页
    │   └── settings/settings.vue # 设置页
    └── services/
        ├── http.js               # $falcon.jsapi.http / fetch 统一封装
        ├── ds.js                 # ds-free-api OpenAI 兼容客户端
        ├── store.js              # 会话/消息/设置 持久化（storage KV）
        └── images.js             # 相册读取 + base64（Shell）
```

## 构建

```bash
cd Deepseek/app
npm install            # 自动执行 aiot-vue-cli 补丁
npm run build:prod     # 产出 8000000000000001.0_1_0.amr
```

> 构建需 Node 18（`build:prod` 脚本已通过 `npx node@18` 自动处理，无需本机装旧版）。
> 构建日志里的「未找到以下模块: storage,langningchen,fs」属正常——这些是设备端原生模块，运行时解析。

## 安装到词典笔

```bash
adb push 8000000000000001.0_1_0.amr /userdisk/Favorite/
adb shell "miniapp_cli install /userdisk/Favorite/8000000000000001.0_1_0.amr"
adb shell "miniapp_cli start 1 index"    # appid 去掉 800 前缀
```

> appid 为 `8000000000000001`，安装名 = 去掉前导 `800` = `1`。

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
