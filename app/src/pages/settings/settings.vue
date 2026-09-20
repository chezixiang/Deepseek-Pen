<template>
    <div :class="isDark ? 'page page-dark' : 'page'">
        <div :class="dc('topbar')">
            <text :class="dc('icon-btn')" @click="back">返回</text>
            <text :class="dc('title')">设置</text>
            <text :class="dc('icon-btn')" @click="save">保存</text>
        </div>

        <scroller class="body" scroll-direction="vertical">
            <text :class="dc('group-title')">认证方式</text>
            <text v-if="backendError" :class="dc('backend-error')">{{ backendError }}</text>
            <div :class="dc('field')">
                <text :class="dc('label')">认证模式</text>
                <div class="modes">
                    <text :class="form.authMode === 'builtin' ? dc('chip-active') : dc('chip')" @click="setAuthMode('builtin')">内置 ds-free-api</text>
                    <text :class="form.authMode === 'openai' ? dc('chip-active') : dc('chip')" @click="setAuthMode('openai')">OpenAI 兼容端点</text>
                </div>
            </div>

            <!-- 内置 ds-free-api：DeepSeek 官方账号密码 -->
            <template v-if="form.authMode === 'builtin'">
                <div :class="dc('field')">
                    <text :class="dc('label')">DeepSeek 账号（邮箱或手机号）</text>
                    <div :class="dc('input')" @click="editField('dsUser')">
                        <text :class="form.dsUser ? dc('input-text') : dc('input-text-ph')">{{ form.dsUser || '点击输入' }}</text>
                    </div>
                </div>
                <div :class="dc('field')">
                    <text :class="dc('label')">DeepSeek 密码</text>
                    <div :class="dc('input')" @click="editField('dsPass')">
                        <text :class="form.dsPass ? dc('input-text') : dc('input-text-ph')">{{ dsPassDisplay() }}</text>
                    </div>
                </div>
                <text :class="form.dsConfigured ? dc('field-hint') : dc('field-hint-warn')">{{ form.dsConfigured ? '已配置账号，可直接对话' : '未配置账号，请填写后保存' }}</text>
                <text v-if="trouble.length" :class="dc('field-hint-warn')">⚠️ 最近账号异常 {{ trouble.length }} 次，最早检出 {{ fmtTime(trouble[0].t) }}（{{ trouble[0].kind }}）：{{ trouble[0].message }}</text>
                <div :class="dc('field')">
                    <text :class="dc('label')">设备验证（登录被设备风控拒绝时使用）</text>
                    <text :class="dc('chip')" @click="openDeviceVerify">打开本机浏览器生成设备凭据</text>
                    <text :class="dc('field-hint')">将在本机浏览器中运行 DeepSeek 官方设备组件，自动生成凭据并写入配置，完成后返回本应用重新保存账号</text>
                    <text v-if="deviceVerifyMsg" :class="dc('field-hint')">{{ deviceVerifyMsg }}</text>
                </div>
            </template>

            <!-- OpenAI 兼容端点：baseUrl + apiKey -->
            <template v-else>
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
                <div :class="dc('field')">
                    <text :class="dc('label')">模型 ID</text>
                    <div :class="dc('input')" @click="editField('openaiModelId')">
                        <text :class="form.openaiModelId ? dc('input-text') : dc('input-text-ph')">{{ form.openaiModelId || 'deepseek-v4-flash' }}</text>
                    </div>
                </div>
            </template>

            <text :class="dc('group-title')">默认选项</text>
            <!-- 官方已把快速/专家/识图合并为单一模型，只有多个模式时才显示选择器 -->
            <div :class="dc('field')" v-if="visibleModes.length > 1">
                <text :class="dc('label')">默认模型</text>
                <div class="modes">
                    <text
                        v-for="m in visibleModes"
                        :key="m.key"
                        :class="form.defaultMode === m.key ? dc('chip-active') : dc('chip')"
                        @click="setDefaultMode(m.key)">{{ m.label }}</text>
                </div>
            </div>
            <div :class="dc('field')">
                <text :class="dc('label')">默认深度思考</text>
                <text :class="form.defaultThinking ? dc('chip-active') : dc('chip')" @click="form.defaultThinking = !form.defaultThinking">{{ form.defaultThinking ? '开启' : '关闭' }}</text>
            </div>
            <div :class="dc('field')">
                <text :class="dc('label')">默认联网搜索</text>
                <text :class="form.defaultSearch ? dc('chip-active') : dc('chip')" @click="form.defaultSearch = !form.defaultSearch">{{ form.defaultSearch ? '开启' : '关闭' }}</text>
            </div>
            <div :class="dc('field')">
                <text :class="dc('label')">默认展开思考过程</text>
                <text :class="form.defaultExpandThinking ? dc('chip-active') : dc('chip')" @click="form.defaultExpandThinking = !form.defaultExpandThinking">{{ form.defaultExpandThinking ? '展开' : '收起' }}</text>
            </div>
            <div :class="dc('field')">
                <text :class="dc('label')">流式输出（SSE）</text>
                <text :class="form.sse ? dc('chip-active') : dc('chip')" @click="form.sse = !form.sse">{{ form.sse ? '开启' : '关闭' }}</text>
            </div>

            <text :class="dc('group-title')">外观</text>
            <div :class="dc('field')">
                <text :class="dc('label')">深色模式</text>
                <div class="modes">
                    <text :class="themeChipClass('light')" @click="setTheme('light')">浅色</text>
                    <text :class="themeChipClass('dark')" @click="setTheme('dark')">深色</text>
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
            <div :class="dc('field')" v-if="form.debugMode">
                <text :class="dc('label')">竖屏交互（旋转 90°）</text>
                <text :class="form.portrait ? dc('chip-active') : dc('chip')" @click="form.portrait = !form.portrait">{{ form.portrait ? '开启' : '关闭' }}</text>
            </div>
            <div :class="dc('field')">
                <text :class="dc('label')">启用调试日志</text>
                <text :class="form.debugLog ? dc('chip-active') : dc('chip')" @click="form.debugLog = !form.debugLog">{{ form.debugLog ? '开启' : '关闭' }}</text>
            </div>
            <div :class="dc('field')">
                <text :class="dc('label')">Emoji 字体（实验，联网下载约 10MB）</text>
                <text :class="form.emojiFont ? dc('chip-active') : dc('chip')" @click="toggleEmojiFont">{{ form.emojiFont ? '开启' : '关闭' }}</text>
                <text :class="dc('field-hint')">设备不支持字体注册时会自动用文字替换 Emoji（如 [赞]），不会出现白块</text>
                <text v-if="emojiFontMsg" :class="dc('field-hint')">{{ emojiFontMsg }}</text>
            </div>
            <div :class="dc('field')" v-if="form.debugMode">
                <text :class="dc('label')">出站代理（Socks5/HTTP）</text>
                <div :class="dc('input')" @click="editProxy">
                    <text :class="proxyUrl ? dc('input-text') : dc('input-text-ph')">{{ proxyUrl || '未设置，如 socks5://192.168.1.5:1080' }}</text>
                </div>
                <text :class="dc('field-hint')">后端访问 DeepSeek 走此代理（抓包/绕过 WAF 用），留空恢复直连；保存后自动重启后端</text>
                <text v-if="proxyMsg" :class="dc('field-hint')">{{ proxyMsg }}</text>
            </div>

            <text :class="dc('danger')" @click="resetData">清空全部对话数据</text>
            <text :class="dc('about')" @click="onVersionTap">Deepseek · 词典笔版 {{ appVersion }}</text>
            <text v-if="form.debugMode" :class="dc('debug-badge')" @click="disableDebug">调试模式已开启（点击关闭）</text>
            <text :class="dc('about-sub')">后端：ds-free-api（OpenAI 兼容）</text>
            <text :class="dc('log-link')" @click="showLogModal = true">查看诊断日志</text>
            <text v-if="saveMsg && !showSaveModal" :class="saved ? dc('save-msg-ok') : dc('save-msg')">{{ saveMsg }}</text>
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
                    <text :class="logLines === 80 ? dc('log-tab-active') : dc('log-tab')" @click="setLogLines(80)">80行</text>
                    <text :class="logLines === 200 ? dc('log-tab-active') : dc('log-tab')" @click="setLogLines(200)">200行</text>
                    <text :class="logLines === 500 ? dc('log-tab-active') : dc('log-tab')" @click="setLogLines(500)">500行</text>
                    <text :class="logGen === 1 ? dc('log-tab-active') : dc('log-tab')" @click="setLogGen(1)">上一份</text>
                    <text :class="logGen === 0 ? dc('log-tab-active') : dc('log-tab')" @click="setLogGen(0)">当前</text>
                </div>
                <scroller :class="dc('log-body')" scroll-direction="vertical">
                    <text :class="dc('log-text')">{{ logContent || '暂无日志' }}</text>
                </scroller>
                <div class="log-foot">
                    <text :class="dc('log-btn')" @click="refreshLog">刷新</text>
                    <text :class="dc('log-btn-danger')" @click="clearLog">清空当前日志</text>
                </div>
            </div>
        </div>

        <!-- 保存结果提示：显眼的浮层，用户确认后再返回 -->
        <div v-if="showSaveModal" :class="dc('save-mask')">
            <div :class="dc('save-modal-box')">
                <text :class="saved ? dc('save-modal-title') : dc('save-modal-title-error')">{{ saved ? '✓ 已保存' : '✗ 保存失败' }}</text>
                <text :class="dc('save-modal-msg')">{{ saveMsg }}</text>
                <text :class="dc('save-modal-btn')" @click="closeSaveModal">好的</text>
            </div>
        </div>
    </div>
</template>

<script>
import { MODES } from '../../services/ds.js'
import { DEFAULT_SETTINGS, APP_VERSION, loadSettings, saveSettings, loadConversations, saveConversations, deleteMessages, saveActiveId, readLocalDsPass, loadAccountTrouble } from '../../services/store.js'
import { openTextEditor, updateDsFreeApiAccount, readDsFreeApiProxy, updateDsFreeApiProxy, validateProxyUrl, openDeviceVerification, INPUT_TYPES, deployBackend, ensureBackendRunning } from '../../services/native.js'
import { appLog, appLogTail, appLogClear, backendLogTail, backendLogClear } from '../../services/app-log.js'
import { ensureEmojiFont } from '../../services/emoji-font.js'

// 首帧主题预读：与 index.vue 一致，从 $falcon.__dsTheme 同步读取，避免深色用户闪浅色（#7）
function peekBootTheme() {
  try {
    return ($falcon && $falcon.__dsTheme) || 'light'
  } catch (e) {
    return 'light'
  }
}

export default {
    name: 'settings',
    data() {
        return {
            MODES,
            appVersion: APP_VERSION,
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
            deviceVerifyMsg: '',
            trouble: []
        }
    },
    created() {
        this.init()
    },
    watch: {
        isDark(v) {
            appLog('[settings] isDark 实际变化 => ' + v + ' theme=' + (this.form && this.form.theme))
        },
        showLogModal(v) {
            if (v) {
                this.loadLogContent()
                appLog('[settings] 查看诊断日志 theme=' + (this.form && this.form.theme))
            }
        }
    },
    computed: {
        isDark() {
            // 词典笔无系统深色，只有手动开关：'dark' 深色，其余浅色
            return (this.form && this.form.theme) === 'dark'
        },
        visibleModes() {
            // 模型已合并，MODES 只剩一项；保留该 computed 以兼容多模式重新上线的情况
            return MODES
        }
    },
    methods: {
        // 把当前主题缓存到 $falcon 全局（与 index.vue 约定一致，#7）
        cacheTheme() {
            try { $falcon.__dsTheme = (this.form && this.form.theme) || 'light' } catch (e) { /* 忽略 */ }
        },
        async init() {
            this.form = await loadSettings()
            this.cacheTheme()
            // 账号异常取证（首次检出时间）
            this.trouble = await loadAccountTrouble()
            // 读取本机已配置密码的掩码预览，避免“已配置”时密码栏空白
            const pass = await readLocalDsPass()
            this.form.dsPassPreview = pass ? this.maskKey(pass) : ''
            // 后台部署后端（不阻塞页面渲染，避免"保存键按不下去"）
            this.backendError = ''
            if (this.form.authMode === 'builtin') {
              // 读取本机后端当前代理配置（调试模式的出站代理）
              readDsFreeApiProxy()
                .then((u) => {
                  this.proxyUrl = u || ''
                  this.$forceUpdate()
                })
                .catch(() => {})
              // Bug 修复：增加部署状态标记，保存时检查部署是否完成
              this.backendDeploying = true
              this.$forceUpdate()
              deployBackend().then(r => {
                this.backendDeploying = false
                if (!r.ok) {
                  this.backendError = r.message + (r.code ? ' [错误码:' + r.code + ']' : '')
                }
                this.$forceUpdate()
              }).catch(e => {
                this.backendDeploying = false
                this.backendError = '后端部署失败：' + (e.message || e)
                this.$forceUpdate()
              })
            }
            this.$forceUpdate()
        },
        maskKey(key) {
            if (!key) return ''
            if (key.length <= 8) return '****'
            return key.slice(0, 4) + '****' + key.slice(-4)
        },
        dsPassDisplay() {
            if (this.form.dsPass) return this.maskKey(this.form.dsPass)
            // 本机已配置：显示掩码密码，不空白
            if (this.form.dsPassPreview) return this.form.dsPassPreview + '（点击修改）'
            if (this.form.dsConfigured) return '已配置（点击修改）'
            return '点击输入'
        },
        fmtTime(t) {
            const d = new Date(t)
            const p = (n) => (n < 10 ? '0' + n : '' + n)
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
        },
        async editField(field) {
            // Bug 4：把当前值作为预填充文本带回 IME，编辑已有设置项时能看到原文。
            // 敏感字段（API Key / 密码）不回显真实值，避免在输入法中暴露秘密。
            // #2：系统提示词需要中文输入；其余字段（地址/Key/账号）保持英文键盘。
            const SENSITIVE = { apiKey: true, dsPass: true, dsPassPreview: true }
            const CHINESE = { systemPrompt: true }
            const current = SENSITIVE[field] ? '' : (this.form[field] || '')
            const inputType = CHINESE[field] ? INPUT_TYPES.ZH_CN_PREFERRED : INPUT_TYPES.EN_US_ONLY
            const text = await openTextEditor(inputType, current)
            if (text === null) return
            this.form[field] = String(text).trim()
            this.$forceUpdate()
        },
        setTheme(key) {
            this.form.theme = key
            this.cacheTheme()
            appLog('[settings] 切换主题 theme=' + key + ' isDark将变=' + (key === 'dark'))
            this.$forceUpdate()
        },

        // ---------- 诊断日志（#6/#11） ----------
        async loadLogContent() {
            if (this.logSource === 'app') {
                this.logContent = await appLogTail(this.logLines, this.logGen)
            } else {
                this.logContent = await backendLogTail(this.logLines, this.logGen)
            }
            this.$forceUpdate()
        },
        switchLogSource(source) {
            this.logSource = source
            this.loadLogContent()
        },
        setLogLines(n) {
            this.logLines = n
            this.loadLogContent()
        },
        setLogGen(g) {
            this.logGen = g
            this.loadLogContent()
        },
        refreshLog() {
            this.loadLogContent()
        },
        async clearLog() {
            if (this.logSource === 'app') {
                await appLogClear()
            } else {
                await backendLogClear()
            }
            appLog('[settings] 已清空' + (this.logSource === 'app' ? '应用' : '后端') + '日志')
            this.logContent = ''
            this.$forceUpdate()
        },
        // Emoji 字体开关（#2）：开启即下载+注册（成功与否即时反馈）；关闭仅停用
        async toggleEmojiFont() {
            this.form.emojiFont = !this.form.emojiFont
            if (this.form.emojiFont) {
                this.emojiFontMsg = '正在下载字体（约 10MB），请保持网络畅通…'
                this.$forceUpdate()
                try {
                    const r = await ensureEmojiFont()
                    this.emojiFontMsg = r.message
                } catch (e) {
                    this.emojiFontMsg = '失败：' + (e && e.message ? e.message : String(e))
                }
            } else {
                this.emojiFontMsg = '已关闭（重新打开会复用已下载的字体）'
            }
            this.$forceUpdate()
        },
        // 设备验证：拉起本机 WPE 浏览器（miniapp 1779591038449）打开后端
        // /device 辅助页，在真实浏览器环境运行官方数美 SDK 生成 device_id，
        // 由页面直接回写后端配置并重新登录。纯笔内完成。
        async openDeviceVerify() {
            if (this.form.authMode !== 'builtin') {
                this.deviceVerifyMsg = '自定义端点模式无需设备验证（由服务端处理）'
                this.$forceUpdate()
                return
            }
            this.deviceVerifyMsg = '正在确认后端状态…'
            this.$forceUpdate()
            try {
                const r = await ensureBackendRunning()
                if (!r.ok) {
                    this.deviceVerifyMsg = '后端未就绪：' + (r.message || '请稍后重试')
                    this.$forceUpdate()
                    return
                }
                const result = await openDeviceVerification(this.form.apiKey || '')
                this.deviceVerifyMsg = result.message
            } catch (e) {
                this.deviceVerifyMsg = '启动失败：' + (e && e.message ? e.message : String(e))
            }
            this.$forceUpdate()
        },
        // 出站代理（调试模式）：写入本机后端 config.toml 的 [proxy] 段并重启后端。
        // 留空提交 = 清除代理恢复直连。
        async editProxy() {
            const text = await openTextEditor(INPUT_TYPES.EN_US_ONLY, this.proxyUrl || '')
            if (text === null) return
            const v = String(text).trim()
            const invalid = validateProxyUrl(v)
            if (invalid) {
                this.proxyMsg = invalid
                this.$forceUpdate()
                return
            }
            if (this.form.authMode !== 'builtin') {
                this.proxyMsg = '仅内置后端模式使用本机代理（当前为自定义端点模式）'
                this.$forceUpdate()
                return
            }
            this.proxyMsg = v ? '正在写入代理配置并重启后端…' : '正在清除代理并重启后端…'
            this.$forceUpdate()
            try {
                const r = await updateDsFreeApiProxy(v)
                if (r.ok) this.proxyUrl = v
                this.proxyMsg = r.message
                appLog('[settings] 代理更新 ok=' + r.ok + ' msg=' + (r.message || ''))
            } catch (e) {
                this.proxyMsg = '失败：' + (e && e.message ? e.message : String(e))
            }
            this.$forceUpdate()
        },
        setAuthMode(mode) {
            this.form.authMode = mode
            this.$forceUpdate()
        },
        setDefaultMode(key) {
            this.form.defaultMode = key
        },
        themeChipClass(key) {
            return (this.form.theme || 'light') === key ? this.dc('chip-active') : this.dc('chip')
        },
        // 深色模式类名切换：浅色返回原类，深色返回 -dark 变体类（引擎仅支持单类选择器）
        dc(cls) {
            return this.isDark ? (cls + '-dark') : cls
        },
        // 调试模式：连续点击版本号 16 次，弹出输入框，输入 key（182376）开启。
        // 开启后显示实验性开关（如竖屏、调试日志），避免普通用户误触。
        async onVersionTap() {
            const now = Date.now()
            if (!this.tapCount || (now - this.tapLast) > 3000) {
                this.tapCount = 1
            } else {
                this.tapCount += 1
            }
            this.tapLast = now
            if (this.tapCount < 16) return
            this.tapCount = 0
            const key = await openTextEditor('EnUSOnly')
            if (!key) return
            if (key.trim() === '182376') {
                this.form.debugMode = true
                await saveSettings(this.form)
                this.$forceUpdate()
            }
        },
        async disableDebug() {
            this.form.debugMode = false
            this.form.portrait = false
            await saveSettings(this.form)
            this.$forceUpdate()
        },
        async save() {
            if (!this.form || this.saving) return
            
            // Bug 修复：检查后端是否正在部署中，避免用户在部署完成前点击保存
            if (this.backendDeploying) {
                this.saveMsg = '后端服务正在部署中，请稍后再试'
                this.saved = false
                this.showSaveModal = true
                this.$forceUpdate()
                return
            }
            
            this.saving = true
            this.saveMsg = ''
            appLog('[settings] save start theme=' + (this.form.theme || '(空)') + ' authMode=' + this.form.authMode)
            try {
                // OpenAI 兼容端点：API Key 必填
                if (this.form.authMode === 'openai' && !(this.form.apiKey || '').trim()) {
                    this.saveMsg = 'OpenAI 兼容端点需要填写 API Key'
                    this.saved = false
                    this.showSaveModal = true
                    this.$forceUpdate()
                    return
                }
                // 1) 先保存所有设置项（始终执行，不因账号为空而中断）
                this.form.baseUrl = (this.form.baseUrl || '').trim()
                if (!this.form.baseUrl) this.form.baseUrl = 'https://api.deepseek.com/v1'
                // 不把明文密码/掩码预览写入应用设置存储，密码只写入本机 ds-free-api config
                const persistForm = Object.assign({}, this.form)
                delete persistForm.dsPass
                delete persistForm.dsPassPreview
                await saveSettings(persistForm)
                this.cacheTheme()

                // 2) 内置模式：若填了账号密码，则写入本机 ds-free-api 配置并重启（可选步骤）
                let accountMsg = ''
                let accountResult = null
                if (this.form.authMode === 'builtin') {
                    if (this.form.dsUser && this.form.dsPass) {
                        accountResult = await updateDsFreeApiAccount(this.form.dsUser, this.form.dsPass)
                        accountMsg = accountResult.message || ''
                        // 成功后把后端生成的新 API Key 同步到应用设置，避免旧 key 导致 401 未认证
                        if (accountResult.ok && accountResult.apiKey) {
                            this.form.apiKey = accountResult.apiKey
                            await saveSettings(Object.assign({}, this.form, { dsPass: undefined, dsPassPreview: undefined }))
                            appLog('[settings] 已同步新 apiKey 到应用设置 len=' + accountResult.apiKey.length)
                        }
                    } else if (this.form.dsConfigured) {
                        accountMsg = '已保存设置（沿用本机已配置的账号）'
                    } else {
                        accountMsg = '已保存设置（未配置 DeepSeek 账号）'
                    }
                }

                // 显眼的保存提示：弹窗确认后再返回
                const accountFailed = !!(accountResult && !accountResult.ok)
                if (accountFailed && accountResult && accountResult.code) {
                  // 失败：标题红色，message + 错误码清晰展示
                  this.saveMsg = accountResult.message + ' [错误码:' + accountResult.code + ']'
                  this.saved = false
                } else {
                  this.saveMsg = accountFailed ? accountMsg : (accountMsg || '已保存')
                  this.saved = !accountFailed
                }
                this.showSaveModal = true
                this.$forceUpdate()
            } finally {
                this.saving = false
                this.$forceUpdate()
            }
        },
        async resetData() {
            // 清空所有会话与其消息，保留设置
            const list = await loadConversations()
            for (const c of list) {
                try {
                    await deleteMessages(c.id)
                } catch (e) { /* 忽略 */ }
            }
            await saveConversations([])
            await saveActiveId(null)
            this.back()
        },
        closeSaveModal() {
            this.showSaveModal = false
            this.back()
        },
        back() {
            if (this.$page && this.$page.finish) {
                this.$page.finish()
            }
        }
    }
}
</script>

<style lang="less" scoped>
.page {
    flex: 1;
    flex-direction: column;
    background-color: #f2f3f5;
    position: relative;
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

.field-hint {
    font-size: 14px;
    color: #999999;
    padding: 8px 16px 12px 16px;
}
.field-hint-warn {
    font-size: 14px;
    color: #d93025;
    padding: 8px 16px 12px 16px;
}
.save-msg {
    font-size: 16px;
    color: #d93025;
    text-align: center;
    padding: 8px 16px;
}
.save-msg-ok {
    font-size: 16px;
    color: #188038;
    text-align: center;
    padding: 8px 16px;
}
.group-title {
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

.danger {
    font-size: 20px;
    color: #d93025;
    text-align: center;
    padding: 24px 16px;
}
.backend-error {
    font-size: 16px;
    color: #d93025;
    text-align: center;
    padding: 10px 16px;
    background-color: #fce8e6;
    border-radius: 8px;
    margin: 0 16px 12px;
}

.about {
    font-size: 16px;
    color: #aaaaaa;
    text-align: center;
    margin-top: 20px;
    padding: 6px 0;
}
.debug-badge {
    font-size: 14px;
    color: #1a73e8;
    text-align: center;
    margin-top: 6px;
    padding: 4px 0;
}
.about-sub {
    font-size: 14px;
    color: #cccccc;
    text-align: center;
    margin-top: 4px;
    margin-bottom: 30px;
}
.log-link {
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

/* ========== 深色模式（引擎仅支持单类选择器，用 -dark 变体类切换） ========== */
.page-dark {
    background-color: #121212;
}
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
.group-title-dark {
    font-size: 16px;
    color: #999999;
    padding: 16px 16px 6px 16px;
}
.label-dark {
    font-size: 16px;
    color: #aaaaaa;
    margin-bottom: 8px;
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
    color: #ffffff;
}
.field-hint-dark {
    font-size: 14px;
    color: #999999;
    padding: 8px 16px 12px 16px;
}
.field-hint-warn-dark {
    font-size: 14px;
    color: #ff8a80;
    padding: 8px 16px 12px 16px;
}
.backend-error-dark {
    font-size: 16px;
    color: #ff8a80;
    text-align: center;
    padding: 10px 16px;
    background-color: #3d1f1f;
    border-radius: 8px;
    margin: 0 16px 12px;
}
.danger-dark {
    font-size: 20px;
    color: #ff8a80;
    text-align: center;
    padding: 24px 16px;
}
.about-dark {
    font-size: 16px;
    color: #aaaaaa;
    text-align: center;
    margin-top: 20px;
    padding: 6px 0;
}
.about-sub-dark {
    font-size: 14px;
    color: #777777;
    text-align: center;
    margin-top: 4px;
    margin-bottom: 30px;
}
.log-link-dark {
    font-size: 16px;
    color: #82b1ff;
    text-align: center;
    padding: 6px 0;
}
.save-msg-ok-dark {
    font-size: 16px;
    color: #81c995;
    text-align: center;
    padding: 8px 16px;
}
.save-msg-dark {
    font-size: 16px;
    color: #ff8a80;
    text-align: center;
    padding: 8px 16px;
}
.save-mask-dark {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.7);
    justify-content: center;
    align-items: center;
}
.save-modal-box-dark {
    background-color: #1e1e1e;
    border-radius: 16px;
    padding: 24px;
    max-width: 80%;
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
    color: #ffffff;
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
</style>