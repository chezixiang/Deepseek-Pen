// 后端健康检查服务
// 用于启动时检查后端是否就绪，以及运行时监控后端状态

import { httpRequest } from './http.js'

const BACKEND_PORTS = [22217, 22218, 22219, 22220, 22221, 22222]
let activeBackendBaseUrl = 'http://127.0.0.1:22217'

function backendUrls() {
    return BACKEND_PORTS.map((port) => `http://127.0.0.1:${port}`)
}

export function getActiveBackendBaseUrl() {
    return activeBackendBaseUrl
}

async function requestHealth(timeout = 3000) {
    const urls = backendUrls()
    const results = await Promise.all(urls.map(async (baseUrl) => {
        try {
            return await httpRequest({
                url: `${baseUrl}/health`,
                method: 'GET',
                timeout
            })
        } catch (e) {
            return { error: e.message || String(e) }
        }
    }))

    for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.statusCode === 200 && result.data) {
            activeBackendBaseUrl = urls[i]
            return result
        }
    }
    return results[0] || { error: '未找到后端服务' }
}

/**
 * 检查后端健康状态
 * @param {Object} options 配置选项
 * @param {number} options.maxAttempts 最大尝试次数，默认30次
 * @param {number} options.interval 每次尝试间隔（毫秒），默认1000ms
 * @param {boolean} options.waitForReady 等待"完全启动"（ready=true，即账号
 *   登录完成）才返回成功；false 时只要求端口/服务可达（旧行为）。
 * @param {Function} options.onProgress 进度回调 (attempt, total) => void
 * @returns {Promise<{success: boolean, error?: string, code?: string, data?: any}>}
 */
export async function checkBackendHealth(options = {}) {
    const {
        maxAttempts = 30,
        interval = 1000,
        onProgress = null,
        waitForReady = false
    } = options

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (onProgress) {
            try {
                onProgress(attempt, maxAttempts)
            } catch (e) {
                // 忽略回调错误
            }
        }

        try {
            const result = await requestHealth(3000)

            // 检查响应
            if (result.statusCode === 200 && result.data) {
                // 新后端（早绑定模式）以 ready 标记"账号登录完成"；
                // 旧后端无 ready 字段，视为已就绪（向后兼容）。
                const ready = result.data.ready === undefined ? true : !!result.data.ready
                if (!ready) {
                    // 还在登录账号，继续等
                    if (attempt < maxAttempts) {
                        await sleep(interval)
                        continue
                    }
                    return {
                        success: false,
                        error: '后端已启动但账号登录未完成（超时）',
                        code: 'BACKEND_NOT_READY'
                    }
                }
                // 检查账号状态
                const accounts = result.data.accounts
                if (accounts && accounts.total > 0) {
                    // 至少有一个账号，且状态正常
                    return {
                        success: true,
                        data: result.data
                    }
                } else if (accounts && accounts.total === 0) {
                    // 没有可用账号，但后端已启动
                    console.warn('BACKEND_HEALTH | 后端已启动但无可用账号')
                    return {
                        success: true,
                        data: result.data,
                        warning: '后端已启动，但当前没有可用账号'
                    }
                }
            }

            // HTTP 错误或响应格式不对
            if (attempt < maxAttempts) {
                // 还有重试机会，等待后再试
                await sleep(interval)
                continue
            } else {
                // 最后一次尝试失败
                return {
                    success: false,
                    error: result.error || '后端响应异常',
                    code: 'BACKEND_UNHEALTHY'
                }
            }
        } catch (e) {
            console.error('BACKEND_HEALTH | attempt ' + attempt + ' failed: ' + (e.message || String(e)))
            
            if (attempt < maxAttempts) {
                // 还有重试机会
                await sleep(interval)
                continue
            } else {
                // 超过30秒仍无法连接
                return {
                    success: false,
                    error: '超过30秒无法连接到后端服务，请检查后端是否正常启动',
                    code: 'TIMEOUT_30S'
                }
            }
        }
    }

    // 理论上不会到这里
    return {
        success: false,
        error: '健康检查超时',
        code: 'TIMEOUT'
    }
}

/**
 * 单次健康检查（用于运行时监控）
 * @returns {Promise<{ok: boolean, accounts?: any}>}
 */
export async function quickHealthCheck() {
    try {
        const result = await requestHealth(5000)

        if (result.statusCode === 200 && result.data) {
            return {
                ok: true,
                accounts: result.data.accounts
            }
        }

        return { ok: false }
    } catch (e) {
        console.error('BACKEND_HEALTH | quick check failed: ' + (e.message || String(e)))
        return { ok: false }
    }
}

/**
 * 创建后端监控器（在主页面中使用）
 * @param {Object} callbacks
 * @param {Function} callbacks.onDisconnect 后端断开回调
 * @param {Function} callbacks.onReconnect 后端重连回调
 * @param {number} interval 检查间隔（毫秒），默认10秒
 * @returns {Object} 监控器对象 { start, stop }
 */
export function createBackendMonitor(callbacks = {}, interval = 10000) {
    let timer = null
    let isConnected = true
    let consecutiveFailures = 0
    const MAX_FAILURES = 3 // 连续3次失败才认为断开

    const check = async () => {
        const result = await quickHealthCheck()
        
        if (result.ok) {
            // 后端正常
            if (!isConnected) {
                // 之前断开，现在恢复
                console.log('BACKEND_MONITOR | 后端已重新连接')
                isConnected = true
                consecutiveFailures = 0
                if (callbacks.onReconnect) {
                    try {
                        callbacks.onReconnect()
                    } catch (e) {
                        console.error('BACKEND_MONITOR | onReconnect callback error:', e)
                    }
                }
            } else {
                // 一直正常
                consecutiveFailures = 0
            }
        } else {
            // 后端异常
            consecutiveFailures++
            
            if (isConnected && consecutiveFailures >= MAX_FAILURES) {
                // 连续多次失败，认为断开
                console.error('BACKEND_MONITOR | 后端连接断开')
                isConnected = false
                if (callbacks.onDisconnect) {
                    try {
                        callbacks.onDisconnect()
                    } catch (e) {
                        console.error('BACKEND_MONITOR | onDisconnect callback error:', e)
                    }
                }
            }
        }
    }

    return {
        start() {
            if (timer) return
            console.log('BACKEND_MONITOR | 开始监控后端状态')
            // 立即检查一次
            check()
            // 定期检查
            timer = setInterval(check, interval)
        },
        stop() {
            if (timer) {
                console.log('BACKEND_MONITOR | 停止监控后端状态')
                clearInterval(timer)
                timer = null
            }
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}
