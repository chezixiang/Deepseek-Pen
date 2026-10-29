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
                        <template v-if="builtinEnabled && accounts.length && !editing">
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
                        <template v-else-if="builtinEnabled">
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

                        <template v-else>
                            <text :class="dc('card-title')">连接服务</text>
                            <text :class="dc('hint')">DeepSeek 账号登录模式已暂停，请使用下方自定义 OpenAI 兼容端点</text>
                        </template>

                        <!-- 自定义 OpenAI 兼容端点（高级） -->
                        <div :class="dc('alt')">
                            <text v-if="builtinEnabled" :class="dc('alt-toggle')" @click="showAlt = !showAlt">{{ showAlt ? '收起' : '使用自定义服务地址（高级）' }}</text>
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
                        <text :class="dc('warn-text')">注意：最近账号异常 {{ trouble.length }} 次，最早 {{ fmtTime(trouble[0].t) }}（{{ trouble[0].kind }}）：{{ trouble[0].message }}</text>
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

import { peekBootTheme } from '../../services/theme.js'
import { APP_VERSION, BUILTIN_AUTH_ENABLED, loadSettings, loadAccountTrouble, ensureBackendRunning, loadAccountList, openTextEditor, notifyKeyboardResult, INPUT_TYPES, upsertAccount, saveSettings, updateDsFreeApiAccount, setActiveAccount, clearDsFreeApiAccount, removeAccountById, appLogError } from '../../services/store.js'

const logoUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALUAAAC1CAYAAAAZU76pAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGMWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgOS4xLWMwMDIgNzkuYjdjNjRjYywgMjAyNC8wNy8xNi0wNzo1OTo0MCAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnBob3Rvc2hvcD0iaHR0cDovL25zLmFkb2JlLmNvbS9waG90b3Nob3AvMS4wLyIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDI2LjAgKFdpbmRvd3MpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAyNi0wOC0xN1QxMjozODozOSswODowMCIgeG1wOk1vZGlmeURhdGU9IjIwMjYtMDgtMTdUMTI6NDM6MTIrMDg6MDAiIHhtcDpNZXRhZGF0YURhdGU9IjIwMjYtMDgtMTdUMTI6NDM6MTIrMDg6MDAiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOmFlOTM4NGRmLThhZDgtODM0NS04Njg0LTYxNjc3YTliM2UxYiIgeG1wTU06RG9jdW1lbnRJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjBiZjcwN2QwLTc5YjAtMzI0ZC05YTI2LTkzOWZkNjQ5MGY0MyIgeG1wTU06T3JpZ2luYWxEb2N1bWVudElEPSJ4bXAuZGlkOmY3MWFmM2ExLTU4NzAtNjU0ZS1hYTViLTVkYWRjZjQ5NGEzMiI+IDx4bXBNTTpIaXN0b3J5PiA8cmRmOlNlcT4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImNyZWF0ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6ZjcxYWYzYTEtNTg3MC02NTRlLWFhNWItNWRhZGNmNDk0YTMyIiBzdEV2dDp3aGVuPSIyMDI2LTA4LTE3VDEyOjM4OjM5KzA4OjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgMjYuMCAoV2luZG93cykiLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImNvbnZlcnRlZCIgc3RFdnQ6cGFyYW1ldGVycz0iZnJvbSBhcHBsaWNhdGlvbi92bmQuYWRvYmUucGhvdG9zaG9wIHRvIGltYWdlL3BuZyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6YWU5Mzg0ZGYtOGFkOC04MzQ1LTg2ODQtNjE2NzdhOWIzZTFiIiBzdEV2dDp3aGVuPSIyMDI2LTA4LTE3VDEyOjQzOjEyKzA4OjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgMjYuMCAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+JzInugAAdkxJREFUeAHs4dmz5Ped3vm9n8/3l5knz14rqgpVhcK+cAVBcAEXkWJv7J6WNJZGnhmNwjP2hS/8l0z40vbdRMhXE56wJhyOGbkXTUvdbLFJNpvN5gKQ2IEqAFWo9dTZM/P3/Tw+mVnLOUBhZWFpCa9X84f/4v/Cs88+y8bqGqPRiHY0YjAYMBwNuc5pQsI2Y7Zp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";

export default {
    name: 'login',
    data() {
        return {
            appVersion: APP_VERSION,
            // 模块级 import 不会自动出现在模板作用域，必须挂到实例上（同 settings 的 MODES 写法）
            logoUrl,
            theme: peekBootTheme(),
            // 账号登录模式开关（false 时本页只保留自定义端点表单，账号相关代码保留）
            builtinEnabled: BUILTIN_AUTH_ENABLED,
            accounts: [],
            editing: false,
            busy: false,
            msg: '',
            isErr: false,
            // 账号模式暂停时直接展开自定义端点表单，用户不用再点一次「高级」
            showAlt: !BUILTIN_AUTH_ENABLED,
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
            // 账号模式暂停时本页只作为「连接服务」页使用，任何入口都应能返回
            return this.configured || !this.builtinEnabled
        }
    },
    created() {
        // 登录页是应用入口页：右滑（系统返回手势 / 返回键）应当**退出应用**，
        // 而不是被禁用。旧实现调用 npage.setDisableLeftSwipeBack(true)，把入口页的
        // 退出手势整个吃掉 —— 用户被关在登录页里出不去（bug 1）。
        //
        // 正确做法：开启返回事件（$npage.setSupportBack(true)），在 backpressed 里
        // 自己决定行为：作为根页面时退出应用；从主页/设置进来时按普通返回。
        this.enableBackExit();
        this.$page.on('show', this.onShow);
        this.init();
    },
    destroyed() {
        try { this.$page.off('show', this.onShow); } catch (e) { /* 忽略 */ }
        try { this.$page.off('backpressed', this.onBackPressed); } catch (e) { /* 忽略 */ }
        if (this._npBackBound) {
            try { this.$page.$npage.off('backpressed', this.onBackPressed); } catch (e) { /* 忽略 */ }
        }
    },
    methods: {
        // Loli 键盘通过 kbCaller 回到本页，onNewOptions 是官方回传通道
        onNewOptions(options) {
            if (notifyKeyboardResult(options)) this.$forceUpdate()
        },
        // 深色模式类名（引擎仅支持单类选择器，故浅/深各一套）
        dc(cls) {
            return this.isDark ? (cls + '-dark') : cls
        },
        enableBackExit() {
            // 两套事件 API 都注册：框架把 backpressed 既可能从 $falcon 全局事件派发
            // （$page.on），也可能从 npage 页面实例派发（$npage.on）。两处都挂上，
            // 用 _backHandling 去重，避免同一个返回被处理两次（会连退两页）。
            let bound = false;
            try {
                const np = this.$page && this.$page.$npage;
                if (np && np.setSupportBack) {
                    np.setSupportBack(true);
                    if (np.on) {
                        np.on('backpressed', this.onBackPressed);
                        this._npBackBound = true;
                    }
                    this.$page.on('backpressed', this.onBackPressed);
                    bound = true;
                }
            } catch (e) { /* 引擎不支持时走下方兜底 */ }
            if (bound) return
            // 老框架没有 setSupportBack：至少不要禁用滑动返回，让系统手势自己处理
            try {
                const np2 = this.$page && this.$page.$npage;
                if (np2 && np2.setDisableLeftSwipeBack) np2.setDisableLeftSwipeBack(false);
            } catch (e) { /* 忽略 */ }
        },
        // 系统返回（返回键 / 右滑手势）：已配置账号时本页是二级页 → 回上一页；
        // 否则是应用入口 → 退出应用
        onBackPressed() {
            if (this._backHandling) return
            this._backHandling = true;
            setTimeout(() => { this._backHandling = false; }, 400);
            if (this.canGoBack) {
                this.back();
                return
            }
            this.exitApp();
        },
        exitApp() {
            try { $falcon.closeApp(); } catch (e) {
                try { $falcon.$app.finish(); } catch (e2) { /* 忽略 */ }
            }
        },
        mask(s) {
            const v = String(s || '');
            if (v.length <= 4) return '••••'
            return v.slice(0, 2) + '••••' + v.slice(-2)
        },
        fmtTime(t) {
            const d = new Date(t);
            const p = (n) => (n < 10 ? '0' + n : '' + n);
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
        },
        async init() {
            const settings = await loadSettings();
            this.theme = (settings && settings.theme) || 'light';
            this.form.baseUrl = (settings && settings.baseUrl) || '';
            this.form.apiKey = (settings && settings.apiKey) || '';
            this.configured = !!(settings && settings.dsConfigured);
            // 账号登录模式暂停：不读 config.toml 账号列表，也不拉起本机后端
            if (this.builtinEnabled) {
                await this.reloadAccounts();
                this.trouble = await loadAccountTrouble();
                // 已配置但后端没起来（例如刚重装）时顺手拉起，避免登录页点了没反应
                if (this.configured) {
                    ensureBackendRunning().catch(() => { /* 失败不阻断页面 */ });
                }
            } else {
                this.accounts = [];
                this.trouble = [];
            }
        },
        async reloadAccounts() {
            this.accounts = await loadAccountList();
        },
        onShow() {
            this.reloadAccounts();
        },
        stateText(a) {
            if (a.state === 'idle') return '可用'
            if (a.state === 'busy') return '使用中'
            if (a.state === 'error') return '登录失败'
            if (a.state === 'invalid') return '不可用'
            return '已配置'
        },
        startEdit() {
            this.editing = true;
            this.form.user = '';
            this.form.pass = '';
            this.msg = '';
            this.isErr = false;
            this.$forceUpdate();
        },
        cancelEdit() {
            this.editing = false;
            this.form.user = '';
            this.form.pass = '';
            this.msg = '';
            this.$forceUpdate();
        },
        async editField(field) {
            const SENSITIVE = { pass: true, apiKey: true };
            const current = SENSITIVE[field] ? '' : (this.form[field] || '');
            const text = await openTextEditor(INPUT_TYPES.EN_US_ONLY, current, { callerPage: 'login' });
            if (text === null) return
            this.form[field] = String(text).trim();
            this.$forceUpdate();
        },
        // 提交账号：写入 config.toml → 重启后端 → 等待登录（设备凭据自动生成）
        async submitAccount() {
            if (this.busy) return
            const user = String(this.form.user || '').trim();
            const pass = String(this.form.pass || '').trim();
            if (!user) {
                this.fail('请填写邮箱或手机号');
                return
            }
            if (!pass) {
                this.fail('请填写密码');
                return
            }
            this.busy = true;
            this.msg = '正在保存并登录（首次会自动生成设备凭据，稍等）…';
            this.isErr = false;
            this.$forceUpdate();

            try {
                await upsertAccount(user);
                await saveSettings(Object.assign({}, await loadSettings(), {
                    authMode: 'builtin',
                    dsUser: user
                }));
                const saved = await updateDsFreeApiAccount(user, pass);
                if (!saved.ok) {
                    this.busy = false;
                    this.fail(saved.message || '保存失败');
                    return
                }
                await setActiveAccount(user);
                this.configured = true;
                this.editing = false;
                await this.reloadAccounts();
                this.busy = false;
                this.msg = '登录成功，正在进入…';
                this.isErr = false;
                this.$forceUpdate();
                setTimeout(() => {
                    $falcon.navTo('index');
                }, 600);
            } catch (e) {
                this.busy = false;
                appLogError('login', e);
                this.fail('失败：' + (e && e.message ? e.message : String(e)));
            }
        },
        fail(text) {
            this.msg = text;
            this.isErr = true;
            this.$forceUpdate();
        },
        // 空消费点击：在 Weex 里"绑定过点击"的容器才会拦截触摸，这是挡住事件
        // 穿透到下层按钮的手段（同 index.vue 抽屉的 noopDrawer）
        noop() {},
        cancelRemove() {
            this.showRemoveConfirm = false;
            this.$forceUpdate();
        },
        // 退出登录：清空本机后端 config.toml 的账号（真源），再清显示名缓存。
        // 旧实现只删缓存条目，后端账号池仍在用旧凭据登录 —— 「移除」名不副实。
        confirmRemove() {
            this.showRemoveConfirm = true;
            this.isErr = false;
            this.$forceUpdate();
        },
        async doRemove() {
            const acct = this.accounts[0];
            this.showRemoveConfirm = false;
            this.busy = true;
            this.msg = '正在退出并重启后端…';
            this.isErr = false;
            this.$forceUpdate();
            try {
                const r = await clearDsFreeApiAccount();
                if (acct && acct.id) await removeAccountById(acct.id);
                await setActiveAccount('');
                await saveSettings(Object.assign({}, await loadSettings(), { dsUser: '' }));
                this.configured = false;
                this.editing = false;
                this.form.user = '';
                this.form.pass = '';
                await this.reloadAccounts();
                this.busy = false;
                this.msg = r.ok ? '已退出登录' : (r.message || '已退出登录');
                this.isErr = !r.ok;
                this.$forceUpdate();
            } catch (e) {
                this.busy = false;
                appLogError('logout', e);
                this.fail('退出失败：' + (e && e.message ? e.message : String(e)));
            }
        },
        async useCustomEndpoint() {
            const baseUrl = String(this.form.baseUrl || '').trim();
            const apiKey = String(this.form.apiKey || '').trim();
            if (!baseUrl || !apiKey) {
                this.fail('请填写服务地址与 API Key');
                return
            }
            try {
                await saveSettings(Object.assign({}, await loadSettings(), {
                    authMode: 'openai',
                    baseUrl,
                    apiKey
                }));
                $falcon.navTo('index');
            } catch (e) {
                appLogError('login.save', e);
                this.fail('保存失败：' + (e && e.message ? e.message : String(e)));
            }
        },
        goSettings() {
            try {
                $falcon.navTo('settings');
            } catch (e) { appLogError('nav.settings', e); }
        },
        back() {
            // 二级页（从主页/设置进来）→ 关闭本页；根页面（首次启动）→ 退出应用，
            // 与系统返回手势（onBackPressed）保持同一套语义
            if (this.canGoBack && this.$page && this.$page.finish) {
                this.$page.finish();
                return
            }
            this.exitApp();
        }
    }
};
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
