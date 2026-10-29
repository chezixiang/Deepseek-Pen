// 配置加载：config.json ← 环境变量覆盖 ← 默认值。
//
// 设计原则：
//   1) 部署类配置（端口/数据目录/加密参数）只从文件/环境读；运行期可调项
//      （provider / quota / control / 单设备覆盖）由管理后台写入 data/*.json 覆盖，
//      重启后仍然生效；
//   2) 缺失/非法值给出明确告警，不静默降级；
//   3) 密钥（provider.apiKey / 管理员密码哈希）永远不出现在日志与 /admin 响应里。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UPSTREAM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const DEFAULT_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 8787,
    publicUrl: '',
    trustProxy: true,
    bodyLimitBytes: 8 * 1024 * 1024
  },
  dataDir: 'data',
  // 管理后台使用 data/admin-auth.json 中的密码哈希（scrypt），配置里没有固定 token。
  admin: {},
  auth: {
    tokenTtlSec: 24 * 3600,
    pairingTtlSec: 600,
    signatureWindowSec: 300,
    rotateSecretOnRefresh: false,
    nonceCacheMax: 200000,
    pairAttemptsPer10Min: 12,
    // 静默注册：客户端不需要任何人工作业（无配对码、无地址配置），
    // 首次联网即自助领取设备令牌。token 非空时要求客户端带 X-Ds-Enroll（构建期内置）。
    enroll: {
      enabled: true,
      token: '',
      maxDevices: 200,
      perIpPerDay: 20,
      rebindAllowed: true
    }
  },
  // 只保留全局并发保护；单设备 RPM/并发由 quota 统一管理（不再有第二套限速配置）。
  rate: {
    maxConcurrentGlobal: 64
  },
  guard: {
    enabled: true,
    requireClientHeader: true,
    blockOnHighRisk: true,
    riskThreshold: 70,
    warnThreshold: 50,
    blockDurationSec: 1800,
    maxIpsPerHour: 6,
    rhythmMinSamples: 12,
    rhythmCvThreshold: 0.08,
    allowedUaPatterns: ['curl/', 'deepseek', 'pen', 'okhttp'],
    unknownPathPenalty: 50,
    scanPathPenalty: 80
  },
  provider: {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    modelMap: {},
    userAgent: 'deepseek-pen-upstream/1.0',
    timeoutMs: 300000,
    idleTimeoutMs: 120000,
    maxResponseBytes: 16 * 1024 * 1024,
    modelsCacheSec: 300,
    extraHeaders: {}
  },
  // 网页搜索/抓取代理（/v1/tools/search|fetch）：客户端注入 tool call 后，
  // 设备统一到这里执行搜索——DeepSeek API Key 只存服务端，设备侧零密钥。
  // apiKey 为官方平台（https://platform.deepseek.com）的 API Key，Search/Fetch 按次计费。
  tools: {
    enabled: true,
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    userAgent: 'deepseek-pen-upstream/1.0',
    timeoutMs: 30000,
    // 每设备每天搜索/抓取总次数（0 = 不限）
    perDayPerDevice: 100,
    // 全局同时在途的搜索/抓取请求数上限
    maxInflight: 8,
    // search.count 钳制上限（官方上限 50，笔端场景无需那么多）
    maxCount: 20,
    // fetch 正文回传给设备的最大字符数（笔端内存与请求体都吃紧）
    fetchMaxChars: 12000,
    // search 单条结果 content/summary 截断长度
    resultMaxChars: 2000
  },
  // 配额：按设备计算，limit 为 0 表示该项不限。
  // 客户端 /v1/me 可查询每一项的剩余量；管理后台可热改（data/quota.json）。
  quota: {
    enabled: true,
    // 每设备并发聊天请求数（0 = 不限）
    maxConcurrent: 2,
    rpm: 20,
    tpm: 0,
    // 最近 5 小时滚动窗口 token（0 = 不限）
    fiveHourTokens: 0,
    dailyTokens: 0,
    monthlyTokens: 0
  },
  // 客户端状态上报（监控）：客户端按云控 limits.reportSec 的节奏上报一份轻量快照。
  telemetry: {
    enabled: true,
    maxDevices: 500,
    maxEventsPerDevice: 30
  },
  // 会话云端备份：本地仍是主库，网关只保存一份可恢复的副本。
  sessions: {
    enabled: true,
    maxPerDevice: 300,
    maxMessagesPerSession: 300,
    maxDevicesCached: 200
  },
  // 意见反馈
  feedback: {
    enabled: true,
    maxPerDayPerDevice: 20,
    maxEntries: 2000
  },
  // 云控（后台下发到客户端的运行策略，存 data/control.json）
  control: {
    enabled: true
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

// 只对普通对象做深合并：数组/标量整段替换（模型列表、UA 白名单等不能拼接）
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  for (const key of Object.keys(patch)) {
    const pv = patch[key]
    if (isPlainObject(pv) && isPlainObject(base[key])) {
      deepMerge(base[key], pv)
    } else if (pv !== undefined) {
      base[key] = isPlainObject(pv) ? clone(pv) : pv
    }
  }
  return base
}

function toInt(v, fallback, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (min != null && i < min) return fallback
  if (max != null && i > max) return fallback
  return i
}

function toBool(v, fallback) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return fallback
}

function str(v, fallback = '') {
  return v === undefined || v === null ? fallback : String(v).trim()
}

function normalizeBaseUrl(u) {
  const s = str(u).replace(/\/+$/, '')
  return s
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.configPath] 显式配置文件路径
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{config: Object, warnings: string[], configPath: string, fileLoaded: boolean}}
 */
export function loadConfig(opts = {}) {
  const env = opts.env || process.env
  const configPath = path.resolve(
    opts.configPath || env.UPSTREAM_CONFIG || path.join(UPSTREAM_ROOT, 'config.json')
  )

  let fileConfig = {}
  let fileLoaded = false
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8')
    try {
      fileConfig = JSON.parse(text)
    } catch (e) {
      throw new Error('配置文件不是合法 JSON：' + configPath + '（' + e.message + '）')
    }
    fileLoaded = true
  }

  const config = deepMerge(clone(DEFAULT_CONFIG), fileConfig || {})
  const warnings = []

  // ---- 环境变量覆盖（部署时通常只给密钥） ----
  if (env.UPSTREAM_HOST) config.server.host = str(env.UPSTREAM_HOST)
  if (env.UPSTREAM_PORT) config.server.port = toInt(env.UPSTREAM_PORT, config.server.port, 0, 65535)
  if (env.UPSTREAM_PUBLIC_URL) config.server.publicUrl = str(env.UPSTREAM_PUBLIC_URL)
  if (env.UPSTREAM_DATA_DIR) config.dataDir = str(env.UPSTREAM_DATA_DIR)
  if (env.UPSTREAM_PROVIDER_BASE_URL) config.provider.baseUrl = str(env.UPSTREAM_PROVIDER_BASE_URL)
  if (env.UPSTREAM_PROVIDER_API_KEY) config.provider.apiKey = str(env.UPSTREAM_PROVIDER_API_KEY)
  if (env.UPSTREAM_PROVIDER_MODEL) config.provider.defaultModel = str(env.UPSTREAM_PROVIDER_MODEL)
  if (env.UPSTREAM_TOOLS_BASE_URL) config.tools.baseUrl = str(env.UPSTREAM_TOOLS_BASE_URL)
  if (env.UPSTREAM_TOOLS_API_KEY) config.tools.apiKey = str(env.UPSTREAM_TOOLS_API_KEY)
  if (env.UPSTREAM_ENROLL_TOKEN) config.auth.enroll.token = str(env.UPSTREAM_ENROLL_TOKEN)
  if (env.UPSTREAM_ENROLL_ENABLED) config.auth.enroll.enabled = toBool(env.UPSTREAM_ENROLL_ENABLED, config.auth.enroll.enabled)

  // ---- 归一化与校验 ----
  config.server.port = toInt(config.server.port, 8787, 0, 65535)
  config.server.bodyLimitBytes = toInt(config.server.bodyLimitBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024)
  config.server.trustProxy = toBool(config.server.trustProxy, true)

  config.auth.tokenTtlSec = toInt(config.auth.tokenTtlSec, 86400, 60, 365 * 86400)
  config.auth.pairingTtlSec = toInt(config.auth.pairingTtlSec, 600, 60, 3600)
  config.auth.signatureWindowSec = toInt(config.auth.signatureWindowSec, 300, 30, 900)
  config.auth.rotateSecretOnRefresh = toBool(config.auth.rotateSecretOnRefresh, false)
  config.auth.nonceCacheMax = toInt(config.auth.nonceCacheMax, 200000, 1000, 2000000)
  config.auth.pairAttemptsPer10Min = toInt(config.auth.pairAttemptsPer10Min, 12, 1, 1000)

  // 静默注册：默认开启（客户端零配置的直接前提）
  const enroll = config.auth.enroll && typeof config.auth.enroll === 'object' ? config.auth.enroll : {}
  config.auth.enroll = {
    enabled: toBool(enroll.enabled, true),
    token: str(enroll.token),
    maxDevices: toInt(enroll.maxDevices, 200, 1, 1000000),
    perIpPerDay: toInt(enroll.perIpPerDay, 20, 1, 100000),
    rebindAllowed: toBool(enroll.rebindAllowed, true)
  }

  config.rate.maxConcurrentGlobal = toInt(config.rate.maxConcurrentGlobal, 64, 1, 10000)
  // 旧配置里的单设备限速字段（requestsPerMinute / burst / maxConcurrentPerDevice）
  // 已并入 quota，config.json 里若还留着会被忽略，不再读。

  config.guard.enabled = toBool(config.guard.enabled, true)
  config.guard.requireClientHeader = toBool(config.guard.requireClientHeader, true)
  config.guard.blockOnHighRisk = toBool(config.guard.blockOnHighRisk, true)
  config.guard.riskThreshold = toInt(config.guard.riskThreshold, 70, 10, 100)
  config.guard.warnThreshold = toInt(config.guard.warnThreshold, 50, 1, 100)
  config.guard.blockDurationSec = toInt(config.guard.blockDurationSec, 1800, 60, 30 * 86400)
  config.guard.maxIpsPerHour = toInt(config.guard.maxIpsPerHour, 6, 1, 1000)
  config.guard.rhythmMinSamples = toInt(config.guard.rhythmMinSamples, 12, 4, 200)
  config.guard.rhythmCvThreshold = Number(config.guard.rhythmCvThreshold)
  if (!Number.isFinite(config.guard.rhythmCvThreshold)) config.guard.rhythmCvThreshold = 0.08
  if (!Array.isArray(config.guard.allowedUaPatterns)) config.guard.allowedUaPatterns = ['curl/', 'deepseek', 'pen', 'okhttp']

  config.provider.baseUrl = normalizeBaseUrl(config.provider.baseUrl)
  config.provider.timeoutMs = toInt(config.provider.timeoutMs, 300000, 1000, 3600000)
  config.provider.idleTimeoutMs = toInt(config.provider.idleTimeoutMs, 120000, 1000, 3600000)
  config.provider.maxResponseBytes = toInt(config.provider.maxResponseBytes, 16 * 1024 * 1024, 1024, 256 * 1024 * 1024)
  config.provider.modelsCacheSec = toInt(config.provider.modelsCacheSec, 300, 0, 86400)
  if (!Array.isArray(config.provider.models)) config.provider.models = []
  if (!isPlainObject(config.provider.modelMap)) config.provider.modelMap = {}
  if (!isPlainObject(config.provider.extraHeaders)) config.provider.extraHeaders = {}

  const tools = config.tools && typeof config.tools === 'object' ? config.tools : {}
  config.tools = {
    enabled: toBool(tools.enabled, true),
    baseUrl: normalizeBaseUrl(tools.baseUrl) || 'https://api.deepseek.com',
    apiKey: str(tools.apiKey),
    userAgent: str(tools.userAgent) || 'deepseek-pen-upstream/1.0',
    timeoutMs: toInt(tools.timeoutMs, 30000, 1000, 120000),
    perDayPerDevice: toInt(tools.perDayPerDevice, 100, 0, 1000000),
    maxInflight: toInt(tools.maxInflight, 8, 1, 256),
    maxCount: toInt(tools.maxCount, 20, 1, 50),
    fetchMaxChars: toInt(tools.fetchMaxChars, 12000, 1000, 100000),
    resultMaxChars: toInt(tools.resultMaxChars, 2000, 100, 20000)
  }

  const quota = config.quota && typeof config.quota === 'object' ? config.quota : {}
  config.quota = {
    enabled: toBool(quota.enabled, true),
    maxConcurrent: toInt(quota.maxConcurrent, 2, 0, 100),
    rpm: toInt(quota.rpm, 20, 0, 100000),
    tpm: toInt(quota.tpm, 0, 0, 100000000),
    fiveHourTokens: toInt(quota.fiveHourTokens, 0, 0, 1000000000000),
    dailyTokens: toInt(quota.dailyTokens, 0, 0, 1000000000000),
    monthlyTokens: toInt(quota.monthlyTokens, 0, 0, 1000000000000)
  }

  const sessions = config.sessions && typeof config.sessions === 'object' ? config.sessions : {}
  config.sessions = {
    enabled: toBool(sessions.enabled, true),
    maxPerDevice: toInt(sessions.maxPerDevice, 300, 1, 100000),
    maxMessagesPerSession: toInt(sessions.maxMessagesPerSession, 300, 1, 5000),
    maxDevicesCached: toInt(sessions.maxDevicesCached, 200, 1, 100000)
  }

  const feedback = config.feedback && typeof config.feedback === 'object' ? config.feedback : {}
  config.feedback = {
    enabled: toBool(feedback.enabled, true),
    maxPerDayPerDevice: toInt(feedback.maxPerDayPerDevice, 20, 1, 10000),
    maxEntries: toInt(feedback.maxEntries, 2000, 10, 100000)
  }

  const control = config.control && typeof config.control === 'object' ? config.control : {}
  config.control = { enabled: toBool(control.enabled, true) }

  const telemetry = config.telemetry && typeof config.telemetry === 'object' ? config.telemetry : {}
  config.telemetry = {
    enabled: toBool(telemetry.enabled, true),
    maxDevices: toInt(telemetry.maxDevices, 500, 10, 100000),
    maxEventsPerDevice: toInt(telemetry.maxEventsPerDevice, 30, 5, 500)
  }

  const dataDir = str(config.dataDir) || 'data'
  config.dataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(UPSTREAM_ROOT, dataDir)

  if (!config.provider.baseUrl) {
    warnings.push('provider.baseUrl 为空：/v1/chat/completions 会返回 503 provider_not_configured')
  }
  if (!config.provider.apiKey) {
    warnings.push('provider.apiKey 为空：部署后需通过环境变量 UPSTREAM_PROVIDER_API_KEY 或 config.json 配置')
  }
  if (config.tools.enabled && !config.tools.apiKey) {
    warnings.push('tools.apiKey 为空：/v1/tools/search|fetch 会返回 503 tools_not_configured（客户端联网搜索不可用）')
  }
  if (config.guard.riskThreshold <= config.guard.warnThreshold) {
    warnings.push('guard.riskThreshold 应大于 warnThreshold，已按配置继续（可能导致一有信号就封禁）')
  }
  if (!config.auth.enroll.enabled && !config.auth.pairAttemptsPer10Min) {
    warnings.push('auth.enroll 关闭且没有其它开户途径：新设备无法接入')
  }
  if (config.auth.enroll.enabled && !config.auth.enroll.token) {
    warnings.push('auth.enroll.token 为空：任何持有本 App 客户端的设备都能自助注册（建议生产环境配置 X-Ds-Enroll 令牌）')
  }

  return { config, warnings, configPath, fileLoaded }
}

// 供 /admin 展示：去掉所有密钥
export function redactConfig(config) {
  const c = clone(config)
  c.admin = { mode: 'password' }
  c.provider.apiKey = c.provider.apiKey ? '***已设置***' : ''
  if (c.tools) c.tools.apiKey = c.tools.apiKey ? '***已设置***' : ''
  if (c.auth && c.auth.enroll) c.auth.enroll.token = c.auth.enroll.token ? '***已设置***' : ''
  return c
}
