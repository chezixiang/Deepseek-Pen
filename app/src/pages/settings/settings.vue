<template>
    <div :class="isDark ? 'page page-dark' : 'page'">
        <div :class="dc('topbar')">
            <text :class="dc('icon-btn')" @click="back">返回</text>
            <text :class="dc('title')">设置</text>
            <text v-if="canEditSettings" :class="dc('icon-btn')" @click="save">保存</text>
            <text v-else :class="dc('icon-btn') + ' icon-btn-disabled'">只读</text>
        </div>

        <scroller class="body" scroll-direction="vertical">
            <!-- 横屏宽度接近 960px：字段两列排布，避免每行只放一个短控件、
                 把页面拉成很长的单列。长文本（提示、通知、版本等）仍占整行。 -->
            <div class="settings-stack">
            <div v-if="settingsLocked" :class="isDark ? 'notice notice-dark' : 'notice'">
                <text :class="isDark ? 'notice-title notice-title-dark' : 'notice-title'">设置已锁定</text>
                <text :class="isDark ? 'notice-text notice-text-dark' : 'notice-text'">服务提供方关闭了设置修改，本页仅可查看；如需调整请联系服务提供者。</text>
            </div>
            <!-- 后端类型：非锁定构建下两种模式随时互切；锁定构建（LOCK_TO_UPSTREAM）
                 整段隐藏，只保留下方那套静默上游面板 -->
            <template v-if="!upstreamLocked">
                <text :class="dc('group-title')">后端</text>
                <text v-if="backendError" :class="dc('backend-error')">{{ backendError }}</text>
                <div :class="dc('field')">
                    <text :class="dc('label')">后端类型</text>
                    <div class="modes">
                        <text :class="form.backendMode === 'custom' ? dc('chip-active') : dc('chip')" @click="setBackendMode('custom')">自定义端点</text>
                        <text :class="form.backendMode === 'upstream' ? dc('chip-active') : dc('chip')" @click="setBackendMode('upstream')">内置服务</text>
                    </div>
                    <text :class="dc('field-hint')">{{ form.backendMode === 'upstream' ? '接入内置服务：地址预置、设备自动注册，不需要 API Key 或配对码' : '直连任意 OpenAI 兼容 API：填写服务地址与 API Key；设备配对是可选加固' }}</text>
                </div>
            </template>

            <!-- 上游模式：服务状态 / 额度 / 设备 / 版本与反馈 -->
            <template v-if="upstreamMode">
                <text :class="dc('group-title')">服务</text>
                <div class="grid-row">
                    <div :class="dc('field') + ' field-grid'">
                        <text :class="dc('label')">内置服务</text>
                        <div :class="dc('acct-row')">
                            <text :class="dc('acct-name')">{{ upstreamStateText }}</text>
                            <text :class="upstreamReady ? dc('acct-ok') : dc('acct-bad')">{{ upstreamReady ? '已连接' : '未连接' }}</text>
                        </div>
                        <text :class="dc('field-hint')">{{ upstreamHint }}</text>
                    </div>
                    <div :class="dc('field') + ' field-grid'">
                        <text :class="dc('label')">设备</text>
                        <text :class="dc('field-hint')">{{ deviceLine }}</text>
                        <div class="modes model-actions">
                            <text :class="dc('nav-btn-sm')" @click="checkUpstream">{{ upstreamChecking ? '查询中…' : '刷新状态' }}</text>
                            <text :class="dc('nav-btn-sm')" @click="restoreFromCloud">{{ restoring ? '恢复中…' : '从云端恢复会话' }}</text>
                        </div>
                    </div>
                </div>
                <text v-if="upstreamMsg" :class="upstreamMsgErr ? dc('field-hint-warn') : dc('field-hint')">{{ upstreamMsg }}</text>

                <!-- 额度：每次进入设置页都强制刷新一次；逐项展示上游全部限制 -->
                <div :class="dc('field')">
                    <div class="quota-head">
                        <text :class="dc('label')">剩余额度</text>
                        <text :class="quotaRefreshing ? 'quota-refresh quota-refresh-busy' : 'quota-refresh'" @click="refreshQuota">{{ quotaRefreshing ? '刷新中…' : '立即刷新' }}</text>
                    </div>
                    <div v-if="quotaItemsView.length" class="quota-grid">
                        <div v-for="it in quotaItemsView" :key="it.key" class="quota-cell" :class="isDark ? 'quota-cell-dark' : ''">
                            <div class="quota-cell-head">
                                <text class="quota-cell-label" :class="isDark ? 'quota-label-dark' : ''">{{ it.label }}</text>
                                <text class="quota-cell-pct" :class="it.pctClass">{{ it.limit > 0 ? it.pct + '%' : '不限' }}</text>
                            </div>
                            <text class="quota-cell-value" :class="isDark ? 'quota-value-dark' : 'quota-value'">{{ it.valueText }}</text>
                            <div class="quota-bar" :class="isDark ? 'quota-bar-dark' : ''"><div class="quota-bar-fill" :class="it.barClass" :style="{ width: it.barWidth }"></div></div>
                            <text class="quota-cell-foot" :class="isDark ? 'quota-foot-dark' : 'quota-foot'">{{ it.footText }}</text>
                        </div>
                    </div>
                    <text v-else :class="dc('field-hint')">正在读取额度…</text>
                    <text :class="dc('field-hint')">{{ plain(quotaSubLine) }}</text>
                </div>

            </template>

            <!-- 自定义端点 / 内置账号模式 -->
            <template v-else>
                <div v-if="!builtinEnabled && !endpointReady" :class="isDark ? 'notice notice-dark' : 'notice'">
                    <text :class="isDark ? 'notice-title notice-title-dark' : 'notice-title'">请先完成后端配置</text>
                    <text :class="isDark ? 'notice-text notice-text-dark' : 'notice-text'">「自定义端点」需要服务地址 + API Key。</text>
                    <text v-if="form.dsUser" :class="isDark ? 'notice-text notice-text-dark' : 'notice-text'">原 DeepSeek 账号 {{ maskedDsUser }} 已保留，恢复账号模式后可继续使用。</text>
                </div>

                <div v-if="builtinEnabled" :class="dc('field')">
                    <div class="modes">
                        <text :class="form.authMode === 'builtin' ? dc('chip-active') : dc('chip')" @click="setAuthMode('builtin')">内置 ds-free-api</text>
                        <text :class="form.authMode === 'openai' ? dc('chip-active') : dc('chip')" @click="setAuthMode('openai')">OpenAI 兼容端点</text>
                    </div>
                </div>

                <!-- 内置 ds-free-api：账号由专用登录页管理（本页只显示状态 + 入口） -->
                <template v-if="builtinEnabled && form.authMode === 'builtin'">
                    <div :class="dc('field')">
                        <text :class="dc('label')">DeepSeek 账号</text>
                        <div :class="dc('acct-row')">
                            <text :class="dc('acct-name')">{{ maskedDsUser }}</text>
                            <text :class="form.dsConfigured ? dc('acct-ok') : dc('acct-bad')">{{ form.dsConfigured ? '已登录' : '未登录' }}</text>
                        </div>
                    </div>
                    <text v-if="trouble.length" :class="dc('field-hint-warn')">注意：最近账号异常 {{ trouble.length }} 次，最早检出 {{ fmtTime(trouble[0].t) }}（{{ trouble[0].kind }}）：{{ trouble[0].message }}</text>
                    <div :class="dc('field')">
                        <text :class="dc('nav-btn')" @click="goLogin">{{ form.dsConfigured ? '管理账号 / 切换' : '去登录' }}</text>
                        <text :class="dc('field-hint')">登录、切换账号、退出登录都在登录页完成；设备凭据由后端自动生成，无需手动操作</text>
                    </div>
                </template>

                <!-- 自定义端点：服务地址 + API Key -->
                <template v-if="form.backendMode === 'custom'">
                    <div :class="dc('field')">
                        <text :class="dc('label')">服务地址</text>
                        <div :class="dc('input')" @click="editField('baseUrl')">
                            <text :class="form.baseUrl ? dc('input-text') : dc('input-text-ph')">{{ form.baseUrl || 'https://api.deepseek.com/v1' }}</text>
                        </div>
                    </div>
                    <div :class="dc('field')">
                        <text :class="dc('label')">API Key（必填）</text>
                        <div :class="dc('input')" @click="editField('apiKey')">
                            <text :class="form.apiKey ? dc('input-text') : dc('input-text-ph')">{{ form.apiKey ? maskKey(form.apiKey) : '请输入 API Key' }}</text>
                        </div>
                    </div>
                </template>

                <!-- 上游网关：地址 + 连接检查 + 设备配对 + TLS 锁定 -->
                <template v-else>
                    <div :class="dc('field')">
                        <text :class="dc('label')">服务地址</text>
                        <div :class="dc('input')" @click="editField('upstreamBaseUrl')">
                            <text :class="form.upstreamBaseUrl ? dc('input-text') : dc('input-text-ph')">{{ form.upstreamBaseUrl || buildUpstreamUrl || '请填写服务地址，如 https://api.example.com/v1' }}</text>
                        </div>
                        <text :class="dc('field-hint')">由内置服务的提供方预置（形如 https://域名/v1），通常不需要改；构建期可用 feature-flags.js 的 UPSTREAM_BASE_URL 预置，预置后此处可留空</text>
                    </div>
                    <div :class="dc('field')">
                        <text :class="dc('label')">连接检查</text>
                        <div class="modes model-actions">
                            <text :class="dc('nav-btn-sm')" @click="checkUpstream">{{ upstreamChecking ? '检查中…' : '检查连接与设备状态' }}</text>
                        </div>
                        <text v-if="upstreamMsg" :class="upstreamMsgErr ? dc('field-hint-warn') : dc('field-hint')">{{ upstreamMsg }}</text>
                        <text v-if="upstreamStatus" :class="dc('field-hint')">{{ upstreamStatus }}</text>
                        <text v-else :class="dc('field-hint')">先保存地址并完成配对，再检查；会读取 /health（连通性）与 /v1/me（设备状态、今日用量）</text>
                    </div>
                    <div :class="dc('field')">
                        <text :class="dc('label')">设备配对（{{ form.backendMode === 'upstream' ? '必需' : '可选，防搬运' }}）</text>
                        <text :class="isPaired ? dc('acct-ok') : dc('acct-bad')">{{ pairStateText }}</text>
                        <div class="modes model-actions">
                            <text :class="dc('nav-btn-sm')" @click="startPairing">{{ isPaired ? '重新配对' : '开始配对' }}</text>
                            <text v-if="isPaired" :class="dc('nav-btn-sm')" @click="refreshToken">{{ pairing.busy ? '处理中…' : '刷新令牌' }}</text>
                            <text v-if="isPaired" :class="dc('nav-btn-sm')" @click="unpair">解除配对</text>
                        </div>
                        <text :class="dc('field-hint')">配对流程：点「开始配对」→ 在服务端管理后台输入设备标识与配对码并批准 → 回本页点「继续」。{{ form.backendMode === 'upstream' ? '内置服务未配对时无法发送消息。' : '未配对时按上方 API Key 直连，行为不变。' }}</text>
                        <text v-if="pairing.msg" :class="pairing.err ? dc('field-hint-warn') : dc('field-hint')">{{ pairing.msg }}</text>
                    </div>
                    <div :class="dc('field')">
                        <text :class="dc('label')">TLS 证书锁定（高级，可留空）</text>
                        <div :class="dc('input')" @click="editField('pairTlsPin')">
                            <text :class="form.pairTlsPin ? dc('input-text') : dc('input-text-ph')">{{ form.pairTlsPin || 'sha256//Base64(SPKI)，留空不启用' }}</text>
                        </div>
                        <text :class="dc('field-hint')">锁定服务端证书公钥后，中间人即使持有受信 CA 也无法抓包改包（配对模式的流式请求生效）</text>
                    </div>
                </template>
            </template>

            <!-- 模型 ID / 模型列表：两种后端模式共用（上游模式的模型由网关注入，
                 但允许用户覆盖；拉取走 /v1/models，认证由模式决定）。
                 锁定构建或云控关闭「模型切换」时整段隐藏。 -->
            <template v-if="!upstreamLocked && canPickModel">
                <div :class="dc('field')">
                    <text :class="dc('label')">模型 ID</text>
                    <div :class="dc('input')" @click="editField('openaiModelId')">
                        <text :class="form.openaiModelId ? dc('input-text') : dc('input-text-ph')">{{ form.openaiModelId || (form.backendMode === 'upstream' ? '留空使用服务默认模型' : '留空自动选择（官方 API 用 deepseek-chat）') }}</text>
                    </div>
                    <div class="modes model-actions">
                        <text :class="dc('nav-btn-sm')" @click="fetchModels">{{ modelFetching ? '拉取中…' : '从 API 拉取模型' }}</text>
                        <text :class="dc('nav-btn-sm')" @click="editField('openaiModelId')">手动输入</text>
                    </div>
                    <text v-if="modelMsg" :class="modelMsgErr ? dc('field-hint-warn') : dc('field-hint')">{{ modelMsg }}</text>
                    <text v-else :class="dc('field-hint')">「从 API 拉取模型」读取端点声明的模型列表（GET /v1/models），点选即填入。{{ form.backendMode === 'upstream' ? '内置服务只返回后台「模型」页配置的目录，不会实时请求上游；后台未配置的模型会提示不支持' : '官方 API 可用 deepseek-chat / deepseek-reasoner，留空则自动选择' }}</text>
                </div>
                <div v-if="modelList.length" :class="dc('model-list')">
                    <div
                        v-for="m in modelList"
                        :key="m.id"
                        :class="form.openaiModelId === m.id ? dc('model-item-active') : dc('model-item')"
                        @click="pickModel(m.id)">
                        <text :class="form.openaiModelId === m.id ? dc('model-id-active') : dc('model-id')">{{ m.id }}</text>
                        <text v-if="m.ownedBy" :class="dc('model-owner')">{{ m.ownedBy }}</text>
                    </div>
                    <text v-if="modelTruncated" :class="dc('field-hint')">（仅显示前 {{ MODEL_LIST_MAX }} 个）</text>
                </div>
            </template>

            <text :class="dc('group-title')">默认选项</text>
            <!-- 官方已把快速/专家/识图合并为单一模型，只有多个模式时才显示选择器 -->
            <div class="grid-row">
                <div :class="dc('field') + ' field-grid'" v-if="visibleModes.length > 1">
                    <text :class="dc('label')">默认模型</text>
                    <div class="modes">
                        <text
                            v-for="m in visibleModes"
                            :key="m.key"
                            :class="form.defaultMode === m.key ? dc('chip-active') : dc('chip')"
                            @click="setDefaultMode(m.key)">{{ m.label }}</text>
                    </div>
                </div>
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">新对话默认开关</text>
                    <!-- 三项合并成一行：横屏只有 290px 高，独立三行会把下面的区块挤出屏幕 -->
                    <div class="opt-row">
                        <text :class="form.defaultThinking ? dc('chip-sm-active') : dc('chip-sm')" @click="toggleDefault('defaultThinking')">深度思考 {{ form.defaultThinking ? '开' : '关' }}</text>
                        <text :class="form.defaultSearch ? dc('chip-sm-active') : dc('chip-sm')" @click="toggleDefault('defaultSearch')">联网搜索 {{ form.defaultSearch ? '开' : '关' }}</text>
                        <text :class="form.defaultExpandThinking ? dc('chip-sm-active') : dc('chip-sm')" @click="toggleDefault('defaultExpandThinking')">思考过程 {{ form.defaultExpandThinking ? '展开' : '收起' }}</text>
                    </div>
                </div>
            </div>
            <text :class="dc('field-hint')">流式输出（SSE）已固定开启，逐字显示回复，不再提供开关</text>

            <text :class="dc('group-title')">外观与输入</text>
            <div class="grid-row">
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">深色模式</text>
                    <div class="modes">
                        <text :class="themeChipClass('light')" @click="setTheme('light')">浅色</text>
                        <text :class="themeChipClass('dark')" @click="setTheme('dark')">深色</text>
                    </div>
                </div>
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">输入键盘</text>
                    <div class="modes">
                        <text :class="form.keyboardMode === 'calculator' ? dc('chip') : dc('chip-active')" @click="setKeyboardMode('system')">系统键盘</text>
                        <text v-if="loliKbSupported" :class="form.keyboardMode === 'calculator' ? dc('chip-active') : dc('chip')" @click="setKeyboardMode('calculator')">Loli 键盘</text>
                    </div>
                    <text :class="dc('field-hint')">{{ loliKbSupported ? (form.keyboardMode === 'calculator' ? '使用 Loli 键盘（Rime 全键盘，含拼音候选）' : '使用设备自带输入法，兼容性最好') : '使用设备自带输入法；Loli 键盘需内置 Rime 引擎，当前固件跨应用调用无法回传文本' }}</text>
                </div>
            </div>

            <text :class="dc('group-title')">提示词</text>
            <div :class="dc('field')">
                <text :class="dc('label')">系统提示词（可选）</text>
                <div :class="dc('input')" @click="editField('systemPrompt')">
                    <text :class="form.systemPrompt ? dc('input-text') : dc('input-text-ph')">{{ form.systemPrompt || '例如：你是一个乐于助人的助手' }}</text>
                </div>
            </div>

            <text :class="dc('group-title')">实验性（调试模式）</text>
            <div class="grid-row">
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">启用调试日志</text>
                    <text :class="form.debugLog ? dc('chip-active') : dc('chip')" @click="form.debugLog = !form.debugLog">{{ form.debugLog ? '开启' : '关闭' }}</text>
                    <text v-if="builtinEnabled" :class="dc('field-hint')">双向抓取 app→后端、后端→上游报文；切换后点「保存」生效</text>
                    <text v-else :class="dc('field-hint')">记录应用侧调试日志；切换后点「保存」生效</text>
                </div>
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">Emoji 字体（实验）</text>
                    <text :class="form.emojiFont ? dc('chip-active') : dc('chip')" @click="toggleEmojiFont">{{ form.emojiFont ? '开启' : '关闭' }}</text>
                    <text :class="dc('field-hint')">设备不支持字体注册时自动用文字替换 Emoji（约下载 10MB）</text>
                    <text v-if="emojiFontMsg" :class="dc('field-hint')">{{ emojiFontMsg }}</text>
                </div>
            </div>
            <div class="grid-row" v-if="form.debugMode">
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">竖屏交互（旋转 90°）</text>
                    <text :class="form.portrait ? dc('chip-active') : dc('chip')" @click="form.portrait = !form.portrait">{{ form.portrait ? '开启' : '关闭' }}</text>
                </div>
                <div :class="dc('field') + ' field-grid'">
                    <text :class="dc('label')">出站代理（Socks5/HTTP）</text>
                    <div :class="dc('input')" @click="editProxy">
                        <text :class="proxyUrl ? dc('input-text') : dc('input-text-ph')">{{ proxyUrl || '未设置' }}</text>
                    </div>
                    <text :class="dc('field-hint')">后端访问上游走此代理；保存后自动重启后端</text>
                    <text v-if="proxyMsg" :class="dc('field-hint')">{{ proxyMsg }}</text>
                </div>
            </div>

            <text :class="dc('danger')" @click="resetData">清空全部对话数据</text>

            <!-- 版本与反馈固定在设置页底部：两种后端模式都能看到，
                 不再只出现在「内置服务」面板里。 -->
            <text :class="dc('group-title')">版本与反馈</text>
            <div :class="dc('field') + ' field-wide'">
                <text :class="dc('label')">Deepseek · 词典笔版 {{ appVersion }}</text>
                <text :class="dc('field-hint')">{{ serverVersion ? '服务端 ' + serverVersion : (form.backendMode === 'upstream' ? '服务端版本在连接内置服务后显示' : '自定义端点模式') }}</text>
                <div class="modes model-actions">
                    <text v-if="canCheckUpdate" :class="dc('nav-btn-sm')" @click="checkUpdate">{{ updateChecking ? '检查中…' : '检查更新' }}</text>
                    <text v-if="canFeedback" :class="dc('nav-btn-sm')" @click="goFeedback">意见反馈</text>
                </div>
                <text v-if="updateMsg" :class="dc('field-hint')">{{ plain(updateMsg) }}</text>
            </div>

            <text :class="dc('about')" @click="onVersionTap">Deepseek · 词典笔版</text>
            <text v-if="form.debugMode" :class="dc('debug-badge')" @click="disableDebug">调试模式已开启（点击关闭）</text>
            <text :class="dc('about-sub')">{{ form.backendMode === 'upstream' ? '服务：内置服务（OpenAI 兼容）' : '服务：自定义 OpenAI 兼容端点（传输由设备 curl/http 承担）' }}</text>
            <text :class="dc('log-link')" @click="showLogModal = true">查看诊断日志</text>
            <text v-if="saveMsg && !showSaveModal" :class="saved ? dc('save-msg-ok') : dc('save-msg')">{{ saveMsg }}</text>
            </div>
        </scroller>

        <!-- 诊断日志弹窗（#6/#11 重构）：
             旧版用 max-height:400px 的内联样式（Weex 不支持 max-height），面板比
             横屏屏幕（280px 高）还高，导致内容溢出屏幕无法观看。
             新版固定适配横屏的面板高度：应用/后端双日志源 + 行数切换 + 刷新/清空。 -->
        <div v-if="showLogModal" class="log-mask">
            <div :class="dc('log-panel')">
                <div :class="dc('log-head')">
                    <text :class="dc('log-title')">诊断日志</text>
                    <text :class="dc('icon-btn')" @click="showLogModal = false">关闭</text>
                </div>
                <div class="log-tabs">
                    <text :class="logSource === 'app' ? dc('log-tab-active') : dc('log-tab')" @click="switchLogSource('app')">应用日志</text>
                    <text :class="logSource === 'backend' ? dc('log-tab-active') : dc('log-tab')" @click="switchLogSource('backend')">后端日志</text>
                    <text :class="logSource === 'capture' ? dc('log-tab-active') : dc('log-tab')" @click="switchLogSource('capture')">网络抓取</text>
                    <text :class="logLines === 80 ? dc('log-tab-active') : dc('log-tab')" @click="setLogLines(80)">80行</text>
                    <text :class="logLines === 200 ? dc('log-tab-active') : dc('log-tab')" @click="setLogLines(200)">200行</text>
                    <text :class="logLines === 500 ? dc('log-tab-active') : dc('log-tab')" @click="setLogLines(500)">500行</text>
                    <text :class="logGen === 1 ? dc('log-tab-active') : dc('log-tab')" @click="setLogGen(1)">上一份</text>
                    <text :class="logGen === 0 ? dc('log-tab-active') : dc('log-tab')" @click="setLogGen(0)">当前</text>
                </div>
                <scroller :class="dc('log-body')" scroll-direction="vertical">
                    <text :class="dc('log-text')">{{ logContent || (logSource === 'capture' ? '暂无抓取（在「启用调试日志」开启并保存后产生）' : '暂无日志') }}</text>
                </scroller>
                <div class="log-foot">
                    <text :class="dc('log-btn')" @click="refreshLog">刷新</text>
                    <text :class="dc('log-btn-danger')" @click="clearLog">清空当前日志</text>
                </div>
            </div>
        </div>

        <!-- 服务通知：noticeId 变化才弹（与首页共用已读状态） -->
        <div v-if="noticeModal && noticeInfo" :class="dc('save-mask')">
            <div :class="dc('save-modal-box')">
                <text :class="dc('save-modal-title')">服务通知</text>
                <text :class="dc('save-modal-msg')">{{ plain(noticeInfo.text) }}</text>
                <text :class="dc('save-modal-btn')" @click="dismissNotice">知道了</text>
            </div>
        </div>

        <!-- 保存结果提示：显眼的浮层，用户确认后再返回 -->
        <div v-if="showSaveModal" :class="dc('save-mask')">
            <div :class="dc('save-modal-box')">
                <text :class="saved ? dc('save-modal-title') : dc('save-modal-title-error')">{{ saved ? '已保存' : '保存失败' }}</text>
                <text :class="dc('save-modal-msg')">{{ saveMsg }}</text>
                <text :class="dc('save-modal-btn')" @click="closeSaveModal">好的</text>
            </div>
        </div>

        <!-- 设备配对向导：点「开始配对」后弹出，服务端批准后点「继续」完成 -->
        <div v-if="showPairModal" :class="dc('save-mask')" @click="cancelPairing">
            <div :class="dc('save-modal-box')" @click="noop">
                <text :class="dc('save-modal-title')">设备配对</text>
                <text :class="dc('save-modal-msg')">1. 打开你的 API 服务管理后台</text>
                <text :class="dc('save-modal-msg')">2. 输入设备标识：{{ pairing.deviceId }}</text>
                <text :class="dc('save-modal-msg')">3. 输入配对码并批准：{{ pairing.code }}</text>
                <text :class="dc('save-modal-msg')">4. 回到本页点「继续」</text>
                <text v-if="pairing.msg" :class="pairing.err ? dc('field-hint-warn') : dc('field-hint')">{{ pairing.msg }}</text>
                <div class="modes model-actions">
                    <text :class="dc('save-modal-btn')" @click="confirmPairing">{{ pairing.busy ? '处理中…' : '继续' }}</text>
                    <text :class="dc('save-modal-btn')" @click="cancelPairing">取消</text>
                </div>
            </div>
        </div>
    </div>
</template>

<script>

import { peekBootTheme } from '../../services/theme.js'
import { MODES, listRemoteModels } from '../../services/ds.js'
import { ensureEmojiFont } from '../../services/emoji-font.js'
import { pullMissing, syncPurgeAll } from '../../services/session-sync.js'
import { LOLI_KEYBOARD_CROSS_APP, APP_VERSION, BUILD_NUM, BUILTIN_AUTH_ENABLED, DEFAULT_SETTINGS, UPSTREAM_BASE_URL, LOCK_TO_UPSTREAM, appLog, appLogError, debugLog, isUpstreamMode, resolveBackendBaseUrl, loadSettings, loadAccountTrouble, loadControlCache, readLocalDsPass, readDsFreeApiProxy, deployBackend, saveSettings, INPUT_TYPES, openTextEditor, notifyKeyboardResult, appLogTail, readNetCaptureTail, backendLogTail, appLogClear, netCaptureClear, backendLogClear, validateProxyUrl, updateDsFreeApiProxy, saveControlCache, loadConversations, saveMessages, saveConversations, updateDsFreeApiAccount, updateDsFreeApiNetCapture, deleteMessages, saveActiveId } from '../../services/store.js'
import { maskDeviceId, generatePairingCode, isSameHost } from '../../services/api-auth.js'
import { pairDevice, refreshDeviceToken, revokeDeviceToken } from '../../services/api-pairing.js'
import { validateExternalUrl } from '../../services/http.js'
import { quotaText, quotaLow, normalizeControl, normalizeQuota, ensureUpstreamAuth, getLastAuthError, upstreamBase, fetchDeviceStatus, fetchControl, updateGate, fmtReset, fmtAmount, controlFeature, controlLimit, reportTelemetry, noticeFor, debugGate, stableDeviceId, rememberDeviceId } from '../../services/cloud-control.js'
import { startRemoteDebug, stopRemoteDebug } from '../../services/remote-debug.js'
import { substituteEmoji } from '../../services/emoji-subst.js'

const MODEL_LIST_MAX = 50

export default {
    name: 'settings',
    data() {
        return {
            MODES,
            appVersion: APP_VERSION,
            // 账号登录模式是否可用（false 时隐藏内置后端相关 UI，代码保留）
            builtinEnabled: BUILTIN_AUTH_ENABLED,
            form: Object.assign({}, DEFAULT_SETTINGS, { theme: peekBootTheme() }),
            saved: false,
            saving: false,
            saveMsg: '',
            showSaveModal: false,
            backendError: '',
            backendDeploying: false,
            showLogModal: false,
            logContent: '',
            logSource: 'app', // app | backend
            logLines: 80,
            logGen: 0, // 0=当前 1=上一份（轮转保留）
            emojiFontMsg: '',
            proxyUrl: '',
            proxyMsg: '',
            // 定义在 data 之外也可用：模板需要常量参与渲染（列表封顶提示）
            MODEL_LIST_MAX,
            // 自定义端点：从 /v1/models 拉取到的声明模型（bug 6）
            modelList: [],
            modelTruncated: false,
            modelFetching: false,
            modelMsg: '',
            modelMsgErr: false,
            trouble: [],
            // 设备配对（防搬运）：弹窗与状态
            showPairModal: false,
            pairing: { deviceId: '', code: '', busy: false, msg: '', err: false },
            // 上游模式：构建期预置地址 + 连接/设备状态检查
            buildUpstreamUrl: UPSTREAM_BASE_URL,
            upstreamLocked: LOCK_TO_UPSTREAM,
            upstreamChecking: false,
            upstreamMsg: '',
            upstreamMsgErr: false,
            upstreamStatus: '',
            // 静默注册后的设备状态 / 配额 / 云控（全部只读）
            upstreamChecked: false,
            upstreamOk: false,
            // 额度面板：每次进入设置页都会强制刷新一次
            quota: null,
            quotaRefreshing: false,
            lastQuotaAt: 0,
            telemetryReporting: false,
            control: null,
            // 服务通知（弹窗）
            noticeInfo: null,
            noticeModal: false,
            serverVersion: '',
            restoring: false,
            updateChecking: false,
            updateMsg: ''
        }
    },
    created() {
        // 从主页/其它页面回到设置时也要刷新额度：create 只跑一次，
        // 页面实例可能被复用，必须靠框架的 show 事件。
        try { this.$page.on('show', this.onPageShow); } catch (e) { /* 忽略 */ }
        this.init();
    },
    destroyed() {
        try { this.$page.off('show', this.onPageShow); } catch (e) { /* 忽略 */ }
    },
    watch: {
        showLogModal(v) {
            if (v) {
                this.loadLogContent();
            }
        }
    },
    computed: {
        loliKbSupported() {
            return !!LOLI_KEYBOARD_CROSS_APP
        },
        isDark() {
            // 词典笔无系统深色，只有手动开关：'dark' 深色，其余浅色
            return (this.form && this.form.theme) === 'dark'
        },
        visibleModes() {
            // 模型已合并，MODES 只剩一项；保留该 computed 以兼容多模式重新上线的情况
            return MODES
        },
        // 账号在设置页只做展示，按邮箱/手机号各自掩码（避免整串明文暴露在设置页）
        maskedDsUser() {
            const v = String((this.form && this.form.dsUser) || '');
            if (!v) return '未登录'
            const at = v.indexOf('@');
            if (at > 0) return v.slice(0, 2) + '***' + v.slice(at)
            if (v.length >= 7) return v.slice(0, 3) + '****' + v.slice(-4)
            return v
        },
        // 设备配对是否已生效（三要件齐全，与 api-auth.js isPaired 同口径）
        isPaired() {
            return !!(this.form && this.form.pairDeviceId && this.form.pairToken && this.form.pairSecret)
        },
        // 当前是否「我的上游」模式（锁定构建恒为 true）
        upstreamMode() {
            return isUpstreamMode(this.form && this.form.backendMode)
        },
        // 上游是否可用：以最近一次查询结果为准（没查过时按"连接中"展示，避免误报已连接）
        upstreamReady() {
            return this.upstreamChecked ? this.upstreamOk : false
        },
        upstreamStateText() {
            if (this.upstreamChecking || !this.upstreamChecked) return '正在连接…'
            if (!this.isPaired) return '正在自动注册设备…'
            return '设备 ' + (maskDeviceId(this.form.pairDeviceId) || '—')
        },
        upstreamHint() {
            if (this.upstreamLocked) {
                return '服务地址已内置，设备首次联网自动注册；无需填写地址、密钥或配对码。'
            }
            return '设备凭证由服务端自动下发；如需更换服务，可在上方「后端类型」中切回自定义端点。'
        },
        // 额度统一归一化：服务端 items → 固定 6 项，缺字段也不会渲染崩
        quotaView() {
            return normalizeQuota(this.quota || (this.form && this.form.quotaCache))
        },
        quotaLine() {
            return quotaText(this.quotaView)
        },
        // 设置页逐项展示：剩余量 + 已用 + 重置时间，覆盖上游全部限制项
        quotaItemsView() {
            const q = this.quotaView;
            if (!q) return []
            return q.items.map((it) => {
                const unlimited = !(it.limit > 0);
                const pct = unlimited ? 0 : Math.min(100, Math.round(it.used / it.limit * 100));
                const valueText = unlimited ? '不限' : ('剩余 ' + fmtAmount(it.remaining, it.unit));
                let footText = '未设置上限';
                if (!unlimited) {
                    if (it.window === 'live') footText = '进行中 ' + it.used + ' / ' + it.limit + ' 个请求';
                    else footText = '已用 ' + fmtAmount(it.used, it.unit) + ' · ' + (fmtReset(it.resetAt) || '随窗口重置');
                }
                return {
                    key: it.key,
                    label: it.label,
                    limit: it.limit,
                    used: it.used,
                    pct,
                    valueText,
                    footText,
                    pctClass: unlimited ? 'quota-pct-free' : (pct >= 100 ? 'quota-pct-bad' : (pct >= 90 ? 'quota-pct-warn' : 'quota-pct-ok')),
                    barClass: unlimited ? 'quota-bar-free' : (pct >= 100 ? 'quota-bar-bad' : (pct >= 90 ? 'quota-bar-warn' : 'quota-bar-ok')),
                    barWidth: (unlimited ? 100 : Math.max(3, pct)) + '%'
                };
            })
        },
        quotaSubLine() {
            const q = this.quotaView;
            if (!q) return '额度由服务端按设备下发';
            if (!q.enabled) return '当前服务未设置额度上限';
            const parts = [];
            if (this.control && this.control.quotaHint) parts.push(this.control.quotaHint);
            if (q.override) parts.push('本设备有单独额度');
            if (q.exhausted) {
                const hit = q.items.filter((i) => i.key === q.blockedBy)[0];
                parts.push((hit ? hit.label : '额度') + '已用完');
            }
            if (this.lastQuotaAt) parts.push('更新于 ' + this.fmtTime(this.lastQuotaAt));
            return parts.join(' · ') || '额度由服务端按设备下发'
        },
        quotaWarn() {
            return quotaLow(this.quotaView)
        },
        // 云控：服务端可关闭设置修改 / 模型切换
        settingsLocked() {
            return !!(this.upstreamMode && this.control && !controlFeature(this.control, 'settingsEdit'))
        },
        canEditSettings() {
            return !this.settingsLocked
        },
        canPickModel() {
            return !(this.control && !controlFeature(this.control, 'modelPicker'))
        },
        canFeedback() {
            return !(this.control && !controlFeature(this.control, 'feedback'))
        },
        // 更新提示开关只隐藏入口；强制更新由 updateGate 单独判定
        canCheckUpdate() {
            return !(this.control && !controlFeature(this.control, 'updates'))
        },
        canUseCloudSessions() {
            return !(this.control && !controlFeature(this.control, 'sessions'))
        },
        deviceLine() {
            const id = maskDeviceId(this.form.pairDeviceId) || '自动生成中';
            const exp = Number(this.form.pairExpiresAt) || 0;
            const token = !this.isPaired ? '待注册' : (exp ? '有效至 ' + this.fmtTime(exp) : '长期有效');
            return '设备标识 ' + id + ' · 设备令牌 ' + token
        },
        // 当前实际请求根地址：上游模式用 upstreamBaseUrl/构建期常量，自定义模式用 baseUrl
        effectiveBaseUrl() {
            if (!this.form) return ''
            return resolveBackendBaseUrl({
                backendMode: this.form.backendMode,
                baseUrl: this.form.baseUrl,
                upstreamBaseUrl: this.form.upstreamBaseUrl,
                defaultBaseUrl: 'https://api.deepseek.com/v1'
            })
        },
        // 是否已满足当前模式的最小可用条件（保存校验与顶部提示共用）
        endpointReady() {
            if (!this.form) return false
            if (isUpstreamMode(this.form.backendMode)) return !!(this.effectiveBaseUrl && this.isPaired)
            return !!String(this.form.apiKey || '').trim() || this.isPaired
        },
        pairStateText() {
            if (!this.isPaired) {
                return isUpstreamMode(this.form && this.form.backendMode)
                    ? '未注册（首次联网会自动注册）'
                    : '未配对（当前按 API Key 直连）'
            }
            const exp = Number(this.form.pairExpiresAt) || 0;
            const id = maskDeviceId(this.form.pairDeviceId);
            if (!exp) return '已配对 ' + id + '（令牌长期有效）'
            if (exp - Date.now() <= 0) return '已配对 ' + id + '（令牌已过期，请点「刷新令牌」）'
            return '已配对 ' + id + '（令牌到期 ' + this.fmtTime(exp) + '）'
        }
    },
    methods: {
        // Loli 键盘通过 kbCaller 回到本页，onNewOptions 是官方回传通道
        onNewOptions(options) {
            if (notifyKeyboardResult(options)) this.$forceUpdate()
        },
        // 把当前主题缓存到 $falcon 全局（与 index.vue 约定一致，#7）
        cacheTheme() {
            try { $falcon.__dsTheme = (this.form && this.form.theme) || 'light'; } catch (e) { /* 忽略 */ }
        },
        async init() {
            try {
                this.form = await loadSettings();
            } catch (e) {
                appLogError('settings.load', e);
                this.form = Object.assign({}, DEFAULT_SETTINGS);
            }
            // 启动页因「端点未配置」引导进来时，返回应去主页而不是回到启动页（避免死路）
            try {
                this._fromSetup = !!$falcon.__dsNeedsEndpointSetup;
                $falcon.__dsNeedsEndpointSetup = false;
            } catch (e) {
                this._fromSetup = false;
            }
            this.cacheTheme();
            // 记录调试日志开关的进入时值：保存时与它比较，变了才同步后端
            // net_capture 并重启（避免每次保存都白重启一次后端）
            this._debugLogAtLoad = !!this.form.debugLog;
            // 账号异常取证（首次检出时间）
            this.trouble = await loadAccountTrouble();
            // 云控缓存先上屏（离线也能看到上次通知/说明），随后静默刷新
            try {
                this.control = normalizeControl(await loadControlCache());
                this.applyControlUi(this.control);
            } catch (e) { debugLog('[settings] 读取云控缓存失败：' + (e && e.message ? e.message : String(e))) }
            // 上游模式：后台静默注册/续期 + 拉配额与云控，不阻塞页面渲染
            if (this.upstreamMode) {
                this.bootstrapUpstream();
            }
            // 读取本机已配置密码的掩码预览，避免“已配置”时密码栏空白
            // （账号登录模式暂停期间不读 config.toml：后端不运行，读到的是过期状态）
            if (this.builtinEnabled) {
              const pass = await readLocalDsPass();
              this.form.dsPassPreview = pass ? this.maskKey(pass) : '';
            }
            // 后台部署后端（不阻塞页面渲染，避免"保存键按不下去"）
            this.backendError = '';
            if (this.builtinEnabled && this.form.authMode === 'builtin') {
              // 读取本机后端当前代理配置（调试模式的出站代理）
              readDsFreeApiProxy()
                .then((u) => {
                  this.proxyUrl = u || '';
                  this.$forceUpdate();
                })
                .catch(() => {});
              // Bug 修复：增加部署状态标记，保存时检查部署是否完成
              this.backendDeploying = true;
              this.$forceUpdate();
              deployBackend().then(r => {
                this.backendDeploying = false;
                if (!r.ok) {
                  this.backendError = r.message + (r.code ? ' [错误码:' + r.code + ']' : '');
                }
                this.$forceUpdate();
              }).catch(e => {
                this.backendDeploying = false;
                this.backendError = '后端部署失败：' + (e.message || e);
                this.$forceUpdate();
              });
            }
            this.$forceUpdate();
        },
        maskKey(key) {
            if (!key) return ''
            if (key.length <= 8) return '****'
            return key.slice(0, 4) + '****' + key.slice(-4)
        },
        // ---------- 设备配对（防搬运，协议见 docs/api-auth-protocol.md） ----------
        noop() { /* 弹窗内消费点击，防穿透到下层按钮（bug 2 同类问题） */ },
        // 从当前表单取配对材料；未配对返回 null
        pairAuthFromForm() {
            const f = this.form || {};
            if (!f.pairDeviceId || !f.pairToken || !f.pairSecret) return null
            // 令牌归属校验：只对当初配对的地址发设备令牌。老设置没有 pairBaseUrl
            // （字段后加），此时若自定义端点已经填了 API Key，就按"令牌不属于这里"
            // 处理——否则会把内置服务的令牌发给第三方端点，401 还会误报成令牌过期。
            const pairedAt = String(f.pairBaseUrl || '').trim();
            if (pairedAt) {
                if (!isSameHost(pairedAt, this.effectiveBaseUrl)) return null
            } else if (!isUpstreamMode(f.backendMode) && String(f.apiKey || '').trim()) {
                return null
            }
            return {
                deviceId: f.pairDeviceId,
                deviceToken: f.pairToken,
                signSecret: f.pairSecret,
                expiresAt: f.pairExpiresAt || 0,
                tlsPin: f.pairTlsPin || ''
            }
        },
        // deviceId 与静默注册共用同一个算法（硬件 SN 派生），
        // 避免手动配对生成随机 UUID、静默注册用 MAC 哈希，同一台笔出现两个 ID。
        async ensureDeviceId() {
            if (!this.form.pairDeviceId) {
                this.form.pairDeviceId = await stableDeviceId();
            }
            return this.form.pairDeviceId
        },
        async startPairing() {
            const baseUrl = this.effectiveBaseUrl;
            if (!baseUrl) {
                this.pairing.msg = '请先填写服务地址';
                this.pairing.err = true;
                this.$forceUpdate();
                return
            }
            this.pairing.deviceId = await this.ensureDeviceId();
            this.pairing.code = generatePairingCode();
            this.pairing.msg = '';
            this.pairing.err = false;
            this.showPairModal = true;
            this.$forceUpdate();
        },
        cancelPairing() {
            this.showPairModal = false;
            this.pairing.busy = false;
            this.pairing.msg = '';
            this.pairing.err = false;
            this.$forceUpdate();
        },
        // 用户已在管理后台批准配对码：换取设备令牌并写入设置
        async confirmPairing() {
            if (this.pairing.busy) return
            this.pairing.busy = true;
            this.pairing.msg = '正在换取设备令牌…';
            this.pairing.err = false;
            this.$forceUpdate();
            try {
                const r = await pairDevice({
                    baseUrl: this.effectiveBaseUrl,
                    pairingCode: this.pairing.code,
                    deviceId: this.pairing.deviceId
                });
                this.form.pairDeviceId = this.pairing.deviceId;
                this.form.pairToken = r.deviceToken;
                this.form.pairSecret = r.signSecret;
                this.form.pairExpiresAt = r.expiresAt;
                // 记下令牌归属的地址：切到别的端点时据此停用，避免拿错令牌发请求
                this.form.pairBaseUrl = this.effectiveBaseUrl;
                await saveSettings(this.form);
                this.showPairModal = false;
                this.pairing.msg = '配对成功，本机已改用设备令牌访问（记得点右上角「保存」）';
                this.pairing.err = false;
                appLog('[settings] 设备配对成功 deviceId=' + this.pairing.deviceId + ' expiresAt=' + r.expiresAt);
                // 配对得到的 ID 也写入持久化记录（重装后恢复同一身份）
                rememberDeviceId(this.form.pairDeviceId).catch(() => {});
            } catch (e) {
                this.pairing.msg = '配对失败：' + (e && e.message ? e.message : String(e));
                this.pairing.err = true;
                appLogError('pair.device', e);
            }
            this.pairing.busy = false;
            this.$forceUpdate();
        },
        async refreshToken() {
            if (this.pairing.busy) return
            const auth = this.pairAuthFromForm();
            if (!auth) {
                this.pairing.msg = '尚未配对，无需刷新';
                this.pairing.err = true;
                this.$forceUpdate();
                return
            }
            this.pairing.busy = true;
            this.pairing.msg = '正在刷新设备令牌…';
            this.pairing.err = false;
            this.$forceUpdate();
            try {
                const r = await refreshDeviceToken({ baseUrl: this.effectiveBaseUrl, auth });
                this.form.pairToken = r.deviceToken;
                if (r.signSecret) this.form.pairSecret = r.signSecret;
                this.form.pairExpiresAt = r.expiresAt;
                this.form.pairBaseUrl = this.effectiveBaseUrl;
                await saveSettings(this.form);
                this.pairing.msg = '令牌已刷新（到期 ' + (r.expiresAt ? this.fmtTime(r.expiresAt) : '长期') + '），记得点右上角「保存」';
                this.pairing.err = false;
                appLog('[settings] 设备令牌刷新成功 expiresAt=' + r.expiresAt);
            } catch (e) {
                this.pairing.msg = '刷新失败：' + (e && e.message ? e.message : String(e));
                this.pairing.err = true;
            }
            this.pairing.busy = false;
            this.$forceUpdate();
        },
        // 解除配对：先通知服务端吊销（best-effort），再清本地材料。
        // 服务端不可达时本地照常断开——令牌到期后自动失效，不会无限期可用。
        async unpair() {
            if (this.pairing.busy) return
            const auth = this.pairAuthFromForm();
            this.pairing.busy = true;
            this.pairing.msg = '正在解除配对…';
            this.pairing.err = false;
            this.$forceUpdate();
            let note = '已解除配对';
            if (auth) {
                const r = await revokeDeviceToken({ baseUrl: String(this.form.pairBaseUrl || this.effectiveBaseUrl || '').trim(), auth });
                note = r.ok
                    ? '已解除配对（服务端令牌已吊销）'
                    : '本地已解除配对；服务端吊销失败（' + (r.message || '未知原因') + '），令牌到期后自动失效';
                appLog('[settings] 解除配对 ok=' + r.ok + ' msg=' + (r.message || ''));
            }
            this.form.pairToken = '';
            this.form.pairSecret = '';
            this.form.pairExpiresAt = 0;
            this.form.pairBaseUrl = '';
            await saveSettings(this.form);
            this.pairing.msg = note + '，记得点右上角「保存」';
            this.pairing.busy = false;
            this.$forceUpdate();
        },
        dsPassDisplay() {
            if (this.form.dsPass) return this.maskKey(this.form.dsPass)
            // 本机已配置：显示掩码密码，不空白
            if (this.form.dsPassPreview) return this.form.dsPassPreview + '（点击修改）'
            if (this.form.dsConfigured) return '已配置（点击修改）'
            return '点击输入'
        },
        fmtTime(t) {
            const d = new Date(t);
            const p = (n) => (n < 10 ? '0' + n : '' + n);
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
        },
        // 千分位：设备 QuickJS 不保证有 Intl/toLocaleString，手写
        fmtNum(n) {
            let s = String(Math.round(Number(n) || 0));
            let out = '';
            let count = 0;
            for (let i = s.length - 1; i >= 0; i--) {
                out = s.charAt(i) + out;
                count++;
                if (count % 3 === 0 && i > 0) out = ',' + out;
            }
            return out
        },
        async editField(field) {
            // Bug 4：把当前值作为预填充文本带回 IME，编辑已有设置项时能看到原文。
            // 敏感字段（API Key / 密码）不回显真实值，避免在输入法中暴露秘密。
            // #2：系统提示词需要中文输入；其余字段（地址/Key/账号）保持英文键盘。
            const SENSITIVE = { apiKey: true, dsPass: true, dsPassPreview: true };
            const CHINESE = { systemPrompt: true };
            const current = SENSITIVE[field] ? '' : (this.form[field] || '');
            const inputType = CHINESE[field] ? INPUT_TYPES.ZH_CN_PREFERRED : INPUT_TYPES.EN_US_ONLY;
            const text = await openTextEditor(inputType, current, {
                keyboardMode: this.form.keyboardMode,
                callerPage: 'settings'
            });
            if (text === null) return
            this.form[field] = String(text).trim();
            this.$forceUpdate();
        },
        setKeyboardMode(mode) {
            this.form.keyboardMode = mode === 'calculator' ? 'calculator' : 'system';
            this.$forceUpdate();
        },
        setTheme(key) {
            this.form.theme = key;
            this.cacheTheme();
            this.$forceUpdate();
        },

        // ---------- 诊断日志（#6/#11） ----------
        async loadLogContent() {
            if (this.logSource === 'app') {
                this.logContent = await appLogTail(this.logLines, this.logGen);
            } else if (this.logSource === 'capture') {
                // 网络抓取是 JSONL 且文件可达 20MB：走 shell tail（native.js），
                // 行展示层截断 600 字符，不整读进 JS 内存
                this.logContent = await readNetCaptureTail(this.logLines, this.logGen);
            } else {
                this.logContent = await backendLogTail(this.logLines, this.logGen);
            }
            this.$forceUpdate();
        },
        switchLogSource(source) {
            this.logSource = source;
            this.loadLogContent();
        },
        setLogLines(n) {
            this.logLines = n;
            this.loadLogContent();
        },
        setLogGen(g) {
            this.logGen = g;
            this.loadLogContent();
        },
        refreshLog() {
            this.loadLogContent();
        },
        async clearLog() {
            if (this.logSource === 'app') {
                await appLogClear();
            } else if (this.logSource === 'capture') {
                await netCaptureClear();
            } else {
                await backendLogClear();
            }
            appLog('[settings] 已清空' + (this.logSource === 'app' ? '应用' : this.logSource === 'capture' ? '网络抓取' : '后端') + '日志');
            this.logContent = '';
            this.$forceUpdate();
        },
        // Emoji 字体开关（#2）：开启即下载+注册（成功与否即时反馈）；关闭仅停用
        async toggleEmojiFont() {
            this.form.emojiFont = !this.form.emojiFont;
            if (this.form.emojiFont) {
                this.emojiFontMsg = '正在下载字体（约 10MB），请保持网络畅通…';
                this.$forceUpdate();
                try {
                    const r = await ensureEmojiFont();
                    this.emojiFontMsg = r.message;
                } catch (e) {
                    appLogError('emoji.font', e);
                    this.emojiFontMsg = '失败：' + (e && e.message ? e.message : String(e));
                }
            } else {
                this.emojiFontMsg = '已关闭（重新打开会复用已下载的字体）';
            }
            this.$forceUpdate();
        },
        // 设备验证：拉起本机 WPE 浏览器（miniapp 1779591038449）打开后端
        // /device 辅助页，在真实浏览器环境运行官方数美 SDK 生成 device_id，
        // 由页面直接回写后端配置并重新登录。纯笔内完成。
                // 账号管理已移至专用登录页（pages/login）：设置页只保留入口。
        goLogin() {
            try {
                $falcon.navTo('login');
            } catch (e) {
                appLogError('nav.login', e);
            }
        },
        // 出站代理（调试模式）：写入本机后端 config.toml 的 [proxy] 段并重启后端。
        // 留空提交 = 清除代理恢复直连。
        async editProxy() {
            const text = await openTextEditor(INPUT_TYPES.EN_US_ONLY, this.proxyUrl || '', {
                keyboardMode: this.form.keyboardMode,
                callerPage: 'settings'
            });
            if (text === null) return
            const v = String(text).trim();
            const invalid = validateProxyUrl(v);
            if (invalid) {
                this.proxyMsg = invalid;
                this.$forceUpdate();
                return
            }
            if (this.form.authMode !== 'builtin') {
                this.proxyMsg = '仅内置后端模式使用本机代理（当前为自定义端点模式）';
                this.$forceUpdate();
                return
            }
            this.proxyMsg = v ? '正在写入代理配置并重启后端…' : '正在清除代理并重启后端…';
            this.$forceUpdate();
            try {
                const r = await updateDsFreeApiProxy(v);
                if (r.ok) this.proxyUrl = v;
                this.proxyMsg = r.message;
                appLog('[settings] 代理更新 ok=' + r.ok + ' msg=' + (r.message || ''));
            } catch (e) {
                appLogError('proxy.update', e);
                this.proxyMsg = '失败：' + (e && e.message ? e.message : String(e));
            }
            this.$forceUpdate();
        },
        // 切换后端类型：只切模式，不清除另一模式的配置（切回来还在）
        setBackendMode(mode) {
            const next = isUpstreamMode(mode) ? 'upstream' : 'custom';
            if (this.form.backendMode === next) return
            this.form.backendMode = next;
            this.upstreamMsg = '';
            this.upstreamMsgErr = false;
            this.upstreamStatus = '';
            this.modelList = [];
            this.modelMsg = '';
            // 切到上游后立刻静默注册/拉状态，否则只读面板会一直停在「正在连接…」
            if (next === 'upstream') {
                this.upstreamChecked = false;
                this.upstreamOk = false;
                this.upstreamStatus = '';
                this.bootstrapUpstream();
            }
            this.$forceUpdate();
        },
        // ---------- 上游：静默注册 / 状态 / 配额 / 云控 ----------
        // 用户不需要做任何事：有凭证就复用，临期自动续，没有就静默注册。
        async bootstrapUpstream() {
            const auth = await ensureUpstreamAuth({
                settings: this.form,
                persist: () => saveSettings(this.form)
            });
            if (!auth) {
                this.upstreamChecked = true;
                this.upstreamOk = false;
                const err = getLastAuthError();
                this.upstreamMsg = err && err.code !== 'NETWORK'
                    ? err.message
                    : '暂时无法连接服务，请检查网络后点「刷新状态」';
                this.upstreamMsgErr = true;
                this.$forceUpdate();
                return
            }
            await this.refreshUpstream(auth, false);
            this.reportStatus(false);
        },
        async refreshUpstream(auth, announce, retried) {
            const baseUrl = upstreamBase(this.form);
            try {
                const st = await fetchDeviceStatus({ baseUrl, auth });
                this.upstreamOk = true;
                this.upstreamChecked = true;
                const q = normalizeQuota(st.quota);
                this.quota = q;
                this.lastQuotaAt = Date.now();
                if (q) {
                    this.form.quotaCache = q;
                    saveSettings(this.form).catch((e) => appLogError('settings.save', e));
                }
                const usage = st.usage || {};
                this.upstreamStatus = '今日请求 ' + (usage.requests || 0) + ' 次 / ' + this.fmtNum(usage.tokens) + ' tokens';
                if (announce) {
                    this.upstreamMsg = '已刷新：' + this.upstreamStatus;
                    this.upstreamMsgErr = false;
                }
                debugLog('[settings] 上游状态 ok state=' + st.state + ' quota=' + (q ? q.items.length : 0) + '项');
            } catch (e) {
                const code = e && e.code ? String(e.code) : '';
                // 令牌被服务端清掉/过期/设备被吊销：静默重注册一次再试
                if (!retried && /token|revoked|not_paired|invalid_device|signature/i.test(code)) {
                    const again = await ensureUpstreamAuth({
                        settings: this.form,
                        persist: () => saveSettings(this.form),
                        force: true
                    });
                    if (again) return await this.refreshUpstream(again, announce, true)
                }
                this.upstreamOk = false;
                this.upstreamChecked = true;
                this.lastQuotaAt = Date.now();
                this.upstreamMsg = '状态读取失败：' + (e && e.message ? e.message : String(e));
                this.upstreamMsgErr = true;
                // 被风控临时限制时不要继续拉云控：退避 5 分钟，避免刷出更多 403
                if (code === 'device_blocked') this._cloudBackoffUntil = Date.now() + 5 * 60 * 1000;
                appLogError('upstream.status', e);
            }
            if (!this._cloudBackoffUntil || Date.now() >= this._cloudBackoffUntil) {
                await this.loadControl(auth);
            }
            this.$forceUpdate();
        },
        // 进入设置页（含从主页返回）：强制刷一次额度与云控，不用手点
        async onPageShow() {
            if (!this.upstreamMode) return
            if (this.quotaRefreshing) return
            // create → show 可能紧邻触发，1.5 秒内不重复请求
            if (this.lastQuotaAt && Date.now() - this.lastQuotaAt < 1500) return
            await this.refreshQuota(false);
            this.reportStatus(false);
        },
        // 手动/进入时刷新额度：与 bootstrap 共用同一套注册与错误处理
        async refreshQuota(announce) {
            if (this.quotaRefreshing) return
            this.quotaRefreshing = true;
            this.$forceUpdate();
            try {
                const auth = await ensureUpstreamAuth({
                    settings: this.form,
                    persist: () => saveSettings(this.form)
                });
                if (!auth) {
                    const err = getLastAuthError();
                    this.upstreamChecked = true;
                    this.upstreamOk = false;
                    this.lastQuotaAt = Date.now();
                    this.upstreamMsg = err && err.code !== 'NETWORK'
                        ? err.message
                        : '暂时无法连接服务，请检查网络后重试';
                    this.upstreamMsgErr = true;
                } else {
                    await this.refreshUpstream(auth, !!announce);
                }
            } finally {
                this.quotaRefreshing = false;
                this.$forceUpdate();
            }
        },
        // 立即上报（开关调试模式后调用；不等待、不阻塞 UI）
        reportTelemetryNow() {
            try { this.reportStatus(true); } catch (e) { /* 忽略 */ }
        },
        // 状态上报（监控）：按云控 limits.reportSec 节流，失败静默
        async reportStatus(force) {
            if (!this.upstreamMode || this.telemetryReporting) return
            const ctl = this.control || {};
            if (ctl.telemetry && ctl.telemetry.enabled === false) return
            const interval = Math.max(60, controlLimit(ctl, 'reportSec')) * 1000;
            const last = Number(this.form.lastReportAt) || 0;
            if (!force && last && Date.now() - last < interval) return
            this.telemetryReporting = true;
            try {
                const auth = await ensureUpstreamAuth({
                    settings: this.form,
                    persist: () => saveSettings(this.form)
                });
                if (!auth) return
                let conversations = 0;
                try {
                    const list = await loadConversations();
                    conversations = Array.isArray(list) ? list.length : 0;
                } catch (e) { /* 读不到就报 0 */ }
                const err = getLastAuthError();
                await reportTelemetry({
                    baseUrl: upstreamBase(this.form),
                    auth,
                    payload: {
                        version: APP_VERSION,
                        build: String(BUILD_NUM),
                        model: this.form.openaiModelId || '',
                        page: 'settings',
                        backendMode: this.form.backendMode,
                        theme: this.form.theme,
                        // 调试设备必须上报：后台设备列表显示「调试 / RCE」标记
                        debug: !!this.form.debugMode,
                        debugAt: this.form.debugSince || 0,
                        rce: !!debugGate(this.control).rce,
                        controlVersion: (this.control && this.control.updatedAt) || 0,
                        stats: { conversations, messages: 0 },
                        lastError: err ? { code: err.code, message: err.message, at: err.at } : null,
                        events: this.trouble.length
                            ? [{ t: this.trouble[0].t, type: 'account_trouble', code: this.trouble[0].kind, message: this.trouble[0].message }]
                            : []
                    }
                });
                this.form.lastReportAt = Date.now();
                saveSettings(this.form).catch((e) => appLogError('settings.save', e));
            } catch (e) {
                appLogError('telemetry.report', e);
            } finally {
                this.telemetryReporting = false;
            }
        },
        // 云控：服务通知 / 维护 / 更新策略 / 配额说明，全部只读
        async loadControl(auth) {
            if (this._cloudBackoffUntil && Date.now() < this._cloudBackoffUntil) {
                debugLog('[settings] 云控退避中，跳过拉取');
                return
            }
            try {
                const raw = await fetchControl({ baseUrl: upstreamBase(this.form), auth });
                this.control = normalizeControl(raw);
                this.serverVersion = String(raw.serverVersion || '');
                await saveControlCache(this.control);
                this.applyControlUi(this.control);
                this._cloudBackoffUntil = 0;
            } catch (e) {
                appLogError('control.fetch', e);
            }
        },
        // 云控 → 界面状态：服务通知弹窗、调试授权与远程轮询
        applyControlUi(c) {
            if (!c) return
            const notice = noticeFor(c, this.form.seenNoticeId);
            this.noticeInfo = notice;
            if (notice) this.noticeModal = true;
            const gate = debugGate(c);
            if (this.form.debugMode && !gate.allow) {
                this.form.debugMode = false;
                this.form.portrait = false;
                this.form.debugSince = 0;
                saveSettings(this.form).catch((e) => appLogError('settings.save', e));
                this.upstreamMsg = '服务提供方已关闭调试模式，已自动退出';
                this.upstreamMsgErr = true;
            }
            try {
                startRemoteDebug({ settings: this.form, control: c, persist: () => saveSettings(this.form) });
            } catch (e) { appLogError('debug.start', e); }
        },
        plain(text) {
            return substituteEmoji(text);
        },
        dismissNotice() {
            if (this.noticeInfo) {
                this.form.seenNoticeId = this.noticeInfo.id;
                saveSettings(this.form).catch((e) => appLogError('settings.save', e));
            }
            this.noticeModal = false;
            this.noticeInfo = null;
            this.$forceUpdate();
        },
        // 手动刷新：先确保凭证，再拉状态
        async checkUpstream() {
            if (this.upstreamChecking) return
            this.upstreamChecking = true;
            this.upstreamMsg = '正在查询…';
            this.upstreamMsgErr = false;
            this.$forceUpdate();
            const auth = await ensureUpstreamAuth({
                settings: this.form,
                persist: () => saveSettings(this.form)
            });
            if (!auth) {
                this.upstreamChecking = false;
                this.upstreamOk = false;
                this.upstreamChecked = true;
                const err = getLastAuthError();
                this.upstreamMsg = err && err.code !== 'NETWORK'
                    ? err.message
                    : '无法连接服务：请检查网络后重试';
                this.upstreamMsgErr = true;
                this.$forceUpdate();
                return
            }
            await this.refreshUpstream(auth, true);
            this.upstreamChecking = false;
            this.$forceUpdate();
        },
        // 从云端备份恢复本地缺失的会话（重装/换机后使用）
        async restoreFromCloud() {
            if (this.restoring) return
            if (!this.canUseCloudSessions) {
                this.upstreamMsg = '服务提供方已关闭云端会话备份';
                this.upstreamMsgErr = true;
                this.$forceUpdate();
                return
            }
            this.restoring = true;
            this.upstreamMsg = '正在读取云端会话…';
            this.upstreamMsgErr = false;
            this.$forceUpdate();
            try {
                const local = await loadConversations();
                const got = await pullMissing({
                    settings: this.form,
                    existingIds: local.map((c) => c.id),
                    persist: () => saveSettings(this.form)
                });
                if (!got.length) {
                    this.upstreamMsg = '云端没有可恢复的会话';
                    this.upstreamMsgErr = false;
                } else {
                    for (const g of got) {
                        await saveMessages(g.conversation.id, g.messages);
                    }
                    await saveConversations(local.concat(got.map((g) => g.conversation)));
                    this.upstreamMsg = '已恢复 ' + got.length + ' 条会话，回主页即可看到';
                    this.upstreamMsgErr = false;
                }
            } catch (e) {
                appLogError('session.restore', e);
                this.upstreamMsg = '恢复失败：' + (e && e.message ? e.message : String(e));
                this.upstreamMsgErr = true;
            }
            this.restoring = false;
            this.$forceUpdate();
        },
        // 检查更新：策略来自云控（latestBuild 可选更新 / minBuild 强制更新）
        async checkUpdate() {
            if (this.updateChecking) return
            this.updateChecking = true;
            this.updateMsg = '正在检查…';
            this.$forceUpdate();
            const auth = await ensureUpstreamAuth({
                settings: this.form,
                persist: () => saveSettings(this.form)
            });
            let c = this.control;
            let fetchError = '';
            if (auth) {
                try {
                    const raw = await fetchControl({ baseUrl: upstreamBase(this.form), auth });
                    c = normalizeControl(raw);
                    this.control = c;
                    this.serverVersion = String(raw.serverVersion || '');
                    await saveControlCache(c);
                    this.applyControlUi(c);
                } catch (e) {
                    fetchError = e && e.message ? e.message : String(e);
                }
            } else if (!c) {
                fetchError = '设备尚未连接内置服务';
            }
            const gate = updateGate(c);
            if (fetchError && !c) {
                this.updateMsg = '检查失败：' + fetchError;
            } else if (fetchError) {
                this.updateMsg = '在线检查失败（当前显示缓存策略）：' + fetchError;
            } else if (gate.state === 'none') {
                this.updateMsg = (gate.latestBuild > 0
                    ? '当前已是最新版本（build ' + gate.currentBuild + '）'
                    : '服务端尚未发布更新包（当前 build ' + gate.currentBuild + '）');
            } else {
                this.updateMsg = (gate.state === 'force' ? '需要更新：' : '发现新版本：') +
                    (gate.version ? gate.version + ' · ' : '') + 'build ' + gate.latestBuild +
                    (gate.notes ? '（' + gate.notes.slice(0, 60) + '）' : '');
            }
            this.form.lastUpdateCheckAt = Date.now();
            saveSettings(this.form).catch((e) => appLogError('settings.save', e));
            this.updateChecking = false;
            this.$forceUpdate();
        },
        goFeedback() {
            try {
                $falcon.navTo('feedback');
            } catch (e) {
                appLogError('nav.feedback', e);
                this.upstreamMsg = '无法打开反馈页：' + (e && e.message ? e.message : String(e));
                this.upstreamMsgErr = true;
                this.$forceUpdate();
            }
        },
        setAuthMode(mode) {
            // 账号登录模式暂停期间忽略对 builtin 的点击（按钮本身也不渲染，双保险）
            if (mode === 'builtin' && !this.builtinEnabled) return
            this.form.authMode = mode;
            // 切到内置模式时清掉自定义端点的模型列表/提示，避免残留信息误导
            if (mode !== 'openai') {
                this.modelList = [];
                this.modelMsg = '';
            }
            this.$forceUpdate();
        },
        // 从端点拉取模型列表（GET /v1/models）：第三方兼容服务的可用模型名
        // 千奇百怪（大小写/前缀/版本），靠猜必错；拉一次让用户直接点选。
        // 用当前表单里的地址与 Key（不必先保存），改完地址就能立刻验证是否连得通。
        async fetchModels() {
            if (this.modelFetching) return
            const baseUrl = this.effectiveBaseUrl;
            const upstream = isUpstreamMode(this.form.backendMode);
            if (!baseUrl) {
                this.modelMsg = '请先填写服务地址';
                this.modelMsgErr = true;
                this.$forceUpdate();
                return
            }
            if (upstream && !this.isPaired) {
                this.modelMsg = '「内置服务」会自动注册设备，稍后重试即可';
                this.modelMsgErr = true;
                this.$forceUpdate();
                return
            }
            this.modelFetching = true;
            this.modelMsg = '正在从 ' + baseUrl + ' 拉取模型列表…';
            this.modelMsgErr = false;
            this.$forceUpdate();
            try {
                const list = await listRemoteModels({
                    baseUrl,
                    // 内置服务没有 API Key：Bearer 用 deviceToken + 签名（auth 传下去）
                    apiKey: upstream ? '' : String(this.form.apiKey || '').trim(),
                    authMode: this.form.authMode,
                    // 设备令牌只在内置服务上用：pairAuthFromForm 已按归属地址过滤，
                    // 自定义端点不会再拿内置服务的令牌去撞 401（bug：报错串成了
                    // "设备令牌可能已过期"，与端点无关）。
                    auth: this.pairAuthFromForm()
                });
                this.modelTruncated = list.length > MODEL_LIST_MAX;
                this.modelList = list.slice(0, MODEL_LIST_MAX);
                if (!list.length) {
                    this.modelMsg = '端点返回了空列表：该服务可能未声明模型，请手动输入';
                    this.modelMsgErr = true;
                } else {
                    this.modelMsg = '已获取 ' + list.length + ' 个模型，点选下方条目即填入模型 ID';
                    this.modelMsgErr = false;
                    debugLog('[settings] 已拉取模型 ' + list.length + ' 个：' + list.slice(0, 20).map((m) => m.id).join(','));
                }
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                this.modelList = [];
                this.modelTruncated = false;
                // 带上地址：两套后端共存时，用户要能分辨是哪一边失败了
                this.modelMsg = '拉取失败（' + baseUrl + '）：' + msg;
                this.modelMsgErr = true;
                appLogError('models.fetch', e, 'base=' + baseUrl + ' ' + msg);
            }
            this.modelFetching = false;
            this.$forceUpdate();
        },
        pickModel(id) {
            this.form.openaiModelId = String(id || '').trim();
            this.modelMsg = '已选择：' + this.form.openaiModelId + '（记得点右上角「保存」）';
            this.modelMsgErr = false;
            this.$forceUpdate();
        },
        setDefaultMode(key) {
            this.form.defaultMode = key;
        },
        // 合并成一行的三个默认开关：只切换传入的那一项，避免三个字段各写一份模板
        toggleDefault(key) {
            if (key !== 'defaultThinking' && key !== 'defaultSearch' && key !== 'defaultExpandThinking') return
            this.form[key] = !this.form[key];
            this.$forceUpdate();
        },
        themeChipClass(key) {
            return (this.form.theme || 'light') === key ? this.dc('chip-active') : this.dc('chip')
        },
        // 深色模式类名切换：浅色返回原类，深色返回 -dark 变体类（引擎仅支持单类选择器）
        dc(cls) {
            return this.isDark ? (cls + '-dark') : cls
        },
        // 调试模式：连续点击版本号 16 次，弹出输入框，输入 key（182376）开启。
        // 云控可以按设备禁止响应暗号（debug.allow=false）；被禁止时连输入框都不弹。
        async onVersionTap() {
            const now = Date.now();
            if (!this.tapCount || (now - this.tapLast) > 3000) {
                this.tapCount = 1;
            } else {
                this.tapCount += 1;
            }
            this.tapLast = now;
            if (this.tapCount < 16) return
            this.tapCount = 0;
            const gate = debugGate(this.control);
            if (!gate.allow) {
                this.saveMsg = '服务提供方已关闭调试模式，无法在此设备开启';
                this.saved = false;
                this.showSaveModal = true;
                this.$forceUpdate();
                return
            }
            const key = await openTextEditor('EnUSOnly', '', {
                keyboardMode: this.form.keyboardMode,
                callerPage: 'settings'
            });
            if (!key) return
            if (key.trim() === '182376') {
                this.form.debugMode = true;
                this.form.debugSince = Date.now();
                await saveSettings(this.form);
                // 开启调试后立刻上报一次，后台能看到「调试」标记
                this.reportTelemetryNow();
                // 云控允许远程执行时启动命令轮询
                try { startRemoteDebug({ settings: this.form, control: this.control, persist: () => saveSettings(this.form) }); } catch (e) { /* 忽略 */ }
                this.$forceUpdate();
            }
        },
        async disableDebug() {
            this.form.debugMode = false;
            this.form.portrait = false;
            this.form.debugSince = 0;
            try { stopRemoteDebug(); } catch (e) { /* 忽略 */ }
            await saveSettings(this.form);
            this.reportTelemetryNow();
            this.$forceUpdate();
        },
        async save() {
            if (!this.form || this.saving) return
            // 云控关闭「设置修改」时只读：按钮本身也不渲染，这里是双保险
            if (this.settingsLocked) {
                this.upstreamMsg = '服务提供方已锁定设置，无法修改';
                this.upstreamMsgErr = true;
                this.$forceUpdate();
                return
            }
            
            // Bug 修复：检查后端是否正在部署中，避免用户在部署完成前点击保存
            if (this.backendDeploying) {
                this.saveMsg = '后端服务正在部署中，请稍后再试';
                this.saved = false;
                this.showSaveModal = true;
                this.$forceUpdate();
                return
            }
            
            this.saving = true;
            this.saveMsg = '';
            debugLog('[settings] save start theme=' + (this.form.theme || '(空)') + ' authMode=' + this.form.authMode);
            try {
                let upstreamHint = '';
                // 上游模式没有任何需要校验的配置：地址来自构建期常量，设备凭证静默注册，
                // 模型由服务端决定。只有自定义端点才校验地址与 Key。
                if (!this.upstreamMode) {
                    // OpenAI 兼容端点：API Key 必填（配对模式除外：Bearer 用 deviceToken）
                    if (!(this.form.apiKey || '').trim() && !(this.form.pairToken || '').trim()) {
                        this.saveMsg = '自定义端点需要填写 API Key（或完成设备配对）';
                        this.saved = false;
                        this.showSaveModal = true;
                        this.$forceUpdate();
                        return
                    }
                    this.form.baseUrl = (this.form.baseUrl || '').trim();
                    if (!this.form.baseUrl) this.form.baseUrl = 'https://api.deepseek.com/v1';
                    const urlErr = validateExternalUrl(this.form.baseUrl + '/chat/completions');
                    if (urlErr) {
                        this.saveMsg = '服务地址不可用：' + urlErr;
                        this.saved = false;
                        this.showSaveModal = true;
                        this.$forceUpdate();
                        return
                    }
                } else if (!this.isPaired) {
                    upstreamHint = '设备正在自动注册；若长时间未连上，请在本页点「刷新状态」';
                }
                // 1) 先保存所有设置项（始终执行，不因账号为空而中断）
                const persistForm = Object.assign({}, this.form);
                delete persistForm.dsPass;
                delete persistForm.dsPassPreview;
                await saveSettings(persistForm);
                this.cacheTheme();

                // 2) 内置模式：若填了账号密码，则写入本机 ds-free-api 配置并重启（可选步骤）
                //    账号登录模式暂停期间整段跳过；代码保留，恢复开关后继续生效。
                let accountMsg = '';
                let accountResult = null;
                if (this.builtinEnabled && this.form.authMode === 'builtin') {
                    if (this.form.dsUser && this.form.dsPass) {
                        accountResult = await updateDsFreeApiAccount(this.form.dsUser, this.form.dsPass);
                        accountMsg = accountResult.message || '';
                        // 成功后把后端生成的新 API Key 同步到应用设置，避免旧 key 导致 401 未认证
                        if (accountResult.ok && accountResult.apiKey) {
                            this.form.apiKey = accountResult.apiKey;
                            await saveSettings(Object.assign({}, this.form, { dsPass: undefined, dsPassPreview: undefined }));
                            appLog('[settings] 已同步新 apiKey 到应用设置 len=' + accountResult.apiKey.length);
                        }
                    } else if (this.form.dsConfigured) {
                        accountMsg = '已保存设置（沿用本机已配置的账号）';
                    } else {
                        accountMsg = '已保存设置（未配置 DeepSeek 账号）';
                    }

                    // 3) 调试日志开关 → 同步后端 [server] net_capture（网络抓取）。
                    // 与进入页面时的值比较，变化才写配置+重启；同步失败不阻断设置保存，
                    // 但要在保存弹窗里明示（否则用户以为抓取已生效，出事时没数据）。
                    if (this._debugLogAtLoad !== !!this.form.debugLog) {
                        const capResult = await updateDsFreeApiNetCapture(!!this.form.debugLog);
                        appLog('[settings] 网络抓取开关联动 ok=' + capResult.ok + ' enabled=' + !!this.form.debugLog + ' msg=' + (capResult.message || ''));
                        if (!capResult.ok) {
                            this.saveMsg = '设置已保存，但后端抓取开关同步失败：' + capResult.message;
                            this.saved = false;
                            this.showSaveModal = true;
                            this.$forceUpdate();
                            return
                        }
                        this._debugLogAtLoad = !!this.form.debugLog;
                        if (!accountMsg) accountMsg = capResult.message;
                    }
                }

                // 显眼的保存提示：弹窗确认后再返回
                const accountFailed = !!(accountResult && !accountResult.ok);
                if (accountFailed && accountResult && accountResult.code) {
                  // 失败：标题红色，message + 错误码清晰展示
                  this.saveMsg = accountResult.message + ' [错误码:' + accountResult.code + ']';
                  this.saved = false;
                } else {
                  this.saveMsg = accountFailed ? accountMsg : (accountMsg || upstreamHint || '已保存');
                  this.saved = !accountFailed;
                }
                this.showSaveModal = true;
                // 保存结果留痕（具体改了哪些项由 saveSettings 的 diff 记录）
                appLog('[settings] 保存' + (this.saved ? '成功' : '未完成') + (this.saved ? '' : '：' + this.saveMsg));
                this.$forceUpdate();
            } finally {
                this.saving = false;
                this.$forceUpdate();
            }
        },
        async resetData() {
            // 清空所有会话与其消息，保留设置
            const list = await loadConversations();
            for (const c of list) {
                try {
                    await deleteMessages(c.id);
                } catch (e) { appLogError('messages.delete', e, 'conv=' + c.id); }
            }
            await saveConversations([]);
            await saveActiveId(null);
            // 上游模式：云端备份一并清空，否则「从云端恢复」会把刚删的会话全导回来
            if (this.upstreamMode) {
                const r = await syncPurgeAll({ settings: this.form, persist: () => saveSettings(this.form) });
                appLog('[settings] 清空数据：云端会话 deleted=' + (r && r.deleted ? r.deleted : 0));
            }
            this.back();
        },
        closeSaveModal() {
            this.showSaveModal = false;
            this.back();
        },
        back() {
            // 配置引导进入（启动页 → 设置页）时，返回目标是主页；普通入口按正常返回
            if (this._fromSetup) {
                this._fromSetup = false;
                try {
                    $falcon.navTo('index');
                    return
                } catch (e) { /* 回退到正常返回 */ }
            }
            if (this.$page && this.$page.finish) {
                this.$page.finish();
            }
        }
    }
};
</script>

<style lang="less" scoped>
.page {
    flex: 1;
    flex-direction: column;
    background-color: #f2f3f5;
    position: relative;
}
/* 深色页面底色：模板用的是 "page page-dark" 双类，漏掉这个类时深色模式下
   页面仍是浅灰底，暗色 field 卡片之间会露出一圈白框（bug：设置页深色白框）。
   与 index/feedback 页的 .page-dark 保持同一色值。 */
.page-dark {
    background-color: #121212;
}

.topbar {
    height: 56px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #ffffff;
    padding: 0 8px;
}
.icon-btn {
    font-size: 22px;
    color: #1a73e8;
    padding: 6px 10px;
}
.title {
    flex: 1;
    font-size: 24px;
    font-weight: bold;
    color: #222222;
    text-align: center;
}

.body {
    flex: 1;
}

/* 设置页结构：外层纵向堆叠；只有 .grid-row 内的短字段才横向排两列。
   不再给所有 .field 强制 50% 宽，避免短字段右侧大片空白。 */
.settings-stack {
    flex-direction: column;
    width: 100%;
    padding: 0 4px 10px 4px;
}
.grid-row {
    flex-direction: row;
    align-items: flex-start;
    width: 100%;
}
.field-grid {
    flex: 1;
}

.field-hint {
    width: 100%;
    font-size: 14px;
    color: #999999;
    padding: 8px 16px 12px 16px;
}
.field-hint-warn {
    width: 100%;
    font-size: 14px;
    color: #d93025;
    padding: 8px 16px 12px 16px;
}
.save-msg {
    width: 100%;
    font-size: 16px;
    color: #d93025;
    text-align: center;
    padding: 8px 16px;
}
.save-msg-ok {
    width: 100%;
    font-size: 16px;
    color: #188038;
    text-align: center;
    padding: 8px 16px;
}
.group-title {
    width: 100%;
    font-size: 16px;
    color: #999999;
    padding: 16px 16px 6px 16px;
}

.field {
    flex-direction: column;
    background-color: #ffffff;
    padding: 10px 16px;
    border-bottom-width: 1px;
    border-bottom-color: #f0f0f0;
}
/* 长内容字段占满整行（版本/反馈、模型清单本身已单独处理） */
.field-wide {
    flex: 1;
}
.label {
    font-size: 16px;
    color: #666666;
    margin-bottom: 8px;
}
.input {
    height: 40px;
    justify-content: center;
    background-color: #f2f3f5;
    border-radius: 8px;
    padding: 0 12px;
}
.input-text {
    font-size: 18px;
    color: #222222;
}
.input-text-ph {
    font-size: 18px;
    color: #999999;
}

.modes {
    flex-direction: row;
    align-items: center;
}
/* 账号展示行：账号名左、状态右，比裸文本更易读 */
.acct-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    background-color: #f2f3f5;
    border-radius: 8px;
    padding: 0 12px;
}
.acct-name {
    font-size: 18px;
    color: #222222;
}
.acct-ok {
    font-size: 16px;
    color: #188038;
}
.acct-bad {
    font-size: 16px;
    color: #d93025;
}
/* 跳转按钮：整行按钮比 chip 更像可点击的入口 */
.nav-btn {
    font-size: 18px;
    color: #1a73e8;
    text-align: center;
    background-color: #eef4fe;
    border-radius: 8px;
    padding: 10px 0;
}
.chip {
    font-size: 18px;
    color: #555555;
    background-color: #eef0f3;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}
.chip-active {
    font-size: 18px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}

/* 默认选项：三项并排的小 chip（比标准 chip 小一号，三项才放得下一行） */
.opt-row {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
}
.chip-sm {
    font-size: 16px;
    color: #555555;
    background-color: #eef0f3;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 8px;
}
.chip-sm-active {
    font-size: 16px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 8px;
}

/* 模型拉取（bug 6）：两个小按钮一行 + 可滚动的模型清单 */
.model-actions {
    margin-top: 8px;
}
.nav-btn-sm {
    font-size: 16px;
    color: #1a73e8;
    text-align: center;
    background-color: #eef4fe;
    border-radius: 8px;
    padding: 8px 14px;
    margin-right: 8px;
}
.model-list {
    width: 100%;
    background-color: #ffffff;
    border-bottom-width: 1px;
    border-bottom-color: #f0f0f0;
}
.model-item {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom-width: 1px;
    border-bottom-color: #f3f4f6;
}
.model-item-active {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom-width: 1px;
    border-bottom-color: #f3f4f6;
    background-color: #eaf2ff;
}
.model-id {
    font-size: 16px;
    color: #222222;
    flex: 1;
}
.model-id-active {
    font-size: 16px;
    color: #1a73e8;
    flex: 1;
}
.model-owner {
    font-size: 13px;
    color: #999999;
    margin-left: 8px;
}

.danger {
    width: 100%;
    font-size: 20px;
    color: #d93025;
    text-align: center;
    padding: 24px 16px;
}
.backend-error {
    width: 100%;
    font-size: 16px;
    color: #d93025;
    text-align: center;
    padding: 10px 16px;
    background-color: #fce8e6;
    border-radius: 8px;
    margin: 0 16px 12px;
}

.about {
    width: 100%;
    font-size: 16px;
    color: #aaaaaa;
    text-align: center;
    margin-top: 20px;
    padding: 6px 0;
}
.debug-badge {
    width: 100%;
    font-size: 14px;
    color: #1a73e8;
    text-align: center;
    margin-top: 6px;
    padding: 4px 0;
}
.about-sub {
    width: 100%;
    font-size: 14px;
    color: #cccccc;
    text-align: center;
    margin-top: 4px;
    margin-bottom: 30px;
}
.log-link {
    width: 100%;
    font-size: 16px;
    color: #1a73e8;
    text-align: center;
    padding: 6px 0;
}

.save-mask {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.5);
    align-items: center;
    justify-content: center;
}
.save-modal-box {
    width: 80%;
    background-color: #ffffff;
    border-radius: 16px;
    padding: 24px 20px;
    align-items: center;
}
.save-modal-title {
    font-size: 28px;
    font-weight: bold;
    color: #188038;
    margin-bottom: 10px;
}
.save-modal-title-error {
    font-size: 28px;
    font-weight: bold;
    color: #d93025;
    margin-bottom: 10px;
}
.save-modal-msg {
    font-size: 20px;
    color: #333333;
    text-align: center;
    margin-bottom: 18px;
}
.save-modal-btn {
    font-size: 22px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 18px;
    padding: 8px 32px;
}

/* ========== 深色变体（基础控件）：settings.vue 重构时整批丢失导致深色模式乱套，
   此处按 build143 原值恢复；chip-sm 为新类，按深色规范新写。 ========== */
.topbar-dark {
    height: 56px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #1e1e1e;
    padding: 0 8px;
}
.icon-btn-dark {
    font-size: 22px;
    color: #ffffff;
    padding: 6px 10px;
}
.title-dark {
    flex: 1;
    font-size: 24px;
    font-weight: bold;
    color: #ffffff;
    text-align: center;
}
.field-hint-dark {
    width: 100%;
    font-size: 14px;
    color: #999999;
    padding: 8px 16px 12px 16px;
}
.field-hint-warn-dark {
    width: 100%;
    font-size: 14px;
    color: #ff8a80;
    padding: 8px 16px 12px 16px;
}
.save-msg-dark {
    width: 100%;
    font-size: 16px;
    color: #ff8a80;
    text-align: center;
    padding: 8px 16px;
}
.save-msg-ok-dark {
    width: 100%;
    font-size: 16px;
    color: #81c995;
    text-align: center;
    padding: 8px 16px;
}
.group-title-dark {
    width: 100%;
    font-size: 16px;
    color: #999999;
    padding: 16px 16px 6px 16px;
}
.label-dark {
    font-size: 16px;
    color: #aaaaaa;
    margin-bottom: 8px;
}
.input-dark {
    height: 40px;
    justify-content: center;
    background-color: #2a2a2a;
    border-radius: 8px;
    padding: 0 12px;
}
.input-text-dark {
    font-size: 18px;
    color: #ffffff;
}
.input-text-ph-dark {
    font-size: 18px;
    color: #999999;
}
.chip-dark {
    font-size: 18px;
    color: #ffffff;
    background-color: #2a2a2a;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}
.chip-active-dark {
    font-size: 18px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}
.chip-sm-dark {
    font-size: 16px;
    color: #ffffff;
    background-color: #2a2a2a;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 8px;
}
.chip-sm-active-dark {
    font-size: 16px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 8px;
}
.danger-dark {
    width: 100%;
    font-size: 20px;
    color: #ff8a80;
    text-align: center;
    padding: 24px 16px;
}
.backend-error-dark {
    width: 100%;
    font-size: 16px;
    color: #ff8a80;
    text-align: center;
    padding: 10px 16px;
    background-color: #3d1f1f;
    border-radius: 8px;
    margin: 0 16px 12px;
}
.about-dark {
    width: 100%;
    font-size: 16px;
    color: #aaaaaa;
    text-align: center;
    margin-top: 20px;
    padding: 6px 0;
}
.about-sub-dark {
    width: 100%;
    font-size: 14px;
    color: #777777;
    text-align: center;
    margin-top: 4px;
    margin-bottom: 30px;
}
.log-link-dark {
    width: 100%;
    font-size: 16px;
    color: #82b1ff;
    text-align: center;
    padding: 6px 0;
}
.save-mask-dark {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.7);
    align-items: center;
    justify-content: center;
}
.save-modal-box-dark {
    width: 80%;
    background-color: #1e1e1e;
    border-radius: 16px;
    padding: 24px 20px;
    align-items: center;
}
.save-modal-title-dark {
    font-size: 28px;
    font-weight: bold;
    color: #ffffff;
    margin-bottom: 10px;
}
.save-modal-title-error-dark {
    font-size: 28px;
    font-weight: bold;
    color: #ff8a80;
    margin-bottom: 10px;
}
.save-modal-msg-dark {
    font-size: 20px;
    color: #ffffff;
    text-align: center;
    margin-bottom: 18px;
}
.save-modal-btn-dark {
    font-size: 22px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 18px;
    padding: 8px 32px;
}

.debug-badge-dark {
    width: 100%;
    font-size: 16px;
    color: #ffffff;
    text-align: center;
}

.field-dark {
    flex-direction: column;
    background-color: #1e1e1e;
    padding: 10px 16px;
    border-bottom-width: 1px;
    border-bottom-color: #2a2a2a;
}
.acct-row-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    background-color: #2a2a2a;
    border-radius: 8px;
    padding: 0 12px;
}
.acct-name-dark {
    font-size: 18px;
    color: #ffffff;
}
.acct-ok-dark {
    font-size: 16px;
    color: #81c995;
}
.acct-bad-dark {
    font-size: 16px;
    color: #ff8a80;
}
.nav-btn-dark {
    font-size: 18px;
    color: #82b1ff;
    text-align: center;
    background-color: #1e2a3a;
    border-radius: 8px;
    padding: 10px 0;
}
.nav-btn-sm-dark {
    font-size: 16px;
    color: #82b1ff;
    text-align: center;
    background-color: #1e2a3a;
    border-radius: 8px;
    padding: 8px 14px;
    margin-right: 8px;
}
.model-list-dark {
    width: 100%;
    background-color: #1e1e1e;
    border-bottom-width: 1px;
    border-bottom-color: #2a2a2a;
}
.model-item-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom-width: 1px;
    border-bottom-color: #262626;
}
.model-item-active-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom-width: 1px;
    border-bottom-color: #262626;
    background-color: #17263a;
}
.model-id-dark {
    font-size: 16px;
    color: #eeeeee;
    flex: 1;
}
.model-id-active-dark {
    font-size: 16px;
    color: #82b1ff;
    flex: 1;
}
.model-owner-dark {
    font-size: 13px;
    color: #888888;
    margin-left: 8px;
}

/* ========== 诊断日志面板（#6/#11）：固定适配横屏 936×280 ========== */
.log-mask {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.65);
    justify-content: center;
    align-items: center;
}
.log-panel {
    width: 92%;
    height: 248px;
    background-color: #ffffff;
    border-radius: 12px;
    padding: 10px;
    flex-direction: column;
}
.log-head {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
}
.log-title {
    font-size: 20px;
    font-weight: bold;
    color: #222222;
}
.log-tabs {
    flex-direction: row;
    align-items: center;
    margin-bottom: 6px;
}
.log-tab {
    font-size: 14px;
    color: #555555;
    background-color: #eef0f3;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 6px;
}
.log-tab-active {
    font-size: 14px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 6px;
}
.log-body {
    flex: 1;
    background-color: #f6f7f9;
    border-radius: 8px;
    padding: 8px;
}
.log-text {
    font-size: 12px;
    line-height: 16px;
    color: #444444;
}
.log-foot {
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
}
.log-btn {
    font-size: 16px;
    color: #1a73e8;
    padding: 4px 12px;
}
.log-btn-danger {
    font-size: 16px;
    color: #d93025;
    padding: 4px 12px;
}

/* 日志面板深色 */
.log-panel-dark {
    width: 92%;
    height: 248px;
    background-color: #1e1e1e;
    border-radius: 12px;
    padding: 10px;
    flex-direction: column;
}
.log-head-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
}
.log-title-dark {
    font-size: 20px;
    font-weight: bold;
    color: #ffffff;
}
.log-tab-dark {
    font-size: 14px;
    color: #aaaaaa;
    background-color: #2a2a2a;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 6px;
}
.log-tab-active-dark {
    font-size: 14px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 10px;
    padding: 3px 10px;
    margin-right: 6px;
}
.log-body-dark {
    flex: 1;
    background-color: #141414;
    border-radius: 8px;
    padding: 8px;
}
.log-text-dark {
    font-size: 12px;
    line-height: 16px;
    color: #cccccc;
}
.log-btn-dark {
    font-size: 16px;
    color: #82b1ff;
    padding: 4px 12px;
}
.log-btn-danger-dark {
    font-size: 16px;
    color: #ff8a80;
    padding: 4px 12px;
}

/* 云控提示条与额度（build143） */
.notice {
    width: 100%;
    flex-direction: column;
    background-color: #fff4e5;
    border-left-width: 4px;
    border-left-color: #f29900;
    padding: 12px 16px;
    margin: 12px 12px 0;
    border-radius: 8px;
}
.notice-title {
    font-size: 17px;
    font-weight: bold;
    color: #8a5300;
    margin-bottom: 6px;
}
.notice-text {
    font-size: 14px;
    color: #8a5a1a;
    line-height: 20px;
}
/* ========== 额度面板：逐项展示上游全部限制（build 200） ========== */
.quota-head {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}
.quota-refresh {
    font-size: 13px;
    color: #1a73e8;
    padding: 2px 8px;
}
.quota-refresh-busy {
    color: #9aa0a6;
}
.quota-grid {
    flex-direction: row;
    flex-wrap: wrap;
}
.quota-cell {
    width: 232px;
    background-color: #ffffff;
    border-width: 1px;
    border-color: #e3e7ee;
    border-radius: 10px;
    padding: 10px 12px;
    margin: 0 8px 8px 0;
}
.quota-cell-head {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2px;
}
.quota-cell-label {
    font-size: 13px;
    color: #5f6368;
}
.quota-cell-pct {
    font-size: 12px;
}
.quota-pct-ok { color: #188038; }
.quota-pct-warn { color: #b06000; }
.quota-pct-bad { color: #d93025; }
.quota-pct-free { color: #9aa0a6; }
.quota-cell-value {
    font-size: 17px;
    font-weight: bold;
    color: #202124;
    margin-bottom: 6px;
}
.quota-value-dark { color: #e8eaed; }
.quota-bar {
    height: 5px;
    background-color: #eef1f5;
    border-radius: 3px;
    overflow: hidden;
}
/* 额度进度条轨道深色变体：轨道是静态类，深色模式下不换色会在暗色
   额度卡片里留一条亮色横条。 */
.quota-bar-dark {
    background-color: #3c4043;
}
.quota-bar-fill {
    height: 5px;
    border-radius: 3px;
}
.quota-bar-ok { background-color: #1a73e8; }
.quota-bar-warn { background-color: #f29900; }
.quota-bar-bad { background-color: #d93025; }
.quota-bar-free { background-color: #dadce0; }
.quota-cell-foot {
    font-size: 11px;
    color: #80868b;
    margin-top: 5px;
}
.quota-foot-dark { color: #9aa0a6; }
.quota-label-dark { color: #bdc1c6; }
.quota-cell-dark {
    background-color: #202124;
    border-color: #3c4043;
}
.icon-btn-disabled {
    color: #9aa0a6;
}

.notice-dark {
    width: 100%;
    background-color: #3a2e1a;
    border-left-color: #f2b24a;
}
.notice-title-dark {
    color: #f5c46a;
}
.notice-text-dark {
    color: #e8cfa0;
}
</style>
