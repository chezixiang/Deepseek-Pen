<template>
    <div :class="pageClass">
        <div :class="portrait ? 'pwrap' : 'pwrap'">
        <!-- 竖屏（实验）：旋转画布为独立内层元素，不再把 transform 挂在
             flex:1 + position:relative 的布局根上（此前结构白屏的可能原因） -->
        <div :class="portrait ? dc('rotate-canvas') : 'fill-canvas'" :style="portraitStyle">
        <!-- 顶栏：会话 | 联网/深度思考 | 模式/标题 | 设置 -->
        <div :class="dc('topbar')">
            <text :class="dc('icon-btn')" @click="toggleDrawer">会话</text>
            <text :class="toggleClass(search)" @click="toggleSearch">联网</text>
            <text :class="toggleClass(thinking)" @click="toggleThinking">深度</text>
            <div class="topbar-center">
                <template v-if="!modeLocked() && visibleModes.length">
                    <text
                        v-for="m in visibleModes"
                        :key="m.key"
                        :class="modeChipClass(m.key)"
                        @click="selectMode(m.key)">{{ m.label }}</text>
                </template>
                <text v-else :class="dc('topbar-title')">Deepseek</text>
            </div>
            <text :class="dc('icon-btn')" @click="goSettings">设置</text>
        </div>

        <!-- 编辑提示条 -->
        <div :class="dc('edit-banner')" v-if="editingMsgId">
            <text :class="dc('edit-banner-text')">正在修改消息，发送后重新生成回复</text>
            <text :class="dc('edit-banner-btn')" @click="cancelEdit">取消</text>
        </div>

        <!-- 后端断线提示 -->
        <div :class="dc('backend-error-banner')" v-if="backendDisconnected">
            <text :class="dc('backend-error-text')">⚠️ 后端连接已断开（如果是安装/更新后第一次打开软件可以通过配置账号的方式重启服务试试）</text>
        </div>

        <!-- 消息区 -->
        <scroller class="msgs" scroll-direction="vertical">
            <div class="empty" v-if="messages.length === 0">
                <text v-if="cloudLoadingId === activeId" :class="dc('empty-tip')">正在加载云端对话…</text>
                <template v-else>
                    <text :class="dc('empty-title')">Deepseek</text>
                    <text :class="dc('empty-tip')">你好，我是 DeepSeek，有什么可以帮你？</text>
                </template>
            </div>

            <div v-for="m in messages" :key="m.id" class="msg">
                <!-- 用户消息 -->
                <div v-if="m.role === 'user'" class="msg-row-user">
                    <div :class="dc('bubble-user')">
                        <div class="imgs" v-if="m.images && m.images.length">
                            <image
                                v-for="img in m.images"
                                :key="img.path"
                                :class="dc('thumb')"
                                resize="cover"
                                :src="fileUrl(img.path)" />
                        </div>                        <text :class="dc('bubble-text-user')" v-if="m.content">{{ m.content }}</text>
                    </div>
                    <div class="msg-actions">
                        <text :class="dc('action')" @click="editMessage(m)">修改</text>
                        <text v-if="userVersionCount(m) > 1" :class="dc('attempt-nav')" @click="prevUserVersion(m)">‹</text>
                        <text v-if="userVersionCount(m) > 1" :class="dc('attempt-indicator')">{{ userActiveVersion(m) + 1 }}/{{ userVersionCount(m) }}</text>
                        <text v-if="userVersionCount(m) > 1" :class="dc('attempt-nav')" @click="nextUserVersion(m)">›</text>
                    </div>
                </div>

                <!-- 助手消息 -->
                <div v-else class="msg-row-assistant">
                    <div :class="dc('bubble-assistant')">
                        <template>
                            <text v-if="m.pending && !m.content && !m.reasoning" :class="dc('pending')">正在思考…</text>
                            <template v-else>
                                <div v-if="m.reasoning" :class="dc('reasoning')" @click="toggleReasoning(m.id)">
                                    <text :class="dc('reasoning-head')">{{ isReasoningCollapsed(m.id) ? '展开思考过程' : '收起思考过程' }}</text>
                                    <text v-if="!isReasoningCollapsed(m.id)" :class="dc('reasoning-body')">{{ m.reasoning }}</text>
                                </div>
                                <text v-if="m.error" :class="dc('bubble-text-error')">{{ m.error }}</text>
                                <div v-else :class="dc('md')">
                                    <div v-for="(block, bi) in markdownBlocks(m.content)" :key="bi" class="md-block">
                                        <div v-if="block.type === 'p'" :class="dc('md-p')">
                                            <text v-for="(s, si) in spans(block.text)" :key="si" :class="spanClass(s)"><text v-for="(r, ri) in emojiRuns(s.text)" :key="ri" :class="emojiRunClass(s, r)">{{ r.t }}</text></text>
                                        </div>
                                        <text v-else-if="block.type === 'code'" :class="dc('md-code')">{{ block.text }}</text>
                                        <text v-else-if="block.type === 'quote'" :class="dc('md-quote')">{{ block.text }}</text>
                                        <text v-else-if="block.type === 'hr'" :class="dc('md-hr')">————————</text>
                                        <div v-else-if="block.type === 'list'" :class="dc('md-list')">
                                            <div v-for="(item, ii) in block.items" :key="ii" class="md-li-row">
                                                <text :class="dc('md-li-marker')">{{ block.ordered ? (ii + 1) + '. ' : '• ' }}</text>
                                                <text v-for="(s, si) in spans(item)" :key="si" :class="spanClass(s)"><text v-for="(r, ri) in emojiRuns(s.text)" :key="ri" :class="emojiRunClass(s, r)">{{ r.t }}</text></text>
                                            </div>
                                        </div>
                                        <text v-else :class="dc('md-heading') + ' md-' + block.type">{{ block.text }}</text>
                                    </div>
                                </div>
                                <text v-if="m.pending" :class="dc('streaming-hint')">正在生成…</text>
                            </template>
                        </template>
                    </div>
                    <div class="msg-actions">
                        <text v-if="isLastAssistant(m) && !m.pending" :class="dc('action')" @click="retryMessage(m)">重试</text>
                        <text v-if="assistantAttemptCount(m) > 1" :class="dc('attempt-nav')" @click="prevAssistantAttempt(m)">‹</text>
                        <text v-if="assistantAttemptCount(m) > 1" :class="dc('attempt-indicator')">{{ assistantActiveAttempt(m) + 1 }}/{{ assistantAttemptCount(m) }}</text>
                        <text v-if="assistantAttemptCount(m) > 1" :class="dc('attempt-nav')" @click="nextAssistantAttempt(m)">›</text>
                    </div>
                </div>
            </div>
            <div class="bottom-anchor" ref="bottom"></div>
        </scroller>

        <!-- 待发图片 -->
        <div :class="dc('draft-imgs')" v-if="draftImages.length">
            <div v-for="(img, i) in draftImages" :key="img.path" class="draft-img">
                <image :class="dc('draft-thumb')" resize="cover" :src="fileUrl(img.path)" />
                <text class="draft-remove" @click="removeDraftImage(i)">×</text>
            </div>
        </div>

        <!-- 输入栏 -->
        <div :class="dc('inputbar')">
            <text v-if="canUploadImage" class="upload" @click="openPicker">图片</text>
            <div :class="dc('input-display')" @click="openInput">
                <text :class="draft ? dc('input-display-text') : dc('input-display-text-ph')">{{ draft || '点击输入消息…' }}</text>
            </div>
            <text :class="sendClass()" @click="send">{{ sending ? '停止' : '发送' }}</text>
        </div>

        <!-- 竖屏旋转画布到此为止：遮罩/抽屉/选择器保持不旋转，绝对定位于 pwrap -->
        </div>

        <!-- 会话抽屉：全屏遮罩挡住穿透点击（#8），点遮罩关闭。
             bug 修复：Weex 中未绑定点击的容器不拦截触摸，事件会穿透到遮罩导致
             点击列表内空白处也关闭抽屉——根节点/头部/列表绑定空消费点击。 -->
        <div class="drawer-mask" v-if="showDrawer" @click="closeDrawer"></div>
        <div :class="dc('drawer')" v-if="showDrawer" @click="noopDrawer">
            <div :class="dc('drawer-head')" @click="noopDrawer">
                <text :class="dc('drawer-title')">会话列表</text>
                <text :class="dc('icon-btn')" @click="searchConversations">{{ convFilter ? '重搜' : '搜索' }}</text>
                <text :class="dc('icon-btn')" @click="syncCloudSessions">{{ syncing ? '同步中…' : '同步' }}</text>
                <text :class="dc('icon-btn')" @click="newConversation(true)">＋ 新对话</text>
            </div>
            <text v-if="syncMsg" :class="dc('sync-msg')">{{ syncMsg }}</text>
            <div class="filter-row" v-if="convFilter">
                <text :class="dc('filter-text')">筛选：{{ convFilter }}</text>
                <text :class="dc('filter-clear')" @click="clearConvFilter">清除</text>
            </div>
            <scroller class="drawer-list" scroll-direction="vertical" @click="noopDrawer">
                <div v-for="c in drawerConversations" :key="c.id" :class="c.id === activeId ? dc('conv-active') : dc('conv')" @click="noopDrawer">
                    <div class="conv-main" @click="switchConversation(c.id)">
                        <text :class="dc('conv-title')" @click="switchConversation(c.id)">{{ c.title }}</text>
                        <text :class="dc('conv-mode')" @click="switchConversation(c.id)">{{ modeLabel(c.mode) }}{{ c.cloudId ? ' · 云' : '' }}</text>
                    </div>
                    <text :class="dc('conv-del')" @click="deleteConversation(c)">删</text>
                </div>
                <text :class="dc('drawer-empty')" v-if="drawerConversations.length === 0">{{ convFilter ? '没有匹配的会话' : '暂无会话' }}</text>
            </scroller>
            <text :class="dc('drawer-close')" @click="closeDrawer">关闭</text>
        </div>

        <!-- 图片选择器 -->
        <div class="picker" v-if="showPicker">
            <div :class="dc('picker-head')">
                <text :class="dc('picker-title')">选择图片（/userdisk/Pictures）</text>
                <text :class="dc('icon-btn')" @click="closePicker">关闭</text>
            </div>
            <text v-if="albumLoading" class="picker-hint">加载中…</text>
            <text v-else-if="albumError" class="picker-hint-error">{{ albumError }}</text>
            <text v-else-if="albumImages.length === 0" class="picker-hint">相册里没有图片</text>
            <scroller v-else class="picker-list" scroll-direction="horizontal">
                <image
                    v-for="img in albumImages"
                    :key="img.path"
                    class="pick-thumb"
                    resize="cover"
                    :src="fileUrl(img.path)"
                    @click="pickImage(img)" />
            </scroller>
        </div>
        </div>
    </div>
</template>

<script>
import { MODES, getMode, buildMessages, chat, chatStream, stripInternalTags, listCloudSessions, listCloudSessionMessages } from '../../services/ds.js'
import {
    loadConversations, saveConversations, loadMessages, saveMessages,
    deleteMessages, loadSettings, loadActiveId, saveActiveId, uid, DEFAULT_SETTINGS,
    recordAccountTrouble
} from '../../services/store.js'
import { listAlbum, readImageDataUrl } from '../../services/images.js'
import { openTextEditor, setDebugLogEnabled, stopStream, INPUT_TYPES, ensureBackendRunning } from '../../services/native.js'
import { markdownToBlocks, inlineSpans, splitEmojiRuns } from '../../services/markdown.js'
import { ensureEmojiFont } from '../../services/emoji-font.js'
import { createBackendMonitor } from '../../services/backend-health.js'
import { appLog } from '../../services/app-log.js'

// 首帧主题预读：startup 页在跳转前把主题写到 $falcon.__dsTheme（跨页共享），
// 这里同步读取，避免深色用户进入主页时先闪一帧浅色（#7）。
function peekBootTheme() {
  try {
    return ($falcon && $falcon.__dsTheme) || 'light'
  } catch (e) {
    return 'light'
  }
}

export default {
    name: 'index',
    data() {
        return {
            MODES,
            // 会话
            conversations: [],
            activeId: null,
            messages: [],
            // 当前会话的选项
            modeKey: 'fast',
            thinking: true,
            search: false,
            // 设置（theme 用首帧预读值初始化，避免闪浅色）
            settings: Object.assign({}, DEFAULT_SETTINGS, { theme: peekBootTheme() }),
            // 输入
            draft: '',
            draftImages: [],
            editingMsgId: null,
            // 状态
            sending: false,
            collapsedReasoning: {},
            // UI
            showDrawer: false,
            showPicker: false,
            albumImages: [],
            albumError: '',
            albumLoading: false,
            // 请求序号（用于丢弃过期响应 / 停止）
            reqSeq: 0,
            // 云端会话同步（#10）
            syncing: false,
            syncMsg: '',
            cloudLoadingId: '',
            // 会话搜索（#7）：抽屉内按标题过滤
            convFilter: '',
            // 当前流式请求的 curl 任务 token（用于停止）
            streamToken: null,
            // 后端监控
            backendMonitor: null,
            backendDisconnected: false
        }
    },
    computed: {
        pageClass() {
            return this.isDark ? 'page page-dark' : 'page'
        },
        isDark() {
            // 深色模式：'dark' 深色，其余浅色（词典笔无系统深色；兼容旧设置里的 'auto' 视为浅色）
            if (!this.settings) return false
            return this.settings.theme === 'dark'
        },
        portrait() {
            // 仅调试模式下才允许竖屏（实验性功能，避免普通用户误触白屏）
            return !!(this.settings && this.settings.debugMode && this.settings.portrait)
        },
        // 竖屏动态样式（#5）：按框架环境宽高计算，适配非 936×280 的设备；
        // 取不到环境值时回退 X7 Pro 实测硬编码。非竖屏返回空对象（避免 null 样式）。
        portraitStyle() {
            if (!this.portrait) return {}
            let w = 936
            let h = 280
            try {
                const env = (typeof weex !== 'undefined') && weex.config && weex.config.env
                if (env && env.deviceWidth && env.deviceHeight) {
                    w = Math.max(env.deviceWidth, env.deviceHeight)
                    h = Math.min(env.deviceWidth, env.deviceHeight)
                }
            } catch (e) { /* 回退默认值 */ }
            return {
                width: h + 'px',
                height: w + 'px',
                transform: 'translateX(' + w + 'px) rotate(90deg)',
                transformOrigin: '0 0'
            }
        },
        visibleModes() {
            // 官方已合并快速/专家/识图为单一模型，MODES 只剩一项。
            // 只有一个模式时不必渲染切换条（省掉顶部一行空间）。
            return MODES.length > 1 ? MODES : []
        },
        // 图片上传是否可用：合并后的模型自带图片理解（file_feature.vision=true），
        // 不再依赖"识图模式"，所以任何时候都能传图。
        canUploadImage() {
            return true
        }
    },
    created() {
        this.$page.on('show', this.onPageShow)
        this.init()
        this.startBackendMonitor()
    },
    watch: {
        isDark(v) {
            appLog('[index] isDark 实际变化 => ' + v + ' theme=' + (this.settings && this.settings.theme))
        }
    },
    destroyed() {
        this.$page.off('show', this.onPageShow)
        this.stopBackendMonitor()
    },
    methods: {
        // 深色模式类名切换：浅色返回原类，深色返回 -dark 变体类
        // （Weex 引擎仅支持单类选择器，不能用 .dark .xxx 后代选择器覆盖）
        dc(cls) {
            return this.isDark ? (cls + '-dark') : cls
        },
        // 把当前主题缓存到 $falcon 全局，供 settings/index 页首帧同步预读（#7）
        cacheTheme() {
            try { $falcon.__dsTheme = (this.settings && this.settings.theme) || 'light' } catch (e) { /* 忽略 */ }
        },
        closeDrawer() {
            this.showDrawer = false
            this.syncMsg = ''
            this.$forceUpdate()
        },
        // 空消费点击：挡住抽屉内部空白区域的事件穿透到遮罩（bug 修复）
        noopDrawer() {},
        // 抽屉渲染列表：按搜索词过滤（#7）
        drawerConversations() {
            const q = (this.convFilter || '').trim().toLowerCase()
            if (!q) return this.conversations
            return this.conversations.filter((c) => (c.title || '').toLowerCase().indexOf(q) >= 0)
        },
        async searchConversations() {
            const text = await openTextEditor(INPUT_TYPES.ZH_CN_PREFERRED, this.convFilter || '')
            if (text === null) return
            this.convFilter = String(text).trim()
            this.$forceUpdate()
        },
        clearConvFilter() {
            this.convFilter = ''
            this.$forceUpdate()
        },

        // ---------- 云端会话同步（#10） ----------
        // 拉取 DeepSeek 账号的会话列表，按标题去重后导入：
        // 恢复原会话模式（model_type→mode），记录 cloudId 供进入时按需拉取消息内容
        async syncCloudSessions() {
            if (this.syncing) return
            this.syncing = true
            this.syncMsg = ''
            this.$forceUpdate()
            try {
                const list = await listCloudSessions({
                    baseUrl: this.settings.baseUrl,
                    apiKey: this.settings.apiKey,
                    authMode: this.settings.authMode
                })
                let added = 0
                for (const s of list) {
                    const title = String(s.title || '').trim()
                    if (!title) continue
                    // 仅按 cloudId 去重（标题同名不再挤掉云端条目，本地/云端可并存）
                    if (this.conversations.some((c) => c.cloudId === s.id)) continue
                    const ts = s.updated_at ? Math.round(s.updated_at * 1000) : Date.now()
                    // 模型已合并：云端 model_type 无论是 default/expert/vision 都映射到唯一模式
                    const mode = MODES[0].key
                    this.conversations.push({
                        id: uid('c'),
                        title: title.slice(0, 30),
                        mode,
                        thinking: true,
                        search: false,
                        createdAt: ts,
                        updatedAt: ts,
                        cloudId: s.id,
                        cloudLoaded: false
                    })
                    added += 1
                }
                this.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                if (added > 0) {
                    await saveConversations(this.conversations)
                }
                this.syncMsg = added > 0 ? ('已导入 ' + added + ' 个云端会话（进入时加载内容）') : '云端会话均已存在'
                appLog('[sync] 云端会话 ' + list.length + ' 个，新增 ' + added)
            } catch (e) {
                this.syncMsg = '同步失败：' + (e && e.message ? e.message : '未知错误')
                const msg = e && e.message ? e.message : String(e)
                if (/封禁|限制|HTTP_401|HTTP_403|未认证|没有可用账号|空闲账号/.test(msg)) {
                    recordAccountTrouble('同步', msg)
                }
                appLog('[sync] 失败 ' + msg)
            }
            this.syncing = false
            this.$forceUpdate()
        },

        // 进入带 cloudId 的空会话时，按需拉取云端消息内容（一次性）
        async ensureCloudMessages(conv) {
            if (!conv || !conv.cloudId || conv.cloudLoaded) return
            this._cloudLoading = this._cloudLoading || {}
            if (this._cloudLoading[conv.id]) return
            this._cloudLoading[conv.id] = true
            this.cloudLoadingId = conv.id
            this.$forceUpdate()
            try {
                const list = await listCloudSessionMessages({
                    baseUrl: this.settings.baseUrl,
                    apiKey: this.settings.apiKey,
                    authMode: this.settings.authMode,
                    sessionId: conv.cloudId
                })
                const convNow = this.conversations.find((c) => c.id === conv.id)
                if (!convNow) return
                const now = Date.now()
                const msgs = []
                let seq = 0
                for (const m of list) {
                    if (m.role === 'user') {
                        const id = uid('u')
                        msgs.push({
                            id, role: 'user', content: m.content, images: [], createdAt: now + seq++,
                            revisions: [{ content: m.content, images: [], createdAt: now + seq }], activeRevision: 0
                        })
                    } else {
                        const id = uid('a')
                        msgs.push({
                            id, role: 'assistant', content: m.content, reasoning: m.reasoning || '', pending: false,
                            createdAt: now + seq++,
                            attempts: [{ id, content: m.content, reasoning: m.reasoning || '', pending: false, createdAt: now + seq }],
                            activeAttempt: 0
                        })
                    }
                }
                convNow.cloudLoaded = true
                await saveConversations(this.conversations)
                if (msgs.length && this.activeId === conv.id) {
                    this.messages = msgs
                    await saveMessages(conv.id, this.messages)
                    this.$forceUpdate()
                    this.scrollToBottom()
                }
                appLog('[cloud] 已加载云端会话内容 ' + msgs.length + ' 条: ' + conv.title)
            } catch (e) {
                // 静默失败：保留占位会话，下次进入重试
                const msg = e && e.message ? e.message : String(e)
                if (/封禁|限制|HTTP_401|HTTP_403|未认证|没有可用账号|空闲账号/.test(msg)) {
                    recordAccountTrouble('云端内容', msg)
                }
                appLog('[cloud] 拉取云端会话内容失败 ' + msg)
            } finally {
                this._cloudLoading[conv.id] = false
                if (this.cloudLoadingId === conv.id) {
                    this.cloudLoadingId = ''
                }
                this.$forceUpdate()
            }
        },
        // 首条消息派生会话标题（#9 本地兜底；后端 dsTitle 可用时会被覆盖）
        deriveTitle(text, imgCount) {
            const t = (text || '').replace(/\s+/g, ' ').trim()
            if (t) {
                const cut = t.slice(0, 20)
                const m = cut.match(/^(.+?[，。？！、；：,.!?;:])/)
                return (m ? m[1] : cut) + (t.length > 20 ? '…' : '')
            }
            return imgCount > 0 ? '图片对话' : '新对话'
        },
        fileUrl(path) {
            return 'file://' + path
        },

        // ---------- Markdown ----------
        // 解析结果缓存（bug 修复：$forceUpdate 触发全列表重渲染时，未变化的消息
        // 不再重复跑 markdown/行内解析——这是展开思考/流式输出卡顿的主因）
        markdownBlocks(content) {
            if (!content) return []
            const cache = this._mdCache || (this._mdCache = new Map())
            if (cache.has(content)) return cache.get(content)
            const blocks = markdownToBlocks(content)
            if (cache.size > 400) cache.clear()
            cache.set(content, blocks)
            return blocks
        },
        spans(text) {
            const key = String(text === undefined || text === null ? '' : text)
            const cache = this._spanCache || (this._spanCache = new Map())
            if (cache.has(key)) return cache.get(key)
            const result = inlineSpans(key)
            if (cache.size > 600) cache.clear()
            cache.set(key, result)
            return result
        },
        // emoji 片段拆分（带缓存）：emoji run 单独套 NotoColorEmoji 字体（#2）
        emojiRuns(text) {
            const key = String(text === undefined || text === null ? '' : text)
            const cache = this._emojiCache || (this._emojiCache = new Map())
            if (cache.has(key)) return cache.get(key)
            const result = splitEmojiRuns(key)
            if (cache.size > 600) cache.clear()
            cache.set(key, result)
            return result
        },
        emojiRunClass(s, r) {
            return this.spanClass(s) + (r.e ? ' md-emoji' : '')
        },
        spanStyle(s) {
            let st = ''
            if (s.bold) st += 'font-weight:bold;'
            if (s.italic) st += 'font-style:italic;'
            if (s.code) st += 'font-family:monospace;'
            return st
        },
        // bug 修复（深色黑字）：Weex 的 <div> 颜色不会可靠继承到 <text>，
        // 裸 span/加粗/斜体必须带显式颜色类，否则深色模式下渲染为默认黑色
        spanClass(s) {
            if (s.bold) return this.dc('md-bold')
            if (s.italic) return this.dc('md-italic')
            if (s.code) return this.dc('md-inline-code')
            return this.dc('md-span')
        },

        // ---------- 重试/修改版本切换 ----------
        userVersionCount(m) {
            return (m && m.revisions && m.revisions.length) || 1
        },
        userActiveVersion(m) {
            return (m && typeof m.activeRevision === 'number') ? m.activeRevision : 0
        },
        assistantAttemptCount(m) {
            return (m && m.attempts && m.attempts.length) || 1
        },
        assistantActiveAttempt(m) {
            return (m && typeof m.activeAttempt === 'number') ? m.activeAttempt : 0
        },
        prevUserVersion(m) {
            if (this.sending || !m || !m.revisions || m.revisions.length <= 1) return
            m.activeRevision = (m.activeRevision || 0) - 1
            if (m.activeRevision < 0) m.activeRevision = m.revisions.length - 1
            this.applyUserVersion(m)
        },
        nextUserVersion(m) {
            if (this.sending || !m || !m.revisions || m.revisions.length <= 1) return
            m.activeRevision = (m.activeRevision || 0) + 1
            if (m.activeRevision >= m.revisions.length) m.activeRevision = 0
            this.applyUserVersion(m)
        },
        applyUserVersion(m) {
            const rev = m.revisions[m.activeRevision]
            if (rev) {
                m.content = rev.content || ''
                m.images = rev.images || []
            }
            this.$forceUpdate()
            this.saveCurrentMessages()
        },
        prevAssistantAttempt(m) {
            if (this.sending || !m || !m.attempts || m.attempts.length <= 1) return
            m.activeAttempt = (m.activeAttempt || 0) - 1
            if (m.activeAttempt < 0) m.activeAttempt = m.attempts.length - 1
            this.applyAssistantAttempt(m)
        },
        nextAssistantAttempt(m) {
            if (this.sending || !m || !m.attempts || m.attempts.length <= 1) return
            m.activeAttempt = (m.activeAttempt || 0) + 1
            if (m.activeAttempt >= m.attempts.length) m.activeAttempt = 0
            this.applyAssistantAttempt(m)
        },
        applyAssistantAttempt(m) {
            const att = m.attempts[m.activeAttempt]
            if (att) {
                m.content = att.content || ''
                m.reasoning = att.reasoning || ''
                m.error = att.error || ''
                m.pending = !!att.pending
            }
            this.$forceUpdate()
            this.saveCurrentMessages()
        },
        async saveCurrentMessages() {
            if (!this.activeId) return
            try {
                await saveMessages(this.activeId, this.messages)
            } catch (e) { /* 忽略 */ }
        },

        // ---------- 初始化 / 生命周期 ----------
        // Emoji 字体开关打开时：下载（如需）并注册，成功后重渲染生效（#2）
        ensureEmojiFontIfEnabled() {
            if (!(this.settings && this.settings.emojiFont)) return
            ensureEmojiFont()
                .then((r) => {
                    if (r.ok) {
                        this.$forceUpdate()
                        return
                    }
                    // 失败原因写日志：开关显示"已开启"但只渲染出白块时，
                    // 用户能在"查看日志"里看到到底是设备不支持还是下载失败。
                    appLog('[index] emoji 字体不可用：' + (r.message || '未知原因'))
                })
                .catch((e) => {
                    appLog('[index] emoji 字体异常：' + (e && e.message ? e.message : String(e)))
                })
        },
        setDebugLog() {
            try {
                setDebugLogEnabled(!!(this.settings && this.settings.debugLog))
            } catch (e) { /* 忽略 */ }
        },
        // 兜底拉起后端（startup 页若未执行 ensureBackendRunning 时启用）
        async ensureBackend() {
            // 自定义端点模式不依赖本机后端，别去部署/重启它
            if (this.settings && this.settings.authMode && this.settings.authMode !== 'builtin') return
            if (this._backendEnsuring) return
            this._backendEnsuring = true
            try {
                const result = await ensureBackendRunning()
                appLog('[index] ensureBackend 结果 ok=' + result.ok + ' msg=' + (result.message || '') + ' code=' + (result.code || ''))
                if (result.ok) {
                    // 成功后清除断开标志（自愈完成）
                    if (this.backendDisconnected) {
                        this.backendDisconnected = false
                        this.$forceUpdate()
                    }
                } else if (this.backendDisconnected !== true) {
                    this.backendDisconnected = true
                    this.$forceUpdate()
                }
            } catch (e) {
                appLog('[index] ensureBackend 异常 ' + (e && e.message ? e.message : String(e)))
            } finally {
                this._backendEnsuring = false
            }
        },
        async init() {
            this.settings = await loadSettings()
            this.cacheTheme()
            appLog('[index] init theme=' + (this.settings && this.settings.theme) + ' isDark=' + this.isDark + ' authMode=' + (this.settings && this.settings.authMode))
            this.setDebugLog()
            this.ensureEmojiFontIfEnabled()
            // 兜底拉起后端：startup 页可能因生命周期问题从未执行 ensureBackendRunning，
            // 这里确保后端一定被部署并启动（不阻塞 UI 渲染）
            this.ensureBackend()
            this.conversations = (await loadConversations()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            this.activeId = await loadActiveId()
            if (!this.activeId || !this.conversations.some((c) => c.id === this.activeId)) {
                this.activeId = this.conversations.length ? this.conversations[0].id : null
            }
            if (this.activeId) {
                this.messages = await loadMessages(this.activeId)
                const conv = this.activeConversation()
                if (conv) {
                    this.modeKey = conv.mode
                    this.thinking = conv.thinking
                    this.search = conv.search
                }
            } else {
                this.messages = []
                this.modeKey = this.settings.defaultMode
                this.thinking = this.settings.defaultThinking
                this.search = this.settings.defaultSearch
            }
            this.$forceUpdate()
        },
        async onPageShow() {
            // 从设置页返回时刷新设置与会话列表（可能被清空）
            this.settings = await loadSettings()
            this.cacheTheme()
            this.setDebugLog()
            this.ensureEmojiFontIfEnabled()
            if (this.sending) {
                // 发送中：不重载消息数组，避免 pending 消息被覆盖导致"正在思考"卡住
                return
            }
            this.conversations = (await loadConversations()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            if (!this.activeId || !this.conversations.some((c) => c.id === this.activeId)) {
                this.activeId = this.conversations.length ? this.conversations[0].id : null
                if (this.activeId) {
                    this.messages = await loadMessages(this.activeId)
                    const conv = this.activeConversation()
                    if (conv) {
                        this.modeKey = conv.mode
                        this.thinking = conv.thinking
                        this.search = conv.search
                    }
                } else {
                    this.messages = []
                    this.modeKey = this.settings.defaultMode
                    this.thinking = this.settings.defaultThinking
                    this.search = this.settings.defaultSearch
                }
            }
            this.$forceUpdate()
        },

        // ---------- 派生状态 ----------
        activeConversation() {
            return this.conversations.find((c) => c.id === this.activeId) || null
        },
        modeLabel(key) {
            return getMode(key).label
        },
        modeChipClass(key) {
            if (key === this.modeKey) return 'chip-active'
            if (this.modeLocked()) return this.dc('chip-locked')
            return this.dc('chip')
        },
        modeLocked() {
            // 一旦有用户消息，模型模式即锁定（识图/非识图不可中途切换）
            return this.messages.some((m) => m.role === 'user')
        },
        canSend() {
            return (this.draft && this.draft.trim().length > 0) || this.draftImages.length > 0
        },
        sendClass() {
            // 深色模式：发送键用 send-dark 变体（浅色保持原样）
            if (this.sending) return this.dc('send')
            return this.canSend() ? this.dc('send') : this.dc('send-disabled')
        },
        isLastAssistant(m) {
            const last = this.messages[this.messages.length - 1]
            return m === last && !m.pending
        },

        // ---------- 会话管理 ----------
        toggleDrawer() {
            this.showDrawer = !this.showDrawer
            if (!this.showDrawer) this.syncMsg = ''
            this.$forceUpdate()
        },
        // applyDefaults=true（"＋新对话"按钮）：设置里的默认深度思考/默认联网搜索
        // 在此刻生效一次；false（空态直接发送）：沿用当前开关（尊重用户已拨状态）
        async newConversation(applyDefaults = false) {
            this.reqSeq += 1
            if (applyDefaults) {
                this.thinking = this.settings.defaultThinking
                this.search = this.settings.defaultSearch
            }
            const conv = {
                id: uid('c'),
                title: '新对话',
                mode: this.modeKey,
                thinking: this.thinking,
                search: this.search,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
            this.conversations = [conv].concat(this.conversations)
            await saveConversations(this.conversations)
            this.activeId = conv.id
            await saveActiveId(conv.id)
            this.messages = []
            this.modeKey = conv.mode
            this.thinking = conv.thinking
            this.search = conv.search
            this.editingMsgId = null
            this.draft = ''
            this.draftImages = []
            this.showDrawer = false
            this.syncMsg = ''
            this.convFilter = ''
            this.$forceUpdate()
        },
        async switchConversation(id) {
            if (id === this.activeId) {
                this.showDrawer = false
                return
            }
            this.reqSeq += 1
            this.activeId = id
            await saveActiveId(id)
            this.messages = await loadMessages(id)
            const conv = this.activeConversation()
            if (conv) {
                this.modeKey = conv.mode
                this.thinking = conv.thinking
                this.search = conv.search
                // #10：云端同步的占位会话，进入时按需拉取消息内容
                this.ensureCloudMessages(conv)
            }
            this.editingMsgId = null
            this.draft = ''
            this.draftImages = []
            this.showDrawer = false
            this.syncMsg = ''
            this.$forceUpdate()
            this.scrollToBottom()
        },
        async deleteConversation(c) {
            this.reqSeq += 1
            this.conversations = this.conversations.filter((x) => x.id !== c.id)
            await saveConversations(this.conversations)
            await deleteMessages(c.id)
            if (this.activeId === c.id) {
                this.activeId = this.conversations.length ? this.conversations[0].id : null
                await saveActiveId(this.activeId)
                if (this.activeId) {
                    this.messages = await loadMessages(this.activeId)
                    const conv = this.activeConversation()
                    if (conv) {
                        this.modeKey = conv.mode
                        this.thinking = conv.thinking
                        this.search = conv.search
                    }
                } else {
                    this.messages = []
                    this.modeKey = this.settings.defaultMode
                    this.thinking = this.settings.defaultThinking
                    this.search = this.settings.defaultSearch
                }
                this.draft = ''
                this.draftImages = []
                this.editingMsgId = null
            }
            this.$forceUpdate()
        },
        async persistConversation(conv) {
            const exists = this.conversations.some((c) => c.id === conv.id)
            this.conversations = exists
                ? this.conversations.map((c) => (c.id === conv.id ? conv : c))
                : [conv].concat(this.conversations)
            await saveConversations(this.conversations)
        },

        // ---------- 选项 ----------
        selectMode(key) {
            if (this.modeLocked()) return
            this.modeKey = key
            // 模型已合并，单一模式即支持图片，切换模式不再需要清空待发图片。
            const conv = this.activeConversation()
            if (conv) {
                conv.mode = key
                this.persistConversation(conv)
            }
            this.$forceUpdate()
        },
        toggleClass(v) {
            return v ? this.dc('top-toggle-on') : this.dc('top-toggle')
        },
        toggleThinking() {
            if (this.sending) return
            this.thinking = !this.thinking
            // 会话创建后开关只属于该会话（持久化），不再受设置默认值影响
            const conv = this.activeConversation()
            if (conv) {
                conv.thinking = this.thinking
                this.persistConversation(conv)
            }
            this.$forceUpdate()
        },
        toggleSearch() {
            if (this.sending) return
            this.search = !this.search
            const conv = this.activeConversation()
            if (conv) {
                conv.search = this.search
                this.persistConversation(conv)
            }
            this.$forceUpdate()
        },

        // ---------- 输入 ----------
        async openInput() {
            if (this.sending) return
            // 实测（计算器 v1.12.103 反编译 + 真机）：用默认 ZhCNPreferred 即可带出系统输入法的语音/录音按钮；
            // RecordPreferred 与底部滑动手势关联（y03 主题特有），在本机不触发语音按钮，弃用。
            // Bug 4 修复：将当前 draft 作为预填充文本传给输入法，修改消息时编辑器能显示原文。
            const text = await openTextEditor(INPUT_TYPES.ZH_CN_PREFERRED, this.draft || '')
            if (text === null) return
            // 编辑器返回：null=取消；字符串=确认后结果（含空串"清空"）。直接覆盖 draft。
            this.draft = text || ''
            this.$forceUpdate()
        },

        // ---------- 发送 / 重试 / 修改 ----------
        async send() {
            if (this.sending) {
                this.stopGeneration()
                return
            }
            const text = (this.draft || '').trim()
            // 合并后的模型自带图片理解，图片随任意消息发送即可
            const images = this.draftImages || []
            if (!text && images.length === 0) return

            // 等待后台预压缩完成（若还没好），把 dataUrl 补进每个待发图片对象
            await Promise.all(images.map((i) => i.pending || Promise.resolve()))
            images.forEach((i) => { i.dataUrl = i.dataUrl || null })

            if (!this.activeConversation()) {
                await this.newConversation()
            }
            const conv = this.activeConversation()
            const seq = ++this.reqSeq
            const convId = conv.id

            let pending = null
            if (this.editingMsgId) {
                const idx = this.messages.findIndex((m) => m.id === this.editingMsgId)
                if (idx >= 0) {
                    const userMsg = this.messages[idx]
                    const normalized = this.normalizeImages(images)
                    const rev = { content: text, images: normalized, createdAt: Date.now() }
                    if (!Array.isArray(userMsg.revisions)) userMsg.revisions = []
                    userMsg.revisions.push(rev)
                    userMsg.activeRevision = userMsg.revisions.length - 1
                    userMsg.content = text
                    userMsg.images = normalized

                    // Bug 修复：修改消息时，删除该消息之后的所有消息（实现分支逻辑）
                    // 用户修改消息 → 删除后续所有对话 → 从修改点重新生成
                    this.messages = this.messages.slice(0, idx + 1)
                    
                    // 创建新的助手消息（而不是复用旧的）
                    const att = { id: uid('a'), content: '', reasoning: '', pending: true, createdAt: Date.now() }
                    pending = {
                        id: uid('a'),
                        role: 'assistant',
                        content: '',
                        reasoning: '',
                        pending: true,
                        createdAt: Date.now(),
                        attempts: [att],
                        activeAttempt: 0
                    }
                    this.messages.push(pending)
                }
                this.editingMsgId = null
            } else {
                const normalized = this.normalizeImages(images)
                const userMsg = {
                    id: uid('u'),
                    role: 'user',
                    content: text,
                    images: normalized,
                    createdAt: Date.now(),
                    revisions: [{ content: text, images: normalized, createdAt: Date.now() }],
                    activeRevision: 0
                }
                this.messages.push(userMsg)
                if (!conv.title || conv.title === '新对话') {
                    conv.title = this.deriveTitle(text, images.length)
                }
            }

            if (!pending) {
                const att = { id: uid('a'), content: '', reasoning: '', pending: true, createdAt: Date.now() }
                pending = {
                    id: uid('a'),
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    pending: true,
                    createdAt: Date.now(),
                    attempts: [att],
                    activeAttempt: 0
                }
                this.messages.push(pending)
            }

            this.draft = ''
            this.draftImages = []
            conv.updatedAt = Date.now()
            await this.persistConversation(conv)
            await saveMessages(convId, this.messages)
            this.$forceUpdate()
            this.scrollToBottom()

            await this.generate(conv, convId, seq, pending.id)
        },

        async generate(conv, convId, seq, pendingId, forceThinking = false) {
            this.sending = true
            this.streamToken = null
            try {
                const apiMessages = await buildMessages(this.messages, this.settings.systemPrompt)
                console.error('GEN | built messages count=' + apiMessages.length)

                const opts = {
                    baseUrl: this.settings.baseUrl,
                    apiKey: this.settings.apiKey,
                    modeKey: conv.mode,
                    messages: apiMessages,
                    thinking: forceThinking ? true : conv.thinking,
                    search: conv.search,
                    authMode: this.settings.authMode,
                    modelId: this.settings.openaiModelId || '',
                    conversationId: convId
                }

                const isStream = !!(this.settings && this.settings.sse === true)
                let res = null
                if (isStream) {
                    console.error('GEN | using SSE stream')
                    res = await chatStream(opts, {
                        isCancelled: () => seq !== this.reqSeq || convId !== this.activeId,
                        onToken: (token) => { this.streamToken = token },
                        onDelta: (delta) => {
                            if (seq !== this.reqSeq || convId !== this.activeId) return
                            const m = this.messages.find((x) => x.id === pendingId)
                            if (!m) return
                            const att = m.attempts && m.attempts[m.activeAttempt]
                            if (att) {
                                att.content = (att.content || '') + delta
                                m.content = att.content
                            } else {
                                m.content = (m.content || '') + delta
                            }
                            // 实时清洗内部标签，避免用户看到协议标签
                            if (m.content) {
                                const cleaned = stripInternalTags(m.content)
                                if (cleaned !== m.content) {
                                    if (att) att.content = cleaned
                                    m.content = cleaned
                                }
                            }
                            this.$forceUpdate()
                            this.scrollToBottom()
                        },
                        onReasoning: (delta) => {
                            if (seq !== this.reqSeq || convId !== this.activeId) return
                            const m = this.messages.find((x) => x.id === pendingId)
                            if (!m) return
                            const att = m.attempts && m.attempts[m.activeAttempt]
                            if (att) {
                                att.reasoning = (att.reasoning || '') + delta
                                m.reasoning = att.reasoning
                            } else {
                                m.reasoning = (m.reasoning || '') + delta
                            }
                            this.$forceUpdate()
                        }
                    })
                } else {
                    console.error('GEN | using non-stream chat')
                    res = await chat(opts)
                }

                console.error('GEN | chat returned content len=' + (res && res.content ? res.content.length : 0))
                if (seq !== this.reqSeq || convId !== this.activeId) {
                    console.error('GEN | seq mismatch, return (seq=' + seq + ' reqSeq=' + this.reqSeq + ' convId=' + convId + ' activeId=' + this.activeId + ')')
                    return
                }

                // #12：非思考模式返回空内容时，自动按"深度思考开启"重试一次。
                // thinking=OFF 是唯一返回空内容的场景（疑似 DeepSeek 服务端兼容问题），
                // 自动回退保证用户总能拿到回复；根因以诊断日志持续观察。
                if (res && !res.content && !res.reasoning && conv.thinking === false && !forceThinking) {
                    appLog('[generate] 非思考模式返回空内容（mode=' + conv.mode + ' search=' + conv.search + ' sse=' + isStream + '），自动以思考模式重试 #12')
                    return await this.generate(conv, convId, seq, pendingId, true)
                }

                // #9：会话自动命名——DeepSeek 在会话首条消息时下发自动生成的标题
                // （dsTitle，与 thinking/search 开关无关），用它替换本地截断的标题
                const convNow = this.conversations.find((c) => c.id === convId)
                if (res && res.dsTitle && convNow) {
                    const isFirstRound = this.messages.filter((x) => x.role === 'user').length <= 1
                    const t = String(res.dsTitle).trim()
                    if (t && isFirstRound && convNow.title !== t) {
                        convNow.title = t.slice(0, 30)
                        await this.persistConversation(convNow)
                        appLog('[generate] 会话自动命名 => ' + convNow.title)
                    }
                }

                const m = this.messages.find((x) => x.id === pendingId)
                console.error('GEN | find pending=' + (m ? 'FOUND' : 'MISSING') + ' messages count=' + this.messages.length)
                if (m) {
                    const att = m.attempts && m.attempts[m.activeAttempt]
                    if (att) {
                        att.content = res.content
                        att.reasoning = res.reasoning
                        att.pending = false
                    }
                    m.content = res.content
                    m.reasoning = res.reasoning
                    m.pending = false
                } else {
                    // pending 消息在存储重载后丢失：追加完成的消息，避免卡"正在思考"
                    this.messages.push({
                        id: pendingId,
                        role: 'assistant',
                        content: res.content,
                        reasoning: res.reasoning,
                        pending: false,
                        createdAt: Date.now(),
                        attempts: [{ id: pendingId, content: res.content, reasoning: res.reasoning, pending: false, createdAt: Date.now() }],
                        activeAttempt: 0
                    })
                }
            } catch (e) {
                console.error('GEN | catch err=' + (e && e.message ? e.message : String(e)))
                if (seq !== this.reqSeq || convId !== this.activeId) return
                const msg = e && e.message ? e.message : '发生未知错误，请重试'
                // 账号异常取证：疑似封号/禁言/鉴权失败时记录首次检出时间（#封号取证）
                if (/被限制|禁言|封|空 SSE|HTTP_401|HTTP_403|未认证/.test(msg)) {
                    recordAccountTrouble('对话', msg)
                }
                const m = this.messages.find((x) => x.id === pendingId)
                if (m) {
                    const att = m.attempts && m.attempts[m.activeAttempt]
                    if (att) {
                        att.pending = false
                        att.error = e && e.message ? e.message : '发生未知错误，请重试'
                    }
                    m.pending = false
                    m.error = e && e.message ? e.message : '发生未知错误，请重试'
                } else {
                    this.messages.push({
                        id: pendingId,
                        role: 'assistant',
                        content: '',
                        pending: false,
                        error: e && e.message ? e.message : '发生未知错误，请重试',
                        createdAt: Date.now(),
                        attempts: [{ id: pendingId, content: '', pending: false, error: e && e.message ? e.message : '发生未知错误，请重试', createdAt: Date.now() }],
                        activeAttempt: 0
                    })
                }
            } finally {
                console.error('GEN | finally, sending=false')
                if (this.streamToken) {
                    stopStream(this.streamToken)
                    this.streamToken = null
                }
                this.sending = false
                // 只有仍然停留在原会话时才保存，避免切换会话后把新会话内容写进旧会话
                if (seq === this.reqSeq && convId === this.activeId) {
                    await saveMessages(convId, this.messages)
                }
                this.$forceUpdate()
                this.scrollToBottom()
            }
        },

        async retryMessage(m) {
            if (this.sending) return
            const conv = this.activeConversation()
            if (!conv) return
            if (!m || m.role !== 'assistant') return

            // 不覆盖旧回复：在当前助手气泡上新增一次生成尝试
            const att = { id: uid('a'), content: '', reasoning: '', pending: true, createdAt: Date.now() }
            if (!Array.isArray(m.attempts)) m.attempts = []
            m.attempts.push(att)
            m.activeAttempt = m.attempts.length - 1
            m.content = ''
            m.reasoning = ''
            m.error = ''
            m.pending = true

            const seq = ++this.reqSeq
            const convId = conv.id
            conv.updatedAt = Date.now()
            await this.persistConversation(conv)
            await saveMessages(convId, this.messages)
            this.$forceUpdate()
            this.scrollToBottom()
            await this.generate(conv, convId, seq, m.id)
        },

        editMessage(m) {
            if (this.sending) return
            this.editingMsgId = m.id
            // 保留已算好的 dataUrl，避免重新压缩；没有则回到待处理状态
            this.draftImages = (m.images || []).map((i) => ({
                name: i.name,
                path: i.path,
                dataUrl: i.dataUrl || null,
                pending: i.dataUrl ? Promise.resolve(i.dataUrl) : null
            }))
            // Bug 4 修复：设置 draft，点击输入框时 openInput 会把 draft 作为预填充文本
            // 传给系统输入法（contents 字段），用户能直接看到并编辑原文
            this.draft = m.content || ''
            this.$forceUpdate()
            // 自动滚动到底部，确保用户看到编辑提示条
            this.scrollToBottom()
        },
        cancelEdit() {
            this.editingMsgId = null
            this.draft = ''
            this.draftImages = []
            this.$forceUpdate()
        },

        stopGeneration() {
            this.reqSeq += 1
            if (this.streamToken) {
                stopStream(this.streamToken)
                this.streamToken = null
            }
            const pendingMsg = this.messages.find((x) => x.pending)
            if (pendingMsg) {
                // 保留已生成的部分内容，标记为完成而不是直接抹掉
                const att = pendingMsg.attempts && pendingMsg.attempts[pendingMsg.activeAttempt]
                if (att) att.pending = false
                pendingMsg.pending = false
                if (pendingMsg.error) pendingMsg.error = ''
            }
            this.sending = false
            this.$forceUpdate()
            this.saveCurrentMessages()
        },

        // ---------- 思考过程折叠 ----------
        isReasoningCollapsed(id) {
            if (this.collapsedReasoning[id] !== undefined) return this.collapsedReasoning[id]
            return !(this.settings && this.settings.defaultExpandThinking)
        },
        toggleReasoning(id) {
            this.collapsedReasoning[id] = !this.isReasoningCollapsed(id)
            this.$forceUpdate()
        },

        // ---------- 图片 ----------
        async openPicker() {
            this.showPicker = true
            this.albumLoading = true
            this.albumError = ''
            this.albumImages = []
            this.$forceUpdate()
            try {
                this.albumImages = await listAlbum()
            } catch (e) {
                this.albumError = e && e.message ? e.message : '无法访问相册'
            }
            this.albumLoading = false
            this.$forceUpdate()
        },
        closePicker() {
            this.showPicker = false
            this.$forceUpdate()
        },
        pickImage(img) {
            if (!this.draftImages.some((i) => i.path === img.path)) {
                // 选中后立即在后台预压缩/base64，避免发送时 UI 卡顿。
                // dataUrl 就绪前 pending 保持 Promise，发送时统一 await。
                const item = { name: img.name, path: img.path, dataUrl: null, pending: null }
                item.pending = readImageDataUrl(img.path)
                    .then((du) => { item.dataUrl = du || null })
                    .catch(() => { item.dataUrl = null })
                this.draftImages.push(item)
            }
            this.showPicker = false
            this.$forceUpdate()
        },
        // 把待发图片规整为存进消息的形态：等待预压缩完成，携带 dataUrl。
        normalizeImages(images) {
            return images.map((i) => ({ name: i.name, path: i.path, dataUrl: i.dataUrl || null }))
        },
        removeDraftImage(i) {
            this.draftImages.splice(i, 1)
            this.$forceUpdate()
        },

        // ---------- 其他 ----------
        goSettings() {
            $falcon.navTo('settings')
        },
        scrollToBottom() {
            const self = this
            setTimeout(() => {
                try {
                    if (self.$refs.bottom && self.$page && self.$page.$dom) {
                        self.$page.$dom.scrollToElement(self.$refs.bottom)
                    }
                } catch (e) {
                    /* 忽略 */
                }
            }, 50)
        },

        // ---------- 后端监控 ----------
        startBackendMonitor() {
            if (this.backendMonitor) return
            
            this.backendMonitor = createBackendMonitor({
                onDisconnect: () => {
                    console.error('INDEX | 后端连接断开')
                    this.backendDisconnected = true
                    this.$forceUpdate()
                    // 停止当前请求
                    if (this.sending) {
                        this.stopGeneration()
                    }
                    // 自愈：尝试重新拉起/修复后端（内部 single-flight，不会重复 restart）
                    this.ensureBackend()
                },
                onReconnect: () => {
                    console.log('INDEX | 后端已重新连接')
                    this.backendDisconnected = false
                    this.$forceUpdate()
                }
            }, 10000) // 每10秒检查一次
            
            this.backendMonitor.start()
        },
        
        stopBackendMonitor() {
            if (this.backendMonitor) {
                this.backendMonitor.stop()
                this.backendMonitor = null
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
}

.pwrap {
    flex: 1;
    flex-direction: column;
    position: relative;
}

/* 竖屏模式（实验性）：transform 挂在专用的内层画布上（不占用布局职责的元素），
   避免与 flex:1 + position:relative 的布局根冲突。尺寸/位移由 portraitStyle 内联提供。
   之前把 transform 挂在 pwrap（flex:1+relative）上在真机白屏。 */
.rotate-canvas {
    flex: 0;
    flex-direction: column;
    background-color: #f2f3f5;
}
.rotate-canvas-dark {
    flex: 0;
    flex-direction: column;
    background-color: #121212;
}
.fill-canvas {
    flex: 1;
    flex-direction: column;
}

/* 会话搜索过滤条（#7） */
.filter-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #eeeeee;
}
.filter-text {
    font-size: 16px;
    color: #1a73e8;
    flex: 1;
}
.filter-clear {
    font-size: 16px;
    color: #d93025;
    padding: 2px 8px;
}
.filter-row-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #333333;
}
.filter-text-dark {
    font-size: 16px;
    color: #82b1ff;
    flex: 1;
}
.filter-clear-dark {
    font-size: 16px;
    color: #ff8a80;
    padding: 2px 8px;
}

.topbar {
    flex-direction: row;
    align-items: center;
    background-color: #ffffff;
    padding: 8px;
    flex-wrap: wrap;
}
.icon-btn {
    font-size: 22px;
    color: #1a73e8;
    padding: 6px 10px;
}
.top-toggle {
    font-size: 18px;
    color: #555555;
    background-color: #eef0f3;
    border-radius: 12px;
    padding: 4px 10px;
    margin-right: 6px;
}
.top-toggle-on {
    font-size: 18px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 12px;
    padding: 4px 10px;
    margin-right: 6px;
}
.topbar-center {
    flex: 1;
    flex-direction: row;
    align-items: center;
    justify-content: center;
}
.topbar-title {
    font-size: 24px;
    font-weight: bold;
    color: #1a73e8;
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
.chip-locked {
    font-size: 18px;
    color: #bbbbbb;
    background-color: #f2f3f5;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}

.edit-banner {
    flex-direction: row;
    align-items: center;
    background-color: #fff4e0;
    padding: 4px 12px;
}
.edit-banner-text {
    flex: 1;
    font-size: 16px;
    color: #b26a00;
}
.edit-banner-btn {
    font-size: 16px;
    color: #1a73e8;
    padding: 2px 8px;
}

.backend-error-banner {
    flex-direction: row;
    align-items: center;
    background-color: #fee;
    padding: 6px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #fcc;
}
.backend-error-text {
    flex: 1;
    font-size: 16px;
    color: #c00;
    font-weight: bold;
}

.msgs {
    flex: 1;
}
.empty {
    flex: 1;
    justify-content: center;
    align-items: center;
    padding: 40px 20px;
}
.empty-title {
    font-size: 34px;
    font-weight: bold;
    color: #1a73e8;
}
.empty-tip {
    font-size: 20px;
    color: #888888;
    margin-top: 12px;
}

.msg {
    width: 100%;
}
.msg-row-user {
    padding: 6px 12px;
    align-items: flex-end;
}
.msg-row-assistant {
    padding: 6px 12px;
    align-items: flex-start;
}

.bubble-user {
    max-width: 80%;
    border-radius: 12px;
    padding: 10px 14px;
    background-color: #1a73e8;
}
.bubble-assistant {
    max-width: 80%;
    border-radius: 12px;
    padding: 10px 14px;
    background-color: #ffffff;
}

.bubble-text-user {
    font-size: 20px;
    line-height: 28px;
    color: #ffffff;
}
.bubble-text-assistant {
    font-size: 20px;
    line-height: 28px;
    color: #222222;
}
.bubble-text-error {
    font-size: 20px;
    line-height: 28px;
    color: #d93025;
}

.pending {
    font-size: 18px;
    color: #888888;
}
.streaming-hint {
    font-size: 16px;
    color: #1a73e8;
    margin-top: 4px;
}

.imgs {
    flex-direction: row;
    flex-wrap: wrap;
    margin-bottom: 6px;
}
.thumb {
    width: 120px;
    height: 90px;
    border-radius: 8px;
    margin-right: 6px;
    background-color: #dddddd;
}

.action {
    font-size: 16px;
    color: #999999;
    margin-top: 4px;
    padding: 2px 6px;
}
.msg-actions {
    flex-direction: row;
    align-items: center;
    margin-top: 2px;
}
.attempt-nav {
    font-size: 22px;
    color: #1a73e8;
    padding: 0 6px;
}
.attempt-indicator {
    font-size: 16px;
    color: #999999;
    padding: 0 4px;
}

/* Markdown 渲染 */
.md {
    flex-direction: column;
}
.md-block {
    margin-bottom: 6px;
}
.md-p {
    flex-direction: row;
    flex-wrap: wrap;
    font-size: 20px;
    line-height: 28px;
    color: #222222;
}
.md-richtext {
    font-size: 20px;
    line-height: 28px;
    color: #222222;
}
.md-bold {
    font-weight: bold;
    color: #222222;
    font-size: 20px;
    line-height: 28px;
}
.md-italic {
    font-style: italic;
    color: #222222;
    font-size: 20px;
    line-height: 28px;
}
.md-span {
    color: #222222;
    font-size: 20px;
    line-height: 28px;
}
.md-emoji {
    font-family: NotoColorEmoji;
}
.md-inline-code {
    font-family: monospace;
    background-color: #f0f0f0;
    border-radius: 4px;
    padding: 0 4px;
}
.md-code {
    font-size: 18px;
    line-height: 26px;
    color: #c7254e;
    background-color: #f6f7f9;
    border-radius: 6px;
    padding: 8px;
    font-family: monospace;
}
.md-quote {
    font-size: 20px;
    line-height: 28px;
    color: #666666;
    border-left-width: 3px;
    border-left-color: #cccccc;
    padding-left: 10px;
    margin: 4px 0;
}
.md-hr {
    font-size: 16px;
    color: #cccccc;
    text-align: center;
}
.md-list {
    flex-direction: column;
}
.md-li-row {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
}
.md-li-marker {
    font-size: 20px;
    line-height: 28px;
    color: #222222;
    margin-right: 4px;
}
.md-li {
    font-size: 20px;
    line-height: 28px;
    color: #222222;
}
.md-heading {
    font-weight: bold;
    color: #222222;
}
.md-h1 {
    font-size: 30px;
    line-height: 36px;
    margin-top: 4px;
}
.md-h2 {
    font-size: 28px;
    line-height: 34px;
    margin-top: 4px;
}
.md-h3 {
    font-size: 26px;
    line-height: 32px;
    margin-top: 4px;
}
.md-h4, .md-h5, .md-h6 {
    font-size: 24px;
    line-height: 30px;
    margin-top: 4px;
}

.reasoning {
    margin-bottom: 8px;
    border-radius: 8px;
    background-color: #f6f7f9;
    padding: 6px 10px;
}
.reasoning-head {
    font-size: 16px;
    color: #1a73e8;
}
.reasoning-body {
    font-size: 16px;
    color: #777777;
    line-height: 22px;
    margin-top: 4px;
}

.bottom-anchor {
    height: 1px;
}

.draft-imgs {
    flex-direction: row;
    flex-wrap: wrap;
    background-color: #ffffff;
    padding: 6px 12px 0 12px;
}
.draft-img {
    margin-right: 10px;
    margin-bottom: 6px;
}
.draft-thumb {
    width: 90px;
    height: 68px;
    border-radius: 8px;
    background-color: #dddddd;
}
.draft-remove {
    position: absolute;
    top: 0;
    right: 0;
    width: 24px;
    height: 24px;
    border-radius: 12px;
    background-color: rgba(0, 0, 0, 0.55);
    color: #ffffff;
    font-size: 16px;
    text-align: center;
}

.inputbar {
    flex-direction: row;
    align-items: center;
    background-color: #ffffff;
    padding: 8px 8px 12px 8px;
}
.upload {
    font-size: 22px;
    color: #1a73e8;
    padding: 6px 10px;
    margin-right: 4px;
}
.input-display {
    flex: 1;
    height: 44px;
    justify-content: center;
    background-color: #f2f3f5;
    border-radius: 22px;
    padding: 0 16px;
}
.input-display-text {
    font-size: 20px;
    color: #222222;
}
.input-display-text-ph {
    font-size: 20px;
    color: #999999;
}
.send {
    font-size: 20px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 18px;
    padding: 8px 20px;
    margin-left: 8px;
}
.send-disabled {
    font-size: 20px;
    color: #aaaaaa;
    background-color: #e0e2e6;
    border-radius: 18px;
    padding: 8px 20px;
    margin-left: 8px;
}

.drawer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 60%;
    background-color: #ffffff;
    flex-direction: column;
    border-right-width: 1px;
    border-right-color: #dddddd;
}
.drawer-head {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    border-bottom-width: 1px;
    border-bottom-color: #eeeeee;
}
.drawer-title {
    font-size: 22px;
    font-weight: bold;
    color: #222222;
}
.drawer-list {
    flex: 1;
}
.conv {
    flex-direction: row;
    align-items: center;
    padding: 10px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #f2f3f5;
}
.conv-active {
    flex-direction: row;
    align-items: center;
    padding: 10px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #f2f3f5;
    background-color: #eaf2ff;
}
.conv-main {
    flex: 1;
}
.conv-title {
    font-size: 20px;
    color: #222222;
}
.conv-mode {
    font-size: 14px;
    color: #999999;
    margin-top: 2px;
}
.conv-del {
    font-size: 18px;
    color: #d93025;
    padding: 4px 10px;
}
.drawer-empty {
    font-size: 18px;
    color: #999999;
    text-align: center;
    padding: 30px 0;
}
.drawer-close {
    font-size: 20px;
    color: #1a73e8;
    text-align: center;
    padding: 12px;
    border-top-width: 1px;
    border-top-color: #eeeeee;
}

.picker {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.6);
    flex-direction: column;
}
.picker-head {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #ffffff;
    padding: 12px;
}
.picker-title {
    font-size: 20px;
    color: #222222;
}
.picker-hint {
    font-size: 18px;
    color: #ffffff;
    text-align: center;
    padding: 30px 20px;
}
.picker-hint-error {
    font-size: 18px;
    color: #ffcc80;
    text-align: center;
    padding: 30px 20px;
}
.picker-list {
    flex: 1;
    background-color: #333333;
    padding: 12px;
}
.pick-thumb {
    width: 140px;
    height: 140px;
    border-radius: 8px;
    margin-right: 12px;
    background-color: #555555;
}

/* ========== 深色模式（引擎仅支持单类选择器，用 -dark 变体类切换） ========== */
.page-dark {
    background-color: #121212;
}
.topbar-dark {
    flex-direction: row;
    align-items: center;
    background-color: #1e1e1e;
    padding: 8px;
    flex-wrap: wrap;
}
.icon-btn-dark {
    font-size: 22px;
    color: #ffffff;
    padding: 6px 10px;
}
.top-toggle-dark {
    font-size: 18px;
    color: #ffffff;
    background-color: #2a2a2a;
    border-radius: 12px;
    padding: 4px 10px;
    margin-right: 6px;
}
.top-toggle-on-dark {
    font-size: 18px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 12px;
    padding: 4px 10px;
    margin-right: 6px;
}
.topbar-title-dark {
    font-size: 24px;
    color: #ffffff;
    font-weight: bold;
}
.empty-title-dark {
    font-size: 34px;
    color: #ffffff;
    font-weight: bold;
    text-align: center;
}
.empty-tip-dark {
    font-size: 20px;
    color: #ffffff;
    text-align: center;
}
.bubble-user-dark {
    background-color: #1e5aa8;
    border-radius: 14px;
    padding: 10px 14px;
    max-width: 80%;
}
.bubble-text-user-dark {
    font-size: 20px;
    color: #ffffff;
}
.bubble-assistant-dark {
    background-color: #1e1e1e;
    border-radius: 14px;
    padding: 10px 14px;
    max-width: 90%;
}
.bubble-text-dark {
    font-size: 20px;
    color: #ffffff;
}
.md-text-dark {
    color: #ffffff;
}
.action-dark {
    font-size: 18px;
    color: #ffffff;
    padding: 2px 6px;
}
.reasoning-dark {
    margin-bottom: 8px;
    border-radius: 8px;
    background-color: #232323;
    padding: 6px 10px;
}
.reasoning-head-dark {
    font-size: 16px;
    color: #ffffff;
}
.reasoning-body-dark {
    font-size: 16px;
    color: #ffffff;
    line-height: 22px;
    margin-top: 4px;
}
.md-code-dark {
    font-size: 18px;
    line-height: 26px;
    color: #ffffff;
    background-color: #232323;
    border-radius: 6px;
    padding: 8px;
    font-family: monospace;
}
.md-inline-code-dark {
    font-family: monospace;
    font-size: 16px;
    color: #ffffff;
    background-color: #2a2a2a;
    border-radius: 4px;
    padding: 0 4px;
}
.inputbar-dark {
    flex-direction: row;
    align-items: center;
    background-color: #1e1e1e;
    border-top-width: 1px;
    border-top-color: #333333;
    padding: 8px 8px 12px 8px;
}
.input-display-dark {
    flex: 1;
    height: 44px;
    justify-content: center;
    background-color: #2a2a2a;
    border-radius: 22px;
    padding: 0 16px;
}
.input-display-text-dark {
    font-size: 20px;
    color: #ffffff;
}
.input-display-text-ph-dark {
    font-size: 20px;
    color: #ffffff;
}
.send-dark {
    font-size: 20px;
    color: #000000;
    background-color: #82b1ff;
    border-radius: 18px;
    padding: 8px 20px;
    margin-left: 8px;
}
.drawer-dark {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 60%;
    background-color: #1e1e1e;
    flex-direction: column;
    border-right-width: 1px;
    border-right-color: #333333;
}
.drawer-title-dark {
    font-size: 22px;
    font-weight: bold;
    color: #ffffff;
}
.conv-dark {
    flex-direction: row;
    align-items: center;
    padding: 10px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #ffffff;
}
.conv-active-dark {
    flex-direction: row;
    align-items: center;
    padding: 10px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #ffffff;
    background-color: #1e5aa8;
}
.conv-title-dark {
    font-size: 20px;
    color: #ffffff;
}
.conv-mode-dark {
    font-size: 14px;
    color: #ffffff;
    margin-top: 2px;
}
.modal-mask-dark {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.7);
    justify-content: center;
    align-items: center;
}
.modal-box-dark {
    background-color: #1e1e1e;
    border-radius: 16px;
    padding: 24px;
    max-width: 80%;
}
.modal-title-dark {
    font-size: 24px;
    font-weight: bold;
    color: #ffffff;
    margin-bottom: 12px;
    text-align: center;
}
.picker-head-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    background-color: #1e1e1e;
    padding: 12px;
}
.picker-title-dark {
    font-size: 20px;
    color: #ffffff;
}
.chip-dark {
    font-size: 18px;
    color: #ffffff;
    background-color: #2a2a2a;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}
.chip-locked-dark {
    font-size: 18px;
    color: #ffffff;
    background-color: #1e1e1e;
    border-radius: 12px;
    padding: 4px 12px;
    margin-right: 8px;
}
.edit-banner-dark {
    flex-direction: row;
    align-items: center;
    background-color: #2a2a2a;
    padding: 4px 12px;
}
.edit-banner-text-dark {
    flex: 1;
    font-size: 16px;
    color: #ffffff;
}
.edit-banner-btn-dark {
    font-size: 16px;
    color: #ffffff;
    padding: 2px 8px;
}
.backend-error-banner-dark {
    flex-direction: row;
    align-items: center;
    background-color: #3d1f1f;
    padding: 6px 12px;
    border-bottom-width: 1px;
    border-bottom-color: #4a2a2a;
}
.backend-error-text-dark {
    font-size: 16px;
    color: #ffffff;
}
.draft-imgs-dark {
    flex-direction: row;
    flex-wrap: wrap;
    background-color: #1e1e1e;
    padding: 6px 12px 0 12px;
}

/* ========== build 22 深色补全（#1/#7）：以下为模板中经 dc() 切换的类 ========== */
.drawer-mask {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.4);
}
.md-dark {
    flex-direction: column;
}
.md-p-dark {
    flex-direction: row;
    flex-wrap: wrap;
    font-size: 20px;
    line-height: 28px;
    color: #e8e8e8;
}
.md-span-dark {
    color: #e8e8e8;
    font-size: 20px;
    line-height: 28px;
}
.md-bold-dark {
    font-weight: bold;
    color: #e8e8e8;
    font-size: 20px;
    line-height: 28px;
}
.md-italic-dark {
    font-style: italic;
    color: #e8e8e8;
    font-size: 20px;
    line-height: 28px;
}
.md-quote-dark {
    font-size: 20px;
    line-height: 28px;
    color: #aaaaaa;
    border-left-width: 3px;
    border-left-color: #555555;
    padding-left: 10px;
    margin: 4px 0;
}
.md-hr-dark {
    font-size: 16px;
    color: #666666;
    text-align: center;
}
.md-list-dark {
    flex-direction: column;
}
.md-li-marker-dark {
    font-size: 20px;
    line-height: 28px;
    color: #e8e8e8;
    margin-right: 4px;
}
.md-heading-dark {
    font-weight: bold;
    color: #e8e8e8;
}
.md-h1-dark {
    font-size: 30px;
    line-height: 36px;
    margin-top: 4px;
}
.md-h2-dark {
    font-size: 28px;
    line-height: 34px;
    margin-top: 4px;
}
.md-h3-dark {
    font-size: 26px;
    line-height: 32px;
    margin-top: 4px;
}
.md-h4-dark, .md-h5-dark, .md-h6-dark {
    font-size: 24px;
    line-height: 30px;
    margin-top: 4px;
}
.pending-dark {
    font-size: 18px;
    color: #aaaaaa;
}
.streaming-hint-dark {
    font-size: 16px;
    color: #82b1ff;
    margin-top: 4px;
}
.bubble-text-error-dark {
    font-size: 20px;
    line-height: 28px;
    color: #ff8a80;
}
.thumb-dark {
    width: 120px;
    height: 90px;
    border-radius: 8px;
    margin-right: 6px;
    background-color: #2a2a2a;
}
.attempt-nav-dark {
    font-size: 22px;
    color: #82b1ff;
    padding: 0 6px;
}
.attempt-indicator-dark {
    font-size: 16px;
    color: #aaaaaa;
    padding: 0 4px;
}
.drawer-head-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    border-bottom-width: 1px;
    border-bottom-color: #333333;
}
.conv-del-dark {
    font-size: 18px;
    color: #ff8a80;
    padding: 4px 10px;
}
.drawer-empty-dark {
    font-size: 18px;
    color: #aaaaaa;
    text-align: center;
    padding: 30px 0;
}
.drawer-close-dark {
    font-size: 20px;
    color: #82b1ff;
    text-align: center;
    padding: 12px;
    border-top-width: 1px;
    border-top-color: #333333;
}
.sync-msg {
    font-size: 14px;
    color: #1a73e8;
    padding: 4px 12px;
}
.sync-msg-dark {
    font-size: 14px;
    color: #82b1ff;
    padding: 4px 12px;
}
.send-disabled-dark {
    font-size: 20px;
    color: #666666;
    background-color: #2a2a2a;
    border-radius: 18px;
    padding: 8px 20px;
    margin-left: 8px;
}
</style>
