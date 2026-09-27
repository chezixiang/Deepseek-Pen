<template>
    <div :class="pageClass">
        <div :class="portrait ? 'pwrap' : 'pwrap'">
        <!-- 竖屏（实验）：旋转画布为独立内层元素，不再把 transform 挂在
             flex:1 + position:relative 的布局根上（此前结构白屏的可能原因） -->
        <div :class="portrait ? dc('rotate-canvas') : 'fill-canvas'" :style="portraitStyle">
        <!-- 顶栏：会话 | 联网/深度思考 | 模式/标题 | 设置 -->
        <div :class="dc('topbar')" v-if="!camMode">
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
        <div :class="dc('edit-banner')" v-if="editingMsgId && !camMode">
            <text :class="dc('edit-banner-text')">正在修改消息，发送后重新生成回复</text>
            <text :class="dc('edit-banner-btn')" @click="cancelEdit">取消</text>
        </div>

        <!-- 后端断线提示 -->
        <div :class="dc('backend-error-banner')" v-if="backendDisconnected && !camMode">
            <text :class="dc('backend-error-text')">⚠️ 后端连接已断开（如果是安装/更新后第一次打开软件可以通过配置账号的方式重启服务试试）</text>
        </div>

        <!-- 消息区。scroller 绝不能套 v-if：Falcon 对被 v-if 包装的 scroller 会渲染空白。
             相机模式下由后面的 cam-stage 黑色窗口覆盖，不销毁消息节点，避免进入
             取景页时同步重建/销毁整棵消息树造成输入卡顿。 -->
        <scroller class="msgs" scroll-direction="vertical">
            <div class="empty" v-if="!camMode && messages.length === 0">
                <text v-if="cloudLoadingId === activeId" :class="dc('empty-tip')">正在加载云端对话…</text>
                <text v-else :class="dc('empty-title')">Deepseek</text>
                <text v-if="cloudLoadingId !== activeId" :class="dc('empty-tip')">你好，我是 DeepSeek，有什么可以帮你？</text>
            </div>

            <div v-for="m in chatMessages" :key="m.id" class="msg" :ref="'msg-' + m.id">
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
                        </div>                        <text :class="dc('bubble-text-user')" v-if="m.content">{{ dispText(m.content) }}</text>
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
                                    <text v-if="!isReasoningCollapsed(m.id)" :class="dc('reasoning-body')">{{ dispText(m.reasoning) }}</text>
                                </div>
                                <text v-if="m.error" :class="dc('bubble-text-error')">{{ m.error }}</text>
                                <div v-else :class="dc('md')">
                                    <div v-for="(block, bi) in markdownBlocks(m.content, !m.pending)" :key="bi" class="md-block">
                                        <div v-if="block.type === 'p'" :class="dc('md-p')">
                                            <!-- run 必须是**同级**节点，不能嵌套（见 mdRuns 注释：嵌套会让框架 abort）。
                                                 数学 run 用 <richtext><latex value> 走原生排版，与 <text> 平级。 -->
                                            <template v-for="(r, ri) in mdRuns(block.text, !m.pending)" :key="ri">
                                                <richtext v-if="r.math" :class="dc('md-math')"><latex :value="r.text"></latex></richtext>
                                                <text v-else :class="runClass(r)">{{ r.text }}</text>
                                            </template>
                                        </div>
                                        <div v-else-if="block.type === 'math'" :class="dc('md-math-block')">
                                            <richtext v-if="canTypeset(block.text)" :class="dc('md-math')"><latex :value="block.text"></latex></richtext>
                                            <text v-else-if="!mathBalanced(block.text)" :class="dc('md-math-src')">${{ block.text }}$</text>
                                            <text v-else :class="dc('md-math-fallback')">{{ dispText(block.text) }}</text>
                                        </div>
                                        <text v-else-if="block.type === 'code'" :class="dc('md-code')">{{ block.text }}</text>
                                        <text v-else-if="block.type === 'quote'" :class="dc('md-quote')">{{ dispText(block.text) }}</text>
                                        <text v-else-if="block.type === 'hr'" :class="dc('md-hr')">————————</text>
                                        <div v-else-if="block.type === 'list'" :class="dc('md-list')">
                                            <div v-for="(item, ii) in block.items" :key="ii" class="md-li-row">
                                                <text :class="dc('md-li-marker')">{{ listMarker(block, ii) }}</text>
                                                <template v-for="(r, ri) in mdRuns(item, !m.pending)" :key="ri">
                                                    <richtext v-if="r.math" :class="dc('md-math')"><latex :value="r.text"></latex></richtext>
                                                    <text v-else :class="runClass(r, isTaskDone(block, ii))">{{ r.text }}</text>
                                                </template>
                                            </div>
                                        </div>
                                        <!-- 表格：等宽列、横线分隔（无竖线外框，与整体轻线条风格一致）。
                                             表头是纯文本（粗体+底色）；单元格走行内 runs，
                                             run 仍须同级平铺（<text> 内嵌元素会 abort，见 mdRuns 注释） -->
                                        <div v-else-if="block.type === 'table'" :class="dc('md-table')">
                                            <div :class="dc('md-tr')">
                                                <div v-for="(cell, ci) in block.header" :key="'h' + ci" :class="dc('md-th')">
                                                    <text :class="dc('md-th-text')" :style="mdAlign(block.align, ci)">{{ dispText(cell) }}</text>
                                                </div>
                                            </div>
                                            <div v-for="(row, ri) in block.rows" :key="'r' + ri" :class="dc('md-tr')">
                                                <div v-for="(cell, ci) in row" :key="'c' + ci" :class="dc('md-td')">
                                                    <template v-for="(r, rr) in mdRuns(cell, !m.pending)" :key="rr">
                                                        <richtext v-if="r.math" :class="dc('md-math')"><latex :value="r.text"></latex></richtext>
                                                        <text v-else :class="runClass(r)">{{ r.text }}</text>
                                                    </template>
                                                </div>
                                            </div>
                                        </div>
                                        <text v-else :class="dc('md-heading') + ' md-' + block.type">{{ dispText(block.text) }}</text>
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
            <!-- 空态（欢迎语）时不渲染 spacer/anchor：否则内容高度超过视口，
                 scroller 能滑动且 scrollToBottom 会把气泡滚出视口（用户反馈：
                 欢迎语不应可滑、短会话滚到底只剩"重试"按钮）。 -->
            <div class="msgs-tail-spacer" v-if="messages.length"></div>
            <div class="bottom-anchor" ref="bottom" v-if="messages.length"></div>
        </scroller>

        <!-- 待发图片（悬浮输入组件上方，右对齐） -->
        <div :class="dc('draft-imgs-float')" v-if="draftImages.length && !camMode">
            <div v-for="(img, i) in draftImages" :key="img.path" class="draft-img">
                <image :class="dc('draft-thumb')" resize="cover" :src="fileUrl(img.path)" />
                <text class="draft-remove" @click="removeDraftImage(i)">×</text>
            </div>
        </div>
        <text v-if="imageWarn && !camMode" :class="dc('draft-warn')">{{ imageWarn }}</text>

        <!-- 右下角悬浮输入组件：小文本框在上，相册/发送圆钮在下——
             几乎不占消息区竖向空间（用户手绘稿布局）。
             按钮禁用文字与 emoji（设备字体缺字形渲染白块），一律 PNG 图标 -->
        <div :class="dc('float-input')" v-if="!camMode">
            <div :class="dc('float-textbox')" @click="openInput">
                <text :class="draft ? dc('input-display-text') : dc('input-display-text-ph')">{{ draft || '点击输入' }}</text>
            </div>
            <div class="float-btns">
                <div v-if="canUploadImage" :class="dc('float-btn')" @click="openPicker">
                    <image class="float-icon-img" resize="contain" :src="albumIconSrc()" />
                </div>
                <div :class="sendFloatClass()" @click="send">
                    <image class="float-icon-img" resize="contain" :src="sendIconSrc()" />
                </div>
            </div>
        </div>

        <!-- 竖屏旋转画布到此为止：遮罩/抽屉/选择器/相机浮层保持不旋转，绝对定位于 pwrap。
             相机取景/确认也移出旋转画布：相机永远横屏铺满（936x280），与相册选择器
             同一坐标系 —— 竖屏模式下选择器本就不旋转，取景若留在旋转画布里会被
             220px 侧板挤爆且触摸坐标无法对应。 -->
        </div>

        <!-- 会话抽屉：全屏遮罩挡住穿透点击（#8），点遮罩关闭。
             bug 修复：Weex 中未绑定点击的容器不拦截触摸，事件会穿透到遮罩导致
             点击列表内空白处也关闭抽屉——根节点/头部/列表绑定空消费点击。 -->
        <div class="drawer-mask" v-if="showDrawer && !camMode" @click="closeDrawer"></div>
        <div :class="dc('drawer')" v-if="showDrawer && !camMode" @click="noopDrawer">
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

        <!-- 相册选择器：竖向滚动网格（新图在上），底部"去拍照"引导。
             进入相机后停止相册后台缩略图更新，避免 picker 与相机层同时参与重排。 -->
        <div class="picker" v-if="showPicker && !camMode">
            <div :class="dc('picker-head')">
                <text :class="dc('picker-title')">相册（/userdisk/Pictures）</text>
                <text :class="dc('icon-btn')" @click="closePicker">关闭</text>
            </div>
            <scroller class="picker-vlist" scroll-direction="vertical">
                <text v-if="albumLoading" class="picker-hint">加载中…</text>
                <text v-else-if="albumError" class="picker-hint-error">{{ albumError }}</text>
                <text v-else-if="albumImages.length === 0" class="picker-hint">相册里还没有图片</text>
                <div v-else class="picker-grid">
                    <!-- 拍照固定为第一格（一张"图片"，点击进入取景） -->
                    <div class="pick-cell" @click="openCamera">
                        <div :class="dc('pick-camera')">
                            <image class="pick-camera-icon" resize="contain" :src="cameraIconSrc()" />
                        </div>
                    </div>
                    <div v-for="img in albumImages" :key="img.path" class="pick-cell" @click="pickImage(img)">
                        <image class="pick-thumb-v" resize="cover" :src="fileUrl(img.thumb || img.path)" />
                    </div>
                </div>
                <div class="picker-photo-tip">
                    <text class="picker-photo-text">要发新照片？用系统"拍照识题/拍照"功能拍摄后，回到这里选择</text>
                </div>
            </scroller>
        </div>

        <!-- 相机取景：video29 帧循环转 JPEG，显示区域 700x280；
             相册节点在进入相机时卸载，右侧保留关闭按钮和快门。 -->
        <div class="cam-stage" v-if="showCamera && !showConfirm">
            <image class="cam-frame" v-if="previewMode === 'frames' && previewFrame" resize="contain" :src="previewFrame" />
            <text class="cam-hint" v-if="camHintText">{{ camHintText }}</text>
            <text class="cam-err" v-if="camError">{{ camError }}</text>
            <image class="cam-close" resize="contain" :src="closeIconSrc()" @click="closeCamera(true)" />
            <div class="shutter-outer" @click="shoot">
                <div class="shutter-inner"></div>
            </div>
        </div>

        <!-- 拍照确认浮层：全屏带图 + 可拖拽裁剪框（官方同款：自己拖，不是预设比例） -->
        <div class="camera-view" v-if="showConfirm">
            <image class="camera-preview" resize="contain" :src="confirmSrc" />
            <div class="crop-mask" :style="cropMaskStyle('top')"></div>
            <div class="crop-mask" :style="cropMaskStyle('bottom')"></div>
            <div class="crop-mask" :style="cropMaskStyle('left')"></div>
            <div class="crop-mask" :style="cropMaskStyle('right')"></div>
            <div class="crop-border" :style="cropBoxStyle"></div>
            <div class="crop-grab" :style="cropBoxStyle"
                 @touchstart="cropTouchStart('move', $event)"
                 @touchmove="cropTouchMove"
                 @touchend="cropTouchEnd"></div>
            <div class="crop-handle crop-h-tl" :style="cropHandleStyle('tl')"
                 @touchstart="cropTouchStart('tl', $event)" @touchmove="cropTouchMove" @touchend="cropTouchEnd"></div>
            <div class="crop-handle crop-h-tr" :style="cropHandleStyle('tr')"
                 @touchstart="cropTouchStart('tr', $event)" @touchmove="cropTouchMove" @touchend="cropTouchEnd"></div>
            <div class="crop-handle crop-h-bl" :style="cropHandleStyle('bl')"
                 @touchstart="cropTouchStart('bl', $event)" @touchmove="cropTouchMove" @touchend="cropTouchEnd"></div>
            <div class="crop-handle crop-h-br" :style="cropHandleStyle('br')"
                 @touchstart="cropTouchStart('br', $event)" @touchmove="cropTouchMove" @touchend="cropTouchEnd"></div>
            <text class="crop-hint">拖白框选区域 · 拖四角调大小</text>
            <text class="cam-err" v-if="camError">{{ camError }}</text>
            <div class="confirm-btn-redo" @click="retakeShot">
                <image class="confirm-icon" resize="contain" :src="redoIconSrc()" />
            </div>
            <div class="confirm-btn-ok" @click="confirmShot">
                <image class="confirm-icon" resize="contain" :src="checkIconSrc()" />
            </div>
        </div>
        </div>
    </div>
</template>

<script>
import { MODES, getMode, buildMessages, chatStream, stripInternalTags, listCloudSessions, listCloudSessionMessages, deleteCloudSession } from '../../services/ds.js'
import { isAccountSuspension, isRateLimitedError } from '../../services/error-classify.js'
import {
    loadConversations, saveConversations, loadMessages, saveMessages,
    deleteMessages, loadSettings, loadActiveId, saveActiveId, uid, DEFAULT_SETTINGS,
    recordAccountTrouble
} from '../../services/store.js'
import { listAlbum, readImageDataUrl, ensureThumb, cancelThumbJobs } from '../../services/images.js'
import { startPreview, stopPreview, startFramePreview, stopFramePreview, capturePhoto, cropFrame, PHOTO_W, PHOTO_H } from '../../services/camera.js'
import { openTextEditor, setDebugLogEnabled, stopStream, INPUT_TYPES, ensureBackendRunning } from '../../services/native.js'
import { markdownToBlocks, inlineSpans, splitEmojiRuns, latexToText, splitMathSegments, canTypesetMath, bracesBalanced } from '../../services/markdown.js'
import { ensureEmojiFont } from '../../services/emoji-font.js'
import { substituteEmoji } from '../../services/emoji-subst.js'
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
            // 相册缩略图生成序号：进入取景/关闭相册后，使旧的后台任务失效，
            // 避免每张缩略图完成时继续对整页 forceUpdate。
            albumLoadSeq: 0,
            // 现场拍摄进行中（services/camera.js）
            takingPhoto: false,
            // 相机取景浮层（JPEG 帧循环 ~7fps；避免把黑色 kmssink plane 误判为有效预览）
            showCamera: false,
            // 取景模式：''=启动中，'frames'=黑底+image
            previewMode: '',
            // 取景帧路径（仅 frames 模式使用，/tmp 双文件轮换）
            previewFrame: '',
            // 拍照确认浮层：预览图 + 确认/重拍/可拖拽裁剪框
            showConfirm: false,
            confirmSrc: '',
            confirmPath: '',
            // 裁剪框（屏幕坐标 px，相对相机浮层）：拖动/缩放见 cropTouch* 方法。
            // 初始占满（不拖 = 全带直接发），与官方"自己拖一个框"一致。
            cropBox: { x: 0, y: 0, w: 0, h: 0 },
            // 进行中的拖拽：模式（move/tl/tr/bl/br）+ 上一个触摸点
            cropDrag: { mode: '', x: 0, y: 0 },
            // 相机流程内的错误提示（取景/确认页都可见；相册页的 albumError 互不影响）
            camError: '',
            // 图片过大无法发送时的提示（见 images.js 的体积上限）
            imageWarn: '',
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
            // 相机模式页面保持不透明：预览由 image 帧循环绘制，
            // 不依赖透明洞或 DRM plane 的层级顺序。
            return this.isDark ? 'page page-dark' : 'page'
        },
        // 相机相关浮层是否激活（取景或确认）
        camMode() {
            return this.showCamera || this.showConfirm
        },
        // 消息区：相机模式由后面的 cam-stage 黑色层覆盖显示，**不再把消息数组
        // 替换为空数组**。清空 chatMessages 会让 Falcon 在点击拍照格时同步销毁
        // 整棵消息 scroller（长消息/图片多时表现为整机卡顿，输入事件排队），
        // 这是进入取景页卡顿的根因。scroller 保持稳定，只切换上层相机控件。
        chatMessages() {
            return this.messages
        },
        isDark() {
            // 深色模式：'dark' 深色，其余浅色（词典笔无系统深色；兼容旧设置里的 'auto' 视为浅色）
            if (!this.settings) return false
            return this.settings.theme === 'dark'
        },
        // 抽屉渲染列表：按搜索词过滤（#7）
        // 必须放在 computed 里：之前定义在 methods 中，模板 `v-for="c in drawerConversations"`
        // 拿到的是**函数本身**（不是返回值），v-for 遍历函数对象得到空数组 —— 抽屉永远显示
        // "暂无会话"，云端同步导入成功也看不到（bug 3）。
        drawerConversations() {
            const q = (this.convFilter || '').trim().toLowerCase()
            if (!q) return this.conversations
            return this.conversations.filter((c) => (c.title || '').toLowerCase().indexOf(q) >= 0)
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
        },
        // ===== 相机浮层几何 =====
        // 屏幕尺寸：取框架环境宽高（X7 Pro 实测 936x280 横屏），取不到回退实测值。
        // 相机浮层已移出旋转画布，永远按横屏布局（与相册选择器一致）。
        stageW() {
            try {
                const env = weex.config.env
                return Math.max(env.deviceWidth, env.deviceHeight) || 936
            } catch (e) { return 936 }
        },
        stageH() {
            try {
                const env = weex.config.env
                return Math.min(env.deviceWidth, env.deviceHeight) || 280
            } catch (e) { return 280 }
        },
        // 确认页预览图（PHOTO_W x PHOTO_H 的带图）resize=contain 后实际铺出的
        // 矩形：image 节点占满整个浮层，contain 会在剩余横向空间内居中；
        // 裁剪框必须使用同一矩形，否则会整体偏左而无法贴合照片边框。
        dispRect() {
            const W = this.stageW
            const H = this.stageH
            const s = Math.min(W / PHOTO_W, H / PHOTO_H)
            const w = PHOTO_W * s
            const h = PHOTO_H * s
            return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h }
        },
        cropBoxStyle() {
            const b = this.cropBox
            return {
                left: b.x + 'px',
                top: b.y + 'px',
                width: b.w + 'px',
                height: b.h + 'px'
            }
        },
        camHintText() {
            if (this.previewMode === 'frames' && this.previewFrame) return ''
            return '相机启动中…'
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
        // 相机预览是常驻 gst 管道 + JS 轮询，页面销毁必须一并停掉，
        // 否则相机节点被占、回调持有组件引用
        cancelThumbJobs()
        ++this.albumLoadSeq
        stopPreview()
        if (this._errTimer) { clearTimeout(this._errTimer); this._errTimer = null }
        // 清理节流的渲染/滚动定时器，避免页面销毁后回调仍持有组件引用
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null }
        if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null }
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
        // 流式渲染节流：每来一个 delta 就 $forceUpdate + 滚动，会把弱 SoC 的 CPU
        // 打满（消息多时还要全量重渲染整列），是"发送消息时设备卡死/重启"的诱因之一。
        // 合并成最多 ~8 帧/秒；流式结束时用 flushRender 保证最终画面一致。
        scheduleRender() {
            if (this._renderTimer) return
            this._renderTimer = setTimeout(() => {
                this._renderTimer = null
                this.$forceUpdate()
                this.scrollToBottom(true)
            }, 120)
        },
        flushRender() {
            if (this._renderTimer) {
                clearTimeout(this._renderTimer)
                this._renderTimer = null
            }
            this.$forceUpdate()
            this.scrollToBottom(true)
        },
        closeDrawer() {
            this.showDrawer = false
            this.syncMsg = ''
            this.$forceUpdate()
        },
        // 空消费点击：挡住抽屉内部空白区域的事件穿透到遮罩（bug 修复）
        noopDrawer() {},
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
                let linked = 0
                for (const s of list) {
                    const title = String(s.title || '').trim()
                    if (!title) continue
                    const ts = s.updated_at ? Math.round(s.updated_at * 1000) : Date.now()
                    // 已关联过的云端会话（cloudId 匹配）：不重复导入
                    if (this.conversations.some((c) => c.cloudId === s.id)) continue
                    // 本机新建的会话在云端也有一条同名会话（服务端为每次对话都建了 session），
                    // 但它本地还没有 cloudId。旧实现只按 cloudId 去重，于是同步时把同一条
                    // 对话又导入一遍 —— 抽屉里出现两份（云的一份是空占位，进入才拉取）。
                    // 这里先按标题认领：命中未关联的本地会话就补上 cloudId 并标记
                    // cloudLoaded（消息本地已有，不需要再拉云端内容覆盖）。
                    const candidates = this.conversations.filter((c) => !c.cloudId && !c.cloudLinked && (c.title || '').trim() === title)
                    if (candidates.length) {
                        let best = candidates[0]
                        let bestDiff = Math.abs((best.updatedAt || 0) - ts)
                        for (const c of candidates) {
                            const diff = Math.abs((c.updatedAt || 0) - ts)
                            if (diff < bestDiff) {
                                best = c
                                bestDiff = diff
                            }
                        }
                        best.cloudId = s.id
                        best.cloudLinked = true
                        best.cloudLoaded = true
                        linked += 1
                        continue
                    }
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
                if (added > 0 || linked > 0) {
                    await saveConversations(this.conversations)
                }
                // 已关联的会话不再计入"导入"：认领只是给本地会话补云端身份，没有新增条目
                this.syncMsg = added > 0
                    ? ('已导入 ' + added + ' 个云端会话（进入时加载内容）' + (linked ? '，关联 ' + linked + ' 个本地会话' : ''))
                    : (linked > 0 ? ('已关联 ' + linked + ' 个本地会话，无重复导入') : '云端会话均已存在')
                appLog('[sync] 云端会话 ' + list.length + ' 个，新增 ' + added + '，关联 ' + linked)
            } catch (e) {
                this.syncMsg = '同步失败：' + (e && e.message ? e.message : '未知错误')
                const msg = e && e.message ? e.message : String(e)
                if (isAccountSuspension(msg)) {
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
                        // 云端编辑历史：alt_texts 是被替换的旧版本（升序），当前
                        // content 是最新——与本地 revisions 的语义一致
                        // （revisions[activeRevision] 为当前显示版本）。
                        const alts = Array.isArray(m.alt_texts) ? m.alt_texts : []
                        msgs.push({
                            id, role: 'user', content: m.content, images: [], createdAt: now + seq++,
                            revisions: alts.map((t) => ({ content: t, images: [], createdAt: now + seq }))
                                .concat([{ content: m.content, images: [], createdAt: now + seq }]),
                            activeRevision: alts.length
                        })
                    } else {
                        const id = uid('a')
                        // 云端重试历史同理映射为 attempts（attempts[activeAttempt]
                        // 为当前版本，本地 retryMessage 就是往 attempts 追加）。
                        const alts = Array.isArray(m.alt_texts) ? m.alt_texts : []
                        msgs.push({
                            id, role: 'assistant', content: m.content, reasoning: m.reasoning || '', pending: false,
                            createdAt: now + seq++,
                            attempts: alts.map((t) => ({ id: uid('a'), content: t, reasoning: '', pending: false, createdAt: now + seq }))
                                .concat([{ id, content: m.content, reasoning: m.reasoning || '', pending: false, createdAt: now + seq }]),
                            activeAttempt: alts.length
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
                if (isAccountSuspension(msg)) {
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
        //
        // final=true 表示该内容已定稿（消息不再增长），才写缓存。流式过程中每来
        // 一个 delta 都解析一次却从不命中缓存，把 cache 填满 400 条前缀后就整表
        // clear —— 反复解析 + 反复清缓存是长回复时的内存与 CPU 峰值来源，也是
        // 发送消息时设备卡死/重启的诱因之一（bug 2）。
        markdownBlocks(content, final = true) {
            if (!content) return []
            if (!final) return markdownToBlocks(content)
            const cache = this._mdCache || (this._mdCache = new Map())
            if (cache.has(content)) return cache.get(content)
            const blocks = markdownToBlocks(content)
            if (cache.size > 400) cache.clear()
            cache.set(content, blocks)
            return blocks
        },
        // 行内 run 列表：把一段文本拆成 [{ text, bold?, italic?, code?, emoji }]，
        // 每个 run 由模板渲染成**一个同级 <text>**。
        //
        // 为什么不用嵌套 <text>：本设备的 Falcon 引擎在 <text> 里再放 <text> 时，
        // Yoga 会走到 "Cannot add child: Nodes with measure functions cannot have
        // children." 断言并 abort **整个框架进程**（/usrdisk/corefile 有 dmp）。
        // 表现为"一发消息 App 就闪退/设备像重启了"，重新进入后只要渲染到同一条
        // 消息就立刻再崩——因为 abort 发生在渲染期，消息又已落盘。
        // 曾经的写法是 <text :class="spanClass(s)"><text :class="emojiRunClass(...)">…，
        // 正好踩中这个断言。现在两层合一层，run 之间平级。
        mdRuns(text, final = true) {
            const key = String(text === undefined || text === null ? '' : text)
            if (!final) return this._buildRuns(key, false)
            const cache = this._runCache || (this._runCache = new Map())
            if (cache.has(key)) return cache.get(key)
            const result = this._buildRuns(key, true)
            if (cache.size > 600) cache.clear()
            cache.set(key, result)
            return result
        },
        // 实际转换：先按 markdown 行内语法切 span，再把每个 span 按 emoji 区段切 run，
        // 最后拍平成一个数组（不保留层级，模板才能平铺渲染）。
        //
        // 数学公式：设备固件自带 clatexmath，<richtext><latex value="…"/></richtext> 能排出
        // 真正的分式/求和号/根式。但两个实测限制决定了它只用在"定稿 + 短公式"上：
        // 超长公式被截断（不换行），括号不配平的中间态渲染成空白。其余情况一律回退
        // Unicode（latexToText），内容完整且能换行——宁可朴素，不要显示半截或空白。
        _buildRuns(text, final = true) {
            const src = String(text === undefined || text === null ? '' : text)
            const runs = []
            const segs = splitMathSegments(src)
            for (let k = 0; k < segs.length; k++) {
                const seg = segs[k]
                if (seg.math) {
                    if (final && canTypesetMath(seg.text)) {
                        runs.push({ text: seg.text, math: true })
                    } else if (!bracesBalanced(seg.text)) {
                        // 括号不配平（流式中间态 / 模型笔误）：原生排成空白、Unicode
                        // 会把 \frac 啃成 "frac" 拼出错字。原样显示源码最诚实，且
                        // 流式下一帧就变正常，不会停留。
                        runs.push({ text: '$' + seg.text + '$', code: true })
                    } else {
                        // 超长等其它情况：Unicode 近似（内容完整、可换行，只是不精确）
                        const uni = latexToText('$' + seg.text + '$')
                        if (uni) runs.push({ text: uni })
                    }
                    continue
                }
                const spans = inlineSpans(seg.text)
                for (let i = 0; i < spans.length; i++) {
                    const s = spans[i]
                    // emoji 替换只改显示层：字体可用时用原文，否则把 emoji 换成文字标签
                    const source = this._emojiFontActive ? s.text : substituteEmoji(s.text)
                    const pieces = splitEmojiRuns(source)
                    for (let j = 0; j < pieces.length; j++) {
                        if (!pieces[j].t) continue
                        runs.push({
                            text: pieces[j].t,
                            bold: !!s.bold,
                            italic: !!s.italic,
                            code: !!s.code,
                            emoji: !!pieces[j].e
                        })
                    }
                }
            }
            if (runs.length === 0) runs.push({ text: '' })
            return runs
        },
        // run 的 class：行内样式 + emoji 字体（字体可用时才套，否则已经是文字标签）
        // forceStrike：任务列表已完成项整条加删除线（√ + 删除线传达"完成"）
        runClass(r, forceStrike) {
            let s = r
            if (forceStrike && r && !r.math && !r.code) {
                s = { text: r.text, bold: r.bold, italic: r.italic, code: r.code, strike: true }
            }
            let cls = this.spanClass(s)
            if (r && r.emoji && this._emojiFontActive) cls += ' md-emoji'
            return cls
        },
        // 块级公式是否交给原生排版（过长/括号不配平 → 回退，见 canTypesetMath）
        canTypeset(tex) {
            return canTypesetMath(tex)
        },
        mathBalanced(tex) {
            return bracesBalanced(tex)
        },
        // 纯文本展示路径（用户消息 / 思考过程 / 引用 / 标题）：字体不可用时替换 emoji。
        // 数学公式（LaTeX）在此转成 Unicode 纯文本——这些路径不经过 inlineSpans，
        // 不转换就会把 $x^{2}$ 原样显示出来（bug 2）。
        dispText(text) {
            const key = String(text === undefined || text === null ? '' : text)
            const withMath = latexToText(key)
            return this._emojiFontActive ? withMath : substituteEmoji(withMath)
        },
        spanStyle(s) {
            let st = ''
            if (s.bold) st += 'font-weight:bold;'
            if (s.italic) st += 'font-style:italic;'
            if (s.code) st += 'font-family:monospace;'
            return st
        },
        // bug 修复（深色黑字）：Weex 的 <div> 颜色不会可靠继承到 <text>，
        // 裸 span/加粗/斜体必须带显式颜色类，否则深色模式下渲染为默认黑色。
        // 优先级从上往下：删除线压过粗斜（任务完成项 "√ + ~~**名**~~" 以删除线为准）
        spanClass(s) {
            if (s.strike) return this.dc('md-strike')
            if (s.bold && s.italic) return this.dc('md-bold-italic')
            if (s.bold) return this.dc('md-bold')
            if (s.italic) return this.dc('md-italic')
            if (s.link) return this.dc('md-link')
            if (s.code) return this.dc('md-inline-code')
            return this.dc('md-span')
        },
        // 列表 marker：任务项 √/□（√ 是数学符号 U+221A，设备数学字体必有；
        // □ U+25A1 CJK 字体常带——避开缺字形的 emoji 字符），普通项沿用原符号
        listMarker(block, ii) {
            const st = block.taskStates && block.taskStates[ii]
            if (st === 'done') return '√ '
            if (st === 'open') return '□ '
            return block.ordered ? ((block.start || 1) + ii) + '. ' : '• '
        },
        isTaskDone(block, ii) {
            return !!(block.taskStates && block.taskStates[ii] === 'done')
        },
        // 表格列对齐：GFM 分隔行解析出的 left/center/right 套到单元格文字上
        mdAlign(align, ci) {
            const a = (align && align[ci]) || 'left'
            return 'text-align:' + a
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
                // errorCode 必须跟着切：重试按钮靠它判断"这条是限流失败"，
                // 漏掉会让用户切到成功的版本后重试仍被拦（或反之放行）（bug 1）
                m.errorCode = att.errorCode || ''
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
        // Emoji 字体开关打开时：下载（如需）并注册，成功后重渲染生效（#2）。
        // 注册成功 → 关闭文本替换（_emojiFontActive），清缓存后强制重渲染；
        // 注册失败（设备不支持/下载失败）→ 保持替换，emoji 以文字标签展示。
        ensureEmojiFontIfEnabled() {
            if (!(this.settings && this.settings.emojiFont)) return
            ensureEmojiFont()
                .then((r) => {
                    if (r.ok) {
                        this._emojiFontActive = true
                        // run 缓存里存的是「按当时字体可用性构建」的结果，字体状态一变就得整表清掉
                        if (this._runCache) this._runCache.clear()
                        this.$forceUpdate()
                        return
                    }
                    // 失败原因写日志：开关显示"已开启"但只渲染出白块时，
                    // 用户能在"查看日志"里看到到底是设备不支持还是下载失败。
                    this._emojiFontActive = false
                    appLog('[index] emoji 字体不可用（已用文字替换 emoji）：' + (r.message || '未知原因'))
                })
                .catch((e) => {
                    this._emojiFontActive = false
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
            // 未登录兜底：内置模式且没有任何账号时，引导到专用登录页
            // （正常路径由 startup 页判断；这里防御直接进入 index 的情况）
            if (this.settings && this.settings.authMode === 'builtin' && !this.settings.dsConfigured) {
                appLog('[index] 未配置账号，跳转登录页')
                try {
                    $falcon.navTo('login')
                } catch (e) { /* 忽略 */ }
                return
            }
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
        // 悬浮圆钮状态：正常（可发）/禁用（无内容）/停止（发送中）——
        // 引擎仅支持单类选择器，三种状态是三个独立类名
        sendFloatClass() {
            if (this.sending) return this.dc('float-btn-stop')
            return this.canSend() ? this.dc('float-btn-send') : this.dc('float-btn')
        },
        // 按钮 PNG 图标（icons/ 随 AMR 打包，见 build-wrapper 步骤 4）。
        // 浅色按钮蓝图标 / 深色按钮亮蓝图标；发送（蓝底白机）/停止（红底白方块）。
        albumIconSrc() {
            return this.isDark ? 'icons/album-dark.png' : 'icons/album.png'
        },
        sendIconSrc() {
            if (this.sending) return this.isDark ? 'icons/stop-dark.png' : 'icons/stop.png'
            if (!this.canSend()) return this.isDark ? 'icons/send-blue-dark.png' : 'icons/send-blue.png'
            return this.isDark ? 'icons/send-dark.png' : 'icons/send.png'
        },
        closeIconSrc() {
            return this.isDark ? 'icons/close-dark.png' : 'icons/close.png'
        },
        cameraIconSrc() {
            return this.isDark ? 'icons/camera-dark.png' : 'icons/camera.png'
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
            // 切换会话不滚到底：短会话会被"锚点对齐上沿"式滚动把气泡滚出
            // 视口（只剩"重试"按钮），历史会话从头看更自然
        },
        async deleteConversation(c) {
            this.reqSeq += 1
            const cloudId = c && c.cloudId
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
            // 同步删云端会话（bug 3）：只删本地的话，下次「同步」会把这条会话
            // 从云端再导回来，用户看到"删了又回来"。失败不阻断本地删除
            // （本地已经删掉了），只把原因写进提示，用户能自己决定要不要重试。
            if (cloudId) {
                this.deleteCloudConversation(cloudId, c.title)
            }
        },
        // 删除远端会话：失败时把原因显示在抽屉的同步提示里（不弹窗打扰）
        async deleteCloudConversation(cloudId, title) {
            try {
                await deleteCloudSession({
                    baseUrl: this.settings.baseUrl,
                    apiKey: this.settings.apiKey,
                    authMode: this.settings.authMode,
                    sessionId: cloudId
                })
                appLog('[cloud] 已删除云端会话 ' + cloudId + '（' + (title || '') + '）')
            } catch (e) {
                const msg = e && e.message ? e.message : String(e)
                this.syncMsg = '本地已删除，云端删除失败：' + msg + '（下次同步可能重新出现）'
                if (isAccountSuspension(msg)) {
                    recordAccountTrouble('删除云端会话', msg)
                }
                appLog('[cloud] 删除云端会话失败 ' + msg)
                this.$forceUpdate()
            }
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
        // 发送前的本地校验失败提示（不写入消息，避免污染会话）
        failSend(text) {
            this.imageWarn = text
            this.$forceUpdate()
            try { appLog('[send] 已阻断：' + text) } catch (e) { /* 忽略 */ }
        },
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
            const usable = images.filter((i) => i.dataUrl)
            if (images.length && !usable.length) {
                // 全部图片都超限：别发空消息，直接告知原因
                this.failSend('图片过大无法发送（单图上限约 900KB），请换一张或先裁剪')
                return
            }
            if (usable.length < images.length) {
                this.imageWarn = '部分图片过大，无法发送（已跳过）'
            }

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
            this.imageWarn = ''
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

                // 流式（SSE）始终启用：逐字输出是设备上唯一可接受的体验，
                // 非流式要等整段生成完才出字（开关已移除，见 store.js）
                console.error('GEN | using SSE stream')
                const res = await chatStream(opts, {
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
                        this.scheduleRender()
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
                        this.scheduleRender()
                    }
                })

                console.error('GEN | chat returned content len=' + (res && res.content ? res.content.length : 0))
                if (seq !== this.reqSeq || convId !== this.activeId) {
                    console.error('GEN | seq mismatch, return (seq=' + seq + ' reqSeq=' + this.reqSeq + ' convId=' + convId + ' activeId=' + this.activeId + ')')
                    return
                }

                // 上游限流：**立即停止，不做任何自动重试/续发**。
                // 后端此时已让账号进入退避窗口；应用侧再自动发一次，就等于把
                // 退避白等（bug 1：连续请求会被上游升级为禁言）。
                if (res && res.rateLimited) {
                    appLog('[generate] 上游限流，停止自动重试（' + (res.content || '') + '）')
                    const rm = this.messages.find((x) => x.id === pendingId)
                    if (rm) {
                        const rAtt = rm.attempts && rm.attempts[rm.activeAttempt]
                        if (rAtt) {
                            rAtt.pending = false
                            rAtt.error = res.content || '上游限流，请稍后再试'
                        }
                        rm.pending = false
                        rm.error = res.content || '上游限流，请稍后再试'
                    }
                    this.$forceUpdate()
                    return
                }

                // #12：非思考模式返回空内容时，自动按"深度思考开启"重试一次。
                // thinking=OFF 是唯一返回空内容的场景（疑似 DeepSeek 服务端兼容问题），
                // 自动回退保证用户总能拿到回复；根因以诊断日志持续观察。
                if (res && !res.content && !res.reasoning && conv.thinking === false && !forceThinking) {
                    appLog('[generate] 非思考模式返回空内容（mode=' + conv.mode + ' search=' + conv.search + '），自动以思考模式重试 #12')
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
                // 云端会话 id（后端随流末尾下发）：记下来，同步时按 id 去重，
                // 本机这条对话就不会被当成"云端还有一条新的"重复导入（bug 3）
                if (res && res.dsSessionId && convNow && convNow.cloudId !== res.dsSessionId) {
                    convNow.cloudId = res.dsSessionId
                    convNow.cloudLinked = true
                    convNow.cloudLoaded = true
                    await this.persistConversation(convNow)
                    appLog('[generate] 记录云端会话 id => ' + res.dsSessionId)
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
                // 账号异常取证：只记"上游真的限制了这个账号"（禁言/封禁/空 SSE）。
                // 401/未认证不算——那多半是本机后端没起来或 key 失配，记进来会把
                // 用户和后续排查都引向"换账号"（bug 4）。
                if (isAccountSuspension(msg)) {
                    recordAccountTrouble('对话', msg)
                }
                // 限流单独标记在消息上：重试按钮据此拦截，不再向已退避的后端发请求（bug 1）
                const errCode = e && e.code ? String(e.code) : ''
                const rateLimited = isRateLimitedError(e)
                const m = this.messages.find((x) => x.id === pendingId)
                if (m) {
                    const att = m.attempts && m.attempts[m.activeAttempt]
                    if (att) {
                        att.pending = false
                        att.error = e && e.message ? e.message : '发生未知错误，请重试'
                        att.errorCode = rateLimited ? 'upstream_rate_limited' : errCode
                    }
                    m.pending = false
                    m.error = e && e.message ? e.message : '发生未知错误，请重试'
                    m.errorCode = rateLimited ? 'upstream_rate_limited' : errCode
                } else {
                    this.messages.push({
                        id: pendingId,
                        role: 'assistant',
                        content: '',
                        pending: false,
                        error: e && e.message ? e.message : '发生未知错误，请重试',
                        errorCode: rateLimited ? 'upstream_rate_limited' : errCode,
                        createdAt: Date.now(),
                        attempts: [{ id: pendingId, content: '', pending: false, error: e && e.message ? e.message : '发生未知错误，请重试', errorCode: rateLimited ? 'upstream_rate_limited' : errCode, createdAt: Date.now() }],
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
                // 结束前把节流的渲染补上（流式期间可能还有一帧没落地）
                this.flushRender()
            }
        },

        async retryMessage(m) {
            if (this.sending) return
            const conv = this.activeConversation()
            if (!conv) return
            if (!m || m.role !== 'assistant') return
            // 上游限流期间点「重试」= 再发一次请求，正是把限流升级成禁言的动作（bug 1）。
            // 后端已让账号退避，这里直接拦住并说明原因，不再向后端发请求。
            if (isRateLimitedError({ code: m.errorCode, message: m.error })) {
                this.imageWarn = '上游正在限流：请等待一段时间再重试（连续请求会导致账号被禁言）'
                this.$forceUpdate()
                return
            }

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
            cancelThumbJobs()
            const loadSeq = ++this.albumLoadSeq
            this.showPicker = true
            this.albumLoading = true
            this.albumError = ''
            this.albumImages = []
            this.$forceUpdate()
            try {
                const list = await listAlbum()
                // 如果用户已经进入相机/关闭相册，旧任务只退出，不再触发任何更新。
                if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                // 逐张后台生成缩略图（原图 12MP 直接进 image 会堵死渲染线程，
                // 真机表现为相册浮层全黑）：每张就绪立即刷新，列表渐进显示。
                this.albumImages = list
                this.albumLoading = false
                this.$forceUpdate()
                for (const img of list) {
                    if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                    const thumb = await ensureThumb(img.path)
                    if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                    if (thumb !== img.path) {
                        const item = this.albumImages.find((i) => i.path === img.path)
                        if (item) {
                            item.thumb = thumb
                            this.$forceUpdate()
                        }
                    }
                }
            } catch (e) {
                if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                this.albumError = e && e.message ? e.message : '无法访问相册'
                this.albumLoading = false
            }
            if (loadSeq === this.albumLoadSeq && this.showPicker) this.$forceUpdate()
        },
        closePicker() {
            cancelThumbJobs()
            ++this.albumLoadSeq
            this.showPicker = false
            this.$forceUpdate()
        },
        pickImage(img) {
            cancelThumbJobs()
            ++this.albumLoadSeq
            this.addDraftImage(img.name, img.path)
            this.showPicker = false
            this.$forceUpdate()
        },
        // ---------- 相机取景浮层（对齐手机选图体验：预览 → 快门 → 裁剪 → 待发）----------
        async openCamera() {
            if (this.showCamera || this.showConfirm) return
            // 先使相册缩略图任务失效；否则每张图完成时都会在相机层上方
            // 继续触发整页 forceUpdate，导致触摸事件排队。
            cancelThumbJobs()
            ++this.albumLoadSeq
            this.showPicker = false
            this.camError = ''
            this.previewFrame = ''
            this.previewMode = ''
            this.showCamera = true
            this.$forceUpdate()
            // 让相机层先提交一次布局，再启动 native 取景管道；避免点击回调里
            // 同步叠加相册卸载、历史消息重排和相机初始化。
            setTimeout(() => {
                if (this.showCamera && !this.showConfirm) this.startCameraPreview()
            }, 0)
        },
        // 使用已验证可见的 JPEG 帧循环（~7fps）；不把 kmssink 进程存活误判为画面可见
        async startCameraPreview() {
            const mode = await startPreview((jpg) => {
                this.previewFrame = 'file://' + jpg
                this.$forceUpdate()
            })
            if (mode === 'dead') return // 期间已被关闭/重启，丢弃
            this.previewMode = mode
            appLog('[camera] preview mode=' + mode)
            this.$forceUpdate()
        },
        // 拍照失败后的取景重启，与正常启动共用 active 状态。
        restartFramePreview() {
            this.startCameraPreview()
        },
        // backToPicker=true（取景页 ×）：回相册选择页；false（确认页确认后）：回主聊天页
        closeCamera(backToPicker) {
            this.showCamera = false
            this.showConfirm = false
            this.previewFrame = ''
            this.previewMode = ''
            this.camError = ''
            stopPreview()
            if (backToPicker) {
                // 回相册选择页（openPicker 自带重载列表）
                this.openPicker()
            }
            this.$forceUpdate()
        },
        // 快门：抓一帧 → 确认浮层（可拖框裁剪，勾收进待发 / 环形箭头重拍）
        async shoot() {
            if (this.takingPhoto || !this.showCamera) return
            this.takingPhoto = true
            this.camError = ''
            this.$forceUpdate()
            try {
                // 取景与拍照共用 video29，必须先暂停帧循环避免相机节点冲突
                if (this.previewMode === 'frames') stopFramePreview()
                const r = await capturePhoto()
                if (!r.ok) {
                    // 失败提示必须可见：视频 plane 在 UI 之上会盖住提示，
                    // 先停预览露出黑底+提示，2.5 秒后按原模式自动恢复取景
                    const wasFrames = this.previewMode === 'frames'
                    stopPreview()
                    this.camError = r.error || '拍照失败'
                    if (this._errTimer) clearTimeout(this._errTimer)
                    this._errTimer = setTimeout(() => {
                        if (!this.showCamera || this.showConfirm) return
                        if (wasFrames) this.restartFramePreview()
                        else this.startCameraPreview()
                    }, 2500)
                    return
                }
                // 进确认页（JPEG 黑底浮层）：预览没用了，停掉省电
                stopPreview()
                this.confirmPath = r.path
                // 确认页用 640 宽小图预览（全图解码会堵渲染线程）
                this.confirmSrc = 'file://' + (r.preview || r.path)
                this.resetCropBox()
                this.showConfirm = true
            } catch (e) {
                this.camError = (e && e.message) || '拍照失败'
            } finally {
                this.takingPhoto = false
                this.$forceUpdate()
            }
        },
        // 确认：把屏幕上的裁剪框映射回源图像素（1920x768 带），裁剪后收进待发，回主聊天页
        async confirmShot() {
            if (this.takingPhoto) return
            this.takingPhoto = true
            this.$forceUpdate()
            try {
                const disp = this.dispRect
                const b = this.clampCropBox(this.cropBox)
                const sx = (b.x - disp.x) * PHOTO_W / disp.w
                const sy = (b.y - disp.y) * PHOTO_H / disp.h
                const sw = b.w * PHOTO_W / disp.w
                const sh = b.h * PHOTO_H / disp.h
                const path = await cropFrame(this.confirmPath, { x: sx, y: sy, w: sw, h: sh })
                const name = String(path).split('/').pop()
                this.addDraftImage(name, path)
                this.closeCamera(false)
            } finally {
                this.takingPhoto = false
                this.$forceUpdate()
            }
        },
        // 重拍：关确认浮层回取景（重启取景）
        retakeShot() {
            this.showConfirm = false
            this.confirmSrc = ''
            this.confirmPath = ''
            this.camError = ''
            this.$forceUpdate()
            this.startCameraPreview()
        },
        // ===== 裁剪框（官方同款：一个可拖可缩的白框，取代旧"比例循环"）=====
        // 真机实测（2026-09-26 事件日志取证）：Falcon 的 touch 事件对象顶层有
        // changedTouches[0]，其中 **screenX/screenY 是绝对页面坐标（936x280
        // 横屏空间，与布局一一对应）**，pageX/pageY 是**元素相对**坐标——
        // 拖动中元素跟着动，用 page 系算增量会自相抵消，必须用 screen 系。
        // 偶发杂散事件（坐标跳到几百 px 外）用跳变保护忽略。
        extractTouchXY(e) {
            let d = e
            if (d && d.data !== undefined && d.data !== null) d = d.data
            const cands = []
            if (d && typeof d === 'object') {
                if (d.changedTouches && d.changedTouches.length) cands.push(d.changedTouches[0])
                if (d.touches && d.touches.length) cands.push(d.touches[0])
                cands.push(d)
                if (d.touch && typeof d.touch === 'object') cands.push(d.touch)
            }
            for (let i = 0; i < cands.length; i++) {
                const t = cands[i]
                if (!t || typeof t !== 'object') continue
                // screen 系优先（绝对坐标）；page/client 系仅作兜底
                const x = t.screenX !== undefined ? t.screenX : (t.pageX !== undefined ? t.pageX : (t.clientX !== undefined ? t.clientX : (t.x !== undefined ? t.x : null)))
                const y = t.screenY !== undefined ? t.screenY : (t.pageY !== undefined ? t.pageY : (t.clientY !== undefined ? t.clientY : (t.y !== undefined ? t.y : null)))
                if (x !== null && y !== null) return { x: x, y: y }
            }
            return null
        },
        cropTouchStart(mode, e) {
            const p = this.extractTouchXY(e)
            if (!this._cropTouchLogged) {
                this._cropTouchLogged = true
                try { appLog('[crop] touchstart ' + JSON.stringify(e).slice(0, 400)) } catch (err) { /* 忽略 */ }
            }
            if (!p) return
            this.cropDrag = { mode: mode, x: p.x, y: p.y }
        },
        cropTouchMove(e) {
            const drag = this.cropDrag
            if (!drag || !drag.mode) return
            const p = this.extractTouchXY(e)
            if (!p) return
            const dx = p.x - drag.x
            const dy = p.y - drag.y
            if (dx === 0 && dy === 0) return
            // 杂散事件保护：单次增量超过半屏基本是引擎毛刺，只重新锚定不移动
            if (Math.abs(dx) > 468 || Math.abs(dy) > 280) {
                this.cropDrag = { mode: drag.mode, x: p.x, y: p.y }
                return
            }
            this.cropDrag = { mode: drag.mode, x: p.x, y: p.y }
            this.applyCropDelta(dx, dy)
        },
        cropTouchEnd() {
            try { appLog('[crop] touchend box=' + JSON.stringify(this.clampCropBox(this.cropBox))) } catch (e) { /* 忽略 */ }
            this.cropDrag = { mode: '', x: 0, y: 0 }
        },
        applyCropDelta(dx, dy) {
            const b = this.cropBox
            const m = this.cropDrag.mode
            if (m === 'move') {
                this.cropBox = this.clampCropBox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
                return
            }
            // 角缩放：固定对角，动被拖的角。min 尺寸 ~ 屏幕上 60x40（≈源图 123x82，够发图用）
            const disp = this.dispRect
            const minW = 60
            const minH = 40
            let x = b.x
            let y = b.y
            let w = b.w
            let h = b.h
            if (m === 'tl' || m === 'bl') {
                const nx = Math.max(disp.x, Math.min(b.x + dx, b.x + b.w - minW))
                w = b.w + (b.x - nx)
                x = nx
            } else if (m === 'tr' || m === 'br') {
                w = Math.min(disp.x + disp.w - b.x, Math.max(minW, b.w + dx))
            }
            if (m === 'tl' || m === 'tr') {
                const ny = Math.max(disp.y, Math.min(b.y + dy, b.y + b.h - minH))
                h = b.h + (b.y - ny)
                y = ny
            } else if (m === 'bl' || m === 'br') {
                h = Math.min(disp.y + disp.h - b.y, Math.max(minH, b.h + dy))
            }
            this.cropBox = { x: x, y: y, w: w, h: h }
        },
        clampCropBox(b) {
            const disp = this.dispRect
            const minW = 60
            const minH = 40
            let w = Math.min(Math.max(b.w, minW), disp.w)
            let h = Math.min(Math.max(b.h, minH), disp.h)
            let x = Math.max(disp.x, Math.min(b.x, disp.x + disp.w - w))
            let y = Math.max(disp.y, Math.min(b.y, disp.y + disp.h - h))
            return { x: x, y: y, w: w, h: h }
        },
        resetCropBox() {
            const disp = this.dispRect
            // 默认框就是照片实际显示区域；用户不调整时确认结果等同于原图。
            // 之前缩进到 92% 会在四周留下未选中的边，和照片边框不贴合。
            this.cropBox = { x: disp.x, y: disp.y, w: disp.w, h: disp.h }
        },
        // 裁剪框外的四块半透明遮罩（上/下/左/右），聚焦框内区域
        cropMaskStyle(pos) {
            const W = this.stageW
            const H = this.stageH
            const b = this.clampCropBox(this.cropBox)
            if (pos === 'top') return { left: '0px', top: '0px', width: W + 'px', height: Math.max(0, b.y) + 'px' }
            if (pos === 'bottom') return { left: '0px', top: (b.y + b.h) + 'px', width: W + 'px', height: Math.max(0, H - b.y - b.h) + 'px' }
            if (pos === 'left') return { left: '0px', top: b.y + 'px', width: Math.max(0, b.x) + 'px', height: b.h + 'px' }
            return { left: (b.x + b.w) + 'px', top: b.y + 'px', width: Math.max(0, W - b.x - b.w) + 'px', height: b.h + 'px' }
        },
        // 四角 L 形手柄：以角为中心的小方块，拖动改变对应角
        cropHandleStyle(corner) {
            const b = this.clampCropBox(this.cropBox)
            const s = 36
            const cx = corner === 'tl' || corner === 'bl' ? b.x : b.x + b.w
            const cy = corner === 'tl' || corner === 'tr' ? b.y : b.y + b.h
            return { left: (cx - s / 2) + 'px', top: (cy - s / 2) + 'px', width: s + 'px', height: s + 'px' }
        },
        checkIconSrc() {
            // 确认钮是蓝底：用白色勾（蓝底蓝勾不可见）
            return 'icons/check-ok.png'
        },
        redoIconSrc() {
            return this.isDark ? 'icons/redo-dark.png' : 'icons/redo.png'
        },
        // 加入待发图片（相册选择与拍照共用）：后台预压缩，发送时统一 await
        addDraftImage(name, path) {
            this.imageWarn = ''
            if (this.draftImages.some((i) => i.path === path)) return
            const item = { name, path, dataUrl: null, pending: null }
            item.pending = readImageDataUrl(path)
                .then((du) => {
                    item.dataUrl = du || null
                    if (!item.dataUrl) this.setImageWarn()
                    this.$forceUpdate()
                })
                .catch(() => {
                    item.dataUrl = null
                    this.setImageWarn()
                })
            this.draftImages.push(item)
            this.$forceUpdate()
        },
        setImageWarn() {
            // 单图上限 900KB（见 images.js）：超过就不随消息发送，提示用户换一张
            this.imageWarn = '部分图片过大，无法发送（已跳过）'
            this.$forceUpdate()
        },
        // 把待发图片规整为存进消息的形态：等待预压缩完成，携带 dataUrl。
        // 没有 dataUrl 的一律丢弃——把几 MB 原图内联进消息会把设备内存打爆（bug 2）。
        normalizeImages(images) {
            return images
                .map((i) => ({ name: i.name, path: i.path, dataUrl: i.dataUrl || null }))
                .filter((i) => !!i.dataUrl)
        },
        removeDraftImage(i) {
            this.draftImages.splice(i, 1)
            if (!this.draftImages.length) this.imageWarn = ''
            this.$forceUpdate()
        },

        // ---------- 其他 ----------
        goSettings() {
            $falcon.navTo('settings')
        },
        scrollToBottom(force = false) {
            // 空态/无消息绝不滚动：anchor 不渲染（v-if），且短内容滚到底会把
            // 仅有的几条消息滚出视口（Falcon scrollToElement 是"锚点对齐视口上沿"）
            if (!this.messages || !this.messages.length) return
            // 合并重复请求：锚点元素固定，多次排队滚动只在最后一帧有意义
            if (this._scrollTimer) {
                if (!force) return
                clearTimeout(this._scrollTimer)
            }
            const self = this
            this._scrollTimer = setTimeout(() => {
                self._scrollTimer = null
                try {
                    if (!self.$page || !self.$page.$dom) return
                    // 优先滚到"最后一条消息行"的上沿：短会话时目标位置在视口内、
                    // 滚动量被钳制为 0（不滚过头）；长会话视线锚定最新回复行首。
                    // 旧的"滚到内容末尾 anchor"会把气泡整体滚出视口（真机实证）。
                    const last = self.chatMessages[self.chatMessages.length - 1]
                    const ref = last && self.$refs['msg-' + last.id]
                    const el = ref && (Array.isArray(ref) ? ref[ref.length - 1] : ref)
                    if (el) {
                        self.$page.$dom.scrollToElement(el)
                    } else if (self.$refs.bottom) {
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
    /* 注意：绝不能用 flex:1 —— Falcon 引擎里 scroller 子项的 flex:1 会高度
       塌陷为 0（真机实证：欢迎语完全不可见，改固定高度立即恢复）。
       屏幕固定 936x280，顶栏约 55px，悬浮输入不占布局，消息区约 225px。 */
    height: 220px;
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
/* 数学公式（原生 <latex> 排版）：字号与正文一致，垂直居中；与相邻文字平级混排 */
.md-math {
    font-size: 20px;
    color: #222222;
}
/* 独立成块的公式：整行居中，上下留白，视觉上与正文段落区分 */
.md-math-block {
    flex-direction: row;
    justify-content: center;
    align-items: center;
    margin: 6px 0;
}
/* 块级公式回退（过长）：按普通段落展示，保证内容完整可换行 */
.md-math-fallback {
    font-size: 20px;
    line-height: 28px;
    color: #222222;
}
/* 块级公式回退（括号不配平）：原样显示源码，用等宽+底色表明"这是公式源码" */
.md-math-src {
    font-family: monospace;
    font-size: 18px;
    line-height: 26px;
    color: #b04a2f;
    background-color: #f6f7f9;
    border-radius: 6px;
    padding: 4px 8px;
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
/* 表格：等宽列（flex:1），表头底色，行间横线；无竖线外框，走轻线条风格 */
.md-table {
    flex-direction: column;
    margin: 4px 0;
}
.md-tr {
    flex-direction: row;
}
.md-th {
    flex: 1;
    padding: 6px 8px;
    background-color: #f2f3f5;
    border-bottom-width: 1px;
    border-bottom-color: #dddddd;
}
.md-td {
    flex: 1;
    flex-direction: row;
    flex-wrap: wrap;
    padding: 6px 8px;
    border-bottom-width: 1px;
    border-bottom-color: #eeeeee;
}
.md-th-text {
    font-size: 18px;
    line-height: 26px;
    font-weight: bold;
    color: #222222;
}
/* 删除线：~~text~~；颜色压灰一档，弱化"已作废"内容 */
.md-strike {
    text-decoration: line-through;
    color: #999999;
    font-size: 20px;
    line-height: 28px;
}
/* 链接：只显示文字（设备无浏览器），下划线+蓝提示可点，URL 不上屏 */
.md-link {
    color: #2f6fed;
    text-decoration: underline;
    font-size: 20px;
    line-height: 28px;
}
.md-bold-italic {
    font-weight: bold;
    font-style: italic;
    color: #222222;
    font-size: 20px;
    line-height: 28px;
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

/* 消息区底部留空：右下角悬浮输入组件不遮挡最后一条消息 */
.msgs-tail-spacer {
    height: 170px;
}

/* 待发图片：悬浮在输入组件上方，右对齐、不占通栏 */
.draft-imgs-float {
    position: absolute;
    right: 14px;
    bottom: 178px;
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: 420px;
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
/* 图片超限提示（单图 900KB 上限，见 images.js） */
.draft-warn {
    font-size: 14px;
    color: #d93025;
    background-color: #fdecea;
    padding: 4px 12px;
}

// 右下角悬浮输入组件：小文本框 + 相册/发送圆钮（不占消息区通栏）
.float-input {
    position: absolute;
    right: 14px;
    bottom: 14px;
    flex-direction: column;
    align-items: flex-end;
}
.float-textbox {
    /* 与按钮组总宽一致（68+14+68），不超出 */
    width: 150px;
    height: 52px;
    justify-content: center;
    background-color: #ffffff;
    border-radius: 12px;
    border-width: 1px;
    border-color: #dfe3e8;
    padding: 0 14px;
}
.float-btns {
    flex-direction: row;
    margin-top: 10px;
}
.float-btn {
    width: 68px;
    height: 68px;
    border-radius: 34px;
    background-color: #ffffff;
    border-width: 1px;
    border-color: #dfe3e8;
    align-items: center;
    justify-content: center;
    margin-left: 14px;
}
.float-icon-img {
    width: 34px;
    height: 34px;
}
.float-btn-send {
    width: 68px;
    height: 68px;
    border-radius: 34px;
    background-color: #1a73e8;
    align-items: center;
    justify-content: center;
    margin-left: 14px;
}
.float-btn-stop {
    width: 68px;
    height: 68px;
    border-radius: 34px;
    background-color: #d93025;
    align-items: center;
    justify-content: center;
    margin-left: 14px;
}
.input-display-text {
    font-size: 20px;
    color: #222222;
    lines: 1;
    text-overflow: ellipsis;
}
.input-display-text-ph {
    font-size: 20px;
    color: #999999;
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
// 竖向相册网格：3 列缩略图 + 文件名
.picker-vlist {
    flex: 1;
    background-color: #333333;
    padding: 12px;
}
.picker-grid {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: space-between;
}
.pick-cell {
    width: 218px;
    margin-bottom: 12px;
}
.pick-thumb-v {
    width: 218px;
    height: 160px;
    border-radius: 8px;
    background-color: #555555;
}
.picker-photo-tip {
    padding: 20px 10px 40px 10px;
}
.picker-photo-text {
    font-size: 16px;
    color: #90a4ae;
    text-align: center;
    line-height: 24px;
}

/* ========== 相机浮层（JPEG 帧循环 + 右侧按钮条；永远横屏） ========== */
/* 取景器：全屏黑底。左侧 0..700 是预览图区域，右侧 236px 是按钮条。
   首帧生成前显示黑底，避免相册页面残留；图片就绪后由 image 组件轮换刷新。 */
.cam-stage {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: #0d0d0d;
}
/* 帧循环兜底模式：预览图与视频窗口同位同尺寸（左 700px，contain 正好铺满） */
.cam-frame {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 700px;
}
.cam-hint {
    position: absolute;
    top: 10px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 18px;
    color: #ffffff;
    background-color: rgba(0, 0, 0, 0.45);
    padding: 4px 0;
}
.cam-err {
    position: absolute;
    top: 48px;
    left: 80px;
    right: 80px;
    text-align: center;
    font-size: 17px;
    color: #ffd7d7;
    background-color: rgba(130, 20, 20, 0.8);
    padding: 6px 8px;
    border-radius: 6px;
}
.cam-close {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 46px;
    height: 46px;
}
/* 快门：右侧竖直居中（横握笔时拇指位；计算器同款右列布局） */
.shutter-outer {
    position: absolute;
    right: 36px;
    top: 104px;
    width: 72px;
    height: 72px;
    border-radius: 36px;
    border-width: 5px;
    border-color: #ffffff;
    background-color: rgba(0, 0, 0, 0.25);
    align-items: center;
    justify-content: center;
}
.shutter-inner {
    width: 54px;
    height: 54px;
    border-radius: 27px;
    background-color: #ffffff;
}
/* 确认页：全屏带图 + 裁剪框（遮罩/边框/抓取层/四角手柄全部绝对定位，
   几何由 cropMaskStyle/cropBoxStyle/cropHandleStyle 内联提供） */
.camera-view {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: #0d0d0d;
}
.camera-preview {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: #000000;
}
.crop-mask {
    position: absolute;
    background-color: rgba(0, 0, 0, 0.55);
}
/* 只有边框的 div（内部透明）——shutter-outer 同款已验证可渲染 */
.crop-border {
    position: absolute;
    border-width: 3px;
    border-color: #ffffff;
    background-color: transparent;
}
/* 抓取层：透明但绑定触摸（绑定事件的容器会拦截触摸——抽屉遮罩同款结论），
   铺在框内用于整体拖动 */
.crop-grab {
    position: absolute;
    background-color: transparent;
}
/* 四角手柄：白色小方块（36px，几何内联），拖动改对应角 */
.crop-handle {
    position: absolute;
    background-color: rgba(255, 255, 255, 0.25);
    border-width: 4px;
    border-color: #ffffff;
}
/* 两个操作钮各自绝对定位（Weex flex row 对混合尺寸子项布局不稳定，
   绝对定位是唯一确定的行为）。放左右下角，避开中间的裁剪框 */
.confirm-btn-redo {
    position: absolute;
    left: 22px;
    bottom: 18px;
    width: 64px;
    height: 64px;
    border-radius: 32px;
    background-color: rgba(255, 255, 255, 0.92);
    align-items: center;
    justify-content: center;
}
.confirm-btn-ok {
    position: absolute;
    right: 22px;
    bottom: 18px;
    width: 64px;
    height: 64px;
    border-radius: 32px;
    background-color: #1a73e8;
    align-items: center;
    justify-content: center;
}
.confirm-icon {
    width: 34px;
    height: 34px;
}
/* 确认页操作提示：底部居中（顶部被裁剪框占满，两个圆钮之间下方留白） */
.crop-hint {
    position: absolute;
    bottom: 36px;
    left: 110px;
    right: 110px;
    text-align: center;
    font-size: 16px;
    color: #ffffff;
    background-color: rgba(0, 0, 0, 0.4);
    padding: 4px 0;
    border-radius: 6px;
}
/* 相册第一格：拍照入口（图标格，无文字） */
.pick-camera {
    width: 218px;
    height: 160px;
    border-radius: 8px;
    background-color: #e8f0fe;
    align-items: center;
    justify-content: center;
}
.pick-camera-icon {
    width: 52px;
    height: 52px;
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
/* 数学公式（深色）：<latex> 的颜色取自 richtext 样式，必须显式给白色 */
.md-math-dark {
    font-size: 20px;
    color: #ffffff;
}
.md-math-block-dark {
    flex-direction: row;
    justify-content: center;
    align-items: center;
    margin: 6px 0;
}
.md-math-fallback-dark {
    font-size: 20px;
    line-height: 28px;
    color: #ffffff;
}
.md-math-src-dark {
    font-family: monospace;
    font-size: 18px;
    line-height: 26px;
    color: #ffb4a0;
    background-color: #232323;
    border-radius: 6px;
    padding: 4px 8px;
}
.float-input-dark {
    position: absolute;
    right: 14px;
    bottom: 14px;
    flex-direction: column;
    align-items: flex-end;
}
.float-textbox-dark {
    /* 与按钮组总宽一致（68+14+68），不超出 */
    width: 150px;
    height: 52px;
    justify-content: center;
    background-color: #2a2a2a;
    border-radius: 12px;
    border-width: 1px;
    border-color: #444444;
    padding: 0 14px;
}
.float-btns-dark {
    flex-direction: row;
    margin-top: 10px;
}
.float-btn-dark {
    width: 68px;
    height: 68px;
    border-radius: 34px;
    background-color: #2a2a2a;
    border-width: 1px;
    border-color: #444444;
    align-items: center;
    justify-content: center;
    margin-left: 14px;
}
.float-icon-img-dark {
    width: 34px;
    height: 34px;
}
.float-btn-send-dark {
    width: 68px;
    height: 68px;
    border-radius: 34px;
    background-color: #82b1ff;
    align-items: center;
    justify-content: center;
    margin-left: 14px;
}
.float-btn-stop-dark {
    width: 68px;
    height: 68px;
    border-radius: 34px;
    background-color: #e05545;
    align-items: center;
    justify-content: center;
    margin-left: 14px;
}
.input-display-text-dark {
    font-size: 20px;
    color: #ffffff;
    lines: 1;
    text-overflow: ellipsis;
}
.input-display-text-ph-dark {
    font-size: 20px;
    color: #ffffff;
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
.picker-vlist-dark {
    flex: 1;
    background-color: #191919;
    padding: 12px;
}
.picker-grid-dark {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: space-between;
}
.pick-cell-dark {
    width: 218px;
    margin-bottom: 12px;
}
.pick-thumb-v-dark {
    width: 218px;
    height: 160px;
    border-radius: 8px;
    background-color: #2a2a2a;
}
.picker-photo-tip-dark {
    padding: 20px 10px 40px 10px;
}
.picker-photo-text-dark {
    font-size: 16px;
    color: #5f747f;
    text-align: center;
    line-height: 24px;
}
.pick-camera-dark {
    width: 218px;
    height: 160px;
    border-radius: 8px;
    background-color: #16233a;
    align-items: center;
    justify-content: center;
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
.draft-imgs-float-dark {
    position: absolute;
    right: 14px;
    bottom: 178px;
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: 420px;
}
.draft-warn-dark {
    font-size: 14px;
    color: #ff8a80;
    background-color: #3d1f1f;
    padding: 4px 12px;
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
.md-table-dark {
    flex-direction: column;
    margin: 4px 0;
}
.md-tr-dark {
    flex-direction: row;
}
.md-th-dark {
    flex: 1;
    padding: 6px 8px;
    background-color: #2a2a2a;
    border-bottom-width: 1px;
    border-bottom-color: #444444;
}
.md-td-dark {
    flex: 1;
    flex-direction: row;
    flex-wrap: wrap;
    padding: 6px 8px;
    border-bottom-width: 1px;
    border-bottom-color: #3a3a3a;
}
.md-th-text-dark {
    font-size: 18px;
    line-height: 26px;
    font-weight: bold;
    color: #e8e8e8;
}
.md-strike-dark {
    text-decoration: line-through;
    color: #777777;
    font-size: 20px;
    line-height: 28px;
}
.md-link-dark {
    color: #6ea8ff;
    text-decoration: underline;
    font-size: 20px;
    line-height: 28px;
}
.md-bold-italic-dark {
    font-weight: bold;
    font-style: italic;
    color: #e8e8e8;
    font-size: 20px;
    line-height: 28px;
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
