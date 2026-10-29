<template>
    <div class="startup-page">
        <div class="startup-content">
            <text class="startup-logo">DeepSeek</text>
            
            <div v-if="status === 'checking'" class="status-container">
                <text class="spinner">…</text>
                <text class="status-text">{{ builtinEnabled ? '正在启动后端服务...' : '正在启动...' }}</text>
                <text class="status-detail">{{ statusDetail }}</text>
            </div>
            
            <div v-else-if="status === 'timeout'" class="status-container-error">
                <text class="error-icon">!</text>
                <text class="error-text">启动超时</text>
                <text class="error-detail">后端服务未能在 60 秒内响应</text>
                <text class="retry-btn" @click="retry">重试</text>
            </div>
            
            <div v-else-if="status === 'error'" class="status-container-error">
                <text class="error-icon">×</text>
                <text class="error-text">连接失败</text>
                <text class="error-detail">{{ errorMessage }}</text>
                <text class="retry-btn" @click="retry">重试</text>
            </div>
            
            <div v-else-if="status === 'ready'" class="status-container-success">
                <text class="success-icon">√</text>
                <text class="success-text">启动成功</text>
                <text class="status-detail">正在进入应用...</text>
            </div>
        </div>
    </div>
</template>

<script>

import { checkBackendHealth } from '../../services/backend-health.js'
import { BUILTIN_AUTH_ENABLED, loadSettings, saveControlCache, ensureBackendRunning, saveSettings, appLogError } from '../../services/store.js'
import { ensureUpstreamAuth, fetchControl, upstreamBase, normalizeControl } from '../../services/cloud-control.js'

export default {
    name: 'startup',
    data() {
        return {
            builtinEnabled: BUILTIN_AUTH_ENABLED,
            status: 'checking', // checking | timeout | error | ready
            statusDetail: '初始化中...',
            errorMessage: '',
            startTime: 0,
            checkTimer: null,
            checkingBackend: false,
            timeoutTimer: null,
            navTimer: null
        }
    },
    // 词典笔框架：Vue 组件用 created() + this.$page.on（参考 index.vue）。
    // 之前用 onInit（无效钩子）导致 startBackendCheck 从未执行 → 后端从不拉起。
    // created 时立即检查；show 事件兜底（页面重新进入时若后端断了可重试）。
    created() {
        this.$page.on('show', this.onPageShow);
        this.startBackendCheck();
    },
    destroyed() {
        try { this.$page.off('show', this.onPageShow); } catch (e) { /* 忽略 */ }
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        if (this.navTimer) {
            clearTimeout(this.navTimer);
            this.navTimer = null;
        }
    },
    methods: {
        onPageShow() {
            // 页面重新进入：如果还没就绪则重试（后端可能被系统回收）
            if (this.status === 'error' || this.status === 'timeout') {
                this.retry();
            }
        },
        async startBackendCheck() {
            this.status = 'checking';
            this.statusDetail = '正在更新并启动后端服务...';
            this.startTime = Date.now();

            // 整个流程兜底 try/catch：任何未预期异常（loadSettings 抛错、
            // ensureBackendRunning reject 等）不能让页面永远停在"正在启动…"。
            try {
                await this.doBackendCheck();
            } catch (e) {
                appLogError('startup', e);
                this.status = 'error';
                this.errorMessage = '启动流程异常：' + (e && e.message ? e.message : String(e));
            }
        },

        async doBackendCheck() {
            // #7：进入主页前把主题缓存到 $falcon.__dsTheme，index/settings 页
            // 首帧同步读取，消除"进软件闪一下浅色界面"。
            let settings = null;
            try {
                settings = await loadSettings();
                $falcon.__dsTheme = (settings && settings.theme) || 'light';
            } catch (e) { appLogError('startup.settings', e); }

            // 账号登录模式已暂停：不部署、不拉起、不探测任何本机后端。
            // 两种后端各自判断"是否配置完成"：
            // - 自定义端点：服务地址 + API Key（或配对令牌）
            // - 内置服务：服务地址 + 设备配对（loadSettings 已算好 endpointConfigured）
            if (!BUILTIN_AUTH_ENABLED) {
                const upstream = !!(settings && settings.upstreamMode);
                // 上游模式：用户没有任何配置要做。这里只做两件后台事：
                //   1) 静默注册设备（首次启动）/ 续期令牌；
                //   2) 拉一次云控（公告、维护、更新策略），失败就用缓存。
                // 注册失败也放行进主页：聊天时会给出可重试的错误，比卡在启动页好。
                if (upstream) {
                    this.statusDetail = '正在连接内置服务…';
                    this.$forceUpdate();
                    const auth = await ensureUpstreamAuth({
                        settings,
                        persist: () => saveSettings(settings),
                        timeout: 6000
                    });
                    if (auth) {
                        try {
                            const raw = await fetchControl({ baseUrl: upstreamBase(settings), auth, timeout: 4000 });
                            await saveControlCache(normalizeControl(raw));
                        } catch (e) { appLogError('startup.control', e); }
                    }
                    this.status = 'ready';
                    this.statusDetail = auth ? '已连接内置服务' : '服务暂时不可用，稍后可重试';
                    this.scheduleNav('index');
                    return
                }
                const needsSetup = !(settings && settings.endpointConfigured);
                this.status = 'ready';
                this.statusDetail = needsSetup
                    ? '请先配置 API 服务地址与 Key'
                    : '已使用自定义服务地址';
                // 记住这次是「配置引导」进入设置页：设置页返回时应去主页而不是回到启动页
                try { $falcon.__dsNeedsEndpointSetup = needsSetup; } catch (e) { /* 忽略 */ }
                this.scheduleNav(needsSetup ? 'settings' : 'index');
                return
            }

            // —— 以下为内置 ds-free-api 模式的原有启动流程（恢复开关后继续生效）——

            // 自定义端点模式不需要本机后端：跳过部署/拉起，直接进主页。
            // 旧逻辑无条件部署，外部端点用户既要等 6MB 解码写盘，还会因本机后端
            // 起不来被卡在启动页（"自定义 api 端点模式无法正常使用"的表现之一）。
            if (settings && settings.authMode && settings.authMode !== 'builtin') {
                this.status = 'ready';
                this.statusDetail = '已使用自定义服务地址';
                this.scheduleNav('index');
                return
            }

            // 1) 部署 + 端口级 healthCheck（失败则展示错误）
            const ensureResult = await ensureBackendRunning();
            if (!ensureResult.ok) {
                this.status = 'error';
                this.errorMessage = ensureResult.message || '后端部署或启动失败';
                return
            }

            // 2) 等待"完全启动"（ready=true：wasm/账号登录完成）才放行——
            // 早绑定模式下端口秒通但登录在后台进行，直接放行会让首条消息
            // 撞上 503 initializing（bug 5"要等 ds-free-api 完全启动才让下一步"）。
            const full = await checkBackendHealth({ maxAttempts: 60, interval: 1500, waitForReady: true });

            // 未配置账号 → 进专用登录页（首次使用的主入口）；已配置 → 直接进主页
            // （老用户升级后无感）。dsConfigured 由 loadSettings 从本机 config.toml
            // 的 [[accounts]] 段探测。
            let configured = false;
            try {
                const s2 = await loadSettings();
                configured = !!(s2 && s2.dsConfigured);
            } catch (e) { /* 探测失败按未配置处理 */ }

            if (!full.success) {
                // ready 等待超时：登录可能卡在验证码/风控。已有账号时放行进主页
                // （主页会显示具体错误并支持重试），未配置则去登录页重试。
                this.statusDetail = full.error || '后端启动超时';
                if (!configured) {
                    this.status = 'error';
                    this.errorMessage = this.statusDetail;
                    return
                }
            }

            this.status = 'ready';
            this.statusDetail = (full && full.warning) || '后端服务已就绪';
            const target = configured ? '/index' : '/login';
            this.scheduleNav(target === '/login' ? 'login' : 'index');
        },

        // 导航定时器要可取消：onPageShow→retry 时旧定时器还挂着会双跳转
        scheduleNav(page) {
            if (this.navTimer) clearTimeout(this.navTimer);
            this.navTimer = setTimeout(() => {
                this.navTimer = null;
                $falcon.navTo(page);
            }, 300);
        },
        
        async checkBackend() {
            if (this.checkingBackend || this.status !== 'checking') return
            this.checkingBackend = true;
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            this.statusDetail = `已等待 ${elapsed} 秒...`;
            
            try {
                const result = await checkBackendHealth({ maxAttempts: 1, interval: 0 });
                if (result.success) {
                    // 后端就绪（即使账号池为空，也允许进入应用）
                    this.status = 'ready';
                    this.statusDetail = result.warning || '后端服务已就绪';

                    if (this.checkTimer) {
                        clearInterval(this.checkTimer);
                        this.checkTimer = null;
                    }
                    if (this.timeoutTimer) {
                        clearTimeout(this.timeoutTimer);
                        this.timeoutTimer = null;
                    }

                    this.scheduleNav('index');
                } else {
                    this.statusDetail = result.error || '正在等待后端服务...';
                }
            } catch (err) {
                appLogError('startup.health', err);
            } finally {
                this.checkingBackend = false;
            }
        },
        
        retry() {
            if (this.checkTimer) {
                clearInterval(this.checkTimer);
                this.checkTimer = null;
            }
            if (this.timeoutTimer) {
                clearTimeout(this.timeoutTimer);
                this.timeoutTimer = null;
            }
            if (this.navTimer) {
                clearTimeout(this.navTimer);
                this.navTimer = null;
            }
            this.startBackendCheck();
        }
    }
};
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
