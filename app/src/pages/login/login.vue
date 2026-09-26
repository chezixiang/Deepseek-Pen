<template>
    <div :class="dc('login-page')">
        <!-- 顶栏：已配置账号（从主页/设置进来）时给「返回」；未配置时本页就是根页面，
             给「退出」并提示右滑也能退出 -->
        <div :class="dc('topbar')">
            <text v-if="canGoBack" :class="dc('back-btn')" @click="back">返回</text>
            <text v-else :class="dc('back-btn')" @click="exitApp">退出</text>
            <text :class="dc('settings-btn')" @click="goSettings">设置</text>
        </div>

        <div :class="dc('body')">
            <!-- 左侧品牌区（对标 Lumo 登录页：左 Logo，右表单） -->
            <div :class="dc('brand')">
                <image :class="dc('logo-mark')" resize="contain" :src="logoUrl" />
                <text :class="dc('brand-title')">DeepSeek</text>
                <text :class="dc('brand-sub')">词典笔版</text>
            </div>

            <!-- 右侧表单区：放在 scroller 里，内容再长也能滑动（修复登录页无法滑动） -->
            <div :class="dc('form-col')">
                <scroller :class="dc('form-scroll')" scroll-direction="vertical">
                    <div :class="dc('card')">
                        <!-- 已登录：只展示当前账号 + 操作，不再堆一张空表单 -->
                        <template v-if="accounts.length && !editing">
                            <text :class="dc('card-title')">当前账号</text>
                            <div :class="dc('acct-box')">
                                <text :class="dc('acct-name')">{{ accounts[0].display }}</text>
                                <text :class="dc('acct-state')">{{ stateText(accounts[0]) }}</text>
                            </div>
                            <div :class="dc('btn-row')">
                                <text :class="dc('btn')" @click="startEdit">切换账号</text>
                                <text :class="dc('btn-ghost-danger')" @click="confirmRemove">退出登录</text>
                            </div>
                            <text :class="dc('hint')">设备凭据（device_id）由本机后端自动生成，无需手动填写</text>
                        </template>

                        <!-- 未登录 / 编辑中：账号密码表单 -->
                        <template v-else>
                            <text :class="dc('card-title')">{{ editing ? '切换账号' : '登录 DeepSeek' }}</text>
                            <div :class="dc('field')">
                                <text :class="dc('label')">邮箱或手机号</text>
                                <div :class="dc('input')" @click="editField('user')">
                                    <text :class="form.user ? dc('input-text') : dc('input-text-ph')">{{ form.user || '点击输入' }}</text>
                                </div>
                            </div>
                            <div :class="dc('field')">
                                <text :class="dc('label')">密码</text>
                                <div :class="dc('input')" @click="editField('pass')">
                                    <text :class="form.pass ? dc('input-text') : dc('input-text-ph')">{{ form.pass ? mask(form.pass) : '点击输入' }}</text>
                                </div>
                            </div>
                            <div :class="dc('btn-row')">
                                <text :class="busy ? dc('btn-disabled') : dc('btn')" @click="submitAccount">{{ busy ? '处理中…' : '登录' }}</text>
                                <text v-if="editing" :class="dc('btn-ghost')" @click="cancelEdit">取消</text>
                            </div>
                            <text :class="dc('hint')">设备凭据（device_id）由本机后端自动生成，无需手动填写</text>
                        </template>

                        <!-- 自定义 OpenAI 兼容端点（高级） -->
                        <div :class="dc('alt')">
                            <text :class="dc('alt-toggle')" @click="showAlt = !showAlt">{{ showAlt ? '收起' : '使用自定义服务地址（高级）' }}</text>
                            <template v-if="showAlt">
                                <div :class="dc('field')">
                                    <text :class="dc('label')">服务地址</text>
                                    <div :class="dc('input')" @click="editField('baseUrl')">
                                        <text :class="form.baseUrl ? dc('input-text') : dc('input-text-ph')">{{ form.baseUrl || 'https://api.deepseek.com/v1' }}</text>
                                    </div>
                                </div>
                                <div :class="dc('field')">
                                    <text :class="dc('label')">API Key</text>
                                    <div :class="dc('input')" @click="editField('apiKey')">
                                        <text :class="form.apiKey ? dc('input-text') : dc('input-text-ph')">{{ form.apiKey ? mask(form.apiKey) : '点击输入' }}</text>
                                    </div>
                                </div>
                                <text :class="dc('btn')" @click="useCustomEndpoint">使用自定义端点</text>
                            </template>
                        </div>

                        <text v-if="msg" :class="isErr ? dc('msg-err') : dc('msg-ok')">{{ msg }}</text>
                    </div>

                    <!-- 账号异常取证：只在有记录时显示，帮助定位封号时间点 -->
                    <div v-if="trouble.length" :class="dc('card-warn')">
                        <text :class="dc('warn-text')">⚠️ 最近账号异常 {{ trouble.length }} 次，最早 {{ fmtTime(trouble[0].t) }}（{{ trouble[0].kind }}）：{{ trouble[0].message }}</text>
                    </div>

                    <text :class="dc('version')">Deepseek · 词典笔版 {{ appVersion }}</text>
                </scroller>
            </div>
        </div>

        <!-- 退出登录确认：清空本机后端账号是破坏性操作，先确认。
             touch 事件在整个遮罩/弹窗上都消费掉：Weex 里未绑定点击的容器不拦截触摸，
             否则点弹窗外或点弹窗空白处会穿透到下层的"退出登录"按钮上 ——
             用户本意是取消，结果账号被清空（表现成"进账号页就掉登录"，bug 2）。 -->
        <div v-if="showRemoveConfirm" :class="dc('mask')" @click="noop">
            <div :class="dc('modal')" @click="noop">
                <text :class="dc('modal-title')">退出登录？</text>
                <text :class="dc('modal-msg')">将清空本机后端配置的账号（{{ accounts.length ? accounts[0].display : '' }}），回到未登录状态。</text>
                <div :class="dc('modal-btns')" @click="noop">
                    <text :class="dc('modal-btn-ghost')" @click="cancelRemove">取消</text>
                    <text :class="dc('modal-btn-danger')" @click="doRemove">退出登录</text>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import {
    loadSettings, saveSettings, APP_VERSION,
    loadAccountList, upsertAccount, removeAccountById, setActiveAccount,
    loadAccountTrouble
} from '../../services/store.js'
import {
    openTextEditor, updateDsFreeApiAccount, clearDsFreeApiAccount,
    INPUT_TYPES, ensureBackendRunning
} from '../../services/native.js'
// 应用图标（与桌面/商店里那条鲸鱼是同一张图）。?base64 让打包器在编译期
// 把它内联成 data URI，运行时不必再依赖包内文件路径。
// 路径按**构建根目录**（app/）解析，不是相对本文件——image 插件直接拿这个
// 字符串去 readFileSync，写成 '../../..' 会去找仓库外的文件而构建失败。
import logoUrl from 'app_icon.png?base64'

// 首帧主题预读（与 index/settings 一致，避免深色闪浅色）
function peekBootTheme() {
    try {
        return ($falcon && $falcon.__dsTheme) || 'light'
    } catch (e) {
        return 'light'
    }
}

export default {
    name: 'login',
    data() {
        return {
            appVersion: APP_VERSION,
            // 模块级 import 不会自动出现在模板作用域，必须挂到实例上（同 settings 的 MODES 写法）
            logoUrl,
            theme: peekBootTheme(),
            accounts: [],
            editing: false,
            busy: false,
            msg: '',
            isErr: false,
            showAlt: false,
            showRemoveConfirm: false,
            // 已配置账号时本页是二级页面（从主页/设置进来），给「返回」
            configured: false,
            form: { user: '', pass: '', baseUrl: '', apiKey: '' },
            trouble: []
        }
    },
    computed: {
        isDark() {
            return this.theme === 'dark'
        },
        canGoBack() {
            return this.configured
        }
    },
    created() {
        // 登录页是应用入口页：右滑（系统返回手势 / 返回键）应当**退出应用**，
        // 而不是被禁用。旧实现调用 npage.setDisableLeftSwipeBack(true)，把入口页的
        // 退出手势整个吃掉 —— 用户被关在登录页里出不去（bug 1）。
        //
        // 正确做法：开启返回事件（$npage.setSupportBack(true)），在 backpressed 里
        // 自己决定行为：作为根页面时退出应用；从主页/设置进来时按普通返回。
        this.enableBackExit()
        this.$page.on('show', this.onShow)
        this.init()
    },
    destroyed() {
        try { this.$page.off('show', this.onShow) } catch (e) { /* 忽略 */ }
        try { this.$page.off('backpressed', this.onBackPressed) } catch (e) { /* 忽略 */ }
        if (this._npBackBound) {
            try { this.$page.$npage.off('backpressed', this.onBackPressed) } catch (e) { /* 忽略 */ }
        }
    },
    methods: {
        // 深色模式类名（引擎仅支持单类选择器，故浅/深各一套）
        dc(cls) {
            return this.isDark ? (cls + '-dark') : cls
        },
        enableBackExit() {
            // 两套事件 API 都注册：框架把 backpressed 既可能从 $falcon 全局事件派发
            // （$page.on），也可能从 npage 页面实例派发（$npage.on）。两处都挂上，
            // 用 _backHandling 去重，避免同一个返回被处理两次（会连退两页）。
            let bound = false
            try {
                const np = this.$page && this.$page.$npage
                if (np && np.setSupportBack) {
                    np.setSupportBack(true)
                    if (np.on) {
                        np.on('backpressed', this.onBackPressed)
                        this._npBackBound = true
                    }
                    this.$page.on('backpressed', this.onBackPressed)
                    bound = true
                }
            } catch (e) { /* 引擎不支持时走下方兜底 */ }
            if (bound) return
            // 老框架没有 setSupportBack：至少不要禁用滑动返回，让系统手势自己处理
            try {
                const np2 = this.$page && this.$page.$npage
                if (np2 && np2.setDisableLeftSwipeBack) np2.setDisableLeftSwipeBack(false)
            } catch (e) { /* 忽略 */ }
        },
        // 系统返回（返回键 / 右滑手势）：已配置账号时本页是二级页 → 回上一页；
        // 否则是应用入口 → 退出应用
        onBackPressed() {
            if (this._backHandling) return
            this._backHandling = true
            setTimeout(() => { this._backHandling = false }, 400)
            if (this.canGoBack) {
                this.back()
                return
            }
            this.exitApp()
        },
        exitApp() {
            try { $falcon.closeApp() } catch (e) {
                try { $falcon.$app.finish() } catch (e2) { /* 忽略 */ }
            }
        },
        mask(s) {
            const v = String(s || '')
            if (v.length <= 4) return '••••'
            return v.slice(0, 2) + '••••' + v.slice(-2)
        },
        fmtTime(t) {
            const d = new Date(t)
            const p = (n) => (n < 10 ? '0' + n : '' + n)
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
        },
        async init() {
            const settings = await loadSettings()
            this.theme = (settings && settings.theme) || 'light'
            this.form.baseUrl = (settings && settings.baseUrl) || ''
            this.form.apiKey = (settings && settings.apiKey) || ''
            this.configured = !!(settings && settings.dsConfigured)
            await this.reloadAccounts()
            this.trouble = await loadAccountTrouble()
            // 已配置但后端没起来（例如刚重装）时顺手拉起，避免登录页点了没反应
            if (this.configured) {
                ensureBackendRunning().catch(() => { /* 失败不阻断页面 */ })
            }
        },
        async reloadAccounts() {
            this.accounts = await loadAccountList()
        },
        onShow() {
            this.reloadAccounts()
        },
        stateText(a) {
            if (a.state === 'idle') return '可用'
            if (a.state === 'busy') return '使用中'
            if (a.state === 'error') return '登录失败'
            if (a.state === 'invalid') return '不可用'
            return '已配置'
        },
        startEdit() {
            this.editing = true
            this.form.user = ''
            this.form.pass = ''
            this.msg = ''
            this.isErr = false
            this.$forceUpdate()
        },
        cancelEdit() {
            this.editing = false
            this.form.user = ''
            this.form.pass = ''
            this.msg = ''
            this.$forceUpdate()
        },
        async editField(field) {
            const SENSITIVE = { pass: true, apiKey: true }
            const current = SENSITIVE[field] ? '' : (this.form[field] || '')
            const text = await openTextEditor(INPUT_TYPES.EN_US_ONLY, current)
            if (text === null) return
            this.form[field] = String(text).trim()
            this.$forceUpdate()
        },
        // 提交账号：写入 config.toml → 重启后端 → 等待登录（设备凭据自动生成）
        async submitAccount() {
            if (this.busy) return
            const user = String(this.form.user || '').trim()
            const pass = String(this.form.pass || '').trim()
            if (!user) {
                this.fail('请填写邮箱或手机号')
                return
            }
            if (!pass) {
                this.fail('请填写密码')
                return
            }
            this.busy = true
            this.msg = '正在保存并登录（首次会自动生成设备凭据，稍等）…'
            this.isErr = false
            this.$forceUpdate()

            try {
                await upsertAccount(user)
                await saveSettings(Object.assign({}, await loadSettings(), {
                    authMode: 'builtin',
                    dsUser: user
                }))
                const saved = await updateDsFreeApiAccount(user, pass)
                if (!saved.ok) {
                    this.busy = false
                    this.fail(saved.message || '保存失败')
                    return
                }
                await setActiveAccount(user)
                this.configured = true
                this.editing = false
                await this.reloadAccounts()
                this.busy = false
                this.msg = '✓ 登录成功，正在进入…'
                this.isErr = false
                this.$forceUpdate()
                setTimeout(() => {
                    $falcon.navTo('index')
                }, 600)
            } catch (e) {
                this.busy = false
                this.fail('失败：' + (e && e.message ? e.message : String(e)))
            }
        },
        fail(text) {
            this.msg = text
            this.isErr = true
            this.$forceUpdate()
        },
        // 空消费点击：在 Weex 里"绑定过点击"的容器才会拦截触摸，这是挡住事件
        // 穿透到下层按钮的手段（同 index.vue 抽屉的 noopDrawer）
        noop() {},
        cancelRemove() {
            this.showRemoveConfirm = false
            this.$forceUpdate()
        },
        // 退出登录：清空本机后端 config.toml 的账号（真源），再清显示名缓存。
        // 旧实现只删缓存条目，后端账号池仍在用旧凭据登录 —— 「移除」名不副实。
        confirmRemove() {
            this.showRemoveConfirm = true
            this.isErr = false
            this.$forceUpdate()
        },
        async doRemove() {
            const acct = this.accounts[0]
            this.showRemoveConfirm = false
            this.busy = true
            this.msg = '正在退出并重启后端…'
            this.isErr = false
            this.$forceUpdate()
            try {
                const r = await clearDsFreeApiAccount()
                if (acct && acct.id) await removeAccountById(acct.id)
                await setActiveAccount('')
                await saveSettings(Object.assign({}, await loadSettings(), { dsUser: '' }))
                this.configured = false
                this.editing = false
                this.form.user = ''
                this.form.pass = ''
                await this.reloadAccounts()
                this.busy = false
                this.msg = r.ok ? '已退出登录' : (r.message || '已退出登录')
                this.isErr = !r.ok
                this.$forceUpdate()
            } catch (e) {
                this.busy = false
                this.fail('退出失败：' + (e && e.message ? e.message : String(e)))
            }
        },
        async useCustomEndpoint() {
            const baseUrl = String(this.form.baseUrl || '').trim()
            const apiKey = String(this.form.apiKey || '').trim()
            if (!baseUrl || !apiKey) {
                this.fail('请填写服务地址与 API Key')
                return
            }
            try {
                await saveSettings(Object.assign({}, await loadSettings(), {
                    authMode: 'openai',
                    baseUrl,
                    apiKey
                }))
                $falcon.navTo('index')
            } catch (e) {
                this.fail('保存失败：' + (e && e.message ? e.message : String(e)))
            }
        },
        goSettings() {
            try {
                $falcon.navTo('settings')
            } catch (e) { /* 忽略 */ }
        },
        back() {
            // 二级页（从主页/设置进来）→ 关闭本页；根页面（首次启动）→ 退出应用，
            // 与系统返回手势（onBackPressed）保持同一套语义
            if (this.canGoBack && this.$page && this.$page.finish) {
                this.$page.finish()
                return
            }
            this.exitApp()
        }
    }
}
</script>

<style>
/* 浅色 —— 左 Logo / 右表单，对标 Lumo 邮箱登录页 */
.login-page { width: 100vw; height: 100vh; backgroundColor: #f5f6f8; flex-direction: column; }
.topbar { flex-direction: row; align-items: center; justify-content: space-between; padding: 6px 12px; }
.back-btn { fontSize: 20px; color: #1a73e8; padding: 4px 10px; }
.settings-btn { fontSize: 20px; color: #1a73e8; padding: 4px 10px; }

.body { flex: 1; flex-direction: row; paddingLeft: 24px; paddingRight: 24px; paddingBottom: 16px; }

/* 左：品牌 */
.brand { width: 240px; justifyContent: center; alignItems: center; paddingRight: 20px; }
/* image 元素必须显式给宽高，否则不渲染（引擎要求） */
.logo-mark { width: 84px; height: 84px; marginBottom: 14px; }
.brand-title { fontSize: 30px; color: #1f2329; fontWeight: bold; }
.brand-sub { fontSize: 14px; color: #8b8f96; marginTop: 4px; }

/* 右：表单 */
.form-col { flex: 1; justifyContent: center; }
.form-scroll { flex: 1; }
.card { backgroundColor: #ffffff; borderRadius: 16px; padding: 16px 18px; }
.card-warn { backgroundColor: #fdecea; borderRadius: 12px; padding: 10px 12px; marginTop: 10px; }
.warn-text { fontSize: 13px; color: #d93025; lineHeight: 18px; }
.card-title { fontSize: 20px; color: #1f2329; fontWeight: bold; marginBottom: 10px; }

.acct-box { backgroundColor: #f0f2f5; borderRadius: 10px; padding: 10px 12px; marginBottom: 12px; flex-direction: row; align-items: center; justify-content: space-between; }
.acct-name { fontSize: 18px; color: #1f2329; }
.acct-state { fontSize: 13px; color: #1a9c5b; }

.field { marginBottom: 10px; }
.label { fontSize: 13px; color: #8b8f96; marginBottom: 4px; }
.input { minHeight: 38px; backgroundColor: #f5f6f8; borderRadius: 10px; padding: 8px 10px; justifyContent: center; }
.input-text { fontSize: 17px; color: #1f2329; }
.input-text-ph { fontSize: 17px; color: #a8adb5; }

.btn { backgroundColor: #4d6bfe; color: #ffffff; fontSize: 18px; textAlign: center; paddingTop: 10px; paddingBottom: 10px; borderRadius: 10px; }
.btn-disabled { backgroundColor: #b6c7dd; color: #ffffff; fontSize: 18px; textAlign: center; paddingTop: 10px; paddingBottom: 10px; borderRadius: 10px; }
.btn-ghost { color: #4d6bfe; fontSize: 15px; textAlign: center; paddingTop: 8px; }
.btn-ghost-danger { color: #d93025; fontSize: 15px; textAlign: center; paddingTop: 8px; }
.btn-row { marginTop: 4px; }

.hint { fontSize: 12px; color: #8b8f96; marginTop: 8px; lineHeight: 18px; }
.msg-ok { fontSize: 14px; color: #1a9c5b; marginTop: 8px; }
.msg-err { fontSize: 14px; color: #d93025; marginTop: 8px; }

.alt { marginTop: 14px; borderTopWidth: 1px; borderTopColor: #eef0f3; paddingTop: 10px; }
.alt-toggle { fontSize: 14px; color: #4d6bfe; marginBottom: 8px; }
.version { fontSize: 12px; color: #b0b4ba; textAlign: center; marginTop: 10px; }

/* 退出确认弹窗 */
.mask { position: absolute; top: 0; bottom: 0; left: 0; right: 0; backgroundColor: rgba(0,0,0,0.5); alignItems: center; justifyContent: center; }
.modal { width: 420px; backgroundColor: #ffffff; borderRadius: 16px; padding: 20px; alignItems: center; }
.modal-title { fontSize: 24px; fontWeight: bold; color: #1f2329; marginBottom: 8px; }
.modal-msg { fontSize: 16px; color: #5f6873; textAlign: center; marginBottom: 16px; lineHeight: 22px; }
.modal-btns { flex-direction: row; align-items: center; }
.modal-btn-ghost { fontSize: 18px; color: #5f6873; padding: 8px 22px; marginRight: 12px; backgroundColor: #f0f2f5; borderRadius: 18px; }
.modal-btn-danger { fontSize: 18px; color: #ffffff; padding: 8px 22px; backgroundColor: #d93025; borderRadius: 18px; }

/* 深色 */
.login-page-dark { width: 100vw; height: 100vh; backgroundColor: #0c1014; flex-direction: column; }
.topbar-dark { flex-direction: row; align-items: center; justify-content: space-between; padding: 6px 12px; }
.back-btn-dark { fontSize: 20px; color: #6ba8ff; padding: 4px 10px; }
.settings-btn-dark { fontSize: 20px; color: #6ba8ff; padding: 4px 10px; }
.body-dark { flex: 1; flex-direction: row; paddingLeft: 24px; paddingRight: 24px; paddingBottom: 16px; }
.brand-dark { width: 240px; justifyContent: center; alignItems: center; paddingRight: 20px; }
.logo-mark-dark { width: 84px; height: 84px; marginBottom: 14px; }
.brand-title-dark { fontSize: 30px; color: #f5f7fa; fontWeight: bold; }
.brand-sub-dark { fontSize: 14px; color: #7d858f; marginTop: 4px; }
.form-col-dark { flex: 1; justifyContent: center; }
.form-scroll-dark { flex: 1; }
.card-dark { backgroundColor: #151b22; borderRadius: 16px; padding: 16px 18px; }
.card-warn-dark { backgroundColor: #3d1f1f; borderRadius: 12px; padding: 10px 12px; marginTop: 10px; }
.warn-text-dark { fontSize: 13px; color: #ff8a80; lineHeight: 18px; }
.card-title-dark { fontSize: 20px; color: #f5f7fa; fontWeight: bold; marginBottom: 10px; }
.acct-box-dark { backgroundColor: #0c1014; borderRadius: 10px; padding: 10px 12px; marginBottom: 12px; flex-direction: row; align-items: center; justify-content: space-between; }
.acct-name-dark { fontSize: 18px; color: #f5f7fa; }
.acct-state-dark { fontSize: 13px; color: #56d364; }
.field-dark { marginBottom: 10px; }
.label-dark { fontSize: 13px; color: #7d858f; marginBottom: 4px; }
.input-dark { minHeight: 38px; backgroundColor: #0c1014; borderRadius: 10px; padding: 8px 10px; justifyContent: center; }
.input-text-dark { fontSize: 17px; color: #f5f7fa; }
.input-text-ph-dark { fontSize: 17px; color: #5f6873; }
.btn-dark { backgroundColor: #2f81f7; color: #ffffff; fontSize: 18px; textAlign: center; paddingTop: 10px; paddingBottom: 10px; borderRadius: 10px; }
.btn-disabled-dark { backgroundColor: #2b3b4d; color: #7d858f; fontSize: 18px; textAlign: center; paddingTop: 10px; paddingBottom: 10px; borderRadius: 10px; }
.btn-ghost-dark { color: #6ba8ff; fontSize: 15px; textAlign: center; paddingTop: 8px; }
.btn-ghost-danger-dark { color: #ff8a80; fontSize: 15px; textAlign: center; paddingTop: 8px; }
.btn-row-dark { marginTop: 4px; }
.hint-dark { fontSize: 12px; color: #7d858f; marginTop: 8px; lineHeight: 18px; }
.msg-ok-dark { fontSize: 14px; color: #56d364; marginTop: 8px; }
.msg-err-dark { fontSize: 14px; color: #ff8a80; marginTop: 8px; }
.alt-dark { marginTop: 14px; borderTopWidth: 1px; borderTopColor: #232b34; paddingTop: 10px; }
.alt-toggle-dark { fontSize: 14px; color: #6ba8ff; marginBottom: 8px; }
.version-dark { fontSize: 12px; color: #5f6873; textAlign: center; marginTop: 10px; }
.mask-dark { position: absolute; top: 0; bottom: 0; left: 0; right: 0; backgroundColor: rgba(0,0,0,0.7); alignItems: center; justifyContent: center; }
.modal-dark { width: 420px; backgroundColor: #151b22; borderRadius: 16px; padding: 20px; alignItems: center; }
.modal-title-dark { fontSize: 24px; fontWeight: bold; color: #f5f7fa; marginBottom: 8px; }
.modal-msg-dark { fontSize: 16px; color: #a8adb5; textAlign: center; marginBottom: 16px; lineHeight: 22px; }
.modal-btns-dark { flex-direction: row; align-items: center; }
.modal-btn-ghost-dark { fontSize: 18px; color: #a8adb5; padding: 8px 22px; marginRight: 12px; backgroundColor: #232b34; borderRadius: 18px; }
.modal-btn-danger-dark { fontSize: 18px; color: #ffffff; padding: 8px 22px; backgroundColor: #c0392b; borderRadius: 18px; }
</style>
