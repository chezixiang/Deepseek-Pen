<template>
    <div class="startup-page">
        <div class="startup-content">
            <text class="startup-logo">DeepSeek</text>
            
            <div v-if="status === 'checking'" class="status-container">
                <text class="spinner">⏳</text>
                <text class="status-text">正在启动后端服务...</text>
                <text class="status-detail">{{ statusDetail }}</text>
            </div>
            
            <div v-else-if="status === 'timeout'" class="status-container-error">
                <text class="error-icon">⚠️</text>
                <text class="error-text">启动超时</text>
                <text class="error-detail">后端服务未能在 60 秒内响应</text>
                <text class="retry-btn" @click="retry">重试</text>
            </div>
            
            <div v-else-if="status === 'error'" class="status-container-error">
                <text class="error-icon">❌</text>
                <text class="error-text">连接失败</text>
                <text class="error-detail">{{ errorMessage }}</text>
                <text class="retry-btn" @click="retry">重试</text>
            </div>
            
            <div v-else-if="status === 'ready'" class="status-container-success">
                <text class="success-icon">✓</text>
                <text class="success-text">启动成功</text>
                <text class="status-detail">正在进入应用...</text>
            </div>
        </div>
    </div>
</template>

<script>
import { checkBackendHealth } from '../../services/backend-health.js'
import { ensureBackendRunning } from '../../services/native.js'
import { loadSettings } from '../../services/store.js'

export default {
    name: 'startup',
    data() {
        return {
            status: 'checking', // checking | timeout | error | ready
            statusDetail: '初始化中...',
            errorMessage: '',
            startTime: 0,
            checkTimer: null,
            checkingBackend: false,
            timeoutTimer: null
        }
    },
    // 词典笔框架：Vue 组件用 created() + this.$page.on（参考 index.vue）。
    // 之前用 onInit（无效钩子）导致 startBackendCheck 从未执行 → 后端从不拉起。
    // created 时立即检查；show 事件兜底（页面重新进入时若后端断了可重试）。
    created() {
        this.$page.on('show', this.onPageShow)
        this.startBackendCheck()
    },
    destroyed() {
        try { this.$page.off('show', this.onPageShow) } catch (e) { /* 忽略 */ }
        if (this.checkTimer) {
            clearInterval(this.checkTimer)
            this.checkTimer = null
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer)
            this.timeoutTimer = null
        }
    },
    methods: {
        onPageShow() {
            // 页面重新进入：如果还没就绪则重试（后端可能被系统回收）
            if (this.status === 'error' || this.status === 'timeout') {
                this.retry()
            }
        },
        async startBackendCheck() {
            this.status = 'checking'
            this.statusDetail = '正在更新并启动后端服务...'
            this.startTime = Date.now()

            // #7：进入主页前把主题缓存到 $falcon.__dsTheme，index/settings 页
            // 首帧同步读取，消除"进软件闪一下浅色界面"。
            let settings = null
            try {
                settings = await loadSettings()
                $falcon.__dsTheme = (settings && settings.theme) || 'light'
            } catch (e) { /* 忽略，主页会自行兜底 */ }

            // 自定义端点模式不需要本机后端：跳过部署/拉起，直接进主页。
            // 旧逻辑无条件部署，外部端点用户既要等 6MB 解码写盘，还会因本机后端
            // 起不来被卡在启动页（"自定义 api 端点模式无法正常使用"的表现之一）。
            if (settings && settings.authMode && settings.authMode !== 'builtin') {
                this.status = 'ready'
                this.statusDetail = '已使用自定义服务地址'
                setTimeout(() => {
                    $falcon.navTo('index')
                }, 300)
                return
            }

            // ensureBackendRunning 内部已完成 deploy + healthCheck 确认，
            // 成功后直接跳转，不再额外轮询（省 2 秒间隔的重复检查）。
            const ensureResult = await ensureBackendRunning()
            if (!ensureResult.ok) {
                this.status = 'error'
                this.errorMessage = ensureResult.message || '后端部署或启动失败'
                return
            }

            // 快速确认一次（后端可能还在登录 DeepSeek，health 已通但账号未就绪时也允许进入）
            const quick = await checkBackendHealth({ maxAttempts: 1, interval: 0 })

            // 未配置账号 → 进专用登录页（首次使用的主入口）；已配置 → 直接进主页
            // （老用户升级后无感）。dsConfigured 由 loadSettings 从本机 config.toml
            // 的 [[accounts]] 段探测。
            let configured = false
            try {
                const s2 = await loadSettings()
                configured = !!(s2 && s2.dsConfigured)
            } catch (e) { /* 探测失败按未配置处理 */ }

            this.status = 'ready'
            this.statusDetail = quick.warning || '后端服务已就绪'
            const target = configured ? '/index' : '/login'
            setTimeout(() => {
                $falcon.navTo(target === '/login' ? 'login' : 'index')
            }, 300)
        },
        
        async checkBackend() {
            if (this.checkingBackend || this.status !== 'checking') return
            this.checkingBackend = true
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000)
            this.statusDetail = `已等待 ${elapsed} 秒...`
            
            try {
                const result = await checkBackendHealth({ maxAttempts: 1, interval: 0 })
                if (result.success) {
                    // 后端就绪（即使账号池为空，也允许进入应用）
                    this.status = 'ready'
                    this.statusDetail = result.warning || '后端服务已就绪'

                    if (this.checkTimer) {
                        clearInterval(this.checkTimer)
                        this.checkTimer = null
                    }
                    if (this.timeoutTimer) {
                        clearTimeout(this.timeoutTimer)
                        this.timeoutTimer = null
                    }

                    setTimeout(() => {
                        $falcon.navTo('index')
                    }, 500)
                } else {
                    this.statusDetail = result.error || '正在等待后端服务...'
                }
            } catch (err) {
                console.log('Health check error:', err)
            } finally {
                this.checkingBackend = false
            }
        },
        
        retry() {
            if (this.checkTimer) {
                clearInterval(this.checkTimer)
                this.checkTimer = null
            }
            if (this.timeoutTimer) {
                clearTimeout(this.timeoutTimer)
                this.timeoutTimer = null
            }
            this.startBackendCheck()
        }
    }
}
</script>

<style>
.startup-page {
    flex: 1;
    background-color: #f5f7fa;
    justify-content: center;
    align-items: center;
}

.startup-content {
    justify-content: center;
    align-items: center;
    padding: 40px;
}

.startup-logo {
    font-size: 48px;
    font-weight: bold;
    color: #1a73e8;
    margin-bottom: 60px;
}

.status-container {
    justify-content: center;
    align-items: center;
}

.spinner {
    font-size: 48px;
    margin-bottom: 20px;
}

.status-text {
    font-size: 20px;
    color: #333;
    margin-bottom: 12px;
}

.status-detail {
    font-size: 16px;
    color: #666;
}

.status-container-error {
    justify-content: center;
    align-items: center;
}

.error-icon {
    font-size: 64px;
    margin-bottom: 20px;
}

.error-text {
    font-size: 24px;
    color: #d32f2f;
    font-weight: bold;
    margin-bottom: 12px;
}

.error-detail {
    font-size: 16px;
    color: #666;
    margin-bottom: 24px;
    text-align: center;
}

.retry-btn {
    font-size: 18px;
    color: #ffffff;
    background-color: #1a73e8;
    padding: 12px 32px;
    border-radius: 24px;
}

.status-container-success {
    justify-content: center;
    align-items: center;
}

.success-icon {
    font-size: 64px;
    color: #4caf50;
    margin-bottom: 20px;
}

.success-text {
    font-size: 24px;
    color: #4caf50;
    font-weight: bold;
    margin-bottom: 12px;
}
</style>
