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
            </template>

            <!-- OpenAI 兼容端点：baseUrl + apiKey -->
            <template v-else>
                <div class="field">
                    <text class="label">服务地址</text>
                    <div class="input" @click="editField('baseUrl')">
                        <text :class="form.baseUrl ? 'input-text' : 'input-text-ph'">{{ form.baseUrl || 'https://api.deepseek.com/v1' }}</text>
                    </div>
                </div>
                <div class="field">
                    <text class="label">API Key（必填）</text>
                    <div class="input" @click="editField('apiKey')">
                        <text :class="form.apiKey ? 'input-text' : 'input-text-ph'">{{ form.apiKey ? maskKey(form.apiKey) : '请输入 API Key' }}</text>
                    </div>
                </div>
                <div class="field">
                    <text class="label">模型 ID</text>
                    <div class="input" @click="editField('openaiModelId')">
                        <text :class="form.openaiModelId ? 'input-text' : 'input-text-ph'">{{ form.openaiModelId || 'deepseek-v4-flash' }}</text>
                    </div>
                </div>
            </template>

            <text class="group-title">默认选项</text>
            <div class="field">
                <text class="label">默认模型</text>
                <div class="modes">
                    <text
                        v-for="m in visibleModes"
                        :key="m.key"
                        :class="form.defaultMode === m.key ? 'chip-active' : 'chip'"
                        @click="setDefaultMode(m.key)">{{ m.label }}</text>
                </div>
            </div>
            <div class="field">
                <text class="label">默认深度思考</text>
                <text :class="form.defaultThinking ? 'chip-active' : 'chip'" @click="form.defaultThinking = !form.defaultThinking">{{ form.defaultThinking ? '开启' : '关闭' }}</text>
            </div>
            <div class="field">
                <text class="label">默认联网搜索</text>
                <text :class="form.defaultSearch ? 'chip-active' : 'chip'" @click="form.defaultSearch = !form.defaultSearch">{{ form.defaultSearch ? '开启' : '关闭' }}</text>
            </div>
            <div class="field">
                <text class="label">默认展开思考过程</text>
                <text :class="form.defaultExpandThinking ? 'chip-active' : 'chip'" @click="form.defaultExpandThinking = !form.defaultExpandThinking">{{ form.defaultExpandThinking ? '展开' : '收起' }}</text>
            </div>
            <div class="field">
                <text class="label">流式输出（SSE）</text>
                <text :class="form.sse ? 'chip-active' : 'chip'" @click="form.sse = !form.sse">{{ form.sse ? '开启' : '关闭' }}</text>
            </div>

            <text class="group-title">外观</text>
            <div class="field">
                <text class="label">深色模式</text>
                <div class="modes">
                    <text :class="themeChipClass('light')" @click="setTheme('light')">浅色</text>
                    <text :class="themeChipClass('dark')" @click="setTheme('dark')">深色</text>
                </div>
            </div>

            <text class="group-title">提示词</text>
            <div class="field">
                <text class="label">系统提示词（可选）</text>
                <div class="input" @click="editField('systemPrompt')">
                    <text :class="form.systemPrompt ? 'input-text' : 'input-text-ph'">{{ form.systemPrompt || '例如：你是一个乐于助人的助手' }}</text>
                </div>
            </div>

            <text class="group-title">实验性（调试模式）</text>
            <div class="field" v-if="form.debugMode">
                <text class="label">竖屏交互（旋转 90°）</text>
                <text :class="form.portrait ? 'chip-active' : 'chip'" @click="form.portrait = !form.portrait">{{ form.portrait ? '开启' : '关闭' }}</text>
            </div>
            <div class="field">
                <text class="label">启用调试日志</text>
                <text :class="form.debugLog ? 'chip-active' : 'chip'" @click="form.debugLog = !form.debugLog">{{ form.debugLog ? '开启' : '关闭' }}</text>
            </div>

            <text class="danger" @click="resetData">清空全部对话数据</text>
            <text class="about" @click="onVersionTap">Deepseek · 词典笔版 {{ appVersion }}</text>
            <text v-if="form.debugMode" class="debug-badge" @click="disableDebug">调试模式已开启（点击关闭）</text>
            <text class="about-sub">后端：ds-free-api（OpenAI 兼容）</text>
            <text :class="dc('log-link')" @click="showLogModal = true">查看诊断日志</text>
            <text v-if="saveMsg && !showSaveModal" :class="saved ? 'save-msg-ok' : 'save-msg'">{{ saveMsg }}</text>
        </scroller>

        <!-- 诊断日志弹窗 -->
        <div v-if="showLogModal" :class="dc('save-mask')">
            <div :class="dc('save-modal-box')" style="max-width: 90%;">
                <text :class="dc('save-modal-title')">诊断日志</text>
                <scroller style="max-height: 400px; margin-bottom: 12px;">
                    <text style="font-size: 14px; color: #666666; line-height: 20px;">{{ logContent || '暂无日志' }}</text>
                </scroller>
                <div style="flex-direction: row; justify-content: center;">
                    <text :class="dc('save-modal-btn')" @click="showLogModal = false">关闭</text>
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
import { DEFAULT_SETTINGS, APP_VERSION, loadSettings, saveSettings, loadConversations, saveConversations, deleteMessages, saveActiveId, readLocalDsPass } from '../../services/store.js'
import { openTextEditor, updateDsFreeApiAccount, INPUT_TYPES, deployBackend } from '../../services/native.js'
import { appLog, appLogTail } from '../../services/app-log.js'

export default {
    name: 'settings',
    data() {
        return {
            MODES,
            appVersion: APP_VERSION,
            form: Object.assign({}, DEFAULT_SETTINGS),
            saved: false,
            saving: false,
            saveMsg: '',
            showSaveModal: false,
            backendError: '',
            backendDeploying: false,
            showLogModal: false,
            logContent: ''
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
                this.logContent = appLogTail(40)
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
            // 识图模式属于实验性能力，只在调试模式下显示
            if (this.form && this.form.debugMode) return MODES
            return MODES.filter((m) => m.key !== 'vision')
        }
    },
    methods: {
        async init() {
            this.form = await loadSettings()
            // 读取本机已配置密码的掩码预览，避免“已配置”时密码栏空白
            const pass = await readLocalDsPass()
            this.form.dsPassPreview = pass ? this.maskKey(pass) : ''
            // 后台部署后端（不阻塞页面渲染，避免"保存键按不下去"）
            this.backendError = ''
            if (this.form.authMode === 'builtin') {
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
        async editField(field) {
            // Bug 4：把当前值作为预填充文本带回 IME，编辑已有设置项时能看到原文。
            // 敏感字段（API Key / 密码）不回显真实值，避免在输入法中暴露秘密。
            const SENSITIVE = { apiKey: true, dsPass: true, dsPassPreview: true }
            const current = SENSITIVE[field] ? '' : (this.form[field] || '')
            const text = await openTextEditor(INPUT_TYPES.EN_US_ONLY, current)
            if (text === null) return
            this.form[field] = String(text).trim()
            this.$forceUpdate()
        },
        setTheme(key) {
            this.form.theme = key
            appLog('[settings] 切换主题 theme=' + key + ' isDark将变=' + (key === 'dark'))
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
            return (this.form.theme || 'light') === key ? 'chip-active' : 'chip'
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
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #1e1e1e;
    padding: 8px;
}
.icon-btn-dark {
    font-size: 22px;
    color: #ffffff;
    padding: 6px 10px;
}
.title-dark {
    font-size: 22px;
    color: #ffffff;
}
.group-title-dark {
    font-size: 18px;
    color: #ffffff;
    margin: 16px 12px 6px 12px;
}
.label-dark {
    font-size: 18px;
    color: #ffffff;
    margin-bottom: 6px;
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
    background-color: #2a2a2a;
    border-radius: 10px;
    padding: 10px 14px;
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
    font-size: 16px;
    color: #ffffff;
}
.field-hint-warn-dark {
    font-size: 16px;
    color: #ffffff;
}
.backend-error-dark {
    font-size: 16px;
    color: #ffffff;
}
.danger-dark {
    font-size: 20px;
    color: #ffffff;
    text-align: center;
    margin-top: 24px;
}
.about-dark {
    font-size: 18px;
    color: #ffffff;
    text-align: center;
    margin-top: 16px;
}
.about-sub-dark {
    font-size: 16px;
    color: #ffffff;
    text-align: center;
}
.log-link-dark {
    font-size: 16px;
    color: #ffffff;
    text-align: center;
    padding: 6px 0;
}
.save-msg-ok-dark {
    font-size: 16px;
    color: #ffffff;
    text-align: center;
}
.save-msg-dark {
    font-size: 16px;
    color: #ffffff;
    text-align: center;
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
</style>