#!/usr/bin/env node
// DeepSeek 词典笔上游网关。
//
// 一个进程同时承担三件事：
//   1) 设备配对鉴权（/auth/*）：短期令牌 + 每请求 HMAC 签名；
//   2) OpenAI 兼容业务入口（/v1/*）：验签、限速、防反代检测后转发给真正的 Provider；
//   3) 管理后台（/admin）：配对码批准、设备封禁/吊销、审计与统计。
//
// 启动：node server.js  （配置见 config.example.json / 环境变量）
// 测试：node --test test/

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { Readable } from 'node:stream'

import { loadConfig } from './src/config.js'
import { Store, dayKey, monthKey, nextDayAt, nextMonthAt, nextMinuteAt, nextHourAt } from './src/store.js'
import { SessionStore } from './src/sessions.js'
import { normalizeMessageAttachments } from './src/attachments.js'
import {
  ControlStore,
  applyDeviceOverride,
  effectivePrompt,
  effectiveDebug,
  CONTROL_VERSION,
  CONTROL_FEATURES,
  CONTROL_LIMITS
} from './src/control.js'
import { DeviceControlStore } from './src/device-control.js'
import { FileStore } from './src/files.js'
import { ReleaseManager } from './src/releases.js'
import { inspectAmr } from './src/amr.js'
import { DebugQueue } from './src/debug-queue.js'
import { TelemetryStore } from './src/telemetry.js'
import { FeedbackStore } from './src/feedback.js'
import {
  loadQuotaOverride,
  applyQuotaOverride,
  saveQuotaOverride,
  clearQuotaOverride,
  normalizeQuotaInput,
  quotaOverridePath,
  quotaSummary,
  QUOTA_ITEMS,
  QuotaConfigError
} from './src/quota-config.js'
import {
  NonceCache,
  FailWindow,
  verifyDeviceRequest,
  newDeviceToken,
  newSignSecret,
  normalizePairingCode,
  randomHex,
  constantTimeEqual
} from './src/auth.js'
import { DeviceGuard, clientHeaderValid } from './src/guard.js'
import { ProviderClient, ProviderError, classifyUpstreamError } from './src/provider.js'
import { ToolsClient, ToolsError, validateTargetUrl } from './src/tools.js'
import {
  loadProviderOverride,
  applyProviderOverride,
  cloneProvider,
  providerOverridePath
} from './src/provider-config.js'
import {
  loadToolsOverride,
  applyToolsOverride,
  cloneTools,
  toolsOverridePath
} from './src/tools-config.js'
import {
  Router,
  readBody,
  parseJsonBody,
  sendJson,
  sendError,
  clientIp,
  splitPath,
  parseQuery,
  HttpError
} from './src/http.js'
import { registerAdminRoutes } from './src/admin.js'
import { AdminAuth } from './src/admin-auth.js'
import { isHttps } from './src/admin-auth.js'

export const VERSION = '1.7.4'
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/
const PAIR_CODE_RE = /^[A-Z0-9]{4,16}$/

// ---------- SSE 用量抓取 ----------
// 只旁路解析每一行 data:，不改变转发字节。用于管理后台统计 token，
// 解析失败一律忽略——统计不能影响主链路。
class SseUsageTap {
  constructor() {
    this.decoder = new StringDecoder('utf8')
    this.buf = ''
    this.usage = null
  }

  push(chunk) {
    this.buf += this.decoder.write(chunk)
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      this._line(line)
    }
    if (this.buf.length > 65536) this.buf = ''
  }

  _line(line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const obj = JSON.parse(data)
      if (obj && obj.usage && typeof obj.usage === 'object') this.usage = obj.usage
    } catch (_) { /* 非 JSON 行，忽略 */ }
  }
}

function extractUsageFromJson(text) {
  try {
    const obj = JSON.parse(text)
    return obj && obj.usage ? obj.usage : null
  } catch (_) {
    return null
  }
}

// ---------- 联网工具能力说明 ----------
// 只下发 tools 定义时，相当一部分模型会坚持"我无法联网"甚至无视 tools 直接拒答：
// 它们的训练先验里"文本模型不能上网"压过了函数定义（实测 gpt-6.1-sol / gpt-6-astra
// 在部分问法下如此，模型自带的长 system 里也有"不要调用外部 API"的约束）。
// 网关在 system 末尾补一段能力说明，把"能联网"从工具定义提升为明确约束，
// 老客户端无需发版即可受益；客户端（自定义端点模式）另有一份同文案的注入。
const TOOL_USE_DIRECTIVE = '【联网能力】本次对话已开启联网工具：web_search（互联网搜索）与 fetch_page（抓取网页正文）。' +
  '当用户询问实时信息（新闻、天气、价格、股价、赛事、人物近况等）、需要核实事实，或你对答案没有把握时，' +
  '必须先调用 web_search 检索（必要时用 fetch_page 读取全文），再基于检索结果回答。' +
  '严禁声称自己无法联网、没有联网权限或无法访问实时信息；也不要把没检索到的内容说成是检索结果。'

// 请求里带了搜索类工具就认为"本轮联网已开启"
function hasWebTools(body) {
  if (!body || !Array.isArray(body.tools) || body.tools.length === 0) return false
  return body.tools.some((t) => {
    const fn = (t && t.function) || t || {}
    const name = String(fn.name || '')
    return name === 'web_search' || name === 'fetch_page'
  })
}

// 客户端（新版 App）自己会带同一段说明，避免重复注入
function hasToolDirective(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((m) => m && m.role === 'system' &&
    typeof m.content === 'string' && m.content.indexOf('【联网能力】') >= 0)
}

function deviceState(d, now = Date.now()) {
  if (!d) return 'unknown'
  if (d.revokedAt) return 'revoked'
  if (d.blockedUntil && d.blockedUntil > now) return 'blocked'
  if (d.expiresAt && d.expiresAt < now) return 'expired'
  return 'active'
}

export function createApp({ config, configPath = '', fileLoaded = false, fetchImpl = null, now = Date.now } = {}) {
  const store = new Store({ dataDir: config.dataDir }).load()
  const sessions = new SessionStore({ dataDir: config.dataDir, limits: config.sessions })
  const control = new ControlStore({ dataDir: config.dataDir })
  const deviceControl = new DeviceControlStore({ dataDir: config.dataDir })
  const files = new FileStore({ dataDir: config.dataDir })
  const releases = new ReleaseManager({ dataDir: config.dataDir })
  const debugQueue = new DebugQueue({ dataDir: config.dataDir })
  const telemetry = new TelemetryStore({
    dataDir: config.dataDir,
    maxDevices: config.telemetry.maxDevices,
    maxEventsPerDevice: config.telemetry.maxEventsPerDevice
  })
  const feedback = new FeedbackStore({ dataDir: config.dataDir, maxEntries: config.feedback.maxEntries })
  const adminAuth = new AdminAuth({ dataDir: config.dataDir })

  // Provider 运行时覆盖：管理后台保存过就以 data/provider.json 为准（热生效、重启保留）。
  // 保留 config.json 的原始值，供管理后台「恢复文件配置」使用。
  const providerBaseConfig = cloneProvider(config.provider)
  const providerOverride = loadProviderOverride(config.dataDir)
  const overrideApplied = applyProviderOverride(config, providerOverride)

  // 搜索/抓取代理（tools）运行时覆盖：同 provider 模式（data/tools.json）。
  const toolsBaseConfig = cloneTools(config.tools)
  const toolsOverride = loadToolsOverride(config.dataDir)
  const toolsOverrideApplied = applyToolsOverride(config, toolsOverride)

  // 限额运行时覆盖：后台保存过就以 data/quota.json 为准（热生效、重启保留）。
  // 保留 config.json 的原始值，供后台「恢复文件配置」使用。
  const quotaBaseConfig = Object.assign({}, config.quota)
  const quotaOverride = loadQuotaOverride(config.dataDir)
  const quotaOverrideApplied = applyQuotaOverride(config, quotaOverride)

  const provider = new ProviderClient(config, { fetchImpl })
  const toolsClient = new ToolsClient(config, { fetchImpl })
  const guard = new DeviceGuard({ config, store, now })
  const nonceCache = new NonceCache({
    ttlMs: config.auth.signatureWindowSec * 1000,
    max: config.auth.nonceCacheMax
  })
  const pairFailures = new FailWindow({ limit: config.auth.pairAttemptsPer10Min, windowMs: 10 * 60 * 1000 })
  const enrollFailures = new FailWindow({ limit: config.auth.enroll.perIpPerDay, windowMs: 24 * 60 * 60 * 1000 })
  const feedbackFailures = new FailWindow({ limit: config.feedback.maxPerDayPerDevice, windowMs: 24 * 60 * 60 * 1000 })
  const ipFailures = new FailWindow({ limit: 30, windowMs: 10 * 60 * 1000 })
  const ipBlocks = new Map() // ip -> until
  const promptAuditAt = new Map() // deviceId -> last prompt_injected audit ts
  const debugAuditAt = new Map() // deviceId -> last debug_device_report audit ts
  const globalConcurrency = { current: 0 }
  // 搜索/抓取代理：按设备按天计数 + 全局在途上限（tools 配置节）
  const toolsUsage = new Map() // deviceId -> { day, count }
  const toolsInflight = { current: 0 }

  const startedAt = now()
  const ctx = {
    config,
    configPath,
    fileLoaded,
    version: VERSION,
    startedAt,
    store,
    sessions,
    control,
    deviceControl,
    files,
    releases,
    debugQueue,
    telemetry,
    feedback,
    adminAuth,
    provider,
    providerBaseConfig,
    providerOverride: overrideApplied,
    providerOverridePath: providerOverridePath(config.dataDir),
    toolsBaseConfig,
    toolsOverride: toolsOverrideApplied,
    toolsOverridePath: toolsOverridePath(config.dataDir),
    quotaBaseConfig,
    quotaOverride: quotaOverrideApplied,
    quotaOverridePath: quotaOverridePath(config.dataDir),
    saveQuotaOverride: (quota) => saveQuotaOverride(config.dataDir, quota),
    clearQuotaOverride: () => clearQuotaOverride(config.dataDir),
    normalizeQuotaInput,
    quotaSummary,
    quotaItems: QUOTA_ITEMS,
    QuotaConfigError,
    controlFeatures: CONTROL_FEATURES,
    controlLimits: CONTROL_LIMITS,
    fetchImpl,
    guard,
    nonceCache,
    ip: (req) => clientIp(req, { trustProxy: config.server.trustProxy })
  }

  // 更新包下载地址：优先 publicUrl；没有就用当前请求的 Host。
  // 即使反代没配 X-Forwarded-Proto，配置了 publicUrl 的生产环境也不会错。
  function publicBase(req) {
    const configured = String(config.server.publicUrl || '').trim()
    if (configured) return configured.replace(/\/+$/, '')
    return (isHttps(req) ? 'https://' : 'http://') + String(req.headers.host || '127.0.0.1')
  }

  function updateTicketFor(item, deviceId, req, ttlSec) {
    if (!item) return null
    const t = releases.ticket(item.id, { deviceId, ttlSec })
    return {
      token: t.token,
      expiresAt: t.expiresAt,
      url: publicBase(req) + releases.downloadPath(item, t.token)
    }
  }

  // ---------- 限额 ----------  //
  // 按设备统计，limit=0 表示该项不限；单设备可在后台覆盖任意一项。
  // 对外只有一份结构：items（有序，客户端/后台共用）+ 各分项对象。
  function quotaLimits(deviceId) {
    const ov = deviceId ? deviceControl.get(deviceId) : null
    if (!ov || !ov.quota) return { limits: config.quota, overridden: false }
    return { limits: Object.assign({}, config.quota, ov.quota), overridden: true }
  }

  function quotaSection(limit, used, resetAt, unit) {
    const lim = Math.max(0, Number(limit) || 0)
    const u = Math.max(0, Number(used) || 0)
    return {
      limit: lim,
      used: u,
      remaining: lim > 0 ? Math.max(0, lim - u) : null,
      resetAt: Number(resetAt) || 0,
      unit
    }
  }

  function emptyQuota() {
    return {
      enabled: false,
      exhausted: false,
      blockedBy: '',
      override: false,
      limits: {},
      items: [],
      day: dayKey(now()),
      month: monthKey(now()),
      updatedAt: now()
    }
  }

  function quotaOf(device) {
    const d = device ? (store.getDevice(device.deviceId) || device) : null
    if (!d) return emptyQuota()
    const nowTs = now()
    store.rollUsage(d, nowTs)
    const u = store.usage(d.deviceId, nowTs)
    const q = quotaLimits(d.deviceId)
    const lim = q.limits
    const minuteReset = u.minuteResetAt || nextMinuteAt(nowTs)
    const dayReset = nextDayAt(nowTs)
    const monthReset = nextMonthAt(nowTs)
    const hourReset = u.fiveHourResetAt || nextHourAt(nowTs)

    const sections = {
      rpm: quotaSection(lim.rpm, u.minuteRequests, minuteReset, 'requests'),
      tpm: quotaSection(lim.tpm, u.minuteTokens, minuteReset, 'tokens'),
      fiveHourTokens: quotaSection(lim.fiveHourTokens, u.fiveHourTokens, hourReset, 'tokens'),
      dailyTokens: quotaSection(lim.dailyTokens, u.tokens, dayReset, 'tokens'),
      monthlyTokens: quotaSection(lim.monthlyTokens, u.monthTokens, monthReset, 'tokens'),
      maxConcurrent: quotaSection(lim.maxConcurrent, guard.concurrent(d.deviceId), 0, 'requests')
    }

    const items = QUOTA_ITEMS.map((item) => Object.assign(
      { key: item.key, label: item.label, short: item.short, window: item.window },
      sections[item.key]
    ))

    let blockedBy = ''
    if (lim.enabled) {
      for (const item of items) {
        if (item.limit > 0 && item.used >= item.limit) {
          blockedBy = item.key
          break
        }
      }
    }

    return Object.assign({
      enabled: !!lim.enabled,
      exhausted: !!blockedBy,
      blockedBy,
      override: q.overridden,
      limits: {
        maxConcurrent: lim.maxConcurrent,
        rpm: lim.rpm,
        tpm: lim.tpm,
        fiveHourTokens: lim.fiveHourTokens,
        dailyTokens: lim.dailyTokens,
        monthlyTokens: lim.monthlyTokens
      },
      items,
      day: dayKey(nowTs),
      month: monthKey(nowTs),
      updatedAt: nowTs
    }, sections)
  }

  // 设备构建号：优先用最近上报（客户端自报最准），退回注册时带的 build
  function deviceBuild(deviceId) {
    if (!deviceId) return 0
    const tel = telemetry.get(deviceId)
    const d = store.getDevice(deviceId)
    const raw = (tel && tel.build) || (d && d.build) || 0
    return Math.max(0, Math.trunc(Number(raw) || 0))
  }

  // 提示词注入：拼进 system 消息（已有 system 则合并，不再追加第二条）。
  // 只改本次请求的内存副本，不落盘、不回显给客户端。
  function systemText(content) {
    if (typeof content === 'string') return content
    // system 允许内容块数组（OpenAI 规范）：只取其中的文本块，避免 String() 出 [object Object]
    if (Array.isArray(content)) {
      return content.map((p) => {
        if (typeof p === 'string') return p
        return p && typeof p.text === 'string' ? p.text : ''
      }).filter(Boolean).join('\n')
    }
    return ''
  }

  function injectPrompt(messages, prompt) {
    const list = Array.isArray(messages) ? messages.slice() : []
    if (!prompt) return list
    let sysIndex = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].role === 'system') { sysIndex = i; break }
    }
    const parts = []
    if (prompt.system) parts.push(prompt.system)
    if (sysIndex >= 0 && list[sysIndex]) parts.push(systemText(list[sysIndex].content))
    if (prompt.append) parts.push(prompt.append)
    const content = parts.filter(Boolean).join('\n\n')
    if (!content) return list
    if (sysIndex >= 0) list[sysIndex] = Object.assign({}, list[sysIndex], { content })
    else list.unshift({ role: 'system', content })
    return list
  }

  // 云控下发给客户端：全局文档 + 单设备覆盖 + 公告定向 + 服务端实况（功能是否真的开启）
  function controlView(device) {
    const ov = device ? deviceControl.get(device.deviceId) : null
    const view = applyDeviceOverride(control.get(), ov)
    const deviceId = device ? device.deviceId : ''
    // 模型目录：后台配置优先；未配置时退回 provider 目录
    if (!view.models.length) view.models = (config.provider.models || []).slice(0, 40)
    // 上游信息是否披露给客户端：关闭后连 provider 名称都不下发
    if (view.upstream.disclose === false) {
      view.upstream = { disclose: false, name: '', note: '' }
    } else if (!view.upstream.name) {
      view.upstream.name = config.provider.name || ''
    }
    // 维护白名单：覆盖后客户端不再看到维护提示（服务端聊天入口同样放行）
    if (ov && ov.maintenanceBypass) view.maintenance = { enabled: false, message: '', until: 0 }
    return Object.assign(view, {
      object: 'control',
      serverTime: now(),
      serverVersion: VERSION,
      promptActive: !!effectivePrompt(view),
      features: Object.assign({}, view.features, {
        sessions: !!config.sessions.enabled && view.features.sessions !== false,
        feedback: !!config.feedback.enabled && view.features.feedback !== false
      }),
      telemetry: { enabled: !!config.telemetry.enabled && view.telemetry.enabled !== false },
      debug: Object.assign(effectiveDebug(view), { reported: !!(telemetry.get(deviceId) || {}).debug }),
      device: device ? {
        deviceId: device.deviceId,
        state: deviceState(device),
        disabled: !!(ov && ov.disabled),
        build: deviceBuild(deviceId)
      } : null
    })
  }

  // 设备是否被后台单独停用（只挡聊天，不挡云控/上报——否则设备永远看不到恢复通知）
  function deviceDisabled(device) {
    const ov = device ? deviceControl.get(device.deviceId) : null
    return !!(ov && ov.disabled)
  }

  function maintenancePending() {
    if (!config.control.enabled) return false
    const ctl = control.get()
    return !!ctl.maintenance.enabled && (!ctl.maintenance.until || ctl.maintenance.until > now())
  }

  function maintenanceOn(device) {
    if (!maintenancePending()) return null
    const ov = device ? deviceControl.get(device.deviceId) : null
    if (ov && ov.maintenanceBypass) return null
    return control.get().maintenance
  }

  // 管理后台要用同一套口径（额度剩余、云控视图），挂到 ctx 上避免复制逻辑
  ctx.quotaOf = quotaOf
  ctx.controlView = controlView
  ctx.deviceState = deviceState
  ctx.maintenancePending = maintenancePending
  ctx.applyDeviceOverride = applyDeviceOverride

  const router = new Router()
  registerAdminRoutes(router, ctx)

  // ---------- 公共端点 ----------

  router.get('/health', (req, res) => {
    const nowTs = now()
    const devices = Object.values(store.state.devices)
    sendJson(res, 200, {
      ok: true,
      name: 'deepseek-pen-upstream',
      version: VERSION,
      time: nowTs,
      uptimeSec: Math.floor((nowTs - startedAt) / 1000),
      provider: {
        name: config.provider.name,
        configured: !!provider.configured,
        defaultModel: config.provider.defaultModel
      },
      devices: {
        total: devices.length,
        active: devices.filter((d) => deviceState(d, nowTs) === 'active').length
      },
      enroll: { enabled: !!config.auth.enroll.enabled },
      quota: quotaSummary(config.quota),
      control: {
        enabled: !!config.control.enabled,
        version: CONTROL_VERSION,
        updatedAt: control.get().updatedAt || 0,
        maintenance: !!maintenancePending(),
        promptInjection: !!(control.get().prompt && control.get().prompt.enabled),
        latestBuild: control.get().update.latestBuild || 0
      },
      files: {
        count: files.list().length,
        latest: files.list()[0] ? files.list()[0].name : ''
      },
      telemetry: {
        enabled: !!config.telemetry.enabled,
        reported: Object.keys(telemetry.devices).length
      },
      features: {
        sessions: !!config.sessions.enabled,
        feedback: !!config.feedback.enabled
      },
      tools: {
        enabled: !!config.tools.enabled,
        configured: !!toolsClient.configured
      }
    })
  })

  router.post('/auth/pair', async (req, res, meta) => {
    const ip = ctx.ip(req)
    // 只接受本 App：配对是"设备第一次拿到凭证"，这里也要求客户端标识，
    // 避免扫描器拿配对码试探（配对码本身仍是主要凭据）。
    if (config.guard.enabled && config.guard.requireClientHeader) {
      const client = String(req.headers['x-ds-client'] || '')
      if (!clientHeaderValid(client)) {
        store.audit('pair_fail', { ip, code2: 'client_header_required', client: client.slice(0, 64) })
        sendError(res, 403, 'client_header_required', '缺少或非法的 X-Ds-Client 头：仅接受本 App 客户端')
        return
      }
    }
    const fail = pairFailures.peek(ip)
    if (fail.limited) {
      sendError(res, 429, 'too_many_pair_attempts', '配对尝试过于频繁，请稍后再试', { retryAfterSec: fail.retryAfterSec })
      return
    }
    const body = parseJsonBody(meta.raw)
    const code = normalizePairingCode(body.pairingCode)
    const deviceId = String(body.deviceId || '').trim()

    if (!code || !deviceId) {
      sendError(res, 400, 'missing_params', '缺少 pairingCode 或 deviceId')
      return
    }
    if (!PAIR_CODE_RE.test(code)) {
      sendError(res, 400, 'invalid_pairing_code', '配对码格式不正确（4~16 位大写字母/数字）')
      return
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      sendError(res, 400, 'invalid_device_id', 'deviceId 格式不正确（8~128 位字母/数字/._:-）')
      return
    }

    const hit = pairFailures.hit(ip)
    if (hit.limited) {
      sendError(res, 429, 'too_many_pair_attempts', '配对尝试过于频繁，请稍后再试', { retryAfterSec: hit.retryAfterSec })
      return
    }

    const entry = store.getPairing(code)
    if (!entry) {
      store.audit('pair_fail', { code, deviceId, ip, code2: 'pairing_code_not_found' })
      sendError(res, 404, 'pairing_code_not_found', '配对码不存在：请确认管理后台已批准该配对码')
      return
    }
    if (entry.used) {
      store.audit('pair_fail', { code, deviceId, ip, code2: 'pairing_code_used' })
      sendError(res, 410, 'pairing_code_used', '配对码已使用（一次性），请在设备上重新生成')
      return
    }
    if (entry.expiresAt && entry.expiresAt < now()) {
      store.audit('pair_fail', { code, deviceId, ip, code2: 'pairing_code_expired' })
      sendError(res, 410, 'pairing_code_expired', '配对码已过期，请在设备上重新生成')
      return
    }
    if (entry.deviceId && entry.deviceId !== deviceId) {
      store.audit('pair_fail', { code, deviceId, ip, code2: 'pairing_code_bound' })
      sendError(res, 409, 'pairing_code_bound', '配对码已绑定其他设备')
      return
    }
    if (!entry.approved) {
      store.audit('pair_fail', { code, deviceId, ip, code2: 'pairing_not_approved' })
      sendError(res, 409, 'pairing_not_approved', '配对码尚未在管理后台批准')
      return
    }

    const consumed = store.consumePairing(code, deviceId)
    if (!consumed) {
      sendError(res, 409, 'pairing_code_unavailable', '配对码状态已变化，请重新生成')
      return
    }

    const token = newDeviceToken()
    const secret = newSignSecret()
    const expiresAt = now() + config.auth.tokenTtlSec * 1000
    store.issueDevice(deviceId, {
      tokenHash: sha256(token),
      secret,
      expiresAt,
      ua: String(req.headers['user-agent'] || ''),
      ip,
      client: String(req.headers['x-ds-client'] || '')
    })
    store.audit('pair_success', { deviceId, ip, ua: String(req.headers['user-agent'] || '').slice(0, 120) })
    sendJson(res, 200, { deviceToken: token, signSecret: secret, expiresAt }, { 'Cache-Control': 'no-store' })
  })

  // ---------- 静默注册（上游模式的默认开户方式） ----------
  //
  // 客户端在上游模式下不做任何配置：地址来自构建期常量，设备标识首次启动自动生成，
  // 本接口直接签发令牌——不需要配对码、不需要管理员点批准。
  //
  // 安全边界（按重要性排序）：
  //   1) X-Ds-Client 必须匹配本 App（guard.requireClientHeader）；
  //   2) 可选 auth.enroll.token（构建期内置 X-Ds-Enroll），挡住"自己写个脚本刷设备"；
  //   3) 每 IP 每天注册次数上限 + 全局设备数上限；
  //   4) 已吊销设备不会被静默复活（管理员封禁优先）。
  router.post('/device/register', async (req, res, meta) => {
    const ip = ctx.ip(req)
    const client = String(req.headers['x-ds-client'] || '')

    if (!config.auth.enroll.enabled) {
      sendError(res, 403, 'enroll_disabled', '该服务未开放在线注册，请联系管理员')
      return
    }
    if (config.guard.enabled && config.guard.requireClientHeader && !clientHeaderValid(client)) {
      store.audit('enroll_fail', { ip, code: 'client_header_required', client: client.slice(0, 64) })
      sendError(res, 403, 'client_header_required', '缺少或非法的 X-Ds-Client 头：仅接受本 App 客户端')
      return
    }
    const expectToken = String(config.auth.enroll.token || '')
    if (expectToken) {
      const provided = String(req.headers['x-ds-enroll'] || '')
      if (!provided || !constantTimeEqual(provided, expectToken)) {
        store.audit('enroll_fail', { ip, code: 'invalid_enroll_token' })
        sendError(res, 403, 'invalid_enroll_token', '注册令牌不正确：请使用官方客户端')
        return
      }
    }
    const seen = enrollFailures.peek(ip)
    if (seen.limited) {
      sendError(res, 429, 'too_many_enroll_attempts', '今日注册次数过多，请明天再试', { retryAfterSec: seen.retryAfterSec })
      return
    }

    const body = parseJsonBody(meta.raw)
    const deviceId = String(body.deviceId || '').trim()
    if (!deviceId) {
      sendError(res, 400, 'missing_device_id', '缺少 deviceId')
      return
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      sendError(res, 400, 'invalid_device_id', 'deviceId 格式不正确（8~128 位字母/数字/._:-）')
      return
    }

    const existing = store.getDevice(deviceId)
    if (existing && existing.revokedAt) {
      store.audit('enroll_fail', { deviceId, ip, code: 'device_revoked' })
      sendError(res, 403, 'device_revoked', '该设备已被管理员停用，请联系客服')
      return
    }
    if (!existing && store.countDevices() >= config.auth.enroll.maxDevices) {
      store.audit('enroll_fail', { deviceId, ip, code: 'device_limit_reached', max: config.auth.enroll.maxDevices })
      sendError(res, 403, 'device_limit_reached', '服务设备数已达上限，请联系管理员')
      return
    }
    if (existing && !config.auth.enroll.rebindAllowed && !existing.revokedAt) {
      store.audit('enroll_fail', { deviceId, ip, code: 'device_already_enrolled' })
      sendError(res, 409, 'device_already_enrolled', '该设备已注册；如需重装请联系管理员重置')
      return
    }

    enrollFailures.hit(ip)
    const token = newDeviceToken()
    const secret = newSignSecret()
    const expiresAt = now() + config.auth.tokenTtlSec * 1000
    store.issueDevice(deviceId, {
      tokenHash: sha256(token),
      secret,
      expiresAt,
      ua: String(req.headers['user-agent'] || ''),
      ip,
      client,
      build: String(body.build || '').slice(0, 40),
      model: String(body.model || '').slice(0, 80),
      source: 'auto'
    })
    store.audit(existing ? 'device_reenrolled' : 'device_enrolled', {
      deviceId,
      ip,
      client: client.slice(0, 64),
      build: String(body.build || '').slice(0, 40)
    })
    const device = store.getDevice(deviceId)
    sendJson(res, 200, {
      enrolled: true,
      reenrolled: !!existing,
      deviceToken: token,
      signSecret: secret,
      expiresAt,
      serverTime: now(),
      serverVersion: VERSION,
      controlVersion: control.get().updatedAt || 0,
      quota: quotaOf(device)
    }, { 'Cache-Control': 'no-store' })
  })

  // ---------- 签名校验 ----------

  function authenticate(req, raw) {
    const deviceId = String(req.headers['x-ds-device-id'] || '').trim()
    const device = deviceId ? store.getDevice(deviceId) : null
    const result = verifyDeviceRequest({
      headers: req.headers,
      method: req.method,
      path: req.url,
      rawBody: raw,
      device,
      now: now(),
      windowSec: config.auth.signatureWindowSec,
      nonceCache
    })
    if (!result.ok) return result
    return { ok: true, device, deviceId }
  }

  const IP_FAIL_CODES = new Set([
    'missing_auth_headers',
    'invalid_timestamp',
    'timestamp_out_of_window',
    'invalid_nonce',
    'nonce_replay',
    'signature_mismatch',
    'invalid_device_token',
    'device_not_paired'
  ])

  function rejectAuth(req, res, result) {
    const ip = ctx.ip(req)
    const deviceId = String(req.headers['x-ds-device-id'] || '')
    const hdr = {}
    if (result.retryAfterSec) hdr['Retry-After'] = String(result.retryAfterSec)
    sendError(res, result.status || 401, result.code, result.message, { headers: hdr })
    store.audit('auth_fail', {
      deviceId,
      ip,
      code: result.code,
      path: req.url,
      ua: String(req.headers['user-agent'] || '').slice(0, 120)
    })
    // 只对"凭证/签名错误"累计爆破计数：设备被封禁/令牌过期后的正常重试不能把 IP 也拖下水
    if (!IP_FAIL_CODES.has(result.code)) return
    const f = ipFailures.hit(ip)
    if (f.limited) {
      ipBlocks.set(ip, now() + 10 * 60 * 1000)
      store.audit('ip_blocked', { ip, reason: 'auth_failures', count: f.count })
    }
  }

  // 入口统一挡掉被爆破的 IP
  function ipBlocked(req) {
    const ip = ctx.ip(req)
    const until = ipBlocks.get(ip) || 0
    if (until > now()) return Math.ceil((until - now()) / 1000)
    if (until) ipBlocks.delete(ip)
    return 0
  }

  function preAuthChecks(req, res) {
    const retry = ipBlocked(req)
    if (retry) {
      sendError(res, 429, 'ip_rate_limited', '该来源鉴权失败过多，请稍后再试', { retryAfterSec: retry })
      return false
    }
    return true
  }

  // 签名路由公共流程：验签 → 设备风险评分
  // 单设备 RPM/TPM 统一由 quotaOf 在聊天入口判定（能给出具体是哪一项用完了），
  // 这里不再有第二套令牌桶。
  function guardDevice(req, res, meta) {
    if (!preAuthChecks(req, res)) return null
    const auth = authenticate(req, meta.raw)
    if (!auth.ok) {
      rejectAuth(req, res, auth)
      return null
    }
    const device = auth.device
    // 硬门槛：没有本 App 客户端标识的请求直接拒绝（配置可关）。
    // 仅靠风险分不够——反代只要一直不带头，分数会停在 30，永远到不了阈值。
    if (config.guard.enabled && config.guard.requireClientHeader) {
      const client = String(req.headers['x-ds-client'] || '')
      if (!client) {
        store.audit('client_header_missing', { deviceId: device.deviceId, ip: ctx.ip(req), path: req.url })
        sendError(res, 403, 'client_header_required', '缺少 X-Ds-Client 头：仅接受本 App 客户端')
        return null
      }
      if (!clientHeaderValid(client)) {
        store.audit('client_header_invalid', { deviceId: device.deviceId, ip: ctx.ip(req), client: client.slice(0, 64) })
        sendError(res, 403, 'client_header_invalid', 'X-Ds-Client 格式不正确')
        return null
      }
    }
    const assessment = guard.assess(device, req, { path: req.url, rawBody: meta.raw, clientIp: ctx.ip(req) })
    if (assessment.blocked) {
      sendError(res, 403, 'device_blocked', '设备因异常流量被临时限制，请联系管理员解除', {
        retryAfterSec: assessment.retryAfterSec
      })
      return null
    }
    meta.assessment = assessment
    res._deviceId = device.deviceId
    return device
  }

  // ---------- 设备端点 ----------

  router.post('/auth/refresh', (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (deviceState(device) === 'revoked') {
      sendError(res, 401, 'device_revoked', '设备已被吊销，请重新配对')
      return
    }
    const token = newDeviceToken()
    const rotate = !!config.auth.rotateSecretOnRefresh
    const secret = rotate ? newSignSecret() : device.secret
    const expiresAt = now() + config.auth.tokenTtlSec * 1000
    store.rotateToken(device.deviceId, { tokenHash: sha256(token), secret, expiresAt })
    store.audit('token_refreshed', { deviceId: device.deviceId, ip: ctx.ip(req), rotatedSecret: rotate })
    sendJson(res, 200, { deviceToken: token, signSecret: secret, expiresAt }, { 'Cache-Control': 'no-store' })
  })

  router.post('/auth/revoke', (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    store.revokeDevice(device.deviceId, 'client_revoke')
    store.audit('device_revoked', { deviceId: device.deviceId, ip: ctx.ip(req), by: 'client' })
    sendJson(res, 200, { ok: true })
  })

  router.get('/v1/me', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    const d = store.getDevice(device.deviceId) || device
    const usage = store.usage(d.deviceId, now()) || { requests: 0, tokens: 0, monthRequests: 0, monthTokens: 0 }
    const quota = quotaOf(d)
    const ov = deviceControl.get(d.deviceId)
    const view = controlView(d)
    sendJson(res, 200, {
      object: 'device',
      deviceId: d.deviceId,
      state: deviceState(d),
      disabled: !!(ov && ov.disabled),
      maintenanceBypass: !!(ov && ov.maintenanceBypass),
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      lastSeenAt: d.lastSeenAt,
      client: d.client || '',
      build: d.build || '',
      model: d.model || '',
      // 配额：items 为全部限制项（客户端设置页逐项展示剩余量；limit=0 表示不限）
      quota,
      usage: {
        day: usage.day,
        requests: usage.requests,
        errors: d.errorCount || 0,
        tokens: usage.tokens,
        totalRequests: d.requestCount || 0,
        totalTokens: d.tokenCount || 0,
        monthRequests: usage.monthRequests,
        monthTokens: usage.monthTokens,
        minuteRequests: usage.minuteRequests,
        minuteTokens: usage.minuteTokens,
        fiveHourTokens: usage.fiveHourTokens
      },
      features: {
        sessions: !!config.sessions.enabled,
        feedback: !!config.feedback.enabled,
        quota: !!config.quota.enabled,
        telemetry: !!config.telemetry.enabled
      },
      provider: view.upstream.disclose === false
        ? { name: '内置服务', models: [], disclosed: false }
        : {
            name: view.upstream.name || config.provider.name,
            models: view.models,
            disclosed: true,
            note: view.upstream.note || ''
          },
      promptActive: !!effectivePrompt(view),
      debug: view.debug,
      quotaItems: QUOTA_ITEMS.map((i) => ({ key: i.key, label: i.label, short: i.short, window: i.window })),
      controlVersion: control.get().updatedAt || 0,
      serverVersion: VERSION,
      serverTime: now()
    })
  })

  // ---------- 云控 ----------
  router.get('/v1/control', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.control.enabled) {
      sendJson(res, 200, {
        object: 'control',
        enabled: false,
        serverTime: now(),
        serverVersion: VERSION,
        quota: quotaOf(store.getDevice(device.deviceId) || device)
      })
      return
    }
    const view = controlView(store.getDevice(device.deviceId) || device)
    view.enabled = true
    view.quota = quotaOf(store.getDevice(device.deviceId) || device)
    // 更新包绝不返回公开 /files 地址：每次云控下发时现签 30 分钟票据。
    // 老客户端直接 curl 这个 URL 也能工作，新客户端会在安装前再换一张新票据。
    if (view.update && view.update.fileId) {
      const item = files.get(view.update.fileId)
      const ticket = item && item.kind === 'update' ? updateTicketFor(item, device.deviceId, req) : null
      view.update.url = ticket ? ticket.url : ''
      view.update.ticketExpiresAt = ticket ? ticket.expiresAt : 0
    }
    sendJson(res, 200, view, { 'Cache-Control': 'no-store' })
  })

  // 更新包临时下载票据：只有已注册、签名有效的设备能取。
  // 票据只绑定当前发布的 fileId，不能拿它下载其它更新包或普通文件。
  router.post('/v1/update/ticket', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    const body = parseJsonBody(meta.raw)
    const ctl = controlView(store.getDevice(device.deviceId) || device)
    const currentFileId = ctl.update && ctl.update.fileId ? String(ctl.update.fileId) : ''
    const fileId = String(body.fileId || currentFileId)
    if (!currentFileId || !fileId) {
      sendError(res, 404, 'no_update', '当前没有已发布的应用更新')
      return
    }
    if (fileId !== currentFileId) {
      sendError(res, 409, 'update_superseded', '该更新包已不是当前发布版本，请重新检查更新')
      return
    }
    const item = files.get(fileId)
    if (!item || item.kind !== 'update') {
      sendError(res, 404, 'update_file_missing', '更新包不存在或已被删除')
      return
    }
    const ticket = updateTicketFor(item, device.deviceId, req)
    store.audit('update_ticket_issued', {
      deviceId: device.deviceId,
      fileId,
      build: ctl.update.latestBuild,
      ip: ctx.ip(req)
    })
    sendJson(res, 200, {
      ok: true,
      fileId,
      build: ctl.update.latestBuild || 0,
      version: ctl.update.version || '',
      fileName: item.name,
      size: item.size,
      sha256: item.sha256,
      url: ticket.url,
      expiresAt: ticket.expiresAt
    }, { 'Cache-Control': 'no-store' })
  })

  // ---------- 远程调试（仅限被授权的调试设备） ----------
  //
  // 客户端开启调试模式后按 debug.pollSec 轮询；只有云控 debug.allow && debug.rce
  // 同时为真才返回命令。命令一次性投递，执行结果回传后进后台。
  //
  // 支持 wait 长轮询（?wait=秒，上限 25s，须小于 Nginx proxy_read_timeout）：
  // 没有命令时服务端挂住请求，enqueue 的瞬间唤醒返回 —— 等效把命令
  // 「推」给设备，执行延迟从最长 pollSec 降到一个网络往返。
  router.get('/v1/debug/commands', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    const view = controlView(store.getDevice(device.deviceId) || device)
    const dbg = effectiveDebug(view)
    if (!dbg.allow) {
      store.audit('debug_denied', { deviceId: device.deviceId, ip: ctx.ip(req), path: '/v1/debug/commands' })
      sendError(res, 403, 'debug_not_allowed', '服务端未授权该设备响应调试模式')
      return
    }
    if (!dbg.rce) {
      sendJson(res, 200, { ok: true, allowed: true, rce: false, pollSec: dbg.pollSec, commands: [] })
      return
    }
    const waitSec = Math.max(0, Math.min(25, Math.trunc(Number(meta.query.wait) || 0)))
    let commands = debugQueue.take(device.deviceId)
    let waited = false
    if (!commands.length && waitSec > 0) {
      commands = await debugQueue.takeWait(device.deviceId, waitSec * 1000)
      waited = true
    }
    if (commands.length) {
      store.audit('debug_commands_sent', { deviceId: device.deviceId, count: commands.length, ip: ctx.ip(req) })
    }
    sendJson(res, 200, {
      ok: true,
      allowed: true,
      rce: true,
      pollSec: dbg.pollSec,
      commands,
      waited,
      serverTime: now()
    }, { 'Cache-Control': 'no-store' })
  })

  router.post('/v1/debug/results', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    const view = controlView(store.getDevice(device.deviceId) || device)
    const dbg = effectiveDebug(view)
    if (!dbg.allow || !dbg.rce) {
      sendError(res, 403, 'debug_not_allowed', '服务端未授权该设备执行远程命令')
      return
    }
    const body = parseJsonBody(meta.raw)
    const entry = debugQueue.complete(device.deviceId, body)
    if (!entry) {
      sendError(res, 400, 'missing_command_id', '缺少命令 id')
      return
    }
    store.audit('debug_result', { deviceId: device.deviceId, commandId: entry.id, ok: entry.ok, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, receivedAt: entry.at })
  })

  // ---------- 文件下载（普通资源公开；应用更新必须带短时票据） ----------
  router.get('/files/:id/:name', (req, res, meta) => {
    const item = files.get(meta.params.id)
    if (!item) {
      sendError(res, 404, 'file_not_found', '文件不存在或已被删除')
      return
    }
    if (item.kind === 'update') {
      const ticket = Array.isArray(meta.query.ticket) ? meta.query.ticket[0] : meta.query.ticket
      if (!releases.verifyTicket(item.id, ticket)) {
        store.audit('update_download_denied', { fileId: item.id, ip: ctx.ip(req) })
        sendError(res, 403, 'update_ticket_required', '更新包下载需要有效的设备票据，请从应用内检查更新后下载')
        return
      }
    }
    const filePath = files.pathOf(item.id)
    let stat = null
    try { stat = fs.statSync(filePath) } catch (_) { stat = null }
    if (!stat || !stat.isFile()) {
      sendError(res, 410, 'file_missing', '文件记录存在但磁盘上已丢失，请重新上传')
      return
    }
    const total = stat.size
    const headers = {
      'Content-Type': item.mime || 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': item.kind === 'update' ? 'private, no-store, max-age=0' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-File-Sha256': item.sha256 || ''
    }
    const range = String(req.headers.range || '')
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      let start = m[1] === '' ? null : Number(m[1])
      let end = m[2] === '' ? null : Number(m[2])
      if (start === null && end === null) {
        res.writeHead(416, Object.assign({}, headers, { 'Content-Range': 'bytes */' + total }))
        res.end()
        return
      }
      if (start === null) {
        // bytes=-N：最后 N 字节
        start = Math.max(0, total - Number(end))
        end = total - 1
      } else if (end === null || end >= total) {
        end = total - 1
      }
      if (start > end || start >= total) {
        res.writeHead(416, Object.assign({}, headers, { 'Content-Range': 'bytes */' + total }))
        res.end()
        return
      }
      res.writeHead(206, Object.assign({}, headers, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Content-Length': end - start + 1
      }))
      if (req.method === 'HEAD') { res.end(); return }
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, Object.assign({}, headers, { 'Content-Length': total }))
    if (req.method === 'HEAD') { res.end(); return }
    files.touchDownload(item.id)
    fs.createReadStream(filePath).pipe(res)
  })

  // ---------- 客户端状态上报（监控） ----------
  //
  // 客户端按云控 limits.reportSec 的节奏上报轻量快照；这里只存最新一份 + 最近事件。
  // 上报失败不影响客户端任何功能，服务端也不因上报内容改变鉴权/额度。
  router.post('/v1/telemetry', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.telemetry.enabled) {
      sendJson(res, 200, { ok: true, enabled: false })
      return
    }
    const body = parseJsonBody(meta.raw)
    telemetry.record(device.deviceId, body, { ip: ctx.ip(req) })
    const patch = {}
    if (body.build) patch.build = String(body.build).slice(0, 40)
    if (body.model) patch.model = String(body.model).slice(0, 80)
    if (Object.keys(patch).length) store.touchDevice(device.deviceId, patch)
    const ctl = applyDeviceOverride(control.get(), deviceControl.get(device.deviceId))
    // 开启调试模式的设备必须被后台看见：每小时记一条审计（不随心跳刷屏）
    if (body.debug) {
      const last = debugAuditAt.get(device.deviceId) || 0
      if (now() - last > 60 * 60 * 1000) {
        debugAuditAt.set(device.deviceId, now())
        store.audit('debug_device_report', {
          deviceId: device.deviceId,
          ip: ctx.ip(req),
          build: String(body.build || '').slice(0, 40),
          version: String(body.version || '').slice(0, 40)
        })
      }
    }
    sendJson(res, 200, {
      ok: true,
      enabled: true,
      nextReportSec: ctl.limits.reportSec,
      debug: Object.assign(effectiveDebug(ctl), { reported: !!body.debug }),
      serverTime: now()
    })
  })

  // ---------- 会话云端备份 ----------
  //
  // 本地为主库：客户端推上来的是整条会话的快照（last-write-wins），
  // 删除就是删除（客户端删会话时同步调用）。这里不解释消息内容。
  router.get('/v1/sessions', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.sessions.enabled) {
      sendJson(res, 200, { object: 'list', enabled: false, data: [] })
      return
    }
    const list = sessions.list(device.deviceId)
    sendJson(res, 200, {
      object: 'list',
      enabled: true,
      data: list,
      stats: sessions.stats(device.deviceId),
      serverTime: now()
    })
  })

  router.get('/v1/sessions/:id', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.sessions.enabled) {
      sendError(res, 404, 'sessions_disabled', '该服务未开启会话同步')
      return
    }
    const session = sessions.get(device.deviceId, meta.params.id)
    if (!session) {
      sendError(res, 404, 'session_not_found', '云端没有这条会话')
      return
    }
    sendJson(res, 200, Object.assign({ object: 'session' }, session))
  })

  // 客户端用 POST（设备 http 模块对 PUT 支持不稳定），PUT 保留给脚本/管理工具。
  const upsertSession = async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.sessions.enabled) {
      sendError(res, 409, 'sessions_disabled', '该服务未开启会话同步')
      return
    }
    const body = parseJsonBody(meta.raw)
    const result = sessions.put(device.deviceId, meta.params.id, body)
    if (!result.ok) {
      sendError(res, 400, result.reason || 'invalid_session', '会话数据不合法')
      return
    }
    sendJson(res, 200, {
      ok: true,
      object: 'session',
      session: result.session,
      stats: sessions.stats(device.deviceId)
    })
  }
  router.put('/v1/sessions/:id', upsertSession)

  router.post('/v1/sessions/:id/delete', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.sessions.enabled) {
      sendJson(res, 200, { ok: true, deleted: 0, enabled: false })
      return
    }
    const result = sessions.remove(device.deviceId, meta.params.id)
    if (!result.ok) {
      sendError(res, 400, result.reason || 'invalid_session', '会话标识不合法')
      return
    }
    store.audit('session_deleted', { deviceId: device.deviceId, sessionId: meta.params.id })
    sendJson(res, 200, { ok: true, deleted: result.deleted, stats: sessions.stats(device.deviceId) })
  })

  router.post('/v1/sessions/purge', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.sessions.enabled) {
      sendJson(res, 200, { ok: true, deleted: 0, enabled: false })
      return
    }
    const result = sessions.purge(device.deviceId)
    store.audit('sessions_purged', { deviceId: device.deviceId, deleted: result.deleted })
    sendJson(res, 200, { ok: true, deleted: result.deleted, stats: sessions.stats(device.deviceId) })
  })

  // POST 版上传：必须注册在 /v1/sessions/purge 之后，否则 purge 会被当成会话 id。
  router.post('/v1/sessions/:id', upsertSession)

  // ---------- 意见反馈 ----------
  router.post('/v1/feedback', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    if (!config.feedback.enabled) {
      sendError(res, 403, 'feedback_disabled', '该服务未开启意见反馈')
      return
    }
    const limited = feedbackFailures.peek(device.deviceId)
    if (limited.limited) {
      sendError(res, 429, 'too_many_feedback', '今天提交的反馈过多，请明天再试', { retryAfterSec: limited.retryAfterSec })
      return
    }
    const body = parseJsonBody(meta.raw)
    const result = feedback.add({
      deviceId: device.deviceId,
      category: body.category,
      text: body.text,
      contact: body.contact,
      diagnostics: body.diagnostics,
      // 完整日志文件（客户端打包的应用+后端日志），服务端单独落盘
      logs: body.logs,
      client: String(req.headers['x-ds-client'] || ''),
      build: body.build,
      version: body.version,
      ip: ctx.ip(req)
    })
    if (!result.ok) {
      sendError(res, 400, result.reason || 'invalid_feedback', '反馈内容不能为空')
      return
    }
    feedbackFailures.hit(device.deviceId)
    store.audit('feedback_received', {
      deviceId: device.deviceId,
      feedbackId: result.entry.id,
      category: result.entry.category,
      logBytes: result.entry.log ? result.entry.log.bytes : 0
    })
    // 不回显正文：设备端只需要知道提交成功
    sendJson(res, 200, { ok: true, id: result.entry.id, serverTime: now() })
  })

  router.get('/v1/models', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return
    // 客户端拉取的是内置服务后台的模型目录，不在这里请求上游。
    // 上游是否有该模型由管理员配置时确认，运行期列表必须稳定、可预测。
    const list = provider.models()
    sendJson(res, 200, {
      object: 'list',
      data: list.map((m, i) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(startedAt / 1000) + i,
        owned_by: m.owned_by || config.provider.name
      }))
    }, { 'Cache-Control': 'private, max-age=60' })
  })

  // ---------- 网页搜索/抓取代理（Tool call 执行点） ----------
  //
  // 客户端在「联网搜索」开启时向模型注入 web_search / fetch_page 工具；
  // 模型发起 tool call 后，设备统一到这里执行——无论聊天走内置服务还是
  // 自定义端点，搜索本身都经过内置服务网关：DeepSeek Key 只存服务端，
  // 设备侧零密钥，且这里可以做审计与限额。
  // 协议与官方一致：POST /v1/tools/search、POST /v1/tools/fetch。
  async function handleToolRequest(req, res, meta, kind) {
    const device = guardDevice(req, res, meta)
    if (!device) return
    const tcfg = config.tools
    if (!tcfg.enabled) {
      sendError(res, 403, 'tools_disabled', '该服务未开启网页搜索')
      return
    }
    if (!toolsClient.configured) {
      sendError(res, 503, 'tools_not_configured', '网页搜索服务尚未配置，请联系服务管理员')
      return
    }

    // 每设备每天次数（0 = 不限）。注意：参数校验通过后才计数，
    // 非法请求不占用当日额度。
    const body = parseJsonBody(meta.raw)
    let upstreamBody
    if (kind === 'search') {
      const query = String((body && body.query) || '').trim()
      if (!query || query.length > 128) {
        sendError(res, 400, 'invalid_request', 'query 必须为 1~128 个非空白字符')
        return
      }
      const count = Math.min(Math.max(Math.trunc(Number(body.count) || 5), 1), tcfg.maxCount)
      upstreamBody = { query, count, need_content: body.need_content === true }
      const ori = String(body.ori_question || '').trim()
      if (ori) upstreamBody.ori_question = ori.slice(0, 128)
    } else {
      const target = String((body && body.url) || '').trim()
      const bad = validateTargetUrl(target)
      if (bad) {
        sendError(res, 400, 'invalid_request', bad)
        return
      }
      upstreamBody = { url: target }
    }

    if (tcfg.perDayPerDevice > 0) {
      const day = dayKey(now())
      let u = toolsUsage.get(device.deviceId)
      if (!u || u.day !== day) {
        u = { day, count: 0 }
        toolsUsage.set(device.deviceId, u)
      }
      if (u.count >= tcfg.perDayPerDevice) {
        const retryAfterSec = Math.max(60, Math.ceil((nextDayAt(now()) - now()) / 1000))
        store.audit('tool_daily_limit', { deviceId: device.deviceId, ip: ctx.ip(req), count: u.count })
        sendError(res, 429, 'tools_daily_limit', '今天的联网搜索次数已用完，请明天再试', { retryAfterSec })
        return
      }
      u.count += 1
    }

    // 全局在途上限：搜索上游有账号级 QPS 限制，防个别设备连发打满
    if (toolsInflight.current >= tcfg.maxInflight) {
      sendError(res, 429, 'tools_busy', '搜索服务繁忙，请稍后再试', { retryAfterSec: 2 })
      return
    }

    toolsInflight.current += 1
    let released = false
    const releaseTools = () => {
      if (released) return
      released = true
      toolsInflight.current = Math.max(0, toolsInflight.current - 1)
    }

    let aborted = false
    const abortCtl = new AbortController()
    const onClientClose = () => {
      if (!res.writableEnded) {
        aborted = true
        abortCtl.abort()
      }
    }
    res.on('close', onClientClose)

    try {
      let r
      try {
        r = await toolsClient.request(
          kind === 'search' ? 'tools/search' : 'tools/fetch',
          upstreamBody,
          { signal: abortCtl.signal, timeoutMs: tcfg.timeoutMs }
        )
      } catch (e) {
        releaseTools()
        if (e instanceof ToolsError) {
          if (e.code === 'client_aborted') return
          sendError(res, e.status, e.code, e.message)
          return
        }
        throw e
      }

      try {
        if (!r.resp.ok) {
          const info = await ToolsClient.describeError(r.resp)
          releaseTools()
          const status = r.resp.status === 429 ? 429 : (r.resp.status >= 500 || r.resp.status === 401 ? 502 : r.resp.status)
          const code = r.resp.status === 429 ? 'tools_rate_limited' : 'tools_upstream_error'
          store.audit(kind === 'search' ? 'tool_search_fail' : 'tool_fetch_fail', {
            deviceId: device.deviceId,
            ip: ctx.ip(req),
            status: r.resp.status,
            message: info.message.slice(0, 160)
          })
          sendError(res, status, code, info.message)
          return
        }

        const text = await r.resp.text()
        let data = null
        try {
          data = JSON.parse(text)
        } catch (_) {
          data = null
        }
        if (!data) {
          releaseTools()
          sendError(res, 502, 'tools_upstream_error', '搜索服务响应解析失败')
          return
        }

        // 钳制响应体积：笔端内存与回传请求体都吃紧，长文不需要全量
        if (kind === 'search') {
          const results = Array.isArray(data.results) ? data.results : []
          const maxChars = tcfg.resultMaxChars
          const slim = results.slice(0, tcfg.maxCount).map((x) => ({
            title: String((x && x.title) || '').slice(0, 200),
            url: String((x && x.url) || ''),
            snippet: String((x && x.snippet) || '').slice(0, 400),
            summary: String((x && x.summary) || '').slice(0, maxChars),
            content: String((x && x.content) || '').slice(0, maxChars),
            date: (x && x.date) || null,
            site_name: (x && x.site_name) || null,
            authority: Number.isFinite(x && x.authority) ? x.authority : -1
          }))
          sendJson(res, 200, { results: slim })
        } else {
          const content = String(data.content || '')
          const truncated = content.length > tcfg.fetchMaxChars
          sendJson(res, 200, {
            title: String(data.title || ''),
            content: truncated ? content.slice(0, tcfg.fetchMaxChars) : content,
            truncated
          })
        }
        store.audit(kind === 'search' ? 'tool_search' : 'tool_fetch', {
          deviceId: device.deviceId,
          ip: ctx.ip(req),
          q: kind === 'search'
            ? String(upstreamBody.query).slice(0, 80)
            : String(upstreamBody.url).slice(0, 120)
        })
      } finally {
        releaseTools()
      }
    } finally {
      res.removeListener('close', onClientClose)
      if (aborted) releaseTools()
    }
  }

  router.post('/v1/tools/search', (req, res, meta) => handleToolRequest(req, res, meta, 'search'))
  router.post('/v1/tools/fetch', (req, res, meta) => handleToolRequest(req, res, meta, 'fetch'))

  router.post('/v1/chat/completions', async (req, res, meta) => {
    const device = guardDevice(req, res, meta)
    if (!device) return

    // 单设备停用：只拦聊天，云控/上报/会话仍可访问，便于设备看到恢复提示
    if (deviceDisabled(device)) {
      store.audit('device_disabled', { deviceId: device.deviceId, ip: ctx.ip(req) })
      sendError(res, 403, 'device_disabled', '该设备已被管理员停用，请联系服务提供者')
      return
    }

    // 云控维护窗口：服务端也拦一道，避免客户端绕过界面限制继续发（白名单设备除外）
    const ctl = maintenanceOn(device)
    if (ctl) {
      sendJson(res, 503, {
        error: {
          code: 'maintenance',
          message: ctl.message || '服务正在维护，请稍后再试',
          type: 'upstream_gateway_error'
        },
        maintenance: ctl
      }, { 'Retry-After': '60' })
      return
    }

    // 限额：并发 / RPM / TPM / 5 小时 Token / 今日 Token / 本月 Token，
    // 逐项判定并把完整剩余量回给客户端（设置页据此展示具体是哪一项用完了）。
    const quota = quotaOf(device)
    if (quota.enabled && quota.exhausted) {
      const reason = quota.blockedBy
      const section = (quota.items || []).filter((x) => x.key === reason)[0] || null
      const limit = section ? section.limit : 0
      let message = '额度已用完，请稍后再试'
      if (reason === 'maxConcurrent') {
        message = '该设备并发请求已达上限（' + limit + '），请稍后再试'
      } else if (reason === 'rpm') {
        message = '每分钟请求数已达上限（' + limit + ' RPM），请稍后再试'
      } else if (reason === 'tpm') {
        message = '每分钟 Token 用量已达上限（' + limit + ' TPM），请稍后再试'
      } else if (reason === 'fiveHourTokens') {
        message = '5 小时 Token 额度已用完（' + limit + '），将随窗口滚动逐步恢复'
      } else if (reason === 'dailyTokens') {
        message = '今日 Token 额度已用完（' + limit + '），次日 00:00（UTC）重置'
      } else if (reason === 'monthlyTokens') {
        message = '本月 Token 额度已用完（' + limit + '），下月 1 日重置'
      }
      const retryAfterSec = Math.max(1, Math.ceil((((section && section.resetAt) || now()) - now()) / 1000))
      store.audit('quota_exceeded', { deviceId: device.deviceId, ip: ctx.ip(req), reason })
      sendJson(res, 429, {
        error: {
          code: 'quota_exceeded',
          reason,
          message,
          type: 'upstream_gateway_error'
        },
        quota
      }, { 'Retry-After': String(retryAfterSec) })
      return
    }

    if (globalConcurrency.current >= config.rate.maxConcurrentGlobal) {
      sendError(res, 429, 'server_busy', '服务并发已满，请稍后重试', { retryAfterSec: 3 })
      return
    }
    const concLimit = quota.limits ? Number(quota.limits.maxConcurrent) || 0 : 0
    const concurrent = guard.enter(device.deviceId)
    if (concLimit > 0 && concurrent > concLimit) {
      guard.leave(device.deviceId)
      store.audit('concurrency_exceeded', { deviceId: device.deviceId, ip: ctx.ip(req), concurrent, limit: concLimit })
      sendError(res, 429, 'device_concurrency_exceeded', '该设备并发请求过多（上限 ' + concLimit + '），请稍后再试', { retryAfterSec: 2 })
      return
    }
    globalConcurrency.current += 1
    let released = false
    let counted = true
    const release = () => {
      if (released) return
      released = true
      if (counted) globalConcurrency.current = Math.max(0, globalConcurrency.current - 1)
      guard.leave(device.deviceId)
    }

    let aborted = false
    const abortCtl = new AbortController()
    const onClientClose = () => {
      if (!res.writableEnded) {
        aborted = true
        abortCtl.abort()
      }
    }
    res.on('close', onClientClose)

    try {
      const body = parseJsonBody(meta.raw)
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendError(res, 400, 'invalid_request', 'messages 必须是非空数组')
        return
      }
      // 云控提示词注入（服务端执行，客户端不可关闭/不可见）
      const ctlView = controlView(store.getDevice(device.deviceId) || device)
      const injection = effectivePrompt(ctlView)
      if (injection) {
        body.messages = injectPrompt(body.messages, injection)
        res.setHeader('X-Ds-Prompt', 'injected')
        const last = promptAuditAt.get(device.deviceId) || 0
        if (now() - last > 10 * 60 * 1000) {
          promptAuditAt.set(device.deviceId, now())
          store.audit('prompt_injected', {
            deviceId: device.deviceId,
            chars: (injection.system + injection.append).length
          })
        }
      }
      // 严格按后台模型目录解析：不在目录里的模型直接拒绝，
      // 不再原样透传给上游（错误信息由内置服务统一给出）。
      try {
        const resolved = provider.resolveModel(body.model)
        body.model = resolved.upstream
      } catch (e) {
        if (e instanceof ProviderError) {
          store.audit('model_rejected', {
            deviceId: device.deviceId,
            model: String(body.model || '').slice(0, 80),
            code: e.code,
            ip: ctx.ip(req)
          })
          sendError(res, e.status, e.code, e.message)
          return
        }
        throw e
      }
      // 附件协议适配：客户端沿用 ds-free-api 私有的 type:'file'/file_data
      // 内容块，官方 API 没有文档上传通道，原样透传会被上游 400 拒绝。
      // 这里在网关侧把文件真正解析掉：图片走视觉通道、文档/文本提取正文
      // 内联为 text、无法解析的给出明确系统提示（不编造内容）。
      body.messages = normalizeMessageAttachments(body.messages)
      // 联网工具能力说明：请求带了 web_search / fetch_page 就补进 system，
      // 避免模型"抱着工具喊自己上不了网"（见 TOOL_USE_DIRECTIVE 注释）。
      if (hasWebTools(body) && !hasToolDirective(body.messages)) {
        body.messages = injectPrompt(body.messages, { system: '', append: TOOL_USE_DIRECTIVE })
        res.setHeader('X-Ds-Tools', 'injected')
      }
      const stream = body.stream === true
      const bodyText = JSON.stringify(body)

      if (!provider.configured) {
        sendError(res, 503, 'provider_not_configured', '上游服务尚未配置，请联系管理员')
        return
      }

      let upstream
      try {
        upstream = await provider.chat(bodyText, { signal: abortCtl.signal })
      } catch (e) {
        if (e instanceof ProviderError) {
          if (e.code === 'client_aborted') return
          // 连不上/超时/未配置都是网关侧错误（scope=gateway）；审计带上 scope 便于后台区分
          store.audit('provider_error', { deviceId: device.deviceId, code: e.code, message: e.message, scope: 'gateway' })
          sendError(res, e.status, e.code, e.message)
          return
        }
        throw e
      }

      const { resp, cleanup } = upstream

      // 上游非 2xx：把状态码与脱敏后的 message 回给设备（不泄露 provider key）。
      // scope=upstream + upstreamStatus：明确告诉客户端/后台「这是上游透传错误」。
      // 内容审核误拦（sensitive_words_detected 等）单独映射：设备端显示友好中文，
      // 而不是裸的英文错误 + request id（旧版客户端也直接受益，无需发版）。
      if (!resp.ok) {
        const info = await ProviderClient.describeError(resp)
        cleanup()
        const moderation = classifyUpstreamError(info.message || info.raw)
        store.audit('provider_error', {
          deviceId: device.deviceId,
          status: resp.status,
          code: moderation ? moderation.code : 'provider_error',
          message: info.message.slice(0, 300),
          scope: 'upstream'
        })
        const status = resp.status === 429 ? 429 : (resp.status >= 500 ? 502 : resp.status)
        let code = resp.status === 429 ? 'upstream_rate_limited' : 'provider_error'
        let message = info.message || ('上游返回 HTTP ' + resp.status)
        if (moderation) {
          code = moderation.code
          message = moderation.message
        }
        sendError(res, status, code, message, { scope: 'upstream', upstreamStatus: resp.status })
        return
      }

      if (!stream) {
        try {
          const text = await resp.text()
          const usage = extractUsageFromJson(text)
          if (usage) store.recordTokens(device.deviceId, usage)
          res.writeHead(200, {
            'Content-Type': resp.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Upstream-Request-Id': meta.requestId
          })
          res.end(text)
        } catch (e) {
          if (aborted) return
          throw e
        } finally {
          cleanup()
        }
        return
      }

      // ---- SSE 透传 ----
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Upstream-Request-Id': meta.requestId
      })
      res.flushHeaders && res.flushHeaders()

      const tap = new SseUsageTap()
      let idleTimer = null
      let idleTimedOut = false
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          abortCtl.abort()
        }, config.provider.idleTimeoutMs)
        if (idleTimer.unref) idleTimer.unref()
      }
      resetIdle()

      try {
        if (!resp.body) {
          if (!aborted) res.end()
          return
        }
        const bodyStream = Readable.fromWeb(resp.body)
        for await (const chunk of bodyStream) {
          if (aborted) break
          resetIdle()
          tap.push(chunk)
          if (!res.write(chunk)) {
            // 客户端读得慢时等 drain；但客户端断开后 drain 不会再来，必须同时等 close
            await new Promise((resolve) => {
              const done = () => {
                res.removeListener('drain', done)
                res.removeListener('close', done)
                resolve()
              }
              res.once('drain', done)
              res.once('close', done)
            })
          }
        }
        if (tap.usage) store.recordTokens(device.deviceId, tap.usage)
        if (!aborted) res.end()
      } catch (e) {
        if (!aborted) {
          const code = idleTimedOut ? 'upstream_idle_timeout' : 'upstream_stream_error'
          const message = idleTimedOut ? '上游长时间无数据，连接已中断' : '上游流式连接中断'
          store.audit('stream_error', { deviceId: device.deviceId, code, message: e.message })
          try {
            res.write('data: ' + JSON.stringify({ error: { code, message, type: 'upstream_gateway_error' } }) + '\n\n')
            res.write('data: [DONE]\n\n')
          } catch (_) { /* 客户端可能已断开 */ }
          res.end()
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        cleanup()
      }
    } finally {
      res.removeListener('close', onClientClose)
      release()
    }
  })

  // 未匹配路由
  async function handler(req, res) {
    const startedReq = Date.now()
    const requestId = 'req_' + randomHex(6)
    const url = req.url || '/'
    const pathname = splitPath(url)
    const method = String(req.method || 'GET').toUpperCase()

    // 请求体上限：流式聊天也不需要超大 body（图片以 data URL 内联时可能几 MB）
    let raw = Buffer.alloc(0)
    let matched = null
    try {
      matched = router.match(method, pathname)
    } catch (e) {
      sendError(res, 400, 'bad_request', e.message)
      return
    }

    try {
      if (!matched) {
        // 未匹配路径也可能来自"已配对设备"（扫描器/被反代）。带签名头就尽量验一次，
        // 命中扫描特征可以当场封禁；验签失败仍按 404 回，不泄露路由表。
        if (req.headers['x-ds-device-id'] && req.headers['x-ds-signature']) {
          let probeRaw = raw
          if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            try { probeRaw = await readBody(req, config.server.bodyLimitBytes) } catch (_) { probeRaw = Buffer.alloc(0) }
          }
          const auth = authenticate(req, probeRaw)
          if (auth.ok) {
            const assessment = guard.assess(auth.device, req, { path: req.url, rawBody: probeRaw, clientIp: ctx.ip(req) })
            if (assessment.blocked) {
              sendError(res, 403, 'device_blocked', '设备因异常流量被临时限制，请联系管理员解除', {
                retryAfterSec: assessment.retryAfterSec
              })
              return
            }
          }
        }
        sendError(res, 404, 'not_found', '接口不存在：' + pathname)
        return
      }
      if (!matched.handler) {
        sendError(res, 405, 'method_not_allowed', '不支持的方法：' + method + ' ' + pathname)
        return
      }
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        // 文件上传走高上限（应用包最大 64MB），其它接口仍用配置值
        const limit = pathname === '/admin/api/files'
          ? Math.max(config.server.bodyLimitBytes, 64 * 1024 * 1024)
          : config.server.bodyLimitBytes
        raw = await readBody(req, limit)
      }
      // 管理接口与配对接口在进入处理器前解析 JSON；
      // /v1/* 必须先验签（用原始字节算 hash）再解析，不能在这里提前解析。
      // 文件上传是二进制，不解析 JSON。
      let body = null
      if (raw.length && (pathname === '/auth/pair' || pathname === '/admin' || pathname.startsWith('/admin/'))) {
        if (pathname !== '/admin/api/files') body = parseJsonBody(raw)
      }
      const meta = {
        params: matched.params || {},
        query: parseQuery(url),
        raw,
        body,
        requestId,
        assessment: null
      }
      res.setHeader('X-Upstream-Request-Id', requestId)
      await matched.handler(req, res, meta)
    } catch (e) {
      if (res.headersSent) {
        try { res.end() } catch (_) { /* 忽略 */ }
      } else if (e instanceof HttpError) {
        sendError(res, e.status, e.code, e.message)
      } else {
        process.stderr.write('[server] 未处理异常 ' + requestId + '：' + (e && e.stack ? e.stack : e) + '\n')
        sendError(res, 500, 'internal_error', '网关内部错误')
      }
    } finally {
      const status = res.statusCode || 0
      store.recordRequest({
        deviceId: res._deviceId || '',
        path: pathname,
        status,
        durationMs: Date.now() - startedReq,
        billable: pathname === '/v1/chat/completions' && status >= 200 && status < 300
      })
    }
  }

  return {
    handler,
    router,
    store,
    provider,
    guard,
    nonceCache,
    telemetry,
    deviceControl,
    files,
    releases,
    debugQueue,
    ctx,
    startedAt,
    close() {
      store.close()
      sessions.close()
      feedback.close()
      telemetry.close()
      debugQueue.close()
    }
  }
}

// sha256 别名（避免在 server.js 顶部再 import 一次 crypto 全家桶）
function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')
}

export function createServer(opts = {}) {
  const { config, configPath, fileLoaded, fetchImpl } = opts
  const app = createApp({ config, configPath, fileLoaded, fetchImpl })
  const server = http.createServer(app.handler)
  server.requestTimeout = 0
  server.headersTimeout = 65 * 1000
  server.keepAliveTimeout = 65 * 1000
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  const sweeper = setInterval(() => {
    app.nonceCache.sweep()
    app.guard.sweep()
    app.ctx.store.prunePairings()
  }, 60 * 1000)
  if (sweeper.unref) sweeper.unref()

  const originalClose = server.close.bind(server)
  server.close = (cb) => {
    clearInterval(sweeper)
    app.close()
    return originalClose(cb)
  }

  return { server, app }
}

// ---------- CLI 启动 ----------

function isMain() {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
    return entry.toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
  } catch (_) {
    return false
  }
}

if (isMain()) {
  const { config, warnings, configPath, fileLoaded } = loadConfig()
  for (const w of warnings) process.stderr.write('[config] 警告：' + w + '\n')

  const { server, app } = createServer({ config, configPath, fileLoaded })
  const host = config.server.host || '0.0.0.0'
  const port = config.server.port

  server.listen(port, host, () => {
    const addr = server.address()
    const actual = addr && typeof addr === 'object' ? addr.port : port
    process.stdout.write(
      '[upstream] 启动成功 http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + actual + '\n' +
      '[upstream] 配置文件：' + configPath + (fileLoaded ? '' : '（不存在，使用默认值）') + '\n' +
      '[upstream] 数据目录：' + config.dataDir + '\n' +
      '[upstream] Provider：' + (config.provider.baseUrl || '(未配置)') + '，模型：' + config.provider.defaultModel + '\n' +
      '[upstream] 管理后台：http://127.0.0.1:' + actual + '/admin' +
      (app.ctx.adminAuth.configured ? '（密码登录）' : '（首次需在本机设置密码）') + '\n'
    )
  })

  server.on('error', (e) => {
    process.stderr.write('[upstream] 启动失败：' + e.message + '\n')
    process.exitCode = 1
  })

  const shutdown = (sig) => {
    process.stdout.write('[upstream] 收到 ' + sig + '，正在关闭…\n')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 8000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // 未捕获异常不能把进程直接带走（会丢状态文件写入），记录后退出交给进程管理器重启
  process.on('unhandledRejection', (e) => {
    process.stderr.write('[upstream] unhandledRejection：' + (e && e.stack ? e.stack : e) + '\n')
  })
}
