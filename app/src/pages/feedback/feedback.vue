<template>
    <div :class="isDark ? 'page page-dark' : 'page'">
        <div :class="isDark ? 'topbar topbar-dark' : 'topbar'">
            <text :class="isDark ? 'icon-btn icon-btn-dark' : 'icon-btn'" @click="back">返回</text>
            <text :class="isDark ? 'title title-dark' : 'title'">意见反馈</text>
            <text :class="isDark ? 'icon-btn icon-btn-dark' : 'icon-btn'" @click="submit">{{ busy ? '提交中…' : '提交' }}</text>
        </div>
        <scroller class="body" scroll-direction="vertical">
            <text :class="isDark ? 'group-title group-title-dark' : 'group-title'">反馈类型</text>
            <div :class="isDark ? 'field field-dark' : 'field'">
                <div class="modes">
                    <text
                        v-for="c in categories"
                        :key="c.key"
                        :class="category === c.key ? chipActive : chip"
                        @click="setCategory(c.key)">{{ c.label }}</text>
                </div>
            </div>

            <text :class="isDark ? 'group-title group-title-dark' : 'group-title'">问题描述</text>
            <div :class="isDark ? 'field field-dark' : 'field'">
                <div :class="isDark ? 'input input-dark' : 'input'" @click="editText">
                    <text :class="text ? (isDark ? 'input-text input-text-dark' : 'input-text') : (isDark ? 'input-ph input-ph-dark' : 'input-ph')">{{ text || '点此输入：遇到什么问题、在哪个页面、复现步骤' }}</text>
                </div>
                <text :class="isDark ? 'field-hint field-hint-dark' : 'field-hint'">越具体越好（例如「识图发送后一直显示正在思考」）。最少 5 个字。</text>
            </div>

            <text :class="isDark ? 'group-title group-title-dark' : 'group-title'">联系方式（可选）</text>
            <div :class="isDark ? 'field field-dark' : 'field'">
                <div :class="isDark ? 'input input-dark' : 'input'" @click="editContact">
                    <text :class="contact ? (isDark ? 'input-text input-text-dark' : 'input-text') : (isDark ? 'input-ph input-ph-dark' : 'input-ph')">{{ contact || '邮箱 / 手机号，方便回复你' }}</text>
                </div>
            </div>

            <text :class="isDark ? 'group-title group-title-dark' : 'group-title'">诊断信息</text>
            <div :class="isDark ? 'field field-dark' : 'field'">
                <text :class="withDiagnostics ? chipActive : chip" @click="toggleDiagnostics">{{ withDiagnostics ? '附带诊断信息' : '不附带' }}</text>
                <text :class="isDark ? 'field-hint field-hint-dark' : 'field-hint'">诊断包含：版本号、构建号、设备标识（已脱敏）、网络模式、今日额度、最近 40 行应用日志。不含聊天正文，可放心提交。</text>
            </div>

            <text :class="isDark ? 'submit submit-dark' : 'submit'" @click="submit">{{ busy ? '正在提交…' : '提交反馈' }}</text>
            <text v-if="msg" :class="msgErr ? (isDark ? 'msg-warn msg-warn-dark' : 'msg-warn') : (isDark ? 'msg-ok msg-ok-dark' : 'msg-ok')">{{ msg }}</text>
            <text :class="isDark ? 'about about-dark' : 'about'">{{ appVersion }}</text>
        </scroller>
    </div>
</template>

<script>
import { peekBootTheme } from '../../services/theme.js'
import { APP_VERSION, loadSettings, loadFeedbackDraft, openTextEditor, INPUT_TYPES, appLogTail, clearFeedbackDraft, appLog, saveFeedbackDraft, saveSettings } from '../../services/store.js'
import { maskDeviceId } from '../../services/api-auth.js'
import { quotaText, ensureUpstreamAuth, submitFeedback, upstreamBase } from '../../services/cloud-control.js'

export default {
    name: 'feedback',
    data() {
        return {
            appVersion: APP_VERSION,
            theme: peekBootTheme(),
            categories: [
                { key: 'bug', label: '问题/Bug' },
                { key: 'suggestion', label: '功能建议' },
                { key: 'other', label: '其他' }
            ],
            category: 'bug',
            text: '',
            contact: '',
            withDiagnostics: true,
            busy: false,
            msg: '',
            msgErr: false,
            settings: null
        }
    },
    computed: {
        isDark() {
            return this.theme === 'dark'
        },
        chip() {
            return this.isDark ? 'chip chip-dark' : 'chip'
        },
        chipActive() {
            return this.isDark ? 'chip-active chip-active-dark' : 'chip-active'
        }
    },
    async created() {
        try {
            this.settings = await loadSettings();
            this.theme = (this.settings && this.settings.theme) || peekBootTheme();
        } catch (e) { /* 忽略 */ }
        const draft = await loadFeedbackDraft();
        if (draft) {
            this.category = draft.category || 'bug';
            this.text = draft.text || '';
            this.contact = draft.contact || '';
            if (draft.text) {
                this.msg = '已恢复上次未提交的内容';
                this.msgErr = false;
            }
        }
        this.$forceUpdate();
    },
    methods: {
        back() {
            if (this.$page && this.$page.finish) this.$page.finish();
        },
        setCategory(key) {
            this.category = key;
            this.$forceUpdate();
        },
        toggleDiagnostics() {
            this.withDiagnostics = !this.withDiagnostics;
            this.$forceUpdate();
        },
        async editText() {
            const text = await openTextEditor(INPUT_TYPES.ZH_CN_PREFERRED, this.text || '');
            if (text === null) return
            this.text = String(text || '').slice(0, 2000);
            this.msg = '';
            this.$forceUpdate();
        },
        async editContact() {
            const text = await openTextEditor(INPUT_TYPES.EN_US_ONLY, this.contact || '');
            if (text === null) return
            this.contact = String(text || '').slice(0, 120);
            this.$forceUpdate();
        },
        async buildDiagnostics() {
            const s = this.settings || {};
            const diag = {
                mode: s.backendMode || 'upstream',
                paired: !!s.pairToken,
                device: maskDeviceId(s.pairDeviceId),
                theme: this.theme,
                quota: quotaText(s.quotaCache),
                enrollAt: s.lastEnrollAt || 0
            };
            if (this.withDiagnostics) {
                try {
                    diag.log = await appLogTail(40);
                } catch (e) { /* 忽略 */ }
            }
            return diag
        },
        async submit() {
            if (this.busy) return
            const body = String(this.text || '').trim();
            if (body.length < 5) {
                this.msg = '请至少写 5 个字描述问题';
                this.msgErr = true;
                this.$forceUpdate();
                return
            }
            this.busy = true;
            this.msg = '正在提交…';
            this.msgErr = false;
            this.$forceUpdate();
            try {
                const auth = await ensureUpstreamAuth({
                    settings: this.settings || {},
                    // 注册得到的凭证必须落盘：否则反馈页注册的令牌只活在内存里，
                    // 回主页又注册一次，两边互相顶掉
                    persist: () => saveSettings(this.settings)
                });
                if (!auth) {
                    throw new Error('无法连接服务，请检查网络后重试')
                }
                const diagnostics = await this.buildDiagnostics();
                const r = await submitFeedback({
                    baseUrl: upstreamBase(this.settings || {}),
                    auth,
                    category: this.category,
                    text: body,
                    contact: this.contact,
                    diagnostics
                });
                await clearFeedbackDraft();
                this.msg = '已提交，感谢反馈' + (r && r.id ? '（编号 ' + r.id + '）' : '');
                this.msgErr = false;
                this.text = '';
                this.contact = '';
                appLog('[feedback] 提交成功 id=' + ((r && r.id) || '') + ' category=' + this.category);
            } catch (e) {
                const message = e && e.message ? e.message : String(e);
                this.msg = '提交失败：' + message;
                this.msgErr = true;
                // 留在本地，下次进来继续改
                await saveFeedbackDraft({
                    category: this.category,
                    text: body,
                    contact: this.contact,
                    at: Date.now()
                });
                appLog('[feedback] 提交失败 ' + message);
            }
            this.busy = false;
            this.$forceUpdate();
        }
    }
};

</script>

<style lang="less" scoped>
.page {
    flex: 1;
    flex-direction: column;
    background-color: #f2f3f5;
}
.page-dark {
    background-color: #121212;
}
.topbar {
    height: 56px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #ffffff;
    padding-top: 0;
    padding-right: 8px;
    padding-bottom: 0;
    padding-left: 8px;
}
.topbar-dark {
    height: 56px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #1e1e1e;
    padding-top: 0;
    padding-right: 8px;
    padding-bottom: 0;
    padding-left: 8px;
}
.icon-btn {
    font-size: 22px;
    color: #1a73e8;
    padding-top: 6px;
    padding-right: 10px;
    padding-bottom: 6px;
    padding-left: 10px;
}
.icon-btn-dark {
    font-size: 22px;
    color: #82b1ff;
    padding-top: 6px;
    padding-right: 10px;
    padding-bottom: 6px;
    padding-left: 10px;
}
.title {
    flex: 1;
    font-size: 24px;
    font-weight: bold;
    color: #222222;
    text-align: center;
}
.title-dark {
    flex: 1;
    font-size: 24px;
    font-weight: bold;
    color: #ffffff;
    text-align: center;
}
.body {
    flex: 1;
}
.group-title {
    font-size: 16px;
    color: #999999;
    padding-top: 16px;
    padding-right: 16px;
    padding-bottom: 6px;
    padding-left: 16px;
}
.group-title-dark {
    font-size: 16px;
    color: #999999;
    padding-top: 16px;
    padding-right: 16px;
    padding-bottom: 6px;
    padding-left: 16px;
}
.field {
    flex-direction: column;
    background-color: #ffffff;
    padding-top: 10px;
    padding-right: 16px;
    padding-bottom: 10px;
    padding-left: 16px;
    border-bottom-width: 1px;
    border-bottom-color: #f0f0f0;
}
.field-dark {
    flex-direction: column;
    background-color: #1e1e1e;
    padding-top: 10px;
    padding-right: 16px;
    padding-bottom: 10px;
    padding-left: 16px;
    border-bottom-width: 1px;
    border-bottom-color: #2a2a2a;
}
.input {
    min-height: 72px;
    background-color: #f2f3f5;
    border-radius: 8px;
    padding-top: 10px;
    padding-right: 12px;
    padding-bottom: 10px;
    padding-left: 12px;
}
.input-dark {
    min-height: 72px;
    background-color: #2a2a2a;
    border-radius: 8px;
    padding-top: 10px;
    padding-right: 12px;
    padding-bottom: 10px;
    padding-left: 12px;
}
.input-text {
    font-size: 18px;
    color: #222222;
    line-height: 26px;
}
.input-text-dark {
    font-size: 18px;
    color: #ffffff;
    line-height: 26px;
}
.input-ph {
    font-size: 18px;
    color: #999999;
    line-height: 26px;
}
.input-ph-dark {
    font-size: 18px;
    color: #888888;
    line-height: 26px;
}
.field-hint {
    font-size: 14px;
    color: #999999;
    padding-top: 8px;
    padding-right: 0;
    padding-bottom: 2px;
    padding-left: 0;
    line-height: 20px;
}
.field-hint-dark {
    font-size: 14px;
    color: #888888;
    padding-top: 8px;
    padding-right: 0;
    padding-bottom: 2px;
    padding-left: 0;
    line-height: 20px;
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
    padding-top: 4px;
    padding-right: 12px;
    padding-bottom: 4px;
    padding-left: 12px;
    margin-right: 8px;
}
.chip-dark {
    font-size: 18px;
    color: #dddddd;
    background-color: #2a2a2a;
    border-radius: 12px;
    padding-top: 4px;
    padding-right: 12px;
    padding-bottom: 4px;
    padding-left: 12px;
    margin-right: 8px;
}
.chip-active {
    font-size: 18px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 12px;
    padding-top: 4px;
    padding-right: 12px;
    padding-bottom: 4px;
    padding-left: 12px;
    margin-right: 8px;
}
.chip-active-dark {
    font-size: 18px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 12px;
    padding-top: 4px;
    padding-right: 12px;
    padding-bottom: 4px;
    padding-left: 12px;
    margin-right: 8px;
}
.submit {
    font-size: 20px;
    color: #ffffff;
    background-color: #1a73e8;
    text-align: center;
    border-radius: 24px;
    padding-top: 12px;
    padding-right: 0;
    padding-bottom: 12px;
    padding-left: 0;
    margin-top: 24px;
    margin-right: 16px;
    margin-bottom: 8px;
    margin-left: 16px;
}
.submit-dark {
    font-size: 20px;
    color: #000000;
    background-color: #82b1ff;
    text-align: center;
    border-radius: 24px;
    padding-top: 12px;
    padding-right: 0;
    padding-bottom: 12px;
    padding-left: 0;
    margin-top: 24px;
    margin-right: 16px;
    margin-bottom: 8px;
    margin-left: 16px;
}
.msg-ok {
    font-size: 16px;
    color: #188038;
    text-align: center;
    padding-top: 8px;
    padding-right: 16px;
    padding-bottom: 8px;
    padding-left: 16px;
}
.msg-ok-dark {
    font-size: 16px;
    color: #81c995;
    text-align: center;
    padding-top: 8px;
    padding-right: 16px;
    padding-bottom: 8px;
    padding-left: 16px;
}
.msg-warn {
    font-size: 16px;
    color: #d93025;
    text-align: center;
    padding-top: 8px;
    padding-right: 16px;
    padding-bottom: 8px;
    padding-left: 16px;
}
.msg-warn-dark {
    font-size: 16px;
    color: #ff8a80;
    text-align: center;
    padding-top: 8px;
    padding-right: 16px;
    padding-bottom: 8px;
    padding-left: 16px;
}
.about {
    font-size: 14px;
    color: #cccccc;
    text-align: center;
    padding-top: 18px;
    padding-right: 0;
    padding-bottom: 30px;
    padding-left: 0;
}
.about-dark {
    font-size: 14px;
    color: #666666;
    text-align: center;
    padding-top: 18px;
    padding-right: 0;
    padding-bottom: 30px;
    padding-left: 0;
}
</style>
