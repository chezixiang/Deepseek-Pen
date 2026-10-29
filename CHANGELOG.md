# 更新日志 · v0.2.0（工作区相对 HEAD 的未提交改动）

> 生成时间：2026-10-28
> 范围：当前工作区相对 `HEAD` 的全部差异（尚未提交）。
> 规模：17 个文件修改（约 +3028 / −712 行）+ 11 个新增文件（含一个独立服务端项目 `penai-upstream/`）。

---

## 〇之六、消息气泡底部裁切与表格显示不全（2026-10-29，客户端布局修复，真机确认）

### 现象
- 长回复生成结束后，气泡底部内容被截掉；表格、列表、多行单元格最明显。
- 真机表格截图：数据行 "Claude Fable 5.1" 折行后第二行 "Fable" 被行边界拦腰裁掉，表头两行却完整。

### 根因（真机 A/B 实证，两轮证伪）
1. 表头/数据单元格是嵌套 row+wrap 容器，这台 Falcon 引擎对折行后的文本**两遍量高不可依赖**：
   先按 max-content 量高（一行），按列宽折行后高度不涨，第二行被行边界裁掉。
2. build 197 尝试对齐列表项的 `.md-li-body` 方案（td/th 改 row 容器 + 内容层 `flex:1` 定宽）
   ——真机复测仍裁，证伪"定宽一次量高"在嵌套 wrap 场景的可行性。
3. Weex 仅支持单类选择器，无法用 `.md-td .md-span` 后代选择器定点覆盖。

### 修复（`index.vue` + `message-layout.js`）
- 单元格 run 显式声明 `lines: 3`：`runClass` 新增第三参 `cell`，表格上下文输出
  `md-<样式>-cell` / `md-<样式>-dark-cell` 变体类（浅/深共 14 个类），文本盒子按 3 行测量，
  行高永远足够；超 3 行的单元格内容尾部省略（引擎 lines 属性自带省略号）。
- 定稿消息行 key 含全文双 32 位指纹（`message-layout.js`：`messageRenderKey`/`isTallMessage`），
  同长度替换也触发整行重建；长回复/表格滚动锚定内容末尾；流式长消息按 900ms 节流重挂。
- td/th row 化 + `.md-cell-body flex:1` 保留（与列表项同构，作为定宽保险层）。

### 验证
- 布局纯函数 10/10、`npm test` 全套通过、Vue SFC 编译通过、模板审计 7 文件通过。
- **真机确认**（X7 Pro，adb + miniapp_cli capture）：build 198 表格折行完整显示，
  用户滚动核对无半行裁切。
- **数据管道核对**：云端 `penai-upstream` 会话快照与设备落盘逐字 diff——5516 字符完全一致，
  截图所示行与原文逐列吻合，确认无吞消息，问题纯在渲染层。

---

## 〇之五、消息"下部被截断/整段被吞"：气泡高度没有跟着内容长（2026-10-29 中午，客户端待发版）

### 现象（用户截图 + 服务器会话还原）
长回复（列表/表格尤其严重）生成完成后，气泡只有一两行高，里面的内容从中间某一块开始显示、
底边把最后一行文字拦腰裁掉，前面的段落/表格全部不可见——"吞掉很多内容"。

### 根因（Falcon 布局引擎的量高滞后，三个叠加因素）
1. **气泡高度是缓存的**：`.md` 子树重建（textEpoch）能逼引擎重新量高，但**父级气泡**的高度
   不一定跟着重算——子树从 0 长到几千像素，气泡停在早期某帧的高度，内容被裁。
2. **内容被"原地替换"时 key 不变**：`textEpoch` 定稿后恒为 'f'——切生成尝试、云端同步回填、
   编辑重发都会换掉整段内容；若新旧长度同桶，子树都不重建，更重量高无从谈起。
3. **行内文本在 row+wrap 容器里被按 max-content 量高**：列表项正文、表格单元格都是
   "先按一行量、再按列宽折行"，高度不涨，`overflow:hidden` 就把第二行拦腰裁掉
   （截图里"下半行不见"的直接来源）。

### 修复（`index.vue`）
- 新增 `bumpLayout(m)` + 消息行 key 变为 `m.id + ':' + renderEpoch`：**定稿 / 切尝试 /
  编辑版本 / 重试**时整行销毁重建一次——节点创建是本引擎已验证的可靠量高路径，
  这也是唯一能确定"气泡高度 == 内容高度"的手段。
- `textEpoch` 定稿分支带上内容长度（`'f' + len`）：内容一变子树必重建，不再依赖运气。
- 列表项正文包一层 `.md-li-body`（`flex:1`，先拿到确定的剩余宽度再量文字）；
  表格单元格此前已包 `.md-cell-body`——两者都是"先定宽、再量高"。
- （上一轮的）长回复滚动锚点修复保留：`scrollToBottom` 对比视口高的消息改锚内容末尾。

### 验证
- Vue SFC 模板/脚本编译通过、`audit-text-nesting` 7 文件全过；本地无 Falcon 真机可复现，
  需真机验证（build 192+）。

---

## 〇之六、消息气泡底部裁切与表格显示不全（2026-10-29，客户端布局修复）

### 现象
- 长回复生成结束后，气泡底部内容被截掉；表格、列表、多行单元格最明显。
- 部分同长度回复切换后仍沿用旧布局，高度或滚动范围不刷新。

### 根因
- Falcon 对原生文本节点和父气泡高度有缓存；只重建 Markdown 子树不一定会让父级气泡重新测量。
- 表格单元格内容层使用 `overflow:hidden`，在换行后的行高尚未同步时，会把下半行直接裁掉。
- 旧消息行 key 只依赖消息 id 与手动 epoch，同长度内容替换可能复用旧原生节点。

### 修复
- 新增 `app/src/services/message-layout.js`：
  - 用确定性双 32 位指纹生成定稿消息行 key，同长度不同内容也会触发整行重建；
  - 统一长消息判断：长文本、长思考过程、GFM 表格、多个工具卡片都采用末尾滚动锚点。
- `index.vue`：
  - 定稿消息行使用内容指纹 key；流式长消息按 900ms 节流主动重建父消息行；
  - 定稿/切换尝试/云端回填仍走整行重建，350ms 后对长消息再补一次布局刷新；
  - 移除表格单元格 `overflow:hidden`，保留独立单元格内容层按最终列宽测量，避免换行内容被裁掉。
- 新增 `scripts/test-message-layout.mjs`，并纳入 `npm test`。

### 验证
- 布局纯函数回归：10/10 通过。
- Vue SFC 脚本/模板编译通过。
- `audit-text-nesting.js`：7 个文件全部通过。
- 客户端改动需要构建新包后才会在设备上生效。

---

## 〇之四、模型"抱着工具说上不了网" + 不支持附件的答非所问（2026-10-29，服务端热更 1.7.4）

### 1) 部分模型无视 tools 注入，仍回答"我无法联网"
- **现象**：开着联网发问，模型直接回"我无法访问实时信息"，一次搜索卡片都不出现；换模型（deepseek-flash）则正常。
- **定位**（线上直连 new-api 复现）：只下发 `tools` 定义时，模型的长 system（gpt-6.1-sol / gpt-6-astra 实测 prompt 里带 22k tokens 的上游开发者指令，其中包含"不要调用外部 API"）压过了函数定义。模型诚实地说"我不能联网"——它确实"被要求"不能。deepseek-flash 不受影响，所以表现为"部分模型"。
- **修复**：
  - 网关（`server.js`）：请求带 `web_search` / `fetch_page` 时，在 system 末尾补一段能力说明（`TOOL_USE_DIRECTIVE`）：本轮已开启联网工具、实时类问题必须先检索、**严禁声称自己无法联网**。已存在同一段说明时不重复注入（`hasToolDirective`）。
  - 客户端（`ds.js`）：自定义端点模式不经过网关，`injectSearchCapability()` 在发送前把同文案拼进首条 system，并显式带 `tool_choice: 'auto'`；收尾轮摘掉 tools 时用 `removeSearchCapability()` 一并摘掉说明，避免模型"说要搜"却没有工具。
- **验证**（真机凭证按客户端协议直连 `penai.aquavie.top`）：修复前同一问题不产生任何 `tool_calls`；修复后 3 个模型均在第 1 轮发起检索，4 轮循环后正常落地成带来源的答案。

### 2) 上传不支持的附件后，模型开始"解读提示文本"
- **现象**（用户截图，`course_app.db`）：助手回答"这段提示的意思是…合适的回复可以是…以上是对你提供的提示文本的解读"，完全没在回答问题，还被重试了 4 次。
- **定位**：`attachments.js` 把「[系统提示：用户上传了附件 X，但服务端无法解析…请如实告知用户…]」作为一个 **user 内容块**发出去。模型把这段方括号文本当成"用户贴过来让我解释的提示词"，于是逐句解读（gpt-6.1-sol 稳定复现；deepseek-flash 恰好看得懂意图，所以只在部分模型上暴露）。
- **修复**（`attachments.js`）：
  - 无法解析的附件不再进 user 内容，改为合并进 **system**：`[附件状态] 「x.db」无法解析：…`，用户原话保持不动（"分析"就只是"分析"）。
  - 只传文件不打字时，补一句自然提问（"请看一下我上传的文件。"），不再产生空 content。
  - 可解析附件的包装从 `[以下是…的解析内容]` 改为陈述句 `（用户上传的附件「x」内容如下）`；超长截断说明同样移到 system。
  - 已有 system 时合并进同一条，不新增第二条 system（部分端点只接受首条 system）。
- **验证**：修复前 gpt-6.1-sol 输出"这段提示表示…"；修复后同一请求回答"我目前无法读取 `course_app.db` 的内容，请导出为 CSV/SQL/Excel 后重发"。可解析的 .txt 附件同样正常（直接给出成绩分析表格）。

### 测试
- `test/attachments.test.js`：4 条断言改为"说明进 system、user 内容保持干净"，新增"只发文件补提问""已有 system 合并"两条。
- `test/smoke.test.js`：新增端到端子测试——带 tools 注入能力说明、不带 tools 不注入、客户端已带说明不重复、不支持附件的说明进 system 且 user 只剩原话。
- 本地与服务器 `node --test` 均 60/60 通过；线上 `systemctl restart penai-upstream` 后 health 正常。

---

## 〇之三、联网搜索断流 + 思考挡位一发送就重置（2026-10-28 晚，build 188）

### 1) 联网搜索后不再"直接停住"（内置端点实测复现）
- **现象**：开启联网后搜索卡片正常出现，但之后没有任何回答，发送按钮回到可发状态。
- **定位**（用真机凭证按客户端协议直连网关复现）：`chatStream` 的工具循环 `MAX_TOOL_ROUNDS = 4`，达到上限时**直接 `break`**——模型第 4 轮刚发起的 `tool_calls` 既没执行、也没有后续请求，`content` 里只剩「我来搜索…我再核对一下…」这类过渡旁白。实测联网场景 4 轮全部是 `tool_calls`（模型总想"再查一条"），必然命中上限。
- **修复**（`ds.js`）：轮数用尽不再中断，而是
  1. 先执行本轮工具调用（结果对回答仍然有用）；
  2. `delete body.tools` 摘掉工具；
  3. 追加一条 user 指令（`FINAL_ANSWER_INSTRUCTION`：不能再调用工具，立即基于已有搜索结果作答）；
  4. 再跑一轮拿最终答案。
- 另加两处兜底：工具轮之后模型返回空 content → 追加同样的收尾轮；收尾轮若仍凭空吐 `tool_calls` → 直接结束（不会无限续搜）。
- 指令用 user 而不是 system：部分 OpenAI 兼容端点只接受首条 system，中途插 system 会 400；该消息只存在于本次请求的 wireMessages，不落盘、不进会话历史。
- **验证**：真机凭证直连 `penai.aquavie.top` 复现原状（4 轮后 content 仅 71 字旁白）→ 改后同一问题产出 3112 字带来源的回答；带 `user` 会话字段再测同样正常（收尾轮 `finish=stop`、172 字直接答案）。

### 2) 思考挡位"点完、一发消息就重置"
- **根因**（`index.vue`）：`newConversation()` 建会话时只写了布尔 `thinking: this.thinking`，没写 `thinkingLevel`；紧接着的 `applyThinking(conv)` 按"布尔 true → 模型默认挡"折算，用户点的 max/low 当场被压回默认挡。空态直接发送时 `send()` 会走 `newConversation()`，所以重置恰好发生在"发出去的那一刻"。真机 `ds_conversations.json` 里两条会话的 `thinkingLevel` 都是 `""`，与此一致。
- **修复**：
  - `thinking-levels.js` 新增 `thinkingFields(modelId, value)`：挡位字符串是唯一事实来源，`thinking` 布尔同步派生（`none` → false）。
  - `newConversation()` 建会话时带上 `thinkingLevel`（`applyDefaults` 时先折算默认挡再写入）。
  - `send()` 发送前把当前挡位回写会话：旧版本创建的会话（`thinkingLevel` 为空）补一次，重进会话不再退回默认挡。
  - `toggleThinking()` / `applyThinking()` 统一走 `thinkingFields`，挡位与布尔永不失配。
- **验证**：`test-thinking-levels.mjs` 新增 5 条 `thinkingFields` 用例（含 none/布尔/模型不支持挡位折算），客户端 `npm test` 全绿。

---

## 〇之一、客户端日志治理 + 反馈上传完整日志（2026-10-28 傍晚）

### 1) 日志模块收敛为唯一写入方
- `services/app-log.js` 成为唯一日志实现，`store.js` 删掉重复的 read-then-write 副本（此前两份队列并发改写同一文件，会互相覆盖丢行），改为转发导出。
- 新增统一入口：
  - `appLogError(scope, err, extra)`：所有报错统一格式 `[error] scope: code=… message @调用位置`，只取堆栈首帧，避免几千字符挤满窗口。
  - `appLogSetting(key, from, to)`：设置项变更统一格式 `[settings] key: 旧值 -> 新值`；apiKey/token/secret/password/账号等敏感字段只记“已设置(len=N)”。
  - `debugLog(...)`：明细日志，仅在设置页「启用调试日志」开启时落盘（带 `[debug]` 前缀），默认不产生噪声。

### 2) 删除无用日志（噪声/隐私）
- 删除：主题 watcher（`isDark 实际变化`）、裁剪框 touchstart/touchend 全量 JSON、思考按钮诊断三连（click/applied/forceUpdate）、`GEN |` 系列 console 调试、键盘回跳/事件全量 JSON、`loadSettings` 每次进页面都打印、`deploy write b64 len`（值还是空的）、`health ok round` 等例行步骤。
- **隐私修正**：键盘回跳参数、onNewOptions/事件原文、会话标题都不再进日志（日志会随反馈上传）；只保留长度/字段名。
- 降级为 debug：reasoning_effort、云端会话加载/自动命名、相机取景模式、云控缓存读取、同步统计等。

### 3) 报错与设置变更全覆盖
- `saveSettings` 做全量 diff（跳过额度/云控缓存等运行时字段，清洗派生字段），任何设置项变化都会落一行；`saveSettings().catch(()=>{})` 的 8 处静默失败改为记录错误。
- `http.js`：超时/网络失败/4xx/5xx 全部写日志（含 200 字符响应体），成功只进 debug。
- `ds.js`：SSE 畸形 chunk（前 3 条）、非 JSON 错误页原文、工具调用失败（搜索/抓取）写日志。
- `store.js`：storage 读写/JSON 解析失败、反馈草稿读写、账号异常取证、消息落盘失败均记录。
- `native.js`/`store.js`：账号更新/清空、代理、网络抓取、部署失败补 `appLogError`。
- 页面：登录、启动、设置、首页的相册/文件/拍照/会话保存/云同步/配额/模型拉取失败均记录。
- 后端监控的 console 输出改为应用日志（断开/重连/无可用账号）。

### 4) 反馈上传完整日志文件
- 客户端 `buildLogBundle()` 读取**整份**日志：`ds-app.log.old` → `ds-app.log` → `runtime.log.1` → `runtime.log`，按段落加头，最多 512KB（超出保留最近部分并标注）。
- 反馈页去掉「附带诊断信息」开关，**始终**上传完整日志；`diagnostics.log` 仍保留应用日志尾部 120 行供后台快速浏览，`diagnostics.logMeta` 记录行数/字符数/是否截断/分段。
- 客户端 `submitFeedback` 新增 `logs` 字段（name/text/lines/chars/truncated/parts），超时 20s→30s。
- 服务端 `feedback.js`：日志落到 `data/feedback-logs/<id>.log`（0600），`feedback.json` 只存元信息；删除反馈/超出 maxEntries 淘汰时同步删日志文件。
- 服务端 `admin.js`：详情返回 `logText`（尾部 128KB 预览）与 `logMeta`；新增 `GET /admin/api/feedback/:id/log` 整份下载。
- 后台 `admin.html`：反馈抽屉显示完整日志块（大小/行数/是否截断/分段/下载），旧数据仍按 diagnostics 尾部兼容展示。

### 5) 验证
- 客户端 `npm test` 全绿（顺带修正两个因 build143 相机实现变更而失效的旧用例断言）。
- 服务端 `node --test test/smoke.test.js` 27/27 通过；新增断言：日志落盘内容一致、列表不带正文、详情/下载可取回、删除反馈同时删日志文件。

---

## 〇之二、设备 ID 改用硬件 SN（2026-10-28 傍晚，严重 bug 修复）

### 根因
同一台笔卸载重装后出现两个 `deviceId`，服务端变成两台设备、旧会话与额度对不上。旧算法有四处非幂等：

1. `stableDeviceId()` 用网卡 MAC 哈希，冷启动 wlan0 未初始化时 `/sys/class/net/wlan0/address` 可能是 `00:00:00:00:00:00`，且旧正则**接受全零 MAC**（多台"开机即注册"的笔会撞成同一个 ID）；
2. 不同固件网卡名是 wlan0 / eth0 / wlan1，读到哪个不确定；
3. 部分机型 MAC 随机化；
4. 设置页手动配对走另一条路径 `ensureDeviceId()`，直接生成随机 UUID——与静默注册的 MAC 哈希必然不同。

真机日志实证（2026-10-28 17:57，`$dataDir` 新布局首次启动）：
`[settings] pairDeviceId: (空) -> b8e60ec6-4dd2-4144-bdef-e0efd6e7132e`，
即 `stableDeviceId()` 直接读 MAC 失败、退化成随机 UUID；旧数据目录 `/userdisk/data` 与新数据目录
`/userdisk/secondary/miniapp/data/mini_app/pkg/8000000000182376/data` 并存，导致重装后设置丢失、再次生成 ID。

### 修复
- 新增纯函数模块 `app/src/services/device-id.js`：`deviceId = 'pen-' + SHA-256('deepseek-pen:sn:' + SN).slice(0,32)`，同 SN 永远同 ID。
- SN 来源优先级：`/proc/cpuinfo` 的 `Serial`（真机实测 `8c571a98d606d768`，0444 只读、芯片唯一）→ `/proc/device-tree/serial-number` → eMMC CID（真机 `df01…bb00`）→ machine-id。全部不可用才退回旧 MAC 算法，最后才随机 UUID（并写 `[error] device.id`）。
- 全零 MAC 派生的历史占位 ID 会被识别并废弃（`isPlaceholderDeviceId`），改用 SN 重新注册；旧令牌一并清空，避免拿旧 ID 的令牌请求新身份。
- **只走 shell，不赌 fs**：OS 4.9.7 的 falcon `fs` 没有 `fs.writeFile`（应用侧所有写入本来就靠 `store.writeFile` 的 shell base64 兜底，设备上 `ds_settings.json`/`ds-app.log` 全是 `root:root` 即实证），且 `fs.readFile` 读 `/proc`、`/sys` 会失败。改为**一条**命令（`buildProbeCommand`）同时带回硬件标识 + 两份 ID 记录（应用数据目录、`/userdisk`），写进 `$dataDir` 再读回；命令末尾强制 `chmod 644`，否则 root + umask 077 会让应用读不回、探测"看似成功其实全空"，又退回随机 UUID。
- 真机实测：整条探测命令 **55ms**，输出 cpuinfo `8c571a98d606d768` / eMMC CID / dbus machine-id / wlan0 MAC，两段记录解析正确；写入链路（`printf %s <b64> | base64 -d >`，644、root）也逐字节核对通过。
- **随机 UUID 永不写持久化记录**（写进去会锁死身份）；磁盘上已有 UUID 记录时，只要本次读到 SN 就丢弃并收敛到 SN 派生 ID。
- 各来源加最小长度（cpuinfo/device-tree ≥8、eMMC ≥12、machine-id ≥16）：个别固件把芯片型号（如 `RK3562`）写进 `Serial`，全机型相同会让所有笔撞成一个 ID。
- 启动早期探测失败不再锁死一分钟：无 SN 时清缓存、等 400ms 重探一次，仍失败才退化；空结果缓存窗口 60s→5s。
- 发现旧数据目录 `/userdisk/data` 与新 `$dataDir`（`/userdisk/secondary/miniapp/.../data`）并存，数据目录迁移同样会造成"设置丢失 → 重新生成 ID"；SN 方案不依赖数据目录，已覆盖。
- 手动配对与静默注册统一走 `stableDeviceId()`，删除设置页的随机 UUID 生成。
- ID 持久化到 `$dataDir/.ds-device-id.json` 与 `/userdisk/.ds-device-id.json`（用户盘，卸载通常不清）；记录带本机**全部**硬件指纹（`sns` 数组），任一匹配即同机，避免"这次只读到 eMMC、下次读到 CPU SN"被误判成换机；换机/克隆用户盘时全部不匹配才重算。
- 老版本升级：现有 `pairDeviceId` 写入持久化记录（含 SN 指纹）；`pen-` 开头的历史 MAC ID 继续沿用（不丢在线会话/额度）；**历史随机 UUID 会自动迁移为 SN 派生 ID**（UUID 是旧算法读不到 MAC 时的兜底产物，旧令牌清空后自动重注册）。
- 日志：`[device] 由硬件序列号生成标识 source=cpuinfo id=…` / `[device] 复用已保存标识 source=/userdisk/…`，来源可追溯。

### 测试
- 新增 `app/scripts/test-device-id.mjs`（已接入 `npm test`）：真机 cpuinfo 解析、全零/占位值拒绝、同 SN 幂等、大小写/空白归一、旧 MAC 公式兼容、占位 ID 识别、多指纹记录复用/换机重算。
- 新增探测链路用例：真机实采输出（含 adb 的 `\r\r`）解析、空记录/缺结束标记容错、命令必须含两处 `cat` 与 `chmod 644`、UUID 记录必须被 SN 覆盖。
- 客户端 `npm test` 全绿。

### 注意
- 旧版本已经产生的重复设备记录不会自动合并；确认新版本不再新增重复后，可在后台设备页删除旧记录（或后续做服务端合并）。
- 升级后**新装/重装**设备统一使用 SN 派生 ID；历史随机 UUID 首次启动会迁移一次（旧记录需后台清理）；历史 `pen-` MAC ID 保留，避免破坏在线会话。

---

## 〇、控制面板开放化 + 聊天链路修复（2026-10-28 下午，build 185 / server 1.7.1 追加）

### 1) RCE 远程执行改「推送」（等效主动下发，服务端+客户端）
- 服务端 `debug-queue.js`：新增 `takeWait(deviceId, waitMs)` 长轮询；`enqueue()` 即时唤醒等待者。
- 服务端 `server.js` `/v1/debug/commands`：支持 `?wait=秒`（0–25s，须小于 Nginx 读超时）；命令入队瞬间返回，`waited:true` 标记。
- 客户端 `remote-debug.js`：`setInterval` 轮询改为**自调度长轮询循环**——设备常态挂在服务端，命令下发→执行延迟从最长 pollSec（20s）降到约一个网络往返；旧服务端（无 wait）自动按 pollSec 退避兼容。

### 2) 错误区分「网关 / 上游透传」
- 服务端 `http.js sendError`：错误 JSON 新增 `scope`（`gateway`=网关自身 / `upstream`=上游透传）与 `upstreamStatus`；`provider_error` 审计带 scope。
- 客户端 `ds.js`：SSE/JSON 错误消息按 scope 加 `【上游错误】/【网关错误】` 前缀，聊天气泡与遥测 lastError 同步可见。

### 3) 反馈附带日志（闭环）
> 后续迭代见「〇之一」：已升级为上传完整日志文件（服务端独立落盘 + 后台整份下载）。
- 客户端 `feedback.vue`：**始终**附带应用日志尾部（120 行）；fs 读取失败时走 shell 兜底（`readFileWithShellFallback`）；勾选「附带诊断信息」再附后端运行日志尾部。
- 客户端 `index.vue`：聊天失败写入 appLog（此前只走 console.error，反馈里完全看不到错误）。
- 服务端 `feedback.js`：日志类字段（log/backendLog 等）单字段上限 2000→24000 字符，总体 20KB→64KB，超限优先保日志。
- 后台 `admin.html` 反馈抽屉：日志独立成块（可滚动），列表加「含日志」标记，一键下载 `.log`。

### 4) 在线状态实时刷新
- 服务端 `admin.js`：在线窗口 10min→**3min**；在线判定改用 `max(lastSeenAt, reportedAt)`（任意已签名请求都算活跃，长轮询设备每 ~25s 刷新）；新增轻量端点 `GET /admin/api/devices/:id/status`。
- 后台 `admin.html`：设备/监控页 5s 自动刷新（勾选状态跨重渲染保留、失败静默）；**设备抽屉打开时 5s 轮询状态**，实时更新在线/版本/最近错误（管理员正在输入时自动跳过，不打断编辑）。

### 5) 会话记录完整内容查看器（不再是只看标题）
- 服务端 `admin.js`：新增 `GET /admin/api/sessions/:deviceId/:sessionId`（返回完整消息，含 reasoning/attempts/images/files）。
- 后台 `admin.html`：新增会话内容抽屉——按消息渲染角色/正文/思考过程（默认折叠）/出错原因/工具与附件计数/多次生成尝试；「会话备份」页与设备抽屉的会话表均有「查看内容」按钮。

### 6) 修复 CHAT_ERROR「no URL specified!」（真机复现定位）
- **根因**：个别机型 `fs.writeFile` 静默失败 → chatStream 的 curl `-K` 配置文件为空/缺失 → 设备 curl 报 `curl: no URL specified!`（真机 `curl -K 空文件` 精确复现；该设备请求从未到达网关，服务端 audit 0 命中）。
- 修复（`native.js`/`store.js`/`ds.js`）：新增 `writeFileRetry`（失败重试一次）；chatStream 检查 req/cfg 两个文件的写入返回值，失败抛可读错误并记 appLog；`curl:` 裸报错映射为可读文案。
- 审计佐证：该报错设备（095b3964）在服务端 audit 无任何请求到达记录。

### 6b) 根因实锤与彻底修复：OS 4.9.7 没有 fs.writeFile（build 186）
- 用户定位真正根因：**OS 4.9.7 的 falcon fs 模块没有 `fs.writeFile`**（管理员的笔是 4.9.9，因此本地一直无法复现）。一次定位同时解释两类故障：curl 配置文件写不出（`no URL specified!`）与反馈日志为空（appLog 同样写不出）。
- 4.9.7 仍可用的能力（有铁证）：`fs.readFile`（chatStream 能读回 curl 写出的错误文件）、`execShell`（curl 能跑）、storage KV（`setJSON` 双写兜住了设置/会话持久化）。
- **修复**：新增零依赖叶子模块 `services/shell-write.js` —— 纯 JS UTF-8+base64 编码 → 分块 `printf >>` 追加（每块哨兵同步，规避 execShell 异步乱序）→ `base64 -d` 精确落盘；另含 shell 逐行追加（日志）、shell 截断、shell `wc -c`（statSize 兜底）。`native.js`/`store.js` 的 `writeFile`/`statSize` 与两份 appLog、全部 clear 函数均接入兜底。
- 影响：4.9.7 上**聊天恢复可用**（cfg/req 经 shell 写入）、应用日志存在（反馈有现场）、camera/上传/更新校验修复。
- 测试：新增 `scripts/test-shell-write.mjs`（真宿主 sh 集成 + 并发乱序 mock），过程中抓出并修复三个实现 bug（printf 格式串 `\n` 被 shell 吞、反斜杠路径上 glob 清理失效、宿主 sh -c 8192 字符截断 → 块尺寸降到 6000）；6/6 过，9 套件全绿，模板审计过。设备 OS 层经 adb 实测 6.2KB/24KB 命令无截断（8192 限制仅存在于 Windows 宿主）。
- build 186 已打包并 adb 直装（b.bak-185 备份）；4.9.7 用户经后台「发布」获取。

### 7) 测试与部署
- 服务端 smoke 54/54（新增：长轮询即时唤醒/空等超时、会话详情 API、反馈日志放宽上限）；服务器上 27/27 fail 0。
- 客户端 8 项回归全过 + 模板审计通过（camera 两个用例为 HEAD 既存失败，与本次无关）。
- 已部署：服务器 7 文件 md5 校验一致后 systemctl restart，公网 /health 与 admin 新标记均验证通过；远端备份 `/root/backups/penai-upstream/pre-console-v5-20261028-073819.tgz`。
- 客户端 build 185 已打包（`app/8000000000182376.0_2_0.amr`），拆包复核全部改动入包；待 adb 或后台发布安装。

---

## 一、版本与构建（Version bump）

- **package.json**：版本号 `0.1.5 → 0.2.0`；`test` 脚本新增 `test:thinking-levels` 用例。
- **build-wrapper.js**：
  - `APP_VERSION` 由「运行时拼接」改为**构建期融合的单个字符串字面量**（如 `"0.2.0 build 177"`）。原因：发布后台（`penai-upstream/src/amr.js`）靠扫描 AMR 包内 JS/字节码文本里的 `"<version> build <N>"` 字面量识别构建号，拼接形态在 dev/未常量折叠产物里不生成可扫描完整字面量，会报「未能从包内提取构建号」。
  - 新增 `release.json` 元数据写入（appId/version/build/builtAt），降低后台对压缩包内版本字符串格式的依赖。
  - 后端 SHA 同步更新（`1babb3bc45283571 → aa92f5d36963f659`）。
- **build-info.js / api-auth.js / cloud-control.js**：`CLIENT_VERSION`、`CLIENT_BUILD` 同步为 `0.2.0-build-<N>`。

---

## 二、联网搜索重构（重大变更）

旧架构的 `web_search_options` 是 `ds-free-api` 私有协议，网关直连 DeepSeek 官方后官方不识别该字段，搜索会**静默失效**（已于 build 183 移除）。新架构如下：

- **ds.js**：
  - 移除 `body.web_search_options`，改为向请求注入 `web_search` / `fetch_page` 两个 function 工具。
  - `chatStream` 重构为**多轮工具循环**：每轮起独立 curl → 轮询解析 SSE → 若模型发起 tool call 且未达上限（`MAX_TOOL_ROUNDS = 4`）→ 走内置服务网关执行 → 回填 `assistant(tool_calls)/tool` 消息重发。
  - 新增 `WEB_SEARCH_TOOL` / `FETCH_PAGE_TOOL` 定义、`formatSearchResults`、模型发起的搜索/抓取结果格式化（含 `title`、`count`、`durationMs`）。
- **cloud-control.js**：新增 `callWebTool`（统一在**内置服务网关** `/v1/tools/search|fetch` 执行，设备侧零密钥）；新增 `gatewayBase()`（与当前后端模式无关的网关根地址，解决自定义端点模式下 effectiveBaseUrl 指向用户服务的问题）。
- **index.vue**：支持展示「联网工具卡片」（`toolCalls`：`web_search`/`fetch_page` 的搜索词/URL、结果条数、耗时）。
- 自定义端点模式执行联网搜索时，以 `gateway=true` **静默注册**到内置服务网关（`doEnsureUpstreamAuth` 绕过模式门槛）。

---

## 三、思考挡位系统（Thinking Levels）

- **新增 `thinking-levels.js`**：基于模型 ID 的挡位规则表，覆盖 DeepSeek-Flash、GPT-5.6/6.1/6 Sol/Luna、Claude 5.5/5.0/Opus 4.8/4.7、Gemini 3、GLM-5.3、Grok 4.7、Kimi K3、Qwen3.8、StepFun-3.7、腾讯 HY3、Mistral 等。
  - `thinkingSpecFor(modelId)`：返回 `{ levels, default }`，规则按「具体型号在前、宽泛前缀在后」排序避免截胡。
  - `normalizeThinkingLevel(modelId, value)`：遗留布尔/空值折算为模型默认挡；`false`/`'none'` 恒为 `none`（保留「关」语义）。
  - `nextThinkingLevel(modelId, current)`：点击「深度」按钮按当前模型挡位表循环切换。
- **index.vue**：思考按钮从单一「深度」变为**动态挡位文案**（none / minimal / low / medium / high / xhigh / max），采用三层防御（静态 `<text>` 分支 + 各分支不同 `key` + 点击绑在恒定外层 `div`）解决设备端渲染丢失/点击失效。
- **ds.js**：`reasoning_effort` 直传挡位字符串（非布尔）。
- **store.js / session-sync.js / store-schema.js**：`normalizeConversation` 增加 `thinkingLevel` 字段；消息落盘清洗、会话同步同时处理 `images` 与 `files`。

---

## 四、本地文件上传（Files）

- **新增 `files.js`**：词典笔无通用文件选择器，提供从 `/userdisk` 出发的逐级目录浏览；`base64` 读取转 data URL（二进制无法走 Falcon fs 文本接口）；单文件 ≤ 1.5MB、最多 2 个；仅允许在用户盘内浏览。
- **新增图标**：`assets/icons/file.png`、`file-dark.png`（深色模式）。
- **index.vue**：新增文件浏览器浮层、待发附件展示（带大小/移除）、用户消息文件卡片、`draftFiles` 状态；`canUploadFile` 受云控 `files` 开关约束。
- **ds.js `buildMessages`**：文件只随**最后一条用户消息**发送（DeepSeek 会话内记住已上传文件，避免历史重复上传）；`dataUrl` 运行期缓存、落盘前由 `stripImagePayloads` 清除。
- **store-schema / session-sync**：`files` 字段（path/name/size/mime）随会话同步与落盘清洗。

---

## 五、Loli Rime 键盘（实验能力）

- **store.js**：新增计算器 miniapp（`CALC_APPID='8001687764241341'`）键盘调用 `tryCalculatorKeyboard`；`openTextEditor` 支持 `keyboardMode='calculator'`，不可用时自动回退系统输入法；导出 `notifyKeyboardResult` / `abortKeyboardSession` 供回跳页调用；新增 `cachedSettings` 缓存供输入法同步读取。
- **新增 `kbresult.vue`**：Loli 键盘 `kbCaller` 回跳页（独立页避免参数被复用丢弃），`onLoad`/`onNewOptions` 都处理回传并 `navTo('index')`。
- **settings.vue**：新增「输入键盘」选择（系统 / Loli），`loliKbSupported` 由 `LOLI_KEYBOARD_CROSS_APP` 决定。
- **feedback.vue / index.vue / settings.vue**：`openTextEditor` 统一传入 `callerPage`；相关页面新增 `onNewOptions` 处理键盘回传。

---

## 六、云控协议 v4（重大重构）

`cloud-control.js` 由 v1 升级到 **v4**，客户端侧全面适配：

- **结构扩展**：`features`（11 项功能开关，含 `critical` 标记）、`limits`（7 项运行限制：maxInputChars/maxHistoryMessages/maxImageCount/requestTimeoutSec/maxSessions/pollSec/reportSec）、`prompt`（提示词注入）、`debug`（allow/rce/report/pollSec）、`update`（新增 `fileId/fileName/size/sha256/url`）、`telemetry`、`upstream`（披露）、`notice`（`noticeId`/`noticeLevel`）。
- 新增 `controlFeature()` / `controlLimit()` 读取；`FEATURE_DEFS` / `LIMIT_DEFS` / `QUOTA_DEFS` 常量。
- **配额归一化 `normalizeQuota`**：统一 6 项（RPM / TPM / 5h Token / 今日 Token / 本月 Token / 并发），缺字段不崩。
- **公告 → 服务通知**：`announcement` 改为 `notice`（`noticeFor`，`noticeId` 变化才弹，正文哈希做去重键），UI 走弹窗而非聊天区横幅。
- **调试授权 `debugGate`**：`allow`（是否响应暗号）+ `rce`（是否允许远程执行）双层开关。
- 新增 `reportTelemetry`（状态上报，受 `telemetry.enabled` 与 `reportSec` 节流）、`requestUpdateTicket`（更新包下载票据，避免公开 `/files` 地址）。

---

## 七、远程调试（remote-debug）

- **新增 `remote-debug.js`**：仅在「设备开启调试模式 + 云控 `debug.rce`」时运行；支持 `eval`（页面沙箱 `new Function`，仅暴露 `build/now/log` 只读 helper）与 `shell`（root，输出重定向到结果文件 + `__RCE_EXIT:<code>` 哨兵行轮询回收）两类命令，结果回传后台。

---

## 八、设置页重构（Settings）

- 横屏两列网格布局（`grid-row` / `field-grid`），长文本仍整行，避免单列过长。
- **设置锁定**：云控 `settingsEdit=false` 时整页只读（「只读」标签，隐藏保存）。
- **模型切换可云控关闭**（`modelPicker`）；额度面板逐项展示（`quotaItemsView`，进度条 + 已用/剩余/重置时间）。
- 后端类型（自定义端点 / 内置服务）实时切换并即时静默注册/拉状态；「服务地址」可作为上游常量覆盖入口（`resolveBackendBaseUrl` 支持 `upstreamBaseUrl`）。
- 「版本与反馈」移到底部，两种后端模式共用。

---

## 九、启动 / 反馈页 & 文本降级

- **startup.vue**：「我的上游」统一改名为「内置服务」；emoji 图标替换为纯文本（⏳→…、⚠️→!、❌→×、✓→√）规避设备字体白块。
- **feedback.vue**：新增键盘回传 `onNewOptions`；`openTextEditor` 传 `callerPage`。
- **index.vue**：横幅/通知文案移除 emoji，统一走 `plain()`（emoji 文字降级）。

---

## 十、后端模式默认不锁定 & 设备令牌归属

- **store.js**：`LOCK_TO_UPSTREAM = false`（旧为 `true`），两种后端类型默认都可在设置页切换；`resolveBackendBaseUrl` 支持 `upstreamBaseUrl` 覆盖常量。
- **api-auth.js**：新增 `urlHost` / `isSameHost`（仅比较主机名，忽略协议/端口/路径）。
- **store.js / settings.vue**：新增 `pairBaseUrl` 字段，记录令牌签发地址；切换端点后旧令牌停用，避免「拿 A 服务的令牌请求 B 服务」导致 401 被误报成「令牌过期」；`pairAuthFromForm` 据此校验归属。

---

## 十一、测试 & 工具

- **新增 `test-thinking-levels.mjs`**（29 个用例）：覆盖挡位表匹配、遗留值折算、循环切换（纳入 `test` 脚本）。
- **test-markdown.mjs**：emoji 分段用例迁到 `emoji-subst.js`（与实现解耦）。
- **新增 `tools/admin_ui_check.py`**：无头 Chrome + CDP 自动检查管理后台（真实登录、逐页点击、收集 JS 异常/控制台错误、截图）。
- **新增 `tools/pen-remote.py`**：SSH/SCP 远程运维小工具（server / pen 通道）。

---

## 十二、新增独立服务端项目 `penai-upstream/`（未跟踪）

独立 Node 网关（v1.7.0，`type: module`），与 App 配套的发布/管理后台：

- `server.js` + `src/` 共 22 个模块：`admin`、`admin-auth`、`auth`、`control`、`device-control`、`quota-config`、`provider(-config)`、`sessions`、`files`、`telemetry`、`tools(-config)`、`debug-queue`、`releases`、`amr`、`guard`、`http`、`store`、`config`、`feedback`。
- 职责：设备配对鉴权（短期令牌 + 每请求 HMAC 签名）、OpenAI 兼容转发（验签/限速/防反代）、管理后台（配对码批准、封禁/吊销、审计统计）、云控 v4、配额、遥测、会话备份、联网搜索工具后端、更新包发布。

---

## ⚠️ 注意事项 / 待确认

1. **`tools/pen-remote.py` 含明文 SSH 凭据**（服务器 `103.212.186.198`、词典笔 `192.168.1.192` 的 root 密码）。文件注释称「不入库到公开仓库」，但当前为未跟踪状态，提交前务必确认已加入 `.gitignore` 或移除凭据，避免泄露。
2. **`penai-upstream/` 为全新未跟踪目录**（独立项目）。需确认是否要纳入本仓库（建议独立仓库或子模块），否则会让 Deepseek App 仓库体积与关注点膨胀。
3. **`ds-free-api/` 与 `ds-free-api-aarch64`** 含大量编译产物（`.d`/`.rmeta`/`.rlib`/`.pdb`），如未忽略应检查 `.gitignore`，避免误提交。
4. 本次改动**尚未提交**（领先 `origin/main` 3 个 commit，且工作区还有未暂存改动）。建议按模块分组提交，并先处理第 1、2 条安全/结构问题。
