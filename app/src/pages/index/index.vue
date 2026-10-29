<template>
    <div :class="pageClass">
        <div :class="portrait ? 'pwrap' : 'pwrap'">
        <!-- 竖屏（实验）：旋转画布为独立内层元素，不再把 transform 挂在
             flex:1 + position:relative 的布局根上（此前结构白屏的可能原因） -->
        <div :class="portrait ? dc('rotate-canvas') : 'fill-canvas'" :style="portraitStyle">
        <!-- 顶栏：会话 | 联网/深度思考 | 模式/标题 | 设置 -->
        <div :class="dc('topbar')" v-if="!camMode">
            <text :class="dc('icon-btn')" @click="toggleDrawer">会话</text>
            <text v-if="featSearch" :class="toggleClass(search)" @click="toggleSearch">联网</text>
            <!-- 思考挡位按钮：三层防御（build 181）——
                 ① 文案必须是**静态** <text> 分支（v-if 枚举），不能用 {{ 动态绑定 }}：
                    build 176/177 实测动态文案在设备端渲染文字丢失、按钮缩成小块。
                 ② 每个分支必须带不同 key：Vue2 patch 的 sameVnode() 对同 tag 无 key 的
                    同位置节点会「复用+原地更新文字」，踩 falcon 原生 text 更新不可靠的坑
                    （build 178 点击无效的原因）；key 不同强制销毁重建。
                 ③ @click 与开关样式放在**恒定存在的外层 div** 上（只受 featThinking 影响，
                    不随挡位切换重建）：点击热区/事件绑定永不重建，与显示更新彻底解耦——
                    即使内部 text 重建失败，点击本身仍然可靠（build 180 的教训：
                    click 绑在随挡位重建的 text 上，事件与显示耦合在一起无法分别定位）。 -->
            <div v-if="featThinking" :class="toggleClass(thinking)" @click="toggleThinking">
                <text v-if="thinkingLevel === 'none'" key="tk-none" :class="toggleTextClass()">思考 关</text>
                <text v-else-if="thinkingLevel === 'minimal'" key="tk-minimal" :class="toggleTextClass()">思考 minimal</text>
                <text v-else-if="thinkingLevel === 'low'" key="tk-low" :class="toggleTextClass()">思考 low</text>
                <text v-else-if="thinkingLevel === 'medium'" key="tk-medium" :class="toggleTextClass()">思考 medium</text>
                <text v-else-if="thinkingLevel === 'high'" key="tk-high" :class="toggleTextClass()">思考 high</text>
                <text v-else-if="thinkingLevel === 'xhigh'" key="tk-xhigh" :class="toggleTextClass()">思考 xhigh</text>
                <text v-else-if="thinkingLevel === 'max'" key="tk-max" :class="toggleTextClass()">思考 max</text>
                <text v-else key="tk-fallback" :class="toggleTextClass()">思考</text>
            </div>
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
            <text :class="dc('backend-error-text')">后端连接已断开（如果是安装/更新后第一次打开软件可以通过配置账号的方式重启服务试试）</text>
        </div>

        <!-- 未配置端点 / 上游未连接：点进设置 -->
        <div :class="dc('backend-error-banner')"
             v-if="!builtinEnabled && !hasEndpoint && !camMode"
             @click="goSettings">
            <text :class="dc('backend-error-text')">{{ upstreamMode ? '服务未连接：点此查看状态与额度' : '未配置 API 端点：点此填写服务地址与 API Key' }}</text>
        </div>

        <!-- 维护 / 配额耗尽 / 强制更新等阻塞提示（服务通知走弹窗，不占聊天区） -->
        <div :class="dc('backend-error-banner')"
             v-if="blockedNotice && !camMode"
             @click="onBlockedTap">
            <text :class="dc('backend-error-text')">{{ plain(blockedNotice) }}</text>
        </div>

        <!-- 消息区。scroller 绝不能套 v-if：Falcon 对被 v-if 包装的 scroller 会渲染空白。
             相机模式下由后面的 cam-stage 黑色窗口覆盖，不销毁消息节点，避免进入
             取景页时同步重建/销毁整棵消息树造成输入卡顿。
             @touchstart：用户一旦亲手触摸消息区（滚动回看），立即交出滚动控制权，
             流式渲染不再把视口拽回（scrollFollow 语义见 streamScrollTick）。 -->
        <scroller class="msgs" scroll-direction="vertical" @touchstart="onMsgsTouch">
            <div class="empty" v-if="!camMode && messages.length === 0">
                <text v-if="cloudLoadingId === activeId" :class="dc('empty-tip')">正在加载云端对话…</text>
                <text v-else :class="dc('empty-title')">Deepseek</text>
                <text v-if="cloudLoadingId !== activeId" :class="dc('empty-tip')">你好，我是 DeepSeek，有什么可以帮你？</text>
            </div>

            <div v-for="m in chatMessages" :key="messageRenderKey(m)" class="msg" :ref="'msg-' + m.id">
                <!-- 用户消息 -->
                <div v-if="m.role === 'user'" class="msg-row-user">
                    <div :class="dc('bubble-user')">
                        <div class="msg-files" v-if="m.files && m.files.length">
                            <div v-for="f in m.files" :key="f.path || f.name" :class="dc('msg-file')">
                                <text :class="dc('msg-file-name')">{{ f.name }}</text>
                                <text :class="dc('msg-file-meta')">{{ fileSizeText(f.size) }}</text>
                            </div>
                        </div>
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

                <!-- 助手消息。长回复按估算高度切成多个气泡（markdownChunks）：
                     真机实证（build 196~199）：单棵超高 bubble 子树量高失效——尾部滚
                     不到、行边界裁字；嵌套列容器（assistant-col）又会破坏定宽链
                     （build 199 证伪，布局全面紊乱）。因此每个分块都用与普通消息
                     完全同构的「msg-row-assistant > bubble-assistant」兄弟行形态，
                     宽度链确定、量高可靠；超长表格按 5 行一段、续段重复表头
                     （splitTableBlock）。单元格保持 build 198 已验证的 runs +
                     -cell 变体类（lines:3）形态。 -->
                <template v-else>
                    <div class="msg-row-assistant" v-if="assistantHeadVisible(m)">
                        <div :class="dc('bubble-assistant')">
                            <text v-if="m.pending && !m.content && !m.reasoning" :class="dc('pending')">{{ m.toolStatus || '正在思考…' }}</text>
                            <template v-else>
                                <!-- 思考过程：key 带"纪元"——Falcon 对原地增长的 text 节点
                                     实测高度会滞后于内容（气泡比文字矮、消息底部被裁），
                                     定期销毁重建子树逼原生重新量高（节点创建是可靠路径，
                                     见 mdRuns 注释与 build 176~182 结论） -->
                                <div v-if="m.reasoning" :class="dc('reasoning')" :key="'rs-' + textEpoch(m.reasoning, m.pending)" @click="toggleReasoning(m.id)">
                                    <text :class="dc('reasoning-head')">{{ isReasoningCollapsed(m.id) ? '展开思考过程' : '收起思考过程' }}</text>
                                    <text v-if="!isReasoningCollapsed(m.id)" :class="dc('reasoning-body')">{{ dispText(m.reasoning) }}</text>
                                </div>
                                <!-- 联网工具卡片：直观展示模型的每次搜索/网页抓取（官方风格） -->
                                <div v-if="m.toolCalls && m.toolCalls.length" :class="dc('tool-trail')">
                                    <div v-for="(tc, ti) in m.toolCalls" :key="'tc' + ti" :class="dc('tool-card')">
                                        <text :class="dc('tool-card-title')">{{ toolCardText(tc) }}</text>
                                    </div>
                                </div>
                                <text v-if="m.error" :class="dc('bubble-text-error')">{{ m.error }}</text>
                            </template>
                        </div>
                    </div>
                    <!-- 正文分块行：key 带内容纪元（流式每 ~200 字、定稿时整体重建，
                         消除"文字实际范围比气泡框大"的原生量高缓存） -->
                    <div class="msg-row-assistant msg-row-chunk"
                         v-for="(chunk, ci) in markdownChunks(m.content, !m.pending)"
                         :key="'ck' + ci + '-' + textEpoch(m.content, m.pending)">
                        <div :class="dc('bubble-assistant')">
                            <div :class="dc('md')">
                                <div v-for="(block, bi) in chunk" :key="bi" class="md-block">
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
                                            <!-- 正文单独一层（见 .md-li-body 注释）：先定宽，再量高 -->
                                            <div class="md-li-body">
                                                <template v-for="(r, ri) in mdRuns(item, !m.pending)" :key="ri">
                                                    <richtext v-if="r.math" :class="dc('md-math')"><latex :value="r.text"></latex></richtext>
                                                    <text v-else :class="runClass(r, isTaskDone(block, ii))">{{ r.text }}</text>
                                                </template>
                                            </div>
                                        </div>
                                    </div>
                                    <!-- 表格：等宽列、横线分隔。表头纯文本；单元格走行内 runs，
                                         run 平级 + -cell 变体类（lines:3，见样式表注释） -->
                                    <div v-else-if="block.type === 'table'" :class="dc('md-table')">
                                        <div :class="dc('md-tr')">
                                            <div v-for="(cell, ci) in block.header" :key="'h' + ci" :class="dc('md-th')">
                                                <div :class="dc('md-cell-body')">
                                                    <text :class="dc('md-th-text')" :style="mdAlign(block.align, ci)">{{ dispText(cell) }}</text>
                                                </div>
                                            </div>
                                        </div>
                                        <div v-for="(row, ri) in block.rows" :key="'r' + ri" :class="dc('md-tr')">
                                            <div v-for="(cell, ci) in row" :key="'c' + ci" :class="dc('md-td')">
                                                <!-- 单元格内容单独一层（见 .md-cell-body 注释）：
                                                     runClass 传 cell=true 套 lines:3 变体类 -->
                                                <div :class="dc('md-cell-body')">
                                                    <template v-for="(r, rr) in mdRuns(cell, !m.pending)" :key="rr">
                                                        <richtext v-if="r.math" :class="dc('md-math')"><latex :value="r.text"></latex></richtext>
                                                        <text v-else :class="runClass(r, false, true)">{{ r.text }}</text>
                                                    </template>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <text v-else :class="dc('md-heading') + ' md-' + block.type">{{ dispText(block.text) }}</text>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="msg-row-assistant" v-if="m.pending && (m.content || m.reasoning)">
                        <text :class="dc('streaming-hint')">正在生成…</text>
                    </div>
                    <div class="msg-actions">
                        <text v-if="isLastAssistant(m) && !m.pending" :class="dc('action')" @click="retryMessage(m)">重试</text>
                        <text v-if="assistantAttemptCount(m) > 1" :class="dc('attempt-nav')" @click="prevAssistantAttempt(m)">‹</text>
                        <text v-if="assistantAttemptCount(m) > 1" :class="dc('attempt-indicator')">{{ assistantActiveAttempt(m) + 1 }}/{{ assistantAttemptCount(m) }}</text>
                        <text v-if="assistantAttemptCount(m) > 1" :class="dc('attempt-nav')" @click="nextAssistantAttempt(m)">›</text>
                    </div>
                </template>
            </div>
            <!-- 空态（欢迎语）时不渲染 spacer/anchor：否则内容高度超过视口，
                 scroller 能滑动且 scrollToBottom 会把气泡滚出视口（用户反馈：
                 欢迎语不应可滑、短会话滚到底只剩"重试"按钮）。 -->
            <div class="msgs-tail-spacer" v-if="messages.length"></div>
            <div class="bottom-anchor" ref="bottom" v-if="messages.length"></div>
        </scroller>

        <!-- 待发附件（悬浮输入组件上方，右对齐） -->
        <div :class="dc('draft-imgs-float')" v-if="(draftImages.length || draftFiles.length) && !camMode">
            <div v-for="(f, i) in draftFiles" :key="'f' + f.path" :class="dc('draft-file')">
                <text :class="dc('draft-file-name')">{{ f.name }}</text>
                <text :class="dc('draft-file-size')">{{ fileSizeText(f.size) }}</text>
                <text class="draft-file-remove" @click="removeDraftFile(i)">×</text>
            </div>
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
                <div v-if="canUploadFile" :class="dc('float-btn')" @click="openFilePicker">
                    <image class="float-icon-img" resize="contain" :src="fileIconSrc()" />
                </div>
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
                <text v-if="builtinEnabled" :class="dc('icon-btn')" @click="syncCloudSessions">{{ syncing ? '同步中…' : '同步' }}</text>
                <text :class="dc('icon-btn')" @click="newConversation(true)">＋ 新对话</text>
            </div>
            <text v-if="upstreamMode && quotaLine" :class="dc('sync-msg')">剩余额度：{{ quotaLine }}</text>
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
                    <div v-if="featCamera" class="pick-cell" @click="openCamera">
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

        <!-- 文件浏览器：从 /userdisk 出发逐级浏览；目录整行进入，文件整行添加 -->
        <div class="picker" v-if="showFilePicker && !camMode">
            <div :class="dc('picker-head')">
                <div :class="dc('picker-head-col')">
                    <text :class="dc('picker-title')">选择文件</text>
                    <text :class="dc('file-path')">{{ fileDir }}</text>
                </div>
                <text :class="dc('icon-btn')" @click="closeFilePicker">关闭</text>
            </div>
            <scroller class="picker-vlist" scroll-direction="vertical">
                <text v-if="fileLoading" class="picker-hint">加载中…</text>
                <text v-else-if="fileError" class="picker-hint-error">{{ fileError }}</text>
                <text v-else-if="fileEntries.length === 0" class="picker-hint">此目录为空</text>
                <div v-else :class="dc('file-list')">
                    <div v-for="f in fileEntries" :key="f.path" :class="dc('file-row')" @click="pickEntry(f)">
                        <div :class="dc('file-row-main')">
                            <text :class="dc('file-row-name')">{{ f.name }}</text>
                            <text :class="dc('file-row-meta')">{{ f.isDir ? '文件夹' : f.sizeText }}</text>
                        </div>
                        <text :class="dc('file-row-action')">{{ f.isDir ? '打开' : '添加' }}</text>
                    </div>
                </div>
                <div class="picker-photo-tip">
                    <text class="picker-photo-text">从 /userdisk 进入任意目录，全部文件类型均可发送，单个不超过 1.5MB；可用 USB 将文件拷到用户盘</text>
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

        <!-- 版本更新弹窗（云控 updateGate 下发） -->
        <div :class="isDark ? 'ov-mask ov-mask-dark' : 'ov-mask'" v-if="showUpdateModal">
            <div :class="isDark ? 'ov-box ov-box-dark' : 'ov-box'">
                <text :class="isDark ? 'ov-title ov-title-dark' : 'ov-title'">{{ updateState === 'force' ? '需要更新' : '发现新版本' }}</text>
                <text :class="isDark ? 'ov-text ov-text-dark' : 'ov-text'">build {{ updateInfo.latestBuild }}{{ updateInfo.version ? ' · ' + updateInfo.version : '' }}{{ updateInfo.size ? ' · ' + (updateInfo.size / 1024 / 1024).toFixed(1) + 'MB' : '' }}</text>
                <text v-if="updateInfo.notes" :class="isDark ? 'ov-text ov-text-dark' : 'ov-text'">{{ plain(updateInfo.notes) }}</text>
                <text :class="isDark ? 'ov-text ov-text-dark' : 'ov-text'">{{ (updateInfo.url || updateInfo.fileId) ? (updateInfo.fileName || '更新包已就绪，可直接下载安装') : '请通过发布渠道获取新版本' }}</text>
                <div class="modes model-actions">
                    <text v-if="updateInfo.url || updateInfo.fileId" :class="isDark ? 'ov-btn ov-btn-dark' : 'ov-btn'" @click="installUpdate">{{ installing ? '安装中…' : '下载并安装' }}</text>
                    <text v-else :class="isDark ? 'ov-btn ov-btn-dark' : 'ov-btn'" @click="openUpdateUrl">查看更新</text>
                    <text v-if="updateState !== 'force'" :class="isDark ? 'ov-btn ov-btn-dark' : 'ov-btn'" @click="skipUpdate">以后再说</text>
                    <text :class="isDark ? 'ov-btn ov-btn-dark' : 'ov-btn'" @click="closeUpdate">关闭</text>
                </div>
            </div>
        </div>

        <!-- 服务通知弹窗（noticeId 变化才再弹） -->
        <div :class="isDark ? 'ov-mask ov-mask-dark' : 'ov-mask'" v-if="noticeInfo && !camMode">
            <div :class="isDark ? 'ov-box ov-box-dark' : 'ov-box'">
                <text :class="isDark ? 'ov-title ov-title-dark' : 'ov-title'">服务通知</text>
                <text :class="isDark ? 'ov-text ov-text-dark' : 'ov-text'">{{ plain(noticeInfo.text) }}</text>
                <div class="modes model-actions">
                    <text :class="isDark ? 'ov-btn ov-btn-dark' : 'ov-btn'" @click="dismissNotice">知道了</text>
                </div>
            </div>
        </div>
    </div>
</template>

<script>

import { peekBootTheme } from '../../services/theme.js'
import { thinkingFields, nextThinkingLevel } from '../../services/thinking-levels.js'
import { MODES, listCloudSessions, isAccountSuspension, listCloudSessionMessages, getMode, deleteCloudSession, buildMessages, chatStream, isRateLimitedError, stripInternalTags } from '../../services/ds.js'
import { cancelThumbJobs, listAlbum, ensureThumb, readImageDataUrl } from '../../services/images.js'
import { MAX_ATTACH_BYTES, MAX_ATTACH_COUNT, fmtSize as fmtFileSize, browseDir as browseDeviceDir, BROWSER_ROOT as FILE_BROWSER_ROOT } from '../../services/files.js'
import { queueSessionPush, pullMissing, syncDelete } from '../../services/session-sync.js'
import { ensureEmojiFont } from '../../services/emoji-font.js'
import { execShell, sleep, joinPath, dataDirBase, writeFile, readFile, statSize, waitForFile, shq, exists, APP_VERSION, BUILD_NUM, BUILTIN_AUTH_ENABLED, DEFAULT_SETTINGS, isUpstreamMode, resolveBackendBaseUrl, appLog, appLogError, debugLog, saveSettings, loadControlCache, saveControlCache, saveMessages, saveConversations, saveActiveId, loadMessages, openTextEditor, notifyKeyboardResult, INPUT_TYPES, uid, recordAccountTrouble, setDebugLogEnabled, ensureBackendRunning, loadSettings, loadConversations, loadActiveId, deleteMessages, stopStream } from '../../services/store.js'
import { createBackendMonitor } from '../../services/backend-health.js'
import { tokenExpiringSoon, isSameHost } from '../../services/api-auth.js'
import { refreshDeviceToken } from '../../services/api-pairing.js'
import { maintenanceActive, quotaExhausted, quotaText, ensureUpstreamAuth, upstreamBase, fetchControl, normalizeControl, normalizeQuota, fetchDeviceStatus, noticeFor, debugGate, updateGate, controlFeature, controlLimit, reportTelemetry, requestUpdateTicket } from '../../services/cloud-control.js'
import { startRemoteDebug } from '../../services/remote-debug.js'
import { startPreview, stopPreview, stopFramePreview, capturePhoto, cropFrame, PHOTO_W, PHOTO_H } from '../../services/camera.js'
import { latexToText, splitMathSegments, canTypesetMath, bracesBalanced, markdownToBlocks, inlineSpans } from '../../services/markdown.js'
import { splitEmojiRuns, substituteEmoji } from '../../services/emoji-subst.js'
import { messageRenderKey as buildMessageRenderKey, isTallMessage as isMessageTall, chunkMarkdownBlocks } from '../../services/message-layout.js'

export default {
    name: 'index',
    data() {
        return {
            MODES,
            // 账号登录模式是否可用（false 时隐藏云端会话同步等后端专属入口）
            builtinEnabled: BUILTIN_AUTH_ENABLED,
            // 会话
            conversations: [],
            activeId: null,
            messages: [],
            // 当前会话的选项
            modeKey: 'fast',
            thinking: true,
            // 思考挡位字符串（none/minimal/low/medium/high/xhigh/max），由 applyThinking
            // 统一折算并保持与 thinking 布尔同步；模板按它渲染静态文案分支
            thinkingLevel: 'high',
            search: false,
            // 设置（theme 用首帧预读值初始化，避免闪浅色）
            settings: Object.assign({}, DEFAULT_SETTINGS, { theme: peekBootTheme() }),
            // 输入
            draft: '',
            draftImages: [],
            draftFiles: [],
            editingMsgId: null,
            // 状态
            sending: false,
            collapsedReasoning: {},
            // UI
            showDrawer: false,
            showPicker: false,
            showFilePicker: false,
            albumImages: [],
            // 文件浏览器：当前目录 + 条目列表（「返回上一级」伪条目也在其中）
            fileRoot: FILE_BROWSER_ROOT,
            fileDir: FILE_BROWSER_ROOT,
            fileEntries: [],
            fileLoading: false,
            fileError: '',
            albumError: '',
            albumLoading: false,
            // 相册缩略图生成序号：进入取景/关闭相册后，使旧的后台任务失效，
            // 避免每张缩略图完成时继续对整页 forceUpdate。
            albumLoadSeq: 0,
            fileLoadSeq: 0,
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
            backendDisconnected: false,
            // 云控：通知 / 维护 / 更新策略；quota 为最近一次查询的配额快照
            control: null,
            quota: null,
            // 服务通知弹窗（noticeId 变化才再弹）
            noticeInfo: null,
            showUpdateModal: false,
            installing: false,
            updateState: 'none',
            updateInfo: { latestBuild: 0, minBuild: 0, version: '', notes: '', url: '', currentBuild: 0 },
            controlFetchedAt: 0,
            updatePromptedBuild: 0
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
        // 上游模式：零配置后端。云控/配额只在这个模式下生效。
        upstreamMode() {
            return isUpstreamMode(this.settings && this.settings.backendMode)
        },
        maintenanceOn() {
            return this.upstreamMode && maintenanceActive(this.control)
        },
        forceUpdateOn() {
            return this.upstreamMode && this.updateState === 'force'
        },
        quotaOut() {
            if (!this.upstreamMode) return false
            return quotaExhausted(this.quota || (this.settings && this.settings.quotaCache))
        },
        // 发不出去的原因（维护 > 强制更新 > 额度），横幅展示
        blockedNotice() {
            if (this.chatDisabled) return '对话功能已暂停，请稍后再试'
            if (this.maintenanceOn) {
                const m = (this.control && this.control.maintenance) || {};
                return '维护：' + (m.message || '服务正在维护，请稍后再试')
            }
            if (this.forceUpdateOn) {
                return '需要更新到 build ' + this.updateInfo.latestBuild + ' 才能继续使用（点此查看）'
            }
            if (this.quotaOut) {
                return '额度已用完：' + quotaText(this.quota || this.settings.quotaCache)
            }
            return ''
        },
        quotaLine() {
            if (!this.upstreamMode) return ''
            return quotaText(this.quota || (this.settings && this.settings.quotaCache))
        },
        // 抽屉渲染列表：按搜索词过滤（#7）
        // 必须放在 computed 里：之前定义在 methods 中，模板 `v-for="c in drawerConversations"`
        // 拿到的是**函数本身**（不是返回值），v-for 遍历函数对象得到空数组 —— 抽屉永远显示
        // "暂无会话"，云端同步导入成功也看不到（bug 3）。
        drawerConversations() {
            const q = (this.convFilter || '').trim().toLowerCase();
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
            let w = 936;
            let h = 280;
            try {
                const env = (typeof weex !== 'undefined') && weex.config && weex.config.env;
                if (env && env.deviceWidth && env.deviceHeight) {
                    w = Math.max(env.deviceWidth, env.deviceHeight);
                    h = Math.min(env.deviceWidth, env.deviceHeight);
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
        // 图片上传是否可用：云控可关（features.images / limits.maxImageCount=0）
        canUploadImage() {
            return this.featImages && this.imageLimit > 0
        },
        // 文件上传入口：云控可整项关闭（features.files）
        canUploadFile() {
            const c = this.control;
            return !c || !c.features || c.features.files !== false
        },
        // 拍照入口单独受 features.camera 控制（只关拍照时仍可选图）
        featCamera() {
            const c = this.control;
            return !c || !c.features || c.features.camera !== false
        },
        imageLimit() {
            return controlLimit(this.control, 'maxImageCount')
        },
        // 云端会话备份：云控可整体关闭（features.sessions）
        featSessions() {
            const c = this.control;
            return !c || !c.features || c.features.sessions !== false
        },
        // 云控功能开关：服务端未下发（或旧缓存）时一律按开启处理
        featSearch() {
            const c = this.control;
            return !c || !c.features || c.features.search !== false
        },
        featThinking() {
            const c = this.control;
            return !c || !c.features || c.features.thinking !== false
        },
        // ===== 思考挡位 =====
        // 挡位不再走 computed：模板直接渲染 data.thinkingLevel（静态分支比较），
        // 折算逻辑集中在 applyThinking()，在会话加载/切换/新建/点击时同步进 data。
        // （build 176/177 实测：本按钮的 computed + 动态 text 子节点在设备端丢文字，
        // 见模板注释；generate/retry 等逻辑路径也直接读 data，不再依赖 computed。）
        featImages() {
            const c = this.control;
            return !c || !c.features || c.features.images !== false
        },
        chatDisabled() {
            const c = this.control;
            return !!(this.upstreamMode && c && c.features && c.features.chat === false)
        },
        // ===== 相机浮层几何 =====
        // 屏幕尺寸：取框架环境宽高（X7 Pro 实测 936x280 横屏），取不到回退实测值。
        // 相机浮层已移出旋转画布，永远按横屏布局（与相册选择器一致）。
        stageW() {
            try {
                const env = weex.config.env;
                return Math.max(env.deviceWidth, env.deviceHeight) || 936
            } catch (e) { return 936 }
        },
        stageH() {
            try {
                const env = weex.config.env;
                return Math.min(env.deviceWidth, env.deviceHeight) || 280
            } catch (e) { return 280 }
        },
        // 确认页预览图（PHOTO_W x PHOTO_H 的带图）resize=contain 后实际铺出的
        // 矩形：image 节点占满整个浮层，contain 会在剩余横向空间内居中；
        // 裁剪框必须使用同一矩形，否则会整体偏左而无法贴合照片边框。
        dispRect() {
            const W = this.stageW;
            const H = this.stageH;
            const s = Math.min(W / PHOTO_W, H / PHOTO_H);
            const w = PHOTO_W * s;
            const h = PHOTO_H * s;
            return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h }
        },
        cropBoxStyle() {
            const b = this.cropBox;
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
        },
        // 端点是否已配置（startup 已按此分流，这里是运行期二次兜底提示）
        hasEndpoint() {
            const s = this.settings || {};
            // 上游模式没有 API Key：地址解析成功 + 完成配对才算可用
            if (isUpstreamMode(s.backendMode)) return !!(s.effectiveBaseUrl && String(s.pairToken || '').trim())
            if (String(s.apiKey || '').trim()) return true
            // 配对模式没有 apiKey，Bearer 用的是 deviceToken（见 api-auth.js）
            return !!String(s.pairToken || '').trim()
        },
        // 实际请求根地址：上游模式由 store.loadSettings 解析到 effectiveBaseUrl
        // （锁定构建只认构建期常量），自定义模式回落到用户填写的 baseUrl。
        apiBaseUrl() {
            const s = this.settings || {};
            // 不读 s.effectiveBaseUrl（loadSettings 的快照字段，模式切换后可能过期），
            // 按三个源字段现算——主页 settings 在 onPageShow 会重载，通常新鲜，
            // 但现算可彻底杜绝同类漂移（与 cloud-control.js upstreamBase 同一原则）。
            return resolveBackendBaseUrl({
                backendMode: s.backendMode,
                baseUrl: s.baseUrl,
                upstreamBaseUrl: s.upstreamBaseUrl,
                defaultBaseUrl: 'https://api.deepseek.com/v1'
            }) || 'https://api.deepseek.com/v1'
        }
    },
    created() {
        this.$page.on('show', this.onPageShow);
        this.init();
        // 诊断通道：把 vm 挂到全局，远程调试 eval 可通过 $falcon.__dsApp 直接
        // 读取/驱动组件状态（思考按钮真机诊断用；无敏感数据，仅页面实例引用）
        try { $falcon.__dsApp = this; } catch (e) { /* 环境无 $falcon 时忽略 */ }
        // 账号登录模式已暂停：没有本机后端可监控（监控会每 10 秒探测 22217-22222）
        if (BUILTIN_AUTH_ENABLED) this.startBackendMonitor();
    },
    destroyed() {
        this.$page.off('show', this.onPageShow);
        this.stopBackendMonitor();
        // 相机预览是常驻 gst 管道 + JS 轮询，页面销毁必须一并停掉，
        // 否则相机节点被占、回调持有组件引用
        cancelThumbJobs();
        ++this.albumLoadSeq;
        stopPreview();
        if (this._errTimer) { clearTimeout(this._errTimer); this._errTimer = null; }
        // 清理节流的渲染/滚动定时器，避免页面销毁后回调仍持有组件引用
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
        if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null; }
    },
    methods: {
        // Loli 键盘通过 kbCaller 回到本页，onNewOptions 是官方回传通道
        onNewOptions(options) {
            if (notifyKeyboardResult(options)) this.$forceUpdate()
        },
        // 设备凭证材料（未注册返回 null，ds.js 回退到 API Key 模式）
        pairAuth() {
            const s = this.settings || {};
            if (!s.pairDeviceId || !s.pairSecret || !s.pairToken) return null
            // 令牌归属校验：只在签发它的服务上使用。切到自定义端点后仍拿内置服务的
            // 令牌请求第三方 API，会被 401 拒绝并误导成"令牌过期"。
            const pairedAt = String(s.pairBaseUrl || '').trim();
            if (pairedAt) {
                if (!isSameHost(pairedAt, this.apiBaseUrl)) return null
            } else if (!isUpstreamMode(s.backendMode) && String(s.apiKey || '').trim()) {
                // 老设置没有 pairBaseUrl：自定义端点已填 API Key 时按 Key 直连
                return null
            }
            return {
                deviceId: s.pairDeviceId,
                deviceToken: s.pairToken,
                signSecret: s.pairSecret,
                expiresAt: s.pairExpiresAt || 0,
                tlsPin: s.pairTlsPin || ''
            }
        },
        // 发请求前确保凭证可用：
        //   上游模式：静默注册 / 续期（用户不需要做任何配置，失败也不抛，让请求给出可读错误）
        //   自定义模式：临期刷新一次，失败沿用旧令牌
        async ensureFreshAuth() {
            if (this.upstreamMode) {
                return await ensureUpstreamAuth({
                    settings: this.settings,
                    persist: () => saveSettings(this.settings)
                })
            }
            const auth = this.pairAuth();
            if (!auth || !tokenExpiringSoon(auth, 300000)) return auth
            try {
                const r = await refreshDeviceToken({ baseUrl: this.apiBaseUrl, auth });
                this.settings.pairToken = r.deviceToken;
                if (r.signSecret) this.settings.pairSecret = r.signSecret;
                this.settings.pairExpiresAt = r.expiresAt;
                await saveSettings(this.settings);
                appLog('[index] 设备令牌已刷新 expiresAt=' + r.expiresAt);
            } catch (e) {
                appLogError('token.refresh', e, '沿用旧令牌');
            }
            return this.pairAuth()
        },

        // ---------- 云控 / 配额 / 自动更新 ----------
        // 缓存先上屏，再静默刷新；任何失败都只记录日志，不影响聊天。
        async refreshCloudControl(force, prompt) {
            if (!this.upstreamMode) return
            if (!force && this.controlFetchedAt && Date.now() - this.controlFetchedAt < 5 * 60 * 1000) return
            const allowPrompt = prompt !== false;
            try {
                const cached = await loadControlCache();
                if (cached) this.applyControl(cached, false);
            } catch (e) { debugLog('[control] 读取本地缓存失败：' + (e && e.message ? e.message : String(e))) }
            const auth = await ensureUpstreamAuth({
                settings: this.settings,
                persist: () => saveSettings(this.settings)
            });
            if (!auth) return
            const baseUrl = upstreamBase(this.settings);
            try {
                const raw = await fetchControl({ baseUrl, auth });
                const c = normalizeControl(raw);
                this.applyControl(c, allowPrompt);
                await saveControlCache(c);
                this.controlFetchedAt = Date.now();
            } catch (e) {
                appLogError('control.fetch', e);
                // 风控临时限制：退避 5 分钟，避免页面反复重试刷出更多 403
                if (e && e.code === 'device_blocked') this.controlFetchedAt = Date.now() + 5 * 60 * 1000;
            }
            try {
                const st = await fetchDeviceStatus({ baseUrl, auth });
                const q = normalizeQuota(st.quota);
                this.quota = q;
                if (q) {
                    this.settings.quotaCache = q;
                    await saveSettings(this.settings);
                }
            } catch (e) { appLogError('quota.fetch', e); }
            this.reportStatus(false);
            this.$forceUpdate();
        },
        // 状态上报（监控）：云控 limits.reportSec 节流；失败不影响聊天
        async reportStatus(force) {
            if (!this.upstreamMode) return
            const ctl = this.control || {};
            if (ctl.telemetry && ctl.telemetry.enabled === false) return
            const interval = Math.max(60, controlLimit(ctl, 'reportSec')) * 1000;
            const last = Number(this.settings && this.settings.lastReportAt) || 0;
            if (!force && last && Date.now() - last < interval) return
            if (this._reporting) return
            this._reporting = true;
            try {
                const auth = await ensureUpstreamAuth({
                    settings: this.settings,
                    persist: () => saveSettings(this.settings)
                });
                if (!auth) return
                let messages = 0;
                let lastError = null;
                try {
                    const list = Array.isArray(this.messages) ? this.messages : [];
                    messages = list.length;
                    for (let i = list.length - 1; i >= 0; i--) {
                        if (list[i] && list[i].error) {
                            lastError = {
                                code: 'CHAT_ERROR',
                                message: String(list[i].error).slice(0, 200),
                                at: list[i].createdAt || Date.now()
                            };
                            break
                        }
                    }
                } catch (e) { /* 忽略 */ }
                await reportTelemetry({
                    baseUrl: upstreamBase(this.settings),
                    auth,
                    payload: {
                        version: APP_VERSION,
                        build: String(BUILD_NUM),
                        model: (this.settings && this.settings.openaiModelId) || '',
                        page: 'index',
                        backendMode: (this.settings && this.settings.backendMode) || '',
                        theme: (this.settings && this.settings.theme) || '',
                        // 调试模式设备必须上报（后台据此显示「调试 / RCE」标记）
                        debug: !!(this.settings && this.settings.debugMode),
                        debugAt: (this.settings && this.settings.debugSince) || 0,
                        rce: !!debugGate(this.control).rce,
                        controlVersion: (this.control && this.control.updatedAt) || 0,
                        stats: {
                            conversations: Array.isArray(this.conversations) ? this.conversations.length : 0,
                            messages,
                            sending: !!this.sending
                        },
                        lastError,
                        events: []
                    }
                });
                this.settings.lastReportAt = Date.now();
                await saveSettings(this.settings);
            } catch (e) {
                appLogError('telemetry.report', e);
            } finally {
                this._reporting = false;
            }
        },
        applyControl(raw, allowPrompt) {
            const c = normalizeControl(raw);
            this.control = c;
            // 服务通知：noticeId 变了才弹（正文没变不会反复打扰）
            this.noticeInfo = this.settings ? noticeFor(c, this.settings.seenNoticeId) : null;
            // 调试授权：服务端禁止时，自动退出调试模式并停止远程轮询
            const dbg = debugGate(c);
            if (this.settings && this.settings.debugMode && !dbg.allow) {
                this.settings.debugMode = false;
                this.settings.portrait = false;
                saveSettings(this.settings).catch((e) => appLogError('settings.save', e));
                this.imageWarn = '服务提供方已关闭调试模式，已自动退出';
            }
            // 云控允许远程执行时启动命令轮询（未开启调试模式则内部直接返回）
            try { startRemoteDebug({ settings: this.settings, control: c, persist: () => saveSettings(this.settings) }); } catch (e) { /* 忽略 */ }
            const gate = updateGate(c);
            this.updateState = gate.state;
            this.updateInfo = gate;
            if (!allowPrompt || gate.state === 'none') return
            // 可选更新：同一构建号只主动弹一次；强制更新每次进入都提示
            const skipped = Number(this.settings && this.settings.skippedUpdateBuild) || 0;
            if (gate.state === 'optional' && skipped === gate.latestBuild) return
            if (this.updatePromptedBuild === gate.latestBuild && gate.state === 'optional') return
            this.updatePromptedBuild = gate.latestBuild;
            this.showUpdateModal = true;
            this.$forceUpdate();
        },
        // 纯文本：设备字体没有 emoji，服务端文案统一走文字降级
        plain(text) {
            return substituteEmoji(text);
        },
        dismissNotice() {
            if (this.noticeInfo && this.settings) {
                this.settings.seenNoticeId = this.noticeInfo.id;
                saveSettings(this.settings).catch((e) => appLogError('settings.save', e));
            }
            this.noticeInfo = null;
            this.$forceUpdate();
        },
        onBlockedTap() {
            if (this.forceUpdateOn) {
                this.showUpdateModal = true;
                this.$forceUpdate();
                return
            }
            if (this.quotaOut) {
                this.imageWarn = '额度已用完（' + quotaText(this.quota || this.settings.quotaCache) + '），请稍后或明日再试';
                this.$forceUpdate();
                return
            }
            if (this.maintenanceOn) {
                this.imageWarn = '服务维护中，请稍后再试';
                this.$forceUpdate();
            }
        },
        // 下载并安装更新包（.amr）：设备没有浏览器，只能在应用内完成。
        // 先 curl 到 data/update，校验大小后再交给 miniapp_cli install；
        // 安装成功会替换当前应用，进程被系统重启，页面不一定回得来。
        async installUpdate() {
            if (this.installing) return
            const info = this.updateInfo || {};
            if (!info.url && !info.fileId) {
                this.imageWarn = '没有可用的更新地址';
                this.$forceUpdate();
                return
            }
            this.installing = true;
            let url = info.url || '';
            // 控制下发的票据可能已过期：安装前现取一张；旧服务端不支持时继续用原 URL。
            if (this.upstreamMode && info.fileId) {
                try {
                    const auth = await ensureUpstreamAuth({
                        settings: this.settings,
                        persist: () => saveSettings(this.settings)
                    });
                    if (auth) {
                        const ticket = await requestUpdateTicket({
                            baseUrl: upstreamBase(this.settings),
                            auth,
                            fileId: info.fileId
                        });
                        url = ticket.url || url;
                    }
                } catch (e) {
                    appLogError('update.ticket', e);
                    if (!url) {
                        this.imageWarn = '无法获取更新包下载授权，请稍后重试';
                        this.installing = false;
                        this.$forceUpdate();
                        return
                    }
                }
            }
            if (!url) {
                this.imageWarn = '没有可用的更新地址';
                this.installing = false;
                this.$forceUpdate();
                return
            }
            const dir = joinPath(dataDirBase(), 'update');
            const file = joinPath(dir, 'build-' + (info.latestBuild || 0) + '.amr');
            const flag = joinPath(dir, 'download.flag');
            const hashFile = joinPath(dir, 'download.sha256');
            this.imageWarn = '正在下载更新包…';
            this.$forceUpdate();
            try {
                execShell('mkdir -p ' + shq(dir) + ' && rm -f ' + shq(flag) + ' ' + shq(hashFile) + ' ' + shq(file) + ' && ' +
                    '(curl -L -s -m 600 -o ' + shq(file) + ' ' + shq(url) + ' && printf ok > ' + shq(flag) + ' || printf fail > ' + shq(flag) + ')');
                const result = String((await waitForFile(flag, 620000)) || '');
                const size = (await exists(file)) ? await statSize(file) : 0;
                if (result.indexOf('ok') !== 0 || !size || size < 100 * 1024) {
                    this.imageWarn = '下载失败或更新包不完整（' + Math.round(size / 1024) + 'KB），请稍后重试';
                    this.installing = false;
                    this.$forceUpdate();
                    return
                }
                // 服务器发布时写了 sha256；能算就校验，防止下载被中间层截断/替换。
                if (info.sha256) {
                    execShell('sha256sum ' + shq(file) + ' 2>/dev/null | awk \'{print $1}\' > ' + shq(hashFile));
                    const got = String((await readFile(hashFile)) || '').trim().toLowerCase();
                    execShell('rm -f ' + shq(hashFile) + ' 2>/dev/null || true');
                    if (got && got !== String(info.sha256).toLowerCase()) {
                        execShell('rm -f ' + shq(file) + ' 2>/dev/null || true');
                        this.imageWarn = '更新包校验失败，已删除下载文件，请重新检查更新';
                        this.installing = false;
                        this.$forceUpdate();
                        return
                    }
                }
                this.imageWarn = '正在安装更新（约 ' + Math.round(size / 1024 / 1024) + 'MB），完成后应用会自动重启…';
                this.$forceUpdate();
                execShell('miniapp_cli install ' + shq(file) + ' >/dev/null 2>&1');
                appLog('[index] 已触发安装 build ' + (info.latestBuild || 0) + ' size=' + size);
                // 安装完成后系统会重建应用；没有重启时提示用户手动重开
                setTimeout(() => {
                    this.imageWarn = '更新包已下载并安装；若界面没有自动重启，请退出后重新打开应用';
                    this.installing = false;
                    this.$forceUpdate();
                }, 2500);
            } catch (e) {
                this.imageWarn = '安装失败：' + (e && e.message ? e.message : String(e));
                this.installing = false;
                this.$forceUpdate();
            }
        },
        openUpdateUrl() {
            const url = (this.updateInfo && this.updateInfo.url) || '';
            if (!url) {
                this.imageWarn = '请通过发布渠道获取新版本';
                this.$forceUpdate();
                return
            }
            // 设备没有通用浏览器入口：复制到提示条，用户可在 PC 上打开
            this.imageWarn = '更新地址：' + url;
            this.$forceUpdate();
        },
        skipUpdate() {
            this.showUpdateModal = false;
            if (this.updateInfo && this.updateInfo.latestBuild && this.settings) {
                this.settings.skippedUpdateBuild = this.updateInfo.latestBuild;
                saveSettings(this.settings).catch((e) => appLogError('settings.save', e));
            }
            this.$forceUpdate();
        },
        closeUpdate() {
            this.showUpdateModal = false;
            this.$forceUpdate();
        },
        // 会话推送到云端（本地已落盘；失败只记日志）
        queueCloudSync(conv, messages) {
            if (!this.upstreamMode || !conv || !this.featSessions) return
            queueSessionPush({
                settings: this.settings,
                conversation: conv,
                messages: messages || this.messages,
                persist: () => saveSettings(this.settings)
            });
        },
        // 本地没有任何会话时，从云端备份恢复（重装/换机）
        async restoreCloudIfEmpty() {
            if (!this.upstreamMode || this.conversations.length || !this.featSessions) return
            try {
                const got = await pullMissing({
                    settings: this.settings,
                    existingIds: [],
                    max: 20,
                    persist: () => saveSettings(this.settings)
                });
                if (!got.length) return
                for (const g of got) {
                    await saveMessages(g.conversation.id, g.messages);
                }
                this.conversations = got.map((g) => g.conversation);
                this.activeId = this.conversations[0].id;
                await saveConversations(this.conversations);
                await saveActiveId(this.activeId);
                this.messages = await loadMessages(this.activeId);
                this.remountTallMessagesSoon();
                this.remountTallMessagesSoon();
                this.remountTallMessagesSoon();
                this.remountTallMessagesSoon();
                const conv = this.activeConversation();
                if (conv) {
                    this.modeKey = conv.mode;
                    this.applyThinking(conv);
                    this.search = conv.search;
                }
                appLog('[index] 已从云端恢复 ' + got.length + ' 条会话');
                this.$forceUpdate();
            } catch (e) {
                appLogError('session.restore', e);
            }
        },
        // 深色模式类名切换：浅色返回原类，深色返回 -dark 变体类
        // （Weex 引擎仅支持单类选择器，不能用 .dark .xxx 后代选择器覆盖）
        dc(cls) {
            return this.isDark ? (cls + '-dark') : cls
        },
        // 把当前主题缓存到 $falcon 全局，供 settings/index 页首帧同步预读（#7）
        cacheTheme() {
            try { $falcon.__dsTheme = (this.settings && this.settings.theme) || 'light'; } catch (e) { /* 忽略 */ }
        },
        // 流式渲染节流：每来一个 delta 就 $forceUpdate + 滚动，会把弱 SoC 的 CPU
        // 打满（消息多时还要全量重渲染整列），是"发送消息时设备卡死/重启"的诱因之一。
        // 合并成最多 ~8 帧/秒；流式结束时用 flushRender 保证最终画面一致。
        // 滚动走 streamScrollTick（尊重用户的自由滚动，不硬拽视口）。
        scheduleRender() {
            if (this._renderTimer) return
            this._renderTimer = setTimeout(() => {
                this._renderTimer = null;
                this.$forceUpdate();
                this.streamScrollTick();
            }, 120);
        },
        flushRender() {
            if (this._renderTimer) {
                clearTimeout(this._renderTimer);
                this._renderTimer = null;
            }
            this.$forceUpdate();
            this.streamScrollTick();
        },
        closeDrawer() {
            this.showDrawer = false;
            this.syncMsg = '';
            this.$forceUpdate();
        },
        // 空消费点击：挡住抽屉内部空白区域的事件穿透到遮罩（bug 修复）
        noopDrawer() {},
        async searchConversations() {
            const text = await openTextEditor(INPUT_TYPES.ZH_CN_PREFERRED, this.convFilter || '', { callerPage: 'index' });
            if (text === null) return
            this.convFilter = String(text).trim();
            this.$forceUpdate();
        },
        clearConvFilter() {
            this.convFilter = '';
            this.$forceUpdate();
        },

        // ---------- 云端会话同步（#10） ----------
        // 拉取 DeepSeek 账号的会话列表，按标题去重后导入：
        // 恢复原会话模式（model_type→mode），记录 cloudId 供进入时按需拉取消息内容
        async syncCloudSessions() {
            if (!BUILTIN_AUTH_ENABLED) {
                this.syncMsg = '账号登录模式已暂停：云端会话同步暂不可用';
                this.$forceUpdate();
                return
            }
            if (this.syncing) return
            this.syncing = true;
            this.syncMsg = '';
            this.$forceUpdate();
            try {
                const list = await listCloudSessions({
                    baseUrl: this.apiBaseUrl,
                    apiKey: this.settings.apiKey,
                    authMode: this.settings.authMode
                });
                let added = 0;
                let linked = 0;
                for (const s of list) {
                    const title = String(s.title || '').trim();
                    if (!title) continue
                    const ts = s.updated_at ? Math.round(s.updated_at * 1000) : Date.now();
                    // 已关联过的云端会话（cloudId 匹配）：不重复导入
                    if (this.conversations.some((c) => c.cloudId === s.id)) continue
                    // 本机新建的会话在云端也有一条同名会话（服务端为每次对话都建了 session），
                    // 但它本地还没有 cloudId。旧实现只按 cloudId 去重，于是同步时把同一条
                    // 对话又导入一遍 —— 抽屉里出现两份（云的一份是空占位，进入才拉取）。
                    // 这里先按标题认领：命中未关联的本地会话就补上 cloudId 并标记
                    // cloudLoaded（消息本地已有，不需要再拉云端内容覆盖）。
                    const candidates = this.conversations.filter((c) => !c.cloudId && !c.cloudLinked && (c.title || '').trim() === title);
                    if (candidates.length) {
                        let best = candidates[0];
                        let bestDiff = Math.abs((best.updatedAt || 0) - ts);
                        for (const c of candidates) {
                            const diff = Math.abs((c.updatedAt || 0) - ts);
                            if (diff < bestDiff) {
                                best = c;
                                bestDiff = diff;
                            }
                        }
                        best.cloudId = s.id;
                        best.cloudLinked = true;
                        best.cloudLoaded = true;
                        linked += 1;
                        continue
                    }
                    // 模型已合并：云端 model_type 无论是 default/expert/vision 都映射到唯一模式
                    const mode = MODES[0].key;
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
                    });
                    added += 1;
                }
                this.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                if (added > 0 || linked > 0) {
                    await saveConversations(this.conversations);
                }
                // 已关联的会话不再计入"导入"：认领只是给本地会话补云端身份，没有新增条目
                this.syncMsg = added > 0
                    ? ('已导入 ' + added + ' 个云端会话（进入时加载内容）' + (linked ? '，关联 ' + linked + ' 个本地会话' : ''))
                    : (linked > 0 ? ('已关联 ' + linked + ' 个本地会话，无重复导入') : '云端会话均已存在');
                debugLog('[sync] 云端会话 ' + list.length + ' 个，新增 ' + added + '，关联 ' + linked);
            } catch (e) {
                this.syncMsg = '同步失败：' + (e && e.message ? e.message : '未知错误');
                const msg = e && e.message ? e.message : String(e);
                if (isAccountSuspension(msg)) {
                    recordAccountTrouble('同步', msg);
                }
                appLogError('sync.session', e, msg);
            }
            this.syncing = false;
            this.$forceUpdate();
        },

        // 进入带 cloudId 的空会话时，按需拉取云端消息内容（一次性）
        async ensureCloudMessages(conv) {
            if (!BUILTIN_AUTH_ENABLED) return
            if (!conv || !conv.cloudId || conv.cloudLoaded) return
            this._cloudLoading = this._cloudLoading || {};
            if (this._cloudLoading[conv.id]) return
            this._cloudLoading[conv.id] = true;
            this.cloudLoadingId = conv.id;
            this.$forceUpdate();
            try {
                const list = await listCloudSessionMessages({
                    baseUrl: this.apiBaseUrl,
                    apiKey: this.settings.apiKey,
                    authMode: this.settings.authMode,
                    sessionId: conv.cloudId
                });
                const convNow = this.conversations.find((c) => c.id === conv.id);
                if (!convNow) return
                const now = Date.now();
                const msgs = [];
                let seq = 0;
                for (const m of list) {
                    if (m.role === 'user') {
                        const id = uid('u');
                        // 云端编辑历史：alt_texts 是被替换的旧版本（升序），当前
                        // content 是最新——与本地 revisions 的语义一致
                        // （revisions[activeRevision] 为当前显示版本）。
                        const alts = Array.isArray(m.alt_texts) ? m.alt_texts : [];
                        msgs.push({
                            id, role: 'user', content: m.content, images: [], createdAt: now + seq++,
                            revisions: alts.map((t) => ({ content: t, images: [], createdAt: now + seq }))
                                .concat([{ content: m.content, images: [], createdAt: now + seq }]),
                            activeRevision: alts.length
                        });
                    } else {
                        const id = uid('a');
                        // 云端重试历史同理映射为 attempts（attempts[activeAttempt]
                        // 为当前版本，本地 retryMessage 就是往 attempts 追加）。
                        const alts = Array.isArray(m.alt_texts) ? m.alt_texts : [];
                        msgs.push({
                            id, role: 'assistant', content: m.content, reasoning: m.reasoning || '', pending: false,
                            createdAt: now + seq++,
                            attempts: alts.map((t) => ({ id: uid('a'), content: t, reasoning: '', pending: false, createdAt: now + seq }))
                                .concat([{ id, content: m.content, reasoning: m.reasoning || '', pending: false, createdAt: now + seq }]),
                            activeAttempt: alts.length
                        });
                    }
                }
                convNow.cloudLoaded = true;
                await saveConversations(this.conversations);
                if (msgs.length && this.activeId === conv.id) {
                    this.messages = msgs;
                    this.remountTallMessagesSoon();
                    await saveMessages(conv.id, this.messages);
                    this.$forceUpdate();
                    this.scrollToBottom();
                }
                debugLog('[cloud] 已加载云端会话内容 ' + msgs.length + ' 条 titleLen=' + String(conv.title || '').length);
            } catch (e) {
                // 静默失败：保留占位会话，下次进入重试
                const msg = e && e.message ? e.message : String(e);
                if (isAccountSuspension(msg)) {
                    recordAccountTrouble('云端内容', msg);
                }
                appLogError('cloud.messages', e, msg);
            } finally {
                this._cloudLoading[conv.id] = false;
                if (this.cloudLoadingId === conv.id) {
                    this.cloudLoadingId = '';
                }
                this.$forceUpdate();
            }
        },
        // 首条消息派生会话标题（#9 本地兜底；后端 dsTitle 可用时会被覆盖）
        deriveTitle(text, imgCount) {
            const t = (text || '').replace(/\s+/g, ' ').trim();
            if (t) {
                const cut = t.slice(0, 20);
                const m = cut.match(/^(.+?[，。？！、；：,.!?;:])/);
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
        // 流式重建纪元：pending 时按内容长度分桶（每 ~200 字换一个 key → 子树重建、
        // 重新测量原生文本）；定稿时由消息行 key 使用全文指纹，保障同长度替换也重建。
        textEpoch(text, pending) {
            const s = String(text || '');
            // pending 时按长度分桶，控制重建频率；定稿 key 另由整行内容指纹保障。
            if (!pending) return 'f' + s.length
            return 'l' + Math.floor(s.length / 200)
        },
        // 长回复在流式期间可能跨过多个 200 字分桶，但父级气泡的原生布局缓存
        // 有时仍没失效。只给预计会超过屏幕的回复增加整行重建：文字长度阈值、
        // 表格分隔行或列表标记命中任一条件；短消息不重建，避免抖动。
        streamLayoutTick(m) {
            if (!m || !m.pending) return
            if (!isMessageTall(m)) return
            const now = Date.now();
            const id = String(m.id || '');
            const last = this._lastStreamLayoutTick;
            if (last && last.id === id && now - last.at < 900) return
            // 只留组件级的单条节流状态，不写进消息对象或本地会话数据。
            this._lastStreamLayoutTick = { id, at: now };
            this.bumpLayout(m)
        },

        // 消息行整体重建：气泡高度是引擎缓存的，子树重建也不一定带动父级重量。
        // 内容被原地替换（定稿 / 切尝试 / 云同步回填）时把整行销毁重建一次。
        bumpLayout(m) {
            if (m) m.renderEpoch = (m.renderEpoch || 0) + 1
        },
        // 落定后重量：引擎对"挂载那一刻"的量高有缓存，表格折叠行/单元格内边距
        // 这类结构空间可能没算进去（表现为：内容中段渲染正常，但滚动范围停在
        // 消息中段，尾部整段滚不到）。挂载/定稿 350ms 后把长消息整行重建一次，
        // 逼引擎按真实布局重新量高。只重建长消息，避免长会话整列表重挂。
        remountTallMessagesSoon() {
            setTimeout(() => {
                let touched = false;
                for (const m of this.messages || []) {
                    if (this.isTallMessage(m)) { this.bumpLayout(m); touched = true }
                }
                if (touched) this.$forceUpdate();
            }, 350);
        },
        // 正文分块：把 markdown 块按估算高度切成多组，每组渲染成独立气泡。
        // 真机实证（build 196~198）：单棵超高 bubble 子树量高失效（尾部滚不到、
        // 行边界裁字）；分块后每组高度落在引擎可靠量高范围内。
        // 定稿结果按内容缓存；流式（final=false）每次现算——块数少，代价可忽略。
        markdownChunks(content, final = true) {
            const key = String(content === undefined || content === null ? '' : content);
            if (!final) return chunkMarkdownBlocks(markdownToBlocks(key))
            const cache = this._chunkCache || (this._chunkCache = new Map());
            if (cache.has(key)) return cache.get(key)
            const chunks = chunkMarkdownBlocks(markdownToBlocks(key));
            if (cache.size > 200) cache.clear();
            cache.set(key, chunks);
            return chunks
        },
        // 头气泡可见性：没有正文分块（纯思考中/纯错误）或带思考过程/工具卡片/错误时显示
        assistantHeadVisible(m) {
            if (!m) return false
            if (m.pending && !m.content && !m.reasoning) return true
            if (m.reasoning) return true
            if (m.toolCalls && m.toolCalls.length) return true
            if (m.error) return true
            return this.markdownChunks(m.content || '', !m.pending).length === 0
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
            const key = String(text === undefined || text === null ? '' : text);
            if (!final) return this._buildRuns(key, false)
            const cache = this._runCache || (this._runCache = new Map());
            if (cache.has(key)) return cache.get(key)
            const result = this._buildRuns(key, true);
            if (cache.size > 600) cache.clear();
            cache.set(key, result);
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
            const src = String(text === undefined || text === null ? '' : text);
            const runs = [];
            const segs = splitMathSegments(src);
            for (let k = 0; k < segs.length; k++) {
                const seg = segs[k];
                if (seg.math) {
                    if (final && canTypesetMath(seg.text)) {
                        runs.push({ text: seg.text, math: true });
                    } else if (!bracesBalanced(seg.text)) {
                        // 括号不配平（流式中间态 / 模型笔误）：原生排成空白、Unicode
                        // 会把 \frac 啃成 "frac" 拼出错字。原样显示源码最诚实，且
                        // 流式下一帧就变正常，不会停留。
                        runs.push({ text: '$' + seg.text + '$', code: true });
                    } else {
                        // 超长等其它情况：Unicode 近似（内容完整、可换行，只是不精确）
                        const uni = latexToText('$' + seg.text + '$');
                        if (uni) runs.push({ text: uni });
                    }
                    continue
                }
                const spans = inlineSpans(seg.text);
                for (let i = 0; i < spans.length; i++) {
                    const s = spans[i];
                    // emoji 替换只改显示层：字体可用时用原文，否则把 emoji 换成文字标签
                    const source = this._emojiFontActive ? s.text : substituteEmoji(s.text);
                    const pieces = splitEmojiRuns(source);
                    for (let j = 0; j < pieces.length; j++) {
                        if (!pieces[j].t) continue
                        runs.push({
                            text: pieces[j].t,
                            bold: !!s.bold,
                            italic: !!s.italic,
                            code: !!s.code,
                            emoji: !!pieces[j].e
                        });
                    }
                }
            }
            if (runs.length === 0) runs.push({ text: '' });
            return runs
        },
        // run 的 class：行内样式 + emoji 字体（字体可用时才套，否则已经是文字标签）
        // forceStrike：任务列表已完成项整条加删除线（√ + 删除线传达"完成"）
        // cell：表格单元格上下文传 true——Weex 仅支持单类选择器，单元格文字的
        // lines:3 必须落在 run 自身的类上（.md-*-cell 变体，见样式表注释）
        runClass(r, forceStrike, cell) {
            let s = r;
            if (forceStrike && r && !r.math && !r.code) {
                s = { text: r.text, bold: r.bold, italic: r.italic, code: r.code, strike: true };
            }
            let cls = this.spanClass(s);
            if (cell) {
                // spanClass 已过 dc()：浅色 'md-span'、深色 'md-span-dark'。
                // 统一在尾部追加 '-cell' → 'md-span-cell' / 'md-span-dark-cell'（均已声明 lines:3）
                cls = cls + '-cell';
            }
            if (r && r.emoji && this._emojiFontActive) cls += ' md-emoji';
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
            const key = String(text === undefined || text === null ? '' : text);
            const withMath = latexToText(key);
            return this._emojiFontActive ? withMath : substituteEmoji(withMath)
        },
        spanStyle(s) {
            let st = '';
            if (s.bold) st += 'font-weight:bold;';
            if (s.italic) st += 'font-style:italic;';
            if (s.code) st += 'font-family:monospace;';
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
            const st = block.taskStates && block.taskStates[ii];
            if (st === 'done') return '√ '
            if (st === 'open') return '□ '
            return block.ordered ? ((block.start || 1) + ii) + '. ' : '• '
        },
        isTaskDone(block, ii) {
            return !!(block.taskStates && block.taskStates[ii] === 'done')
        },
        // 表格列对齐：GFM 分隔行解析出的 left/center/right 套到单元格文字上
        mdAlign(align, ci) {
            const a = (align && align[ci]) || 'left';
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
            m.activeRevision = (m.activeRevision || 0) - 1;
            if (m.activeRevision < 0) m.activeRevision = m.revisions.length - 1;
            this.applyUserVersion(m);
        },
        nextUserVersion(m) {
            if (this.sending || !m || !m.revisions || m.revisions.length <= 1) return
            m.activeRevision = (m.activeRevision || 0) + 1;
            if (m.activeRevision >= m.revisions.length) m.activeRevision = 0;
            this.applyUserVersion(m);
        },
        applyUserVersion(m) {
            const rev = m.revisions[m.activeRevision];
            if (rev) {
                m.content = rev.content || '';
                m.images = rev.images || [];
            }
            this.bumpLayout(m);
            this.$forceUpdate();
            this.saveCurrentMessages();
        },
        prevAssistantAttempt(m) {
            if (this.sending || !m || !m.attempts || m.attempts.length <= 1) return
            m.activeAttempt = (m.activeAttempt || 0) - 1;
            if (m.activeAttempt < 0) m.activeAttempt = m.attempts.length - 1;
            this.applyAssistantAttempt(m);
        },
        nextAssistantAttempt(m) {
            if (this.sending || !m || !m.attempts || m.attempts.length <= 1) return
            m.activeAttempt = (m.activeAttempt || 0) + 1;
            if (m.activeAttempt >= m.attempts.length) m.activeAttempt = 0;
            this.applyAssistantAttempt(m);
        },
        applyAssistantAttempt(m) {
            const att = m.attempts[m.activeAttempt];
            if (att) {
                m.content = att.content || '';
                m.reasoning = att.reasoning || '';
                m.error = att.error || '';
                // errorCode 必须跟着切：重试按钮靠它判断"这条是限流失败"，
                // 漏掉会让用户切到成功的版本后重试仍被拦（或反之放行）（bug 1）
                m.errorCode = att.errorCode || '';
                m.pending = !!att.pending;
            }
            // 原地换了整段内容：旧的高度缓存全部作废，整行重建
            this.bumpLayout(m);
            this.$forceUpdate();
            this.saveCurrentMessages();
        },
        async saveCurrentMessages() {
            if (!this.activeId) return
            try {
                await saveMessages(this.activeId, this.messages);
            } catch (e) { appLogError('messages.save', e, 'conv=' + this.activeId); }
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
                        this._emojiFontActive = true;
                        // run 缓存里存的是「按当时字体可用性构建」的结果，字体状态一变就得整表清掉
                        if (this._runCache) this._runCache.clear();
                        this.$forceUpdate();
                        return
                    }
                    // 失败原因写日志：开关显示"已开启"但只渲染出白块时，
                    // 用户能在"查看日志"里看到到底是设备不支持还是下载失败。
                    this._emojiFontActive = false;
                    appLog('[index] emoji 字体不可用（已用文字替换 emoji）：' + (r.message || '未知原因'));
                })
                .catch((e) => {
                    this._emojiFontActive = false;
                    appLogError('emoji.font', e);
                });
        },
        setDebugLog() {
            try {
                setDebugLogEnabled(!!(this.settings && this.settings.debugLog));
            } catch (e) { appLogError('debug.toggle', e); }
        },
        // 兜底拉起后端（startup 页若未执行 ensureBackendRunning 时启用）
        async ensureBackend() {
            // 账号登录模式已暂停：不部署、不拉起、不探测任何本机后端
            if (!BUILTIN_AUTH_ENABLED) return
            // 自定义端点模式不依赖本机后端，别去部署/重启它
            if (this.settings && this.settings.authMode && this.settings.authMode !== 'builtin') return
            if (this._backendEnsuring) return
            this._backendEnsuring = true;
            try {
                const result = await ensureBackendRunning();
                appLog('[index] ensureBackend 结果 ok=' + result.ok + ' msg=' + (result.message || '') + ' code=' + (result.code || ''));
                if (result.ok) {
                    // 成功后清除断开标志（自愈完成）
                    if (this.backendDisconnected) {
                        this.backendDisconnected = false;
                        this.$forceUpdate();
                    }
                } else if (this.backendDisconnected !== true) {
                    this.backendDisconnected = true;
                    this.$forceUpdate();
                }
            } catch (e) {
                appLogError('backend.ensure', e);
            } finally {
                this._backendEnsuring = false;
            }
        },
        async init() {
            try {
                this.settings = await loadSettings();
            } catch (e) {
                // 设置读不出来也要能进主页（用默认值），并把原因写进日志
                appLogError('index.settings', e);
                this.settings = Object.assign({}, DEFAULT_SETTINGS);
            }
            this.cacheTheme();
            // 未登录兜底：内置模式且没有任何账号时，引导到专用登录页
            // （正常路径由 startup 页判断；这里防御直接进入 index 的情况）
            if (BUILTIN_AUTH_ENABLED && this.settings && this.settings.authMode === 'builtin' && !this.settings.dsConfigured) {
                appLog('[index] 未配置账号，跳转登录页');
                try {
                    $falcon.navTo('login');
                } catch (e) { appLogError('nav.login', e); }
                return
            }
            this.setDebugLog();
            this.ensureEmojiFontIfEnabled();
            // 兜底拉起后端：startup 页可能因生命周期问题从未执行 ensureBackendRunning，
            // 这里确保后端一定被部署并启动（不阻塞 UI 渲染）
            this.ensureBackend();
            this.conversations = (await loadConversations()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            this.activeId = await loadActiveId();
            if (!this.activeId || !this.conversations.some((c) => c.id === this.activeId)) {
                this.activeId = this.conversations.length ? this.conversations[0].id : null;
            }
            if (this.activeId) {
                this.messages = await loadMessages(this.activeId);
                const conv = this.activeConversation();
                if (conv) {
                    this.modeKey = conv.mode;
                    this.applyThinking(conv);
                    this.search = conv.search;
                }
            } else {
                this.messages = [];
                this.modeKey = this.settings.defaultMode;
                this.applyThinking(this.settings.defaultThinking);
                this.search = this.settings.defaultSearch;
            }
            // 上游模式：云控（通知/维护/更新）与配额；本地为空时尝试从云端恢复
            if (this.upstreamMode) {
                this.refreshCloudControl(false, true);
                this.restoreCloudIfEmpty();
            }
            this.$forceUpdate();
        },
        async onPageShow() {
            // 从设置页返回时刷新设置与会话列表（可能被清空）
            this.settings = await loadSettings();
            this.cacheTheme();
            this.setDebugLog();
            this.ensureEmojiFontIfEnabled();
            if (this.sending) {
                // 发送中：不重载消息数组，避免 pending 消息被覆盖导致"正在思考"卡住
                return
            }
            this.conversations = (await loadConversations()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            if (!this.activeId || !this.conversations.some((c) => c.id === this.activeId)) {
                this.activeId = this.conversations.length ? this.conversations[0].id : null;
                if (this.activeId) {
                    this.messages = await loadMessages(this.activeId);
                    const conv = this.activeConversation();
                    if (conv) {
                        this.modeKey = conv.mode;
                        this.applyThinking(conv);
                        this.search = conv.search;
                    }
                } else {
                    this.messages = [];
                    this.modeKey = this.settings.defaultMode;
                    this.applyThinking(this.settings.defaultThinking);
                    this.search = this.settings.defaultSearch;
                }
            }
            // 从设置页返回：策略可能被改过（例如刚跳过更新/刚反馈），静默刷新一次
            if (this.upstreamMode) this.refreshCloudControl(true, false);
            this.$forceUpdate();
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
            return (this.draft && this.draft.trim().length > 0) || this.draftImages.length > 0 || this.draftFiles.length > 0
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
        fileIconSrc() {
            return this.isDark ? 'icons/file-dark.png' : 'icons/file.png'
        },
        fileSizeText(size) {
            return fmtFileSize(size)
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
            const last = this.messages[this.messages.length - 1];
            return m === last && !m.pending
        },

        // ---------- 会话管理 ----------
        toggleDrawer() {
            this.showDrawer = !this.showDrawer;
            if (!this.showDrawer) this.syncMsg = '';
            this.$forceUpdate();
        },
        // applyDefaults=true（"＋新对话"按钮）：设置里的默认深度思考/默认联网搜索
        // 在此刻生效一次；false（空态直接发送）：沿用当前开关（尊重用户已拨状态）
        async newConversation(applyDefaults = false) {
            this.reqSeq += 1;
            if (applyDefaults) {
                this.applyThinking(this.settings.defaultThinking);
                this.search = this.settings.defaultSearch;
            }
            // 把当前挡位一起写进新会话：只存布尔 thinking 的话，下一行 applyThinking(conv)
            // 会按"true → 模型默认挡"折算，用户点好的挡位当场丢失（空态直接发送时
            // send() 会走到这里，表现就是"点完思考挡位、一发消息就重置"）。
            const think = thinkingFields(this.effectiveModelId(), this.thinkingLevel);
            const conv = {
                id: uid('c'),
                title: '新对话',
                mode: this.modeKey,
                thinking: think.thinking,
                thinkingLevel: think.thinkingLevel,
                search: this.search,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this.conversations = [conv].concat(this.conversations);
            await saveConversations(this.conversations);
            this.activeId = conv.id;
            await saveActiveId(conv.id);
            this.messages = [];
            this.modeKey = conv.mode;
            this.applyThinking(conv);
            this.search = conv.search;
            this.editingMsgId = null;
            this.draft = '';
            this.draftImages = [];
            this.draftFiles = [];
            this.showDrawer = false;
            this.syncMsg = '';
            this.convFilter = '';
            this.$forceUpdate();
        },
        async switchConversation(id) {
            if (id === this.activeId) {
                this.showDrawer = false;
                return
            }
            this.reqSeq += 1;
            this.activeId = id;
            // 换会话回到"跟随"初始态：下次在该会话发消息/重试时流式正常跟手
            this.resumeFollow();
            await saveActiveId(id);
            this.messages = await loadMessages(id);
            this.remountTallMessagesSoon();
            const conv = this.activeConversation();
            if (conv) {
                this.modeKey = conv.mode;
                this.applyThinking(conv);
                this.search = conv.search;
                // #10：云端同步的占位会话，进入时按需拉取消息内容
                this.ensureCloudMessages(conv);
            }
            this.editingMsgId = null;
            this.draft = '';
            this.draftImages = [];
            this.draftFiles = [];
            this.showDrawer = false;
            this.syncMsg = '';
            this.$forceUpdate();
            // 切换会话不滚到底：短会话会被"锚点对齐上沿"式滚动把气泡滚出
            // 视口（只剩"重试"按钮），历史会话从头看更自然
        },
        async deleteConversation(c) {
            this.reqSeq += 1;
            const cloudId = c && c.cloudId;
            this.conversations = this.conversations.filter((x) => x.id !== c.id);
            await saveConversations(this.conversations);
            await deleteMessages(c.id);
            if (this.activeId === c.id) {
                this.activeId = this.conversations.length ? this.conversations[0].id : null;
                await saveActiveId(this.activeId);
                if (this.activeId) {
                    this.messages = await loadMessages(this.activeId);
                    const conv = this.activeConversation();
                    if (conv) {
                        this.modeKey = conv.mode;
                        this.applyThinking(conv);
                        this.search = conv.search;
                    }
                } else {
                    this.messages = [];
                    this.modeKey = this.settings.defaultMode;
                    this.applyThinking(this.settings.defaultThinking);
                    this.search = this.settings.defaultSearch;
                }
                this.draft = '';
                this.draftImages = [];
                this.draftFiles = [];
                this.editingMsgId = null;
            }
            this.$forceUpdate();
            // 同步删云端会话（bug 3）：只删本地的话，下次「同步」/「从云端恢复」
            // 会把这条会话再导回来，用户看到"删了又回来"。
            // 上游模式：删的是会话备份（session-sync），失败不阻断本地删除。
            if (this.upstreamMode && this.featSessions) {
                syncDelete({
                    settings: this.settings,
                    conversation: c,
                    persist: () => saveSettings(this.settings)
                });
            } else if (cloudId) {
                this.deleteCloudConversation(cloudId, c.title);
            }
        },
        // 删除远端会话：失败时把原因显示在抽屉的同步提示里（不弹窗打扰）
        async deleteCloudConversation(cloudId, title) {
            if (!BUILTIN_AUTH_ENABLED) return
            try {
                await deleteCloudSession({
                    baseUrl: this.apiBaseUrl,
                    apiKey: this.settings.apiKey,
                    authMode: this.settings.authMode,
                    sessionId: cloudId
                });
                // 标题属于聊天内容，日志里只留 id
                debugLog('[cloud] 已删除云端会话 ' + cloudId);
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                this.syncMsg = '本地已删除，云端删除失败：' + msg + '（下次同步可能重新出现）';
                if (isAccountSuspension(msg)) {
                    recordAccountTrouble('删除云端会话', msg);
                }
                appLogError('cloud.delete', e, msg);
                this.$forceUpdate();
            }
        },
        async persistConversation(conv) {
            const exists = this.conversations.some((c) => c.id === conv.id);
            this.conversations = exists
                ? this.conversations.map((c) => (c.id === conv.id ? conv : c))
                : [conv].concat(this.conversations);
            await saveConversations(this.conversations);
        },

        // ---------- 选项 ----------
        selectMode(key) {
            if (this.modeLocked()) return
            this.modeKey = key;
            // 模型已合并，单一模式即支持图片，切换模式不再需要清空待发图片。
            const conv = this.activeConversation();
            if (conv) {
                conv.mode = key;
                this.persistConversation(conv);
            }
            this.$forceUpdate();
        },
        toggleClass(v) {
            return v ? this.dc('top-toggle-on') : this.dc('top-toggle')
        },
        // 思考按钮内部文字的配色（容器 div 承载背景/圆角，文字颜色随开关状态）
        toggleTextClass() {
            return this.thinking ? this.dc('top-toggle-txt-on') : this.dc('top-toggle-txt')
        },
        // 当前模型 ID（思考挡位匹配用）：设置页选择的模型，两种后端模式一致；
        // 留空时 thinking-levels.js 走 fallback 挡位（low/high/max）。
        // 注意必须在 methods 里（不能放 computed）——调用方是 this.effectiveModelId()，
        // 若放 computed 会变成字符串值，被当函数调用时抛 TypeError（build 176~181
        // 四个版本「点击无反应/文字丢失」的总根因，见 [think] 真机日志定位）。
        effectiveModelId() {
            const s = this.settings || {};
            return String(s.openaiModelId || '').trim()
        },
        // 把任意思考值折算成当前模型的挡位并同步进 data（thinkingLevel 挡位字符串 +
        // thinking 布尔兼容字段）。所有会话加载/切换/新建/点击路径统一走这里，
        // 模板与逻辑只读 data，不再依赖 computed（设备端渲染可靠性问题，见模板注释）。
        // source：会话对象（取 thinkingLevel ?? thinking ?? 保持当前挡位）或原始值
        // （布尔 true/false 或挡位字符串；undefined 保持当前挡位）。
        applyThinking(source) {
            let raw
            if (source && typeof source === 'object') {
                raw = (source.thinkingLevel !== undefined && source.thinkingLevel !== null && source.thinkingLevel !== '')
                    ? source.thinkingLevel
                    : (source.thinking === undefined ? this.thinkingLevel : source.thinking)
            } else {
                raw = source === undefined ? this.thinkingLevel : source
            }
            const f = thinkingFields(this.effectiveModelId(), raw);
            this.thinkingLevel = f.thinkingLevel;
            this.thinking = f.thinking;
        },
        // 深度思考：多次点击在当前模型的挡位表里循环（如 low→high→max→low；
        // GPT-6 Sol 这类支持 none 的模型循环里含"关"）。挡位按会话持久化，
        // 同时回写布尔 thinking 保持旧版本兼容。没有活动会话时也同步 data，
        // 保证按钮文案能循环（旧实现此时 label 卡死在默认挡）。
        toggleThinking() {
            if (this.sending || !this.featThinking) return
            try {
                const model = this.effectiveModelId();
                const next = nextThinkingLevel(model, this.thinkingLevel);
                this.applyThinking(next);
                const conv = this.activeConversation();
                if (conv) {
                    const f = thinkingFields(model, next);
                    conv.thinkingLevel = f.thinkingLevel;
                    conv.thinking = f.thinking;
                    this.persistConversation(conv);
                }
                this.$forceUpdate();
            } catch (e) {
                appLogError('think.toggle', e);
            }
        },
        toggleSearch() {
            if (this.sending || !this.featSearch) return
            this.search = !this.search;
            const conv = this.activeConversation();
            if (conv) {
                conv.search = this.search;
                this.persistConversation(conv);
            }
            this.$forceUpdate();
        },

        // ---------- 输入 ----------
        async openInput() {
            if (this.sending) return
            // 实测（计算器 v1.12.103 反编译 + 真机）：用默认 ZhCNPreferred 即可带出系统输入法的语音/录音按钮；
            // RecordPreferred 与底部滑动手势关联（y03 主题特有），在本机不触发语音按钮，弃用。
            // Bug 4 修复：将当前 draft 作为预填充文本传给输入法，修改消息时编辑器能显示原文。
            const text = await openTextEditor(INPUT_TYPES.ZH_CN_PREFERRED, this.draft || '', { callerPage: 'index' });
            if (text === null) return
            // 编辑器返回：null=取消；字符串=确认后结果（含空串"清空"）。直接覆盖 draft。
            this.draft = text || '';
            this.$forceUpdate();
        },

        // ---------- 发送 / 重试 / 修改 ----------
        // 发送前的本地校验失败提示（不写入消息，避免污染会话）
        failSend(text) {
            this.imageWarn = text;
            this.$forceUpdate();
            try { appLog('[send] 已阻断：' + text); } catch (e) { /* 忽略 */ }
        },
        async send() {
            if (this.sending) {
                this.stopGeneration();
                return
            }
            // 云控三连：维护 / 强制更新 / 额度用尽时直接拦住，不发请求
            if (this.chatDisabled || this.maintenanceOn || this.forceUpdateOn || this.quotaOut) {
                if (this.forceUpdateOn) this.showUpdateModal = true;
                this.$forceUpdate();
                return
            }
            let text = (this.draft || '').trim();
            // 云控 limits.maxInputChars：超出部分截断并提示（避免请求体过大被网关拒绝）
            const maxChars = controlLimit(this.control, 'maxInputChars');
            if (text.length > maxChars) {
                text = text.slice(0, maxChars);
                this.imageWarn = '输入超过 ' + maxChars + ' 字，已自动截断';
            }
            // 合并后的模型自带图片理解，图片随任意消息发送即可
            const images = this.draftImages || [];
            const files = this.draftFiles || [];
            if (!text && images.length === 0 && files.length === 0) return

            // 等待后台预压缩完成（若还没好），把 dataUrl 补进每个待发图片对象
            await Promise.all(images.map((i) => i.pending || Promise.resolve()));
            images.forEach((i) => { i.dataUrl = i.dataUrl || null; });
            const usable = images.filter((i) => i.dataUrl);
            if (images.length && !usable.length) {
                // 全部图片都超限：别发空消息，直接告知原因
                this.failSend('图片过大无法发送（单图上限约 900KB），请换一张或先裁剪');
                return
            }
            if (usable.length < images.length) {
                this.imageWarn = '部分图片过大，无法发送（已跳过）';
            }

            if (!this.activeConversation()) {
                await this.newConversation();
            }
            const conv = this.activeConversation();
            const seq = ++this.reqSeq;
            const convId = conv.id;

            let pending = null;
            if (this.editingMsgId) {
                const idx = this.messages.findIndex((m) => m.id === this.editingMsgId);
                if (idx >= 0) {
                    const userMsg = this.messages[idx];
                    const normalized = this.normalizeImages(images);
                    const normalizedFiles = this.normalizeFiles(files);
                    const rev = { content: text, images: normalized, files: normalizedFiles, createdAt: Date.now() };
                    if (!Array.isArray(userMsg.revisions)) userMsg.revisions = [];
                    userMsg.revisions.push(rev);
                    userMsg.activeRevision = userMsg.revisions.length - 1;
                    userMsg.content = text;
                    userMsg.images = normalized;
                    userMsg.files = normalizedFiles;

                    // Bug 修复：修改消息时，删除该消息之后的所有消息（实现分支逻辑）
                    // 用户修改消息 → 删除后续所有对话 → 从修改点重新生成
                    this.messages = this.messages.slice(0, idx + 1);
                    
                    // 创建新的助手消息（而不是复用旧的）
                    const att = { id: uid('a'), content: '', reasoning: '', pending: true, createdAt: Date.now() };
                    pending = {
                        id: uid('a'),
                        role: 'assistant',
                        content: '',
                        reasoning: '',
                        pending: true,
                        createdAt: Date.now(),
                        attempts: [att],
                        activeAttempt: 0
                    };
                    this.messages.push(pending);
                }
                this.editingMsgId = null;
            } else {
                const normalized = this.normalizeImages(images);
                const normalizedFiles = this.normalizeFiles(files);
                const userMsg = {
                    id: uid('u'),
                    role: 'user',
                    content: text,
                    images: normalized,
                    files: normalizedFiles,
                    createdAt: Date.now(),
                    revisions: [{ content: text, images: normalized, files: normalizedFiles, createdAt: Date.now() }],
                    activeRevision: 0
                };
                this.messages.push(userMsg);
                if (!conv.title || conv.title === '新对话') {
                    conv.title = this.deriveTitle(text, images.length + files.length);
                }
            }

            if (!pending) {
                const att = { id: uid('a'), content: '', reasoning: '', pending: true, createdAt: Date.now() };
                pending = {
                    id: uid('a'),
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    pending: true,
                    createdAt: Date.now(),
                    attempts: [att],
                    activeAttempt: 0
                };
                this.messages.push(pending);
            }

            this.draft = '';
            this.draftImages = [];
            this.draftFiles = [];
            this.imageWarn = '';
            // 发送时把当前挡位回写会话：旧版本创建的会话 thinkingLevel 为空，
            // 不补这一次的话，下次进入该会话 applyThinking 会按布尔折算回默认挡
            // （用户感觉"设置的挡位过一会儿/重进会话就没了"）。
            const thinkNow = thinkingFields(this.effectiveModelId(), this.thinkingLevel);
            conv.thinkingLevel = thinkNow.thinkingLevel;
            conv.thinking = thinkNow.thinking;
            conv.updatedAt = Date.now();
            await this.persistConversation(conv);
            await saveMessages(convId, this.messages);
            this.$forceUpdate();
            // 新消息发出：恢复流式跟随（用户此前可能手动回看过）
            this.resumeFollow();
            this.scrollToBottom();

            await this.generate(conv, convId, seq, pending.id);
        },

        async generate(conv, convId, seq, pendingId, forceThinking = false) {
            this.sending = true;
            this.streamToken = null;
            try {
                let apiMessages = await buildMessages(this.messages, this.settings.systemPrompt);
                // 云控 limits.maxHistoryMessages：只带最近 N 条历史（system 提示词始终保留）。
                // 不在这里二次钳制上限：N 多大由云控决定，超出模型上下文的部分由服务端自动截断；
                // 本地只保证 tailCount >= 1（maxHistory=0 语义是"只发当前消息"，不能切空）。
                const maxHistory = controlLimit(this.control, 'maxHistoryMessages');
                const hasSystem = !!(apiMessages[0] && apiMessages[0].role === 'system');
                const head = hasSystem ? [apiMessages[0]] : [];
                const tailCount = Math.max(1, maxHistory);
                if (apiMessages.length - head.length > tailCount) {
                    apiMessages = head.concat(apiMessages.slice(apiMessages.length - tailCount));
                }

                // 配对模式：临期先刷新设备令牌（未配对返回 null，走旧行为）
                const auth = await this.ensureFreshAuth();

                // 每次发送记一行上下文：失败时日志里能看到「哪条会话、哪个模型、
                // 什么挡位、带了多少历史」，不必再靠用户复述
                appLog('[chat] 发送 conv=' + convId +
                    ' model=' + (this.settings.openaiModelId || '(默认)') +
                    ' thinking=' + (this.featThinking ? (this.thinkingLevel || '(默认)') : '关') +
                    ' search=' + (this.featSearch && conv.search === true ? '开' : '关') +
                    ' history=' + apiMessages.length +
                    ' mode=' + (this.settings.backendMode || 'custom') +
                    ' paired=' + (auth ? '是' : '否'));

                const opts = {
                    baseUrl: this.apiBaseUrl,
                    apiKey: this.settings.apiKey,
                    modeKey: conv.mode,
                    messages: apiMessages,
                    // 思考挡位：字符串挡位直传；云控关闭深度思考时强制按 false（关）
                    // 下发，避免旧会话残留挡位。forceThinking（#12 空回复重试）按默认挡。
                    thinking: this.featThinking ? (forceThinking ? true : this.thinkingLevel) : false,
                    search: this.featSearch && conv.search === true,
                    authMode: this.settings.authMode,
                    backendMode: this.settings.backendMode,
                    modelId: this.settings.openaiModelId || '',
                    conversationId: convId,
                    timeout: Math.max(10, controlLimit(this.control, 'requestTimeoutSec')) * 1000,
                    auth,
                    // 联网搜索工具（自定义端点模式）执行时需要网关凭证：
                    // settings 提供网关地址与配对材料，persist 用于保存静默注册的令牌
                    settings: this.settings,
                    persistSettings: () => saveSettings(this.settings)
                };

                // 流式（SSE）始终启用：逐字输出是设备上唯一可接受的体验，
                // 非流式要等整段生成完才出字（开关已移除，见 store.js）
                const res = await chatStream(opts, {
                    isCancelled: () => seq !== this.reqSeq || convId !== this.activeId,
                    onToken: (token) => { this.streamToken = token; },
                    onDelta: (delta) => {
                        if (seq !== this.reqSeq || convId !== this.activeId) return
                        const m = this.messages.find((x) => x.id === pendingId);
                        if (!m) return
                        const att = m.attempts && m.attempts[m.activeAttempt];
                        if (att) {
                            att.content = (att.content || '') + delta;
                            m.content = att.content;
                        } else {
                            m.content = (m.content || '') + delta;
                        }
                        // 实时清洗内部标签，避免用户看到协议标签
                        if (m.content) {
                            const cleaned = stripInternalTags(m.content);
                            if (cleaned !== m.content) {
                                if (att) att.content = cleaned;
                                m.content = cleaned;
                            }
                        }
                        this.streamLayoutTick(m);
                        this.scheduleRender();
                    },
                    onReasoning: (delta) => {
                        if (seq !== this.reqSeq || convId !== this.activeId) return
                        const m = this.messages.find((x) => x.id === pendingId);
                        if (!m) return
                        const att = m.attempts && m.attempts[m.activeAttempt];
                        if (att) {
                            att.reasoning = (att.reasoning || '') + delta;
                            m.reasoning = att.reasoning;
                        } else {
                            m.reasoning = (m.reasoning || '') + delta;
                        }
                        this.streamLayoutTick(m);
                        this.scheduleRender();
                    },
                    // 联网搜索工具卡片：start 追加 running 卡片，done 更新为完成态
                    // （每次整体替换数组引用，配合 scheduleRender 全量重绘保证响应式）
                    onToolCall: (ev) => {
                        if (seq !== this.reqSeq || convId !== this.activeId) return
                        const m = this.messages.find((x) => x.id === pendingId);
                        if (!m) return
                        const arr = Array.isArray(m.toolCalls) ? m.toolCalls.slice() : [];
                        if (ev.phase === 'start') {
                            arr.push({ kind: ev.kind || 'search', title: ev.title || '', status: 'running' });
                        } else if (ev.phase === 'done') {
                            for (let i = arr.length - 1; i >= 0; i--) {
                                if (arr[i].status === 'running') {
                                    arr[i] = Object.assign({}, arr[i], { status: 'done', count: ev.count || 0, durationMs: ev.durationMs || 0 });
                                    break
                                }
                            }
                        }
                        m.toolCalls = arr;
                        this.scheduleRender();
                    },
                    // 旧版纯文本工具状态（已被卡片替代，保留兼容旧 service 事件）
                    onToolStatus: (text) => {
                        if (seq !== this.reqSeq || convId !== this.activeId) return
                        const m = this.messages.find((x) => x.id === pendingId);
                        if (!m) return
                        m.toolStatus = text;
                        this.scheduleRender();
                    }
                });

                if (seq !== this.reqSeq || convId !== this.activeId) {
                    return
                }

                // 上游限流：**立即停止，不做任何自动重试/续发**。
                // 后端此时已让账号进入退避窗口；应用侧再自动发一次，就等于把
                // 退避白等（bug 1：连续请求会被上游升级为禁言）。
                if (res && res.rateLimited) {
                    appLog('[generate] 上游限流，停止自动重试（' + (res.content || '') + '）');
                    const rm = this.messages.find((x) => x.id === pendingId);
                    if (rm) {
                        const rAtt = rm.attempts && rm.attempts[rm.activeAttempt];
                        if (rAtt) {
                            rAtt.pending = false;
                            rAtt.error = res.content || '上游限流，请稍后再试';
                        }
                        rm.pending = false;
                        rm.error = res.content || '上游限流，请稍后再试';
                    }
                    this.$forceUpdate();
                    return
                }

                // #12：思考关闭时返回空内容，自动按"默认思考挡"重试一次。
                // thinking=OFF 是唯一返回空内容的场景（疑似 DeepSeek 服务端兼容问题），
                // 自动回退保证用户总能拿到回复；根因以诊断日志持续观察。
                if (res && !res.content && !res.reasoning && this.thinkingLevel === 'none' && !forceThinking) {
                    appLog('[generate] 思考关闭返回空内容（mode=' + conv.mode + ' search=' + conv.search + '），自动以思考模式重试 #12');
                    return await this.generate(conv, convId, seq, pendingId, true)
                }

                // #9：会话自动命名——DeepSeek 在会话首条消息时下发自动生成的标题
                // （dsTitle，与 thinking/search 开关无关），用它替换本地截断的标题
                const convNow = this.conversations.find((c) => c.id === convId);
                if (res && res.dsTitle && convNow) {
                    const isFirstRound = this.messages.filter((x) => x.role === 'user').length <= 1;
                    const t = String(res.dsTitle).trim();
                    if (t && isFirstRound && convNow.title !== t) {
                        convNow.title = t.slice(0, 30);
                        await this.persistConversation(convNow);
                        debugLog('[generate] 会话自动命名 len=' + convNow.title.length);
                    }
                }
                // 云端会话 id（后端随流末尾下发）：记下来，同步时按 id 去重，
                // 本机这条对话就不会被当成"云端还有一条新的"重复导入（bug 3）
                if (res && res.dsSessionId && convNow && convNow.cloudId !== res.dsSessionId) {
                    convNow.cloudId = res.dsSessionId;
                    convNow.cloudLinked = true;
                    convNow.cloudLoaded = true;
                    await this.persistConversation(convNow);
                    }

                const m = this.messages.find((x) => x.id === pendingId);
                if (m) {
                    const att = m.attempts && m.attempts[m.activeAttempt];
                    if (att) {
                        att.content = res.content;
                        att.reasoning = res.reasoning;
                        att.pending = false;
                    }
                    m.content = res.content;
                    m.reasoning = res.reasoning;
                    m.pending = false;
                    // 定稿：切换为含完整内容指纹的行 key，强制重建父气泡和 Markdown 子树。
                    this.bumpLayout(m);
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
                    });
                }
            } catch (e) {
                if (seq !== this.reqSeq || convId !== this.activeId) return
                const msg = e && e.message ? e.message : '发生未知错误，请重试';
                // 聊天失败必须进应用日志：用户提交反馈时日志是唯一现场
                // （console.error 在设备上不可见，此前反馈里完全没有聊天错误记录）
                appLogError('chat', e, 'model=' + (this.settings && this.settings.openaiModelId || '(默认)') +
                    ' search=' + (conv.search === true) + ' thinking=' + this.thinkingLevel)
                // 账号异常取证：只记"上游真的限制了这个账号"（禁言/封禁/空 SSE）。
                // 401/未认证不算——那多半是本机后端没起来或 key 失配，记进来会把
                // 用户和后续排查都引向"换账号"（bug 4）。
                // 账号模式暂停后没有账号可取证，避免把第三方端点的错误混进来。
                if (BUILTIN_AUTH_ENABLED && isAccountSuspension(msg)) {
                    recordAccountTrouble('对话', msg);
                }
                // 限流单独标记在消息上：重试按钮据此拦截，不再向已退避的后端发请求（bug 1）
                const errCode = e && e.code ? String(e.code) : '';
                const rateLimited = isRateLimitedError(e);
                const m = this.messages.find((x) => x.id === pendingId);
                if (m) {
                    const att = m.attempts && m.attempts[m.activeAttempt];
                    if (att) {
                        att.pending = false;
                        att.error = msg;
                        att.errorCode = rateLimited ? 'upstream_rate_limited' : errCode;
                    }
                    m.pending = false;
                    m.error = msg;
                    m.errorCode = rateLimited ? 'upstream_rate_limited' : errCode;
                    this.bumpLayout(m);
                } else {
                    this.messages.push({
                        id: pendingId,
                        role: 'assistant',
                        content: '',
                        pending: false,
                        error: msg,
                        errorCode: rateLimited ? 'upstream_rate_limited' : errCode,
                        createdAt: Date.now(),
                        attempts: [{ id: pendingId, content: '', pending: false, error: msg, errorCode: rateLimited ? 'upstream_rate_limited' : errCode, createdAt: Date.now() }],
                        activeAttempt: 0
                    });
                }
            } finally {
                if (this.streamToken) {
                    stopStream(this.streamToken);
                    this.streamToken = null;
                }
                this.sending = false;
                // 只有仍然停留在原会话时才保存，避免切换会话后把新会话内容写进旧会话
                if (seq === this.reqSeq && convId === this.activeId) {
                    await saveMessages(convId, this.messages);
                    // 本地落盘后异步备份到上游（失败静默，不影响聊天体验）
                    this.queueCloudSync(conv, this.messages);
                }
                // 结束前把节流的渲染补上（流式期间可能还有一帧没落地）
                this.flushRender();
                this.remountTallMessagesSoon();
            }
        },

        async retryMessage(m) {
            if (this.sending) return
            const conv = this.activeConversation();
            if (!conv) return
            if (!m || m.role !== 'assistant') return
            // 上游限流期间点「重试」= 再发一次请求，正是把限流升级成禁言的动作（bug 1）。
            // 后端已让账号退避，这里直接拦住并说明原因，不再向后端发请求。
            if (isRateLimitedError({ code: m.errorCode, message: m.error })) {
                this.imageWarn = '上游正在限流：请等待一段时间再重试（连续请求会导致账号被禁言）';
                this.$forceUpdate();
                return
            }

            // 不覆盖旧回复：在当前助手气泡上新增一次生成尝试
            const att = { id: uid('a'), content: '', reasoning: '', pending: true, createdAt: Date.now() };
            if (!Array.isArray(m.attempts)) m.attempts = [];
            m.attempts.push(att);
            m.activeAttempt = m.attempts.length - 1;
            m.content = '';
            m.reasoning = '';
            m.error = '';
            m.pending = true;
            this.bumpLayout(m);
            const seq = ++this.reqSeq;
            const convId = conv.id;
            conv.updatedAt = Date.now();
            await this.persistConversation(conv);
            await saveMessages(convId, this.messages);
            this.$forceUpdate();
            // 重试同样恢复流式跟随
            this.resumeFollow();
            this.scrollToBottom();
            await this.generate(conv, convId, seq, m.id);
        },

        editMessage(m) {
            if (this.sending) return
            this.editingMsgId = m.id;
            // 保留已算好的 dataUrl，避免重新压缩；没有则回到待处理状态
            this.draftImages = (m.images || []).map((i) => ({
                name: i.name,
                path: i.path,
                dataUrl: i.dataUrl || null,
                pending: i.dataUrl ? Promise.resolve(i.dataUrl) : null
            }));
            this.draftFiles = (m.files || []).map((f) => ({
                name: f.name,
                path: f.path,
                size: f.size || 0,
                mime: f.mime || '',
                dataUrl: f.dataUrl || null
            }));
            // Bug 4 修复：设置 draft，点击输入框时 openInput 会把 draft 作为预填充文本
            // 传给系统输入法（contents 字段），用户能直接看到并编辑原文
            this.draft = m.content || '';
            this.$forceUpdate();
            // 自动滚动到底部，确保用户看到编辑提示条
            this.scrollToBottom();
        },
        cancelEdit() {
            this.editingMsgId = null;
            this.draft = '';
            this.draftImages = [];
            this.draftFiles = [];
            this.$forceUpdate();
        },

        stopGeneration() {
            this.reqSeq += 1;
            if (this.streamToken) {
                stopStream(this.streamToken);
                this.streamToken = null;
            }
            const pendingMsg = this.messages.find((x) => x.pending);
            if (pendingMsg) {
                // 保留已生成的部分内容，标记为完成而不是直接抹掉
                const att = pendingMsg.attempts && pendingMsg.attempts[pendingMsg.activeAttempt];
                if (att) att.pending = false;
                pendingMsg.pending = false;
                if (pendingMsg.error) pendingMsg.error = '';
            }
            this.sending = false;
            this.$forceUpdate();
            this.saveCurrentMessages();
        },

        // ---------- 思考过程折叠 ----------
        isReasoningCollapsed(id) {
            if (this.collapsedReasoning[id] !== undefined) return this.collapsedReasoning[id]
            return !(this.settings && this.settings.defaultExpandThinking)
        },
        toggleReasoning(id) {
            this.collapsedReasoning[id] = !this.isReasoningCollapsed(id);
            this.$forceUpdate();
        },

        // 工具卡片文案：进行中/完成两种状态（纯 CJK+ASCII+标点「」·，无特殊符号）
        toolCardText(tc) {
            const t = String(tc.title || '').trim();
            const shown = t.length > 40 ? t.slice(0, 40) + '…' : t;
            if (tc.status === 'running') {
                return (tc.kind === 'fetch' ? '正在抓取网页' : '正在搜索') + (shown ? ' 「' + shown + '」…' : '…');
            }
            const ms = Number(tc.durationMs) || 0;
            const dur = ms >= 1000 ? (ms / 1000).toFixed(1) + ' 秒' : ms + ' 毫秒';
            if (tc.kind === 'fetch') return '已抓取网页' + (shown ? ' 「' + shown + '」' : '') + ' · ' + dur;
            return '已搜索' + (shown ? ' 「' + shown + '」' : '') + (tc.count ? ' · ' + tc.count + ' 条结果' : '') + ' · ' + dur;
        },

        // ---------- 图片 ----------
        async openPicker() {
            cancelThumbJobs();
            const loadSeq = ++this.albumLoadSeq;
            this.showPicker = true;
            this.albumLoading = true;
            this.albumError = '';
            this.albumImages = [];
            this.$forceUpdate();
            try {
                const list = await listAlbum();
                // 如果用户已经进入相机/关闭相册，旧任务只退出，不再触发任何更新。
                if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                // 逐张后台生成缩略图（原图 12MP 直接进 image 会堵死渲染线程，
                // 真机表现为相册浮层全黑）：每张就绪立即刷新，列表渐进显示。
                this.albumImages = list;
                this.albumLoading = false;
                this.$forceUpdate();
                for (const img of list) {
                    if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                    const thumb = await ensureThumb(img.path);
                    if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                    if (thumb !== img.path) {
                        const item = this.albumImages.find((i) => i.path === img.path);
                        if (item) {
                            item.thumb = thumb;
                            this.$forceUpdate();
                        }
                    }
                }
            } catch (e) {
                appLogError('album.load', e);
                if (loadSeq !== this.albumLoadSeq || !this.showPicker) return
                this.albumError = e && e.message ? e.message : '无法访问相册';
                this.albumLoading = false;
            }
            if (loadSeq === this.albumLoadSeq && this.showPicker) this.$forceUpdate();
        },
        closePicker() {
            cancelThumbJobs();
            ++this.albumLoadSeq;
            this.showPicker = false;
            this.$forceUpdate();
        },
        pickImage(img) {
            cancelThumbJobs();
            ++this.albumLoadSeq;
            this.addDraftImage(img.name, img.path);
            this.showPicker = false;
            this.$forceUpdate();
        },
        // ---------- 文件附件：浏览器式选择，从 /userdisk 逐级进入 ----------
        async openFilePicker() {
            if (!this.canUploadFile) return
            this.showFilePicker = true;
            // 每次打开都回到用户盘根，路径状态不跨会话残留
            await this.loadFileDir(this.fileRoot);
        },
        fileParentDir(dir) {
            const p = String(dir || '').replace(/\/+$/, '').replace(/\/[^/]*$/, '')
            return p || this.fileRoot
        },
        async loadFileDir(dir) {
            const loadSeq = ++this.fileLoadSeq;
            this.fileDir = dir;
            this.fileLoading = true;
            this.fileError = '';
            this.fileEntries = [];
            this.$forceUpdate();
            try {
                const list = await browseDeviceDir(dir);
                if (loadSeq !== this.fileLoadSeq || !this.showFilePicker) return
                if (dir !== this.fileRoot) {
                    // 「返回上一级」伪条目：复用文件行模板，整行点击回退
                    list.unshift({ name: '返回上一级', path: this.fileParentDir(dir), isDir: true, isUp: true })
                }
                this.fileEntries = list;
            } catch (e) {
                appLogError('files.list', e, 'dir=' + dir);
                if (loadSeq !== this.fileLoadSeq || !this.showFilePicker) return
                this.fileError = e && e.message ? e.message : '无法访问目录';
            } finally {
                if (loadSeq === this.fileLoadSeq) this.fileLoading = false;
            }
            if (loadSeq === this.fileLoadSeq && this.showFilePicker) this.$forceUpdate();
        },
        pickEntry(entry) {
            if (!entry) return
            if (entry.isUp) {
                this.upFileDir();
                return
            }
            if (entry.isDir) {
                this.loadFileDir(entry.path);
                return
            }
            this.pickFile(entry);
        },
        upFileDir() {
            if (this.fileDir === this.fileRoot || !this.fileDir) return
            this.loadFileDir(this.fileParentDir(this.fileDir));
        },
        closeFilePicker() {
            ++this.fileLoadSeq;
            this.showFilePicker = false;
            this.$forceUpdate();
        },
        addDraftFile(file) {
            if (!file || !file.path) return
            if (this.draftFiles.some((f) => f.path === file.path)) return
            if (this.draftFiles.length >= MAX_ATTACH_COUNT) {
                this.imageWarn = '单条消息最多 ' + MAX_ATTACH_COUNT + ' 个文件';
                this.$forceUpdate();
                return
            }
            if (file.size > MAX_ATTACH_BYTES) {
                this.imageWarn = '文件超过 ' + this.fileSizeText(MAX_ATTACH_BYTES) + '，已忽略';
                this.$forceUpdate();
                return
            }
            this.draftFiles.push({
                name: file.name,
                path: file.path,
                size: file.size || 0,
                mime: file.mime || ''
            });
            this.imageWarn = '';
            this.$forceUpdate();
        },
        pickFile(file) {
            ++this.fileLoadSeq;
            this.showFilePicker = false;
            this.addDraftFile(file);
            this.$forceUpdate();
        },
        removeDraftFile(i) {
            this.draftFiles.splice(i, 1);
            if (!this.draftFiles.length && !this.draftImages.length) this.imageWarn = '';
            this.$forceUpdate();
        },
        // ---------- 相机取景浮层（对齐手机选图体验：预览 → 快门 → 裁剪 → 待发）----------
        async openCamera() {
            if (this.showCamera || this.showConfirm) return
            // 先使相册缩略图任务失效；否则每张图完成时都会在相机层上方
            // 继续触发整页 forceUpdate，导致触摸事件排队。
            cancelThumbJobs();
            ++this.albumLoadSeq;
            this.showPicker = false;
            this.camError = '';
            this.previewFrame = '';
            this.previewMode = '';
            this.showCamera = true;
            this.$forceUpdate();
            // 让相机层先提交一次布局，再启动 native 取景管道；避免点击回调里
            // 同步叠加相册卸载、历史消息重排和相机初始化。
            setTimeout(() => {
                if (this.showCamera && !this.showConfirm) this.startCameraPreview();
            }, 0);
        },
        // 使用已验证可见的 JPEG 帧循环（~7fps）；不把 kmssink 进程存活误判为画面可见
        async startCameraPreview() {
            const mode = await startPreview((jpg) => {
                this.previewFrame = 'file://' + jpg;
                this.$forceUpdate();
            });
            if (mode === 'dead') return // 期间已被关闭/重启，丢弃
            this.previewMode = mode;
            debugLog('[camera] preview mode=' + mode);
            this.$forceUpdate();
        },
        // 拍照失败后的取景重启，与正常启动共用 active 状态。
        restartFramePreview() {
            this.startCameraPreview();
        },
        // backToPicker=true（取景页 ×）：回相册选择页；false（确认页确认后）：回主聊天页
        closeCamera(backToPicker) {
            this.showCamera = false;
            this.showConfirm = false;
            this.previewFrame = '';
            this.previewMode = '';
            this.camError = '';
            stopPreview();
            if (backToPicker) {
                // 回相册选择页（openPicker 自带重载列表）
                this.openPicker();
            }
            this.$forceUpdate();
        },
        // 快门：抓一帧 → 确认浮层（可拖框裁剪，勾收进待发 / 环形箭头重拍）
        async shoot() {
            if (this.takingPhoto || !this.showCamera) return
            this.takingPhoto = true;
            this.camError = '';
            this.$forceUpdate();
            try {
                // 取景与拍照共用 video29，必须先暂停帧循环避免相机节点冲突
                if (this.previewMode === 'frames') stopFramePreview();
                const r = await capturePhoto();
                if (!r.ok) {
                    // 失败提示必须可见：视频 plane 在 UI 之上会盖住提示，
                    // 先停预览露出黑底+提示，2.5 秒后按原模式自动恢复取景
                    const wasFrames = this.previewMode === 'frames';
                    stopPreview();
                    this.camError = r.error || '拍照失败';
                    if (this._errTimer) clearTimeout(this._errTimer);
                    this._errTimer = setTimeout(() => {
                        if (!this.showCamera || this.showConfirm) return
                        if (wasFrames) this.restartFramePreview();
                        else this.startCameraPreview();
                    }, 2500);
                    return
                }
                // 进确认页（JPEG 黑底浮层）：预览没用了，停掉省电
                stopPreview();
                this.confirmPath = r.path;
                // 确认页用 640 宽小图预览（全图解码会堵渲染线程）
                this.confirmSrc = 'file://' + (r.preview || r.path);
                this.resetCropBox();
                this.showConfirm = true;
            } catch (e) {
                appLogError('camera.capture', e);
                this.camError = (e && e.message) || '拍照失败';
            } finally {
                this.takingPhoto = false;
                this.$forceUpdate();
            }
        },
        // 确认：把屏幕上的裁剪框映射回源图像素（1920x768 带），裁剪后收进待发，回主聊天页
        async confirmShot() {
            if (this.takingPhoto) return
            this.takingPhoto = true;
            this.$forceUpdate();
            try {
                const disp = this.dispRect;
                const b = this.clampCropBox(this.cropBox);
                const sx = (b.x - disp.x) * PHOTO_W / disp.w;
                const sy = (b.y - disp.y) * PHOTO_H / disp.h;
                const sw = b.w * PHOTO_W / disp.w;
                const sh = b.h * PHOTO_H / disp.h;
                const path = await cropFrame(this.confirmPath, { x: sx, y: sy, w: sw, h: sh });
                const name = String(path).split('/').pop();
                this.addDraftImage(name, path);
                this.closeCamera(false);
            } finally {
                this.takingPhoto = false;
                this.$forceUpdate();
            }
        },
        // 重拍：关确认浮层回取景（重启取景）
        retakeShot() {
            this.showConfirm = false;
            this.confirmSrc = '';
            this.confirmPath = '';
            this.camError = '';
            this.$forceUpdate();
            this.startCameraPreview();
        },
        // ===== 裁剪框（官方同款：一个可拖可缩的白框，取代旧"比例循环"）=====
        // 真机实测（2026-09-26 事件日志取证）：Falcon 的 touch 事件对象顶层有
        // changedTouches[0]，其中 **screenX/screenY 是绝对页面坐标（936x280
        // 横屏空间，与布局一一对应）**，pageX/pageY 是**元素相对**坐标——
        // 拖动中元素跟着动，用 page 系算增量会自相抵消，必须用 screen 系。
        // 偶发杂散事件（坐标跳到几百 px 外）用跳变保护忽略。
        extractTouchXY(e) {
            let d = e;
            if (d && d.data !== undefined && d.data !== null) d = d.data;
            const cands = [];
            if (d && typeof d === 'object') {
                if (d.changedTouches && d.changedTouches.length) cands.push(d.changedTouches[0]);
                if (d.touches && d.touches.length) cands.push(d.touches[0]);
                cands.push(d);
                if (d.touch && typeof d.touch === 'object') cands.push(d.touch);
            }
            for (let i = 0; i < cands.length; i++) {
                const t = cands[i];
                if (!t || typeof t !== 'object') continue
                // screen 系优先（绝对坐标）；page/client 系仅作兜底
                const x = t.screenX !== undefined ? t.screenX : (t.pageX !== undefined ? t.pageX : (t.clientX !== undefined ? t.clientX : (t.x !== undefined ? t.x : null)));
                const y = t.screenY !== undefined ? t.screenY : (t.pageY !== undefined ? t.pageY : (t.clientY !== undefined ? t.clientY : (t.y !== undefined ? t.y : null)));
                if (x !== null && y !== null) return { x: x, y: y }
            }
            return null
        },
        cropTouchStart(mode, e) {
            const p = this.extractTouchXY(e);
            if (!this._cropTouchLogged) {
                this._cropTouchLogged = true;
            }
            if (!p) return
            this.cropDrag = { mode: mode, x: p.x, y: p.y };
        },
        cropTouchMove(e) {
            const drag = this.cropDrag;
            if (!drag || !drag.mode) return
            const p = this.extractTouchXY(e);
            if (!p) return
            const dx = p.x - drag.x;
            const dy = p.y - drag.y;
            if (dx === 0 && dy === 0) return
            // 杂散事件保护：单次增量超过半屏基本是引擎毛刺，只重新锚定不移动
            if (Math.abs(dx) > 468 || Math.abs(dy) > 280) {
                this.cropDrag = { mode: drag.mode, x: p.x, y: p.y };
                return
            }
            this.cropDrag = { mode: drag.mode, x: p.x, y: p.y };
            this.applyCropDelta(dx, dy);
        },
        cropTouchEnd() {
            this.cropDrag = { mode: '', x: 0, y: 0 };
        },
        applyCropDelta(dx, dy) {
            const b = this.cropBox;
            const m = this.cropDrag.mode;
            if (m === 'move') {
                this.cropBox = this.clampCropBox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
                return
            }
            // 角缩放：固定对角，动被拖的角。min 尺寸 ~ 屏幕上 60x40（≈源图 123x82，够发图用）
            const disp = this.dispRect;
            const minW = 60;
            const minH = 40;
            let x = b.x;
            let y = b.y;
            let w = b.w;
            let h = b.h;
            if (m === 'tl' || m === 'bl') {
                const nx = Math.max(disp.x, Math.min(b.x + dx, b.x + b.w - minW));
                w = b.w + (b.x - nx);
                x = nx;
            } else if (m === 'tr' || m === 'br') {
                w = Math.min(disp.x + disp.w - b.x, Math.max(minW, b.w + dx));
            }
            if (m === 'tl' || m === 'tr') {
                const ny = Math.max(disp.y, Math.min(b.y + dy, b.y + b.h - minH));
                h = b.h + (b.y - ny);
                y = ny;
            } else if (m === 'bl' || m === 'br') {
                h = Math.min(disp.y + disp.h - b.y, Math.max(minH, b.h + dy));
            }
            this.cropBox = { x: x, y: y, w: w, h: h };
        },
        clampCropBox(b) {
            const disp = this.dispRect;
            const minW = 60;
            const minH = 40;
            let w = Math.min(Math.max(b.w, minW), disp.w);
            let h = Math.min(Math.max(b.h, minH), disp.h);
            let x = Math.max(disp.x, Math.min(b.x, disp.x + disp.w - w));
            let y = Math.max(disp.y, Math.min(b.y, disp.y + disp.h - h));
            return { x: x, y: y, w: w, h: h }
        },
        resetCropBox() {
            const disp = this.dispRect;
            // 默认框就是照片实际显示区域；用户不调整时确认结果等同于原图。
            // 之前缩进到 92% 会在四周留下未选中的边，和照片边框不贴合。
            this.cropBox = { x: disp.x, y: disp.y, w: disp.w, h: disp.h };
        },
        // 裁剪框外的四块半透明遮罩（上/下/左/右），聚焦框内区域
        cropMaskStyle(pos) {
            const W = this.stageW;
            const H = this.stageH;
            const b = this.clampCropBox(this.cropBox);
            if (pos === 'top') return { left: '0px', top: '0px', width: W + 'px', height: Math.max(0, b.y) + 'px' }
            if (pos === 'bottom') return { left: '0px', top: (b.y + b.h) + 'px', width: W + 'px', height: Math.max(0, H - b.y - b.h) + 'px' }
            if (pos === 'left') return { left: '0px', top: b.y + 'px', width: Math.max(0, b.x) + 'px', height: b.h + 'px' }
            return { left: (b.x + b.w) + 'px', top: b.y + 'px', width: Math.max(0, W - b.x - b.w) + 'px', height: b.h + 'px' }
        },
        // 四角 L 形手柄：以角为中心的小方块，拖动改变对应角
        cropHandleStyle(corner) {
            const b = this.clampCropBox(this.cropBox);
            const s = 36;
            const cx = corner === 'tl' || corner === 'bl' ? b.x : b.x + b.w;
            const cy = corner === 'tl' || corner === 'tr' ? b.y : b.y + b.h;
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
            this.imageWarn = '';
            if (this.draftImages.some((i) => i.path === path)) return
            // 云控 limits.maxImageCount：单条消息图片数上限（0 = 不允许带图）
            const cap = this.imageLimit;
            if (cap <= 0 || this.draftImages.length >= cap) {
                this.imageWarn = cap <= 0
                    ? '服务端已关闭图片输入'
                    : ('单条消息最多 ' + cap + ' 张图片，已忽略新增');
                this.$forceUpdate();
                return
            }
            const item = { name, path, dataUrl: null, pending: null };
            item.pending = readImageDataUrl(path)
                .then((du) => {
                    item.dataUrl = du || null;
                    if (!item.dataUrl) this.setImageWarn();
                    this.$forceUpdate();
                })
                .catch((e) => {
                    appLogError('image.read', e, 'path=' + path);
                    item.dataUrl = null;
                    this.setImageWarn();
                });
            this.draftImages.push(item);
            this.$forceUpdate();
        },
        setImageWarn() {
            // 单图上限 900KB（见 images.js）：超过就不随消息发送，提示用户换一张
            this.imageWarn = '部分图片过大，无法发送（已跳过）';
            this.$forceUpdate();
        },
        // 把待发图片规整为存进消息的形态：等待预压缩完成，携带 dataUrl。
        // 没有 dataUrl 的一律丢弃——把几 MB 原图内联进消息会把设备内存打爆（bug 2）。
        normalizeImages(images) {
            return images
                .map((i) => ({ name: i.name, path: i.path, dataUrl: i.dataUrl || null }))
                .filter((i) => !!i.dataUrl)
        },
        // 文件只落元数据，不落 base64：buildMessages 在真正发送时按 path 现读，
        // 避免 PDF 的 data URL 跟着会话 JSON 一起反复序列化。
        normalizeFiles(files) {
            return files.map((f) => ({
                name: f.name,
                path: f.path,
                size: f.size || 0,
                mime: f.mime || ''
            }))
        },
        removeDraftImage(i) {
            this.draftImages.splice(i, 1);
            if (!this.draftImages.length) this.imageWarn = '';
            this.$forceUpdate();
        },

        // ---------- 其他 ----------
        goSettings() {
            $falcon.navTo('settings');
        },
        // 长回复（尤其带表格）比视口高：此时把"消息上沿"对齐视口顶部只能看到
        // 开头，下半截留在视口外——用户看到的就是"气泡被截断、显示不全"。
        // 这类消息改锚内容末尾（引擎把滚动量钳到最大，等价于滚到底）。
        // 视口约 225px（936x280 屏，消息区 ~8 行）：300 字/表格/多张工具卡片
        // 都可能超，取保守阈值，宁可多滚到底也不要停在半截。
        isTallMessage(m) {
            return isMessageTall(m)
        },
        messageRenderKey(m) {
            return buildMessageRenderKey(m)
        },
        scrollToBottom(force = false) {
            // 空态/无消息绝不滚动：anchor 不渲染（v-if），且短内容滚到底会把
            // 仅有的几条消息滚出视口（Falcon scrollToElement 是"锚点对齐视口上沿"）
            if (!this.messages || !this.messages.length) return
            // 合并重复请求：锚点元素固定，多次排队滚动只在最后一帧有意义
            if (this._scrollTimer) {
                if (!force) return
                clearTimeout(this._scrollTimer);
            }
            const self = this;
            this._scrollTimer = setTimeout(() => {
                self._scrollTimer = null;
                try {
                    if (!self.$page || !self.$page.$dom) return
                    // 长回复/表格锚到内容末尾；短消息锚到最后消息行，避免滚过头。
                    const last = self.chatMessages[self.chatMessages.length - 1];
                    const tall = self.isTallMessage(last);
                    const ref = (!tall && last) ? self.$refs['msg-' + last.id] : null;
                    const el = ref && (Array.isArray(ref) ? ref[ref.length - 1] : ref);
                    if (el) {
                        self.$page.$dom.scrollToElement(el);
                    } else if (self.$refs.bottom) {
                        self.$page.$dom.scrollToElement(self.$refs.bottom);
                    }
                } catch (e) {
                    /* 忽略 */
                }
            }, 50);
        },

        // ---------- 流式滚动跟随 ----------
        // 旧行为的问题：流式期间每个渲染 tick 都强制 scrollToElement(最后一条消息)，
        // 而 Falcon 的 scrollToElement 是"锚点对齐视口上沿"——视口被死死钉在回复
        // 开头，新内容在视口下方持续增长却永远看不见；用户手动滚动回看会被下一帧
        // 拽回去（等于锁定）。
        // 新语义（scrollFollow）：
        //   - _followStream=true（默认）：流式时把视口钉在内容末尾（bottom anchor，
        //     由引擎钳制到最大滚动量），用户始终看到正在生成的最新文字；短回复时
        //     滚动量被钳为 0，视口不动（保持旧行为）。
        //   - 用户一触摸消息区（onMsgsTouch）→ _followStream=false：停止一切自动
        //     滚动，用户自由回看；再次发送/重试/切换会话时自动恢复跟随。
        // _followStream 故意不放 data（非响应式）：它只影响滚动，不应触发重渲染。
        onMsgsTouch() {
            this._followStream = false;
        },
        resumeFollow() {
            this._followStream = true;
        },
        streamScrollTick() {
            // 用户接管滚动期间：绝不自动滚
            if (this._followStream === false) return
            if (!this.messages || !this.messages.length) return
            const last = this.chatMessages[this.chatMessages.length - 1];
            // 长回复流式中：钉到内容末尾（锚 bottom-anchor，引擎钳到最大滚动），
            // 让"正在生成"的最新行始终可见。阈值取视口可容纳的字符量级
            // （936x280 屏，消息区约 225px ≈ 8 行 ≈ 300 字，取 350 保守判断）：
            // 短回复仍走旧锚定（消息行首），避免 126px 底部留白把短气泡顶出视口。
            // 带表格/工具卡片的消息即使字数不多也可能超出视口，一并按"长回复"处理。
            if (last && last.pending && ((last.content || '').length > 350 || this.isTallMessage(last))) {
                try {
                    if (this.$page && this.$page.$dom && this.$refs.bottom) {
                        this.$page.$dom.scrollToElement(this.$refs.bottom);
                        return
                    }
                } catch (e) {
                    /* 落回旧行为 */
                }
            }
            this.scrollToBottom(true);
        },

        // ---------- 后端监控 ----------
        startBackendMonitor() {
            if (this.backendMonitor) return
            
            this.backendMonitor = createBackendMonitor({
                onDisconnect: () => {
                    debugLog('[health] 后端连接断开（页面回调）');
                    this.backendDisconnected = true;
                    this.$forceUpdate();
                    // 停止当前请求
                    if (this.sending) {
                        this.stopGeneration();
                    }
                    // 自愈：尝试重新拉起/修复后端（内部 single-flight，不会重复 restart）
                    this.ensureBackend();
                },
                onReconnect: () => {
                    debugLog('[health] 后端已重新连接（页面回调）');
                    this.backendDisconnected = false;
                    this.$forceUpdate();
                }
            }, 10000); // 每10秒检查一次
            
            this.backendMonitor.start();
        },
        
        stopBackendMonitor() {
            if (this.backendMonitor) {
                this.backendMonitor.stop();
                this.backendMonitor = null;
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
/* 思考按钮内部文字（背景/圆角/padding 在外层 div 容器上，见模板注释） */
.top-toggle-txt {
    font-size: 18px;
    color: #555555;
}
.top-toggle-txt-on {
    font-size: 18px;
    color: #ffffff;
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
/* 表格：等宽列（flex:1），表头底色，行间横线；无竖线外框，走轻线条风格。
   .md-tr 允许换行：放不下的列折到下一行，宁可表格变形也不突破气泡。
   单元格是单 text + 内联 lines（见 cellLines/cellLineCount）：嵌套 row+wrap
   里折行文本的两遍量高在这台引擎不可依赖（build 196/197 真机证伪），
   显式 lines 让文本盒子按 N 行分配，行高永远足够。 */
.md-table {
    flex-direction: column;
    margin: 4px 0;
}
.md-tr {
    flex-direction: row;
    flex-wrap: wrap;
}
.md-th {
    flex-direction: row;
    align-items: stretch;
    flex: 1;
    padding: 6px 8px;
    background-color: #f2f3f5;
    border-bottom-width: 1px;
    border-bottom-color: #dddddd;
}
.md-td {
    flex-direction: row;
    align-items: stretch;
    flex: 1;
    padding: 6px 8px;
    border-bottom-width: 1px;
    border-bottom-color: #eeeeee;
}
/* 单元格内容层：flex:1（主轴为横向）先从 td 拿到确定宽度，文字只量一次高。
   这是列表 .md-li-body 已真机验证的同一模式。 */
.md-cell-body {
    flex: 1;
    flex-direction: row;
    flex-wrap: wrap;
}
.md-th-text {
    font-size: 18px;
    line-height: 26px;
    font-weight: bold;
    color: #222222;
}
/* 表格单元格 run 变体（runClass 第三参 cell=true 输出 md-<样式>-cell）：
   Weex 仅支持单类选择器，无法用 .md-td .md-span 后代选择器；而真机两轮实证
   （build 196/197 表格截图）：单元格文本折行后父行量不出两行高，第二行被
   行边界拦腰裁掉（"Claude Fable 5.1" → "Fable" 半行）。lines:3 显式声明
   文本盒子按 3 行测量/排版，行高保证足够；超出 3 行的单元格尾部省略。
   深色变体由 spanClass→dc() 先产出 md-<样式>-dark，再追加 -cell。
   build 198 真机确认此形态表格完整（用户确认），build 200 恢复。 */
.md-span-cell,
.md-bold-cell,
.md-italic-cell,
.md-bold-italic-cell,
.md-strike-cell,
.md-link-cell,
.md-inline-code-cell,
.md-span-dark-cell,
.md-bold-dark-cell,
.md-italic-dark-cell,
.md-bold-italic-dark-cell,
.md-strike-dark-cell,
.md-link-dark-cell,
.md-inline-code-dark-cell {
    lines: 3;
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
/* 列表项正文层：单独一层、由 flex:1 拿到"剩余宽度"这个确定值。
   正文直接当 .md-li-row 的 flex 子项时，引擎先按 max-content 量高（一行），
   再按剩余宽度折行——高度不涨，第二行被 text 自身的盒子裁掉（列表项"下半行不见"）。
   flex:1 让宽度先定下来，文字只量一次。 */
.md-li-body {
    flex: 1;
    flex-direction: row;
    flex-wrap: wrap;
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
/* 联网工具卡片：跟在 reasoning 块后的搜索/抓取轨迹（官方风格） */
.tool-trail {
    margin-bottom: 8px;
}
.tool-card {
    background-color: #f6f7f9;
    border-radius: 8px;
    padding: 6px 10px;
    margin-bottom: 6px;
}
.tool-card-title {
    font-size: 15px;
    color: #1a73e8;
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

/* 消息区底部留空：右下角悬浮输入组件不遮挡最后一条消息
   （整组 94px + 底边 12px，留 126px 余量即可） */
.msgs-tail-spacer {
    height: 126px;
}

/* 待发图片：悬浮在输入组件上方，右对齐、不占通栏 */
.draft-imgs-float {
    position: absolute;
    right: 12px;
    bottom: 132px;
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
.draft-thumb-dark {
    width: 90px;
    height: 68px;
    border-radius: 8px;
    background-color: #333333;
}
/* 待发文件：窄条 + 文件名，不渲染文件图标以省内存 */
.draft-file {
    position: relative;
    width: 216px;
    height: 46px;
    margin-right: 10px;
    margin-bottom: 6px;
    padding: 7px 26px 7px 10px;
    border-radius: 8px;
    background-color: #ffffff;
    border-width: 1px;
    border-color: #dfe3e8;
    justify-content: center;
}
.draft-file-name {
    font-size: 15px;
    color: #222222;
    lines: 1;
    text-overflow: ellipsis;
}
.draft-file-size {
    font-size: 12px;
    color: #777777;
    margin-top: 2px;
}
.draft-file-remove {
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
/* 用户气泡里的文件附件 */
.msg-files {
    margin-bottom: 6px;
}
.msg-file {
    width: 252px;
    padding: 7px 10px;
    margin-bottom: 5px;
    border-radius: 8px;
    background-color: rgba(255, 255, 255, 0.78);
}
.msg-file-name {
    font-size: 15px;
    color: #222222;
    lines: 1;
    text-overflow: ellipsis;
}
.msg-file-meta {
    font-size: 12px;
    color: #666666;
    margin-top: 2px;
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
// 尺寸按 960x290 的横屏定：旧版 68px 圆钮 + 52px 文本框吃掉近一半屏高，
// 现在整组 94px 高（40 文本框 + 8 间距 + 46 圆钮），按钮不再抢视线。
.float-input {
    position: absolute;
    right: 12px;
    bottom: 12px;
    flex-direction: column;
    align-items: flex-end;
}
.float-textbox {
    /* 比按钮组（46+10+46）略宽：输入的是文字，宽一点能多看到几个字 */
    width: 168px;
    height: 40px;
    justify-content: center;
    background-color: #ffffff;
    border-radius: 10px;
    border-width: 1px;
    border-color: #dfe3e8;
    padding: 0 12px;
}
.float-btns {
    flex-direction: row;
    margin-top: 8px;
}
.float-btn {
    width: 46px;
    height: 46px;
    border-radius: 23px;
    background-color: #ffffff;
    border-width: 1px;
    border-color: #dfe3e8;
    align-items: center;
    justify-content: center;
    margin-left: 10px;
}
.float-icon-img {
    width: 24px;
    height: 24px;
}
.float-btn-send {
    width: 46px;
    height: 46px;
    border-radius: 23px;
    background-color: #1a73e8;
    align-items: center;
    justify-content: center;
    margin-left: 10px;
}
.float-btn-stop {
    width: 46px;
    height: 46px;
    border-radius: 23px;
    background-color: #d93025;
    align-items: center;
    justify-content: center;
    margin-left: 10px;
}
.input-display-text {
    font-size: 17px;
    color: #222222;
    lines: 1;
    text-overflow: ellipsis;
}
.input-display-text-ph {
    font-size: 17px;
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

/* 文件选择器：行式列表，一行放得下长文件名 */
.file-list {
    flex-direction: column;
}
.file-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 720px;
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 8px;
    background-color: #ffffff;
}
.file-row-main {
    flex: 1;
    padding-right: 10px;
}
.file-row-name {
    font-size: 17px;
    color: #222222;
    lines: 1;
    text-overflow: ellipsis;
}
.file-row-meta {
    font-size: 13px;
    color: #90a4ae;
    margin-top: 2px;
}
.file-row-add,
.file-row-action {
    font-size: 16px;
    color: #1a73e8;
    padding: 5px 10px;
    border-radius: 6px;
    background-color: #eef3ff;
}

/* 头部：标题 + 当前路径两行竖排 */
.picker-head-col {
    flex: 1;
    flex-direction: column;
    padding-right: 10px;
}
.file-path {
    font-size: 13px;
    color: #90a4ae;
    margin-top: 3px;
    lines: 1;
    text-overflow: ellipsis;
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
/* 思考按钮内部文字（暗色）：off=白字深灰底，on=黑字浅蓝底 */
.top-toggle-txt-dark {
    font-size: 18px;
    color: #ffffff;
}
.top-toggle-txt-on-dark {
    font-size: 18px;
    color: #000000;
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
.tool-trail-dark {
    margin-bottom: 8px;
}
.tool-card-dark {
    background-color: #232323;
    border-radius: 8px;
    padding: 6px 10px;
    margin-bottom: 6px;
}
.tool-card-title-dark {
    font-size: 15px;
    color: #82b1ff;
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
    right: 12px;
    bottom: 12px;
    flex-direction: column;
    align-items: flex-end;
}
.float-textbox-dark {
    /* 比按钮组（46+10+46）略宽：输入的是文字，宽一点能多看到几个字 */
    width: 168px;
    height: 40px;
    justify-content: center;
    background-color: #2a2a2a;
    border-radius: 10px;
    border-width: 1px;
    border-color: #444444;
    padding: 0 12px;
}
.float-btns-dark {
    flex-direction: row;
    margin-top: 8px;
}
.float-btn-dark {
    width: 46px;
    height: 46px;
    border-radius: 23px;
    background-color: #2a2a2a;
    border-width: 1px;
    border-color: #444444;
    align-items: center;
    justify-content: center;
    margin-left: 10px;
}
.float-icon-img-dark {
    width: 24px;
    height: 24px;
}
.float-btn-send-dark {
    width: 46px;
    height: 46px;
    border-radius: 23px;
    background-color: #82b1ff;
    align-items: center;
    justify-content: center;
    margin-left: 10px;
}
.float-btn-stop-dark {
    width: 46px;
    height: 46px;
    border-radius: 23px;
    background-color: #e05545;
    align-items: center;
    justify-content: center;
    margin-left: 10px;
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
/* 文件选择器 / 附件：深色 */
.file-list-dark {
    flex-direction: column;
}
.file-row-dark {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 720px;
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 8px;
    background-color: #252525;
}
.file-row-main-dark {
    flex: 1;
    padding-right: 10px;
}
.file-row-name-dark {
    font-size: 17px;
    color: #ffffff;
    lines: 1;
    text-overflow: ellipsis;
}
.file-row-meta-dark {
    font-size: 13px;
    color: #8ea2b5;
    margin-top: 2px;
}
.file-row-add-dark,
.file-row-action-dark {
    font-size: 16px;
    color: #9fc3ff;
    padding: 5px 10px;
    border-radius: 6px;
    background-color: #17253f;
}

/* 头部路径行：深色 */
.picker-head-col-dark {
    flex: 1;
    flex-direction: column;
    padding-right: 10px;
}
.file-path-dark {
    font-size: 13px;
    color: #8ea2b5;
    margin-top: 3px;
    lines: 1;
    text-overflow: ellipsis;
}
.draft-file-dark {
    position: relative;
    width: 216px;
    height: 46px;
    margin-right: 10px;
    margin-bottom: 6px;
    padding: 7px 26px 7px 10px;
    border-radius: 8px;
    background-color: #252525;
    border-width: 1px;
    border-color: #3c3c3c;
    justify-content: center;
}
.draft-file-name-dark {
    font-size: 15px;
    color: #ffffff;
    lines: 1;
    text-overflow: ellipsis;
}
.draft-file-size-dark {
    font-size: 12px;
    color: #9aa5b1;
    margin-top: 2px;
}
.msg-file-dark {
    width: 252px;
    padding: 7px 10px;
    margin-bottom: 5px;
    border-radius: 8px;
    background-color: rgba(255, 255, 255, 0.08);
}
.msg-file-name-dark {
    font-size: 15px;
    color: #ffffff;
    lines: 1;
    text-overflow: ellipsis;
}
.msg-file-meta-dark {
    font-size: 12px;
    color: #b8c2cc;
    margin-top: 2px;
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
    right: 12px;
    bottom: 132px;
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
    flex-wrap: wrap;
}
.md-th-dark {
    flex-direction: row;
    align-items: stretch;
    flex: 1;
    padding: 6px 8px;
    background-color: #2a2a2a;
    border-bottom-width: 1px;
    border-bottom-color: #444444;
}
.md-td-dark {
    flex-direction: row;
    align-items: stretch;
    flex: 1;
    padding: 6px 8px;
    border-bottom-width: 1px;
    border-bottom-color: #3a3a3a;
}
.md-cell-body-dark {
    flex: 1;
    flex-direction: row;
    flex-wrap: wrap;
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

/* 版本更新弹窗（build143 起由云控 updateGate 触发） */
.ov-mask {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.6);
    justify-content: center;
    align-items: center;
}
.ov-mask-dark {
    background-color: rgba(0, 0, 0, 0.8);
}
.ov-box {
    width: 72%;
    background-color: #ffffff;
    border-radius: 16px;
    padding: 18px 16px;
    flex-direction: column;
    align-items: center;
}
.ov-box-dark {
    background-color: #1e1e1e;
}
.ov-title {
    font-size: 24px;
    font-weight: bold;
    color: #222222;
    margin-bottom: 10px;
}
.ov-title-dark {
    color: #ffffff;
}
.ov-text {
    font-size: 16px;
    color: #555555;
    line-height: 22px;
    text-align: center;
    margin-bottom: 6px;
}
.ov-text-dark {
    color: #cccccc;
}
.ov-btn {
    font-size: 18px;
    color: #ffffff;
    background-color: #1a73e8;
    border-radius: 16px;
    padding: 7px 18px;
    margin-right: 8px;
}
.ov-btn-dark {
    color: #000000;
    background-color: #82b1ff;
}

/* ========== 长回复分块行（build 201）：分块气泡所在行改 stretch。
   真机实证（build 200 帧序列）：只含表格的分块气泡宽度回落到内容自然宽，
   坍缩成 ~110px 窄条，单元格窄到无法排字（文字消失、只剩行线）；同屏的
   段落气泡与含长段落参照的表格则完全正常。stretch 让气泡拉伸到行宽
   （仍被 bubble-assistant 的 max-width:80% 钳制），表格列宽随之确定。
   本类须位于 .msg-row-assistant 之后（同优先级后声明生效）。 ========== */
.msg-row-chunk {
    align-items: stretch;
}

</style>