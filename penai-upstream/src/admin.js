// 管理后台 API：密码登录、设备控制、云控、限额、上游、监控、审计。
//
// 鉴权：管理员在后台设置密码，登录后使用 HttpOnly 会话 Cookie。
// 首次部署通过本机回环地址初始化密码，不再使用固定 admin token。
//
// 路由处理器签名统一为 (req, res, meta)，meta = { params, query, body, raw }。
// 不用共享 ctx 挂请求体：并发请求会互相覆盖。

import fs from 'node:fs'
import path from 'node:path'
import { UPSTREAM_ROOT, redactConfig } from './config.js'
import { sendJson, sendError, sendText, normalizeIp } from './http.js'
import { AdminAuthError, adminCookie, clearAdminCookie, isHttps } from './admin-auth.js'
import { generatePairingCode, normalizePairingCode } from './auth.js'
import { CONTROL_FEATURES, CONTROL_LIMITS, DEFAULT_CONTROL, CONTROL_VERSION } from './control.js'
import { validateDeviceOverride } from './device-control.js'
import { MAX_FILE_BYTES } from './files.js'
import { inspectAmr } from './amr.js'
import { DEFAULT_QUOTA, QUOTA_ITEMS, QuotaConfigError } from './quota-config.js'
import { ProviderClient } from './provider.js'
import {
  PROVIDER_PRESETS,
  ProviderConfigError,
  normalizeProviderInput,
  redactProvider,
  saveProviderOverride,
  clearProviderOverride,
  cloneProvider
} from './provider-config.js'
import {
  ToolsConfigError,
  normalizeToolsInput,
  redactTools,
  saveToolsOverride,
  clearToolsOverride,
  cloneTools
} from './tools-config.js'

const ADMIN_HTML = path.join(UPSTREAM_ROOT, 'public', 'admin.html')
// 在线判定窗口：设备开启调试长轮询时每 ~25s 就有一次请求；普通设备也在
// reportSec（≥60s）上报一次。3 分钟足够区分「应用在前台」和「已离开」，
// 旧的 10 分钟窗口让离线设备长时间仍显示在线（后台状态看起来不实时）。
const ONLINE_WINDOW_MS = 3 * 60 * 1000

// 登录限速不能用 X-Forwarded-For 的第一段：它可由客户端伪造，
// 轮换该头即可绕过失败次数限制。Nginx 的 X-Real-IP 由 $remote_addr 覆盖，
// 直连时退回 socket 地址。
function adminIp(req) {
  const real = req.headers['x-real-ip']
  if (real) return normalizeIp(String(real).trim())
  return normalizeIp((req.socket && (req.socket.remoteAddress || req.socket.localAddress)) || '')
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '').trim()
  if (!origin) return true // 命令行/运维脚本不带 Origin
  try {
    const parsed = new URL(origin)
    return parsed.host === String(req.headers.host || '')
  } catch (_) {
    return false
  }
}

function requireAdmin(req, res, ctx) {
  const method = String(req.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !sameOrigin(req)) {
    sendError(res, 403, 'origin_denied', '管理请求来源不合法')
    return false
  }
  if (ctx.adminAuth.authenticate(req).ok) return true
  if (!ctx.adminAuth.configured) {
    sendError(res, 401, 'admin_setup_required', '管理员密码尚未设置，请先在服务器本机初始化')
  } else {
    ctx.store.audit('admin_auth_fail', { ip: adminIp(req), reason: 'missing_or_invalid_session' })
    sendError(res, 401, 'admin_unauthorized', '登录已失效，请重新输入后台密码')
  }
  return false
}

function deviceStateOf(d, now = Date.now()) {
  if (!d) return 'unknown'
  if (d.revokedAt) return 'revoked'
  if (d.blockedUntil && d.blockedUntil > now) return 'blocked'
  if (d.expiresAt && d.expiresAt < now) return 'expired'
  return 'active'
}

// 设备最近活跃时刻：状态上报（telemetry）与任意已签名请求（聊天/长轮询/云控）
// 都算。长轮询挂住期间虽然请求未返回，但入队唤醒/下一轮请求会持续刷新 lastSeenAt。
function lastActiveOf(d, tel) {
  return Math.max(Number(d && d.lastSeenAt) || 0, Number(tel && tel.reportedAt) || 0)
}

function publicDevice(d, ctx, { withQuota = false } = {}) {
  const now = Date.now()
  const runtime = ctx.guard ? ctx.guard.status(d.deviceId) : null
  const tel = ctx.telemetry.get(d.deviceId)
  const ctl = ctx.deviceControl.summary(d.deviceId)
  const out = {
    deviceId: d.deviceId,
    state: deviceStateOf(d, now),
    disabled: !!(ctl && ctl.disabled),
    maintenanceBypass: !!(ctl && ctl.maintenanceBypass),
    createdAt: d.createdAt || 0,
    issuedAt: d.issuedAt || 0,
    expiresAt: d.expiresAt || 0,
    revokedAt: d.revokedAt || 0,
    blockedUntil: d.blockedUntil || 0,
    blockReason: d.blockReason || '',
    lastSeenAt: d.lastSeenAt || 0,
    lastIp: d.lastIp || '',
    firstIp: d.firstIp || '',
    ua: d.ua || '',
    client: d.client || '',
    build: d.build || '',
    model: d.model || '',
    requestCount: d.requestCount || 0,
    errorCount: d.errorCount || 0,
    tokenCount: d.tokenCount || 0,
    dayRequests: d.dayRequests || 0,
    dayTokens: d.dayTokens || 0,
    monthTokens: d.monthTokens || 0,
    risk: Math.round((Number(d.risk) || 0) * 10) / 10,
    runtime,
    online: !!(d || tel) && now - lastActiveOf(d, tel) <= ONLINE_WINDOW_MS,
    debug: !!(tel && tel.debug),
    debugAt: (tel && tel.debugAt) || 0,
    rce: !!(ctl && ctl.debug && ctl.debug.rce),
    telemetry: tel
      ? {
          reportedAt: tel.reportedAt || 0,
          version: tel.version || '',
          build: tel.build || '',
          model: tel.model || '',
          page: tel.page || '',
          backendMode: tel.backendMode || '',
          reportCount: tel.reportCount || 0,
          conversations: (tel.stats && tel.stats.conversations) || 0,
          messages: (tel.stats && tel.stats.messages) || 0,
          lastError: tel.lastError || null
        }
      : null,
    control: ctl
  }
  if (withQuota && ctx.quotaOf) out.quota = ctx.quotaOf(d)
  return out
}

export function registerAdminRoutes(router, ctx) {
  // 带管理员鉴权的包装：所有 /admin/api/* 都走这里
  const admin = (fn) => (req, res, meta) => {
    if (!requireAdmin(req, res, ctx)) return
    return fn(req, res, meta || {})
  }

  const sendAuthError = (res, e) => {
    if (e instanceof AdminAuthError) {
      sendError(res, e.status, e.code, e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {})
      return true
    }
    return false
  }

  // ---- 管理员密码登录（公开端点，但登录成功后才有会话） ----
  router.get('/admin/api/auth/status', (req, res) => {
    sendJson(res, 200, Object.assign({ ok: true }, ctx.adminAuth.status(req)))
  })

  router.post('/admin/api/auth/login', (req, res, meta) => {
    if (!sameOrigin(req)) {
      sendError(res, 403, 'origin_denied', '登录请求来源不合法')
      return
    }
    const password = String(((meta && meta.body) || {}).password || '')
    const ip = adminIp(req)
    try {
      const session = ctx.adminAuth.login(password, { ip })
      ctx.store.audit('admin_login', { ip, ok: true })
      sendJson(res, 200, { ok: true, expiresAt: session.expiresAt }, {
        'Set-Cookie': adminCookie(session.token, session.expiresAt, isHttps(req))
      })
    } catch (e) {
      ctx.store.audit('admin_login', { ip, ok: false, code: e.code || '' })
      if (!sendAuthError(res, e)) throw e
    }
  })

  // 首次初始化只接受服务器本机回环直连（例如 SSH 隧道/本机 curl），
  // 防止服务刚上线、尚未设密码时被公网抢先占用。
  router.post('/admin/api/auth/setup', (req, res, meta) => {
    if (!sameOrigin(req)) {
      sendError(res, 403, 'origin_denied', '初始化请求来源不合法')
      return
    }
    const password = String(((meta && meta.body) || {}).password || '')
    try {
      const session = ctx.adminAuth.setup(password, { ip: adminIp(req), req })
      ctx.store.audit('admin_password_setup', { ip: adminIp(req) })
      sendJson(res, 200, { ok: true, expiresAt: session.expiresAt }, {
        'Set-Cookie': adminCookie(session.token, session.expiresAt, isHttps(req))
      })
    } catch (e) {
      if (!sendAuthError(res, e)) throw e
    }
  })

  router.post('/admin/api/auth/logout', (req, res) => {
    ctx.adminAuth.logout(req)
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearAdminCookie() })
  })

  router.post('/admin/api/auth/password', admin((req, res, meta) => {
    const body = meta.body || {}
    try {
      const session = ctx.adminAuth.changePassword(body.currentPassword, body.newPassword)
      ctx.store.audit('admin_password_changed', { ip: ctx.ip(req) })
      sendJson(res, 200, { ok: true, expiresAt: session.expiresAt }, {
        'Set-Cookie': adminCookie(session.token, session.expiresAt, isHttps(req))
      })
    } catch (e) {
      if (!sendAuthError(res, e)) throw e
    }
  }))

  router.post('/admin/api/auth/logout-all', admin((req, res) => {
    const count = ctx.adminAuth.logoutAll()
    ctx.store.audit('admin_logout_all', { ip: ctx.ip(req), count })
    sendJson(res, 200, { ok: true, count }, { 'Set-Cookie': clearAdminCookie() })
  }))

  // ---- 管理页 ----
  router.get('/admin', (req, res) => {
    try {
      const html = fs.readFileSync(ADMIN_HTML, 'utf8')
      sendText(res, 200, html, 'text/html; charset=utf-8')
    } catch (e) {
      sendText(res, 500, '管理页缺失：' + e.message)
    }
  })

  // ---- 概览 ----
  router.get('/admin/api/overview', admin((req, res) => {
    const devices = ctx.store.listDevices()
    const now = Date.now()
    const stats = ctx.store.snapshotStats()
    const day = new Date(now).toISOString().slice(0, 10)
    const monitor = ctx.telemetry.summary({ onlineMs: ONLINE_WINDOW_MS, eventsLimit: 20 })
    sendJson(res, 200, {
      ok: true,
      server: {
        version: ctx.version,
        startedAt: ctx.startedAt,
        uptimeSec: Math.floor((now - ctx.startedAt) / 1000),
        now
      },
      provider: {
        name: ctx.config.provider.name,
        baseUrl: ctx.config.provider.baseUrl,
        configured: !!ctx.provider.configured,
        defaultModel: ctx.config.provider.defaultModel,
        models: ctx.config.provider.models,
        modelMap: ctx.config.provider.modelMap
      },
      limits: {
        maxConcurrentGlobal: ctx.config.rate.maxConcurrentGlobal,
        tokenTtlSec: ctx.config.auth.tokenTtlSec,
        signatureWindowSec: ctx.config.auth.signatureWindowSec
      },
      guard: {
        enabled: ctx.config.guard.enabled,
        requireClientHeader: ctx.config.guard.requireClientHeader,
        riskThreshold: ctx.config.guard.riskThreshold,
        blockDurationSec: ctx.config.guard.blockDurationSec,
        maxIpsPerHour: ctx.config.guard.maxIpsPerHour
      },
      enroll: {
        enabled: !!ctx.config.auth.enroll.enabled,
        requiresToken: !!ctx.config.auth.enroll.token,
        maxDevices: ctx.config.auth.enroll.maxDevices,
        perIpPerDay: ctx.config.auth.enroll.perIpPerDay,
        rebindAllowed: !!ctx.config.auth.enroll.rebindAllowed
      },
      quota: Object.assign(
        { source: ctx.quotaOverride ? 'admin' : 'config', overridePath: ctx.quotaOverridePath },
        ctx.quotaSummary(ctx.config.quota)
      ),
      control: {
        enabled: !!ctx.config.control.enabled,
        version: CONTROL_VERSION,
        updatedAt: ctx.control.get().updatedAt || 0,
        maintenance: ctx.maintenancePending(),
        maintenanceMessage: ctx.control.get().maintenance.message || '',
        minBuild: ctx.control.get().update.minBuild || 0,
        latestBuild: ctx.control.get().update.latestBuild || 0,
        promptInjection: !!(ctx.control.get().prompt && ctx.control.get().prompt.enabled),
        debugRce: !!(ctx.control.get().debug && ctx.control.get().debug.rce),
        overrides: ctx.deviceControl.list().length,
        files: ctx.files.list().length
      },
      telemetry: {
        enabled: !!ctx.config.telemetry.enabled,
        online: monitor.online,
        reported: monitor.totalDevices,
        errorDevices: monitor.errorDevices
      },
      feedback: ctx.feedback.stats(),
      sessions: {
        enabled: !!ctx.config.sessions.enabled,
        maxPerDevice: ctx.config.sessions.maxPerDevice
      },
      counts: {
        devices: devices.length,
        activeDevices: devices.filter((d) => !d.revokedAt && (!d.expiresAt || d.expiresAt > now)).length,
        blockedDevices: devices.filter((d) => d.blockedUntil && d.blockedUntil > now).length,
        disabledDevices: devices.filter((d) => {
          const s = ctx.deviceControl.summary(d.deviceId)
          return !!(s && s.disabled)
        }).length,
        pairingsPending: ctx.store.listPairings().filter((p) => !p.used && p.expiresAt > now).length,
        debugDevices: ctx.telemetry.list().filter((r) => r.debug).length
      },
      today: stats.byDay[day] || { requests: 0, errors: 0, tokens: 0, devices: {} },
      totals: {
        since: stats.since,
        requests: stats.requests,
        errors: stats.errors,
        blocks: stats.blocks,
        pairingsCreated: stats.pairingsCreated,
        tokens: stats.tokens
      },
      nonceCache: ctx.nonceCache.map.size,
      monitor
    })
  }))

  router.get('/admin/api/config', admin((req, res) => {
    sendJson(res, 200, {
      ok: true,
      config: redactConfig(ctx.config),
      configPath: ctx.configPath,
      fileLoaded: ctx.fileLoaded
    })
  }))

  // ---- 上游（Provider）选择与热更新 ----
  router.get('/admin/api/provider', admin((req, res) => {
    sendJson(res, 200, {
      ok: true,
      provider: redactProvider(ctx.config.provider),
      configured: !!ctx.provider.configured,
      source: ctx.providerOverride ? 'admin' : 'config',
      overridePath: ctx.providerOverridePath,
      presets: PROVIDER_PRESETS
    })
  }))

  router.put('/admin/api/provider', admin((req, res, meta) => {
    let patch
    try {
      patch = normalizeProviderInput(meta.body || {}, ctx.config.provider)
    } catch (e) {
      if (e instanceof ProviderConfigError) {
        sendError(res, 400, 'invalid_provider', e.message)
        return
      }
      throw e
    }
    const next = Object.assign({}, ctx.config.provider, patch)
    if (!next.baseUrl) {
      sendError(res, 400, 'invalid_provider', '上游地址不能为空')
      return
    }
    try {
      saveProviderOverride(ctx.config.dataDir, next)
    } catch (e) {
      sendError(res, 500, 'provider_save_failed', '保存 Provider 配置失败：' + e.message)
      return
    }
    // 先落盘再生效：写失败时线上配置保持不变
    Object.assign(ctx.config.provider, patch)
    ctx.provider.invalidateModels()
    ctx.providerOverride = true
    ctx.store.audit('provider_updated', {
      baseUrl: next.baseUrl,
      defaultModel: next.defaultModel || '',
      name: next.name || '',
      apiKeyChanged: Object.prototype.hasOwnProperty.call(patch, 'apiKey'),
      ip: ctx.ip(req)
    })
    sendJson(res, 200, {
      ok: true,
      provider: redactProvider(ctx.config.provider),
      configured: !!ctx.provider.configured,
      source: 'admin'
    })
  }))

  // 测试：body.provider 为表单里的草稿（不落盘）；body.chat=true 时额外发一条 max_tokens=1 的对话
  router.post('/admin/api/provider/test', admin(async (req, res, meta) => {
    const body = meta.body || {}
    let target = ctx.config.provider
    if (body.provider && typeof body.provider === 'object') {
      try {
        const patch = normalizeProviderInput(body.provider, ctx.config.provider)
        target = Object.assign({}, ctx.config.provider, patch)
      } catch (e) {
        if (e instanceof ProviderConfigError) {
          sendError(res, 400, 'invalid_provider', e.message)
          return
        }
        throw e
      }
    }
    const client = new ProviderClient({ provider: target }, { fetchImpl: ctx.fetchImpl })
    const result = await client.probe({
      chat: body.chat === true,
      model: String(body.model || target.defaultModel || '')
    })
    ctx.store.audit('provider_tested', {
      ok: !!result.ok,
      code: result.code || '',
      baseUrl: target.baseUrl,
      chat: body.chat === true,
      ip: ctx.ip(req)
    })
    sendJson(res, 200, { ok: true, result, provider: redactProvider(target) })
  }))

  router.delete('/admin/api/provider', admin((req, res) => {
    try {
      clearProviderOverride(ctx.config.dataDir)
    } catch (e) {
      sendError(res, 500, 'provider_reset_failed', '删除 Provider 覆盖失败：' + e.message)
      return
    }
    Object.assign(ctx.config.provider, cloneProvider(ctx.providerBaseConfig))
    ctx.provider.invalidateModels()
    ctx.providerOverride = false
    ctx.store.audit('provider_reset', { baseUrl: ctx.config.provider.baseUrl, ip: ctx.ip(req) })
    sendJson(res, 200, {
      ok: true,
      provider: redactProvider(ctx.config.provider),
      configured: !!ctx.provider.configured,
      source: 'config'
    })
  }))

  // ---- 网页搜索/抓取代理（tools）配置：与 provider 同一套覆盖模式 ----
  router.get('/admin/api/tools', admin((req, res) => {
    sendJson(res, 200, {
      ok: true,
      tools: redactTools(ctx.config.tools),
      configured: !!(ctx.config.tools.enabled && ctx.config.tools.apiKey),
      source: ctx.toolsOverride ? 'admin' : 'config',
      overridePath: ctx.toolsOverridePath
    })
  }))

  router.put('/admin/api/tools', admin((req, res, meta) => {
    let patch
    try {
      patch = normalizeToolsInput(meta.body || {}, ctx.config.tools)
    } catch (e) {
      if (e instanceof ToolsConfigError) {
        sendError(res, 400, 'invalid_tools', e.message)
        return
      }
      throw e
    }
    const next = Object.assign({}, ctx.config.tools, patch)
    try {
      saveToolsOverride(ctx.config.dataDir, next)
    } catch (e) {
      sendError(res, 500, 'tools_save_failed', '保存搜索配置失败：' + e.message)
      return
    }
    // 先落盘再生效：写失败时线上配置保持不变
    Object.assign(ctx.config.tools, patch)
    ctx.toolsOverride = true
    ctx.store.audit('tools_updated', {
      enabled: next.enabled,
      baseUrl: next.baseUrl || '',
      apiKeyChanged: Object.prototype.hasOwnProperty.call(patch, 'apiKey'),
      ip: ctx.ip(req)
    })
    sendJson(res, 200, {
      ok: true,
      tools: redactTools(ctx.config.tools),
      configured: !!(ctx.config.tools.enabled && ctx.config.tools.apiKey),
      source: 'admin'
    })
  }))

  router.delete('/admin/api/tools', admin((req, res) => {
    try {
      clearToolsOverride(ctx.config.dataDir)
    } catch (e) {
      sendError(res, 500, 'tools_reset_failed', '删除搜索配置覆盖失败：' + e.message)
      return
    }
    Object.assign(ctx.config.tools, cloneTools(ctx.toolsBaseConfig))
    ctx.toolsOverride = false
    ctx.store.audit('tools_reset', { ip: ctx.ip(req) })
    sendJson(res, 200, {
      ok: true,
      tools: redactTools(ctx.config.tools),
      configured: !!(ctx.config.tools.enabled && ctx.config.tools.apiKey),
      source: 'config'
    })
  }))

  // 从上游拉取模型目录（GET {baseUrl}/models）：
  // 第三方聚合服务的模型名千奇百怪，靠手填必错；拉一次再选择性下发。
  // body.apply=true 时把拉到的列表直接写进 provider.models（保存并热生效），
  // 否则只回显，由管理员在「模型」页挑选。
  router.post('/admin/api/provider/pull-models', admin(async (req, res, meta) => {
    const body = meta.body || {}
    let target = ctx.config.provider
    if (body.provider && typeof body.provider === 'object') {
      try {
        const patch = normalizeProviderInput(body.provider, ctx.config.provider)
        target = Object.assign({}, ctx.config.provider, patch)
      } catch (e) {
        if (e instanceof ProviderConfigError) {
          sendError(res, 400, 'invalid_provider', e.message)
          return
        }
        throw e
      }
    }
    const client = new ProviderClient({ provider: target }, { fetchImpl: ctx.fetchImpl })
    const result = await client.probe({ chat: false })
    const models = Array.isArray(result.models) ? result.models : []
    let applied = false
    if (result.ok && body.apply === true && models.length) {
      let patch
      try {
        patch = normalizeProviderInput({
          models,
          defaultModel: String(body.defaultModel || target.defaultModel || models[0])
        }, ctx.config.provider)
      } catch (e) {
        if (e instanceof ProviderConfigError) {
          sendError(res, 400, 'invalid_models', e.message)
          return
        }
        throw e
      }
      const next = Object.assign({}, ctx.config.provider, patch)
      try {
        saveProviderOverride(ctx.config.dataDir, next)
      } catch (e) {
        sendError(res, 500, 'models_save_failed', '保存模型目录失败：' + e.message)
        return
      }
      Object.assign(ctx.config.provider, patch)
      ctx.provider.invalidateModels()
      ctx.providerOverride = true
      applied = true
      ctx.store.audit('models_pulled', { ip: ctx.ip(req), count: models.length, applied: true })
    }
    sendJson(res, 200, {
      ok: !!result.ok,
      result,
      models,
      applied,
      provider: redactProvider(target)
    })
  }))

  // ---- 模型目录（客户端 /v1/models 的唯一来源） ----
  const modelPayload = () => {
    const catalog = ctx.provider.catalogModels().map((m) => {
      const mapping = ctx.provider.resolveModel(m.id, { validate: false })
      return {
        id: m.id,
        owned_by: m.owned_by,
        upstream: mapping.upstream,
        mapped: mapping.upstream !== m.id
      }
    })
    return {
      models: catalog,
      configuredModels: (ctx.config.provider.models || []).slice(),
      defaultModel: ctx.config.provider.defaultModel || '',
      modelMap: ctx.config.provider.modelMap || {},
      count: catalog.length,
      source: ctx.providerOverride ? 'admin' : 'config'
    }
  }

  router.get('/admin/api/models', admin((req, res) => {
    sendJson(res, 200, Object.assign({ ok: true }, modelPayload()))
  }))

  router.put('/admin/api/models', admin((req, res, meta) => {
    const body = meta.body || {}
    const rawModels = Array.isArray(body.models)
      ? body.models
      : String(body.models == null ? '' : body.models).split(/[\r\n,]+/)
    let patch
    try {
      patch = normalizeProviderInput({
        models: rawModels,
        defaultModel: body.defaultModel,
        modelMap: body.modelMap
      }, ctx.config.provider)
    } catch (e) {
      if (e instanceof ProviderConfigError) {
        sendError(res, 400, 'invalid_models', e.message)
        return
      }
      throw e
    }
    const next = Object.assign({}, ctx.config.provider, patch)
    if (!next.models.length) {
      sendError(res, 400, 'empty_model_catalog', '模型目录至少需要一个模型')
      return
    }
    if (!next.defaultModel) {
      sendError(res, 400, 'default_model_required', '请设置默认模型')
      return
    }
    const allowed = new Set(next.models.concat(Object.keys(next.modelMap || {})))
    if (!allowed.has(next.defaultModel)) {
      sendError(res, 400, 'default_model_not_in_catalog', '默认模型必须在模型目录或模型映射中')
      return
    }
    try {
      saveProviderOverride(ctx.config.dataDir, next)
    } catch (e) {
      sendError(res, 500, 'models_save_failed', '保存模型目录失败：' + e.message)
      return
    }
    Object.assign(ctx.config.provider, patch)
    ctx.provider.invalidateModels()
    ctx.providerOverride = true
    ctx.store.audit('models_updated', {
      ip: ctx.ip(req),
      models: next.models,
      defaultModel: next.defaultModel,
      mapped: Object.keys(next.modelMap || {}).length
    })
    sendJson(res, 200, Object.assign({ ok: true }, modelPayload()))
  }))

  // ---- 配对码（备选开户流程，默认走设备静默注册） ----
  router.get('/admin/api/pairings', admin((req, res) => {
    const now = Date.now()
    const list = ctx.store.listPairings().map((p) => Object.assign({}, p, {
      state: p.used ? 'used' : (p.expiresAt < now ? 'expired' : (p.approved ? 'approved' : 'pending'))
    }))
    sendJson(res, 200, { ok: true, pairings: list })
  }))

  router.post('/admin/api/pairings', admin((req, res, meta) => {
    const body = meta.body || {}
    const code = normalizePairingCode(body.code) || generatePairingCode()
    if (ctx.store.getPairing(code)) {
      sendError(res, 409, 'pairing_code_exists', '该配对码已存在')
      return
    }
    const ttlSec = Number(body.ttlSec) > 0 ? Math.min(3600, Number(body.ttlSec)) : ctx.config.auth.pairingTtlSec
    const entry = ctx.store.createPairing(code, {
      deviceId: String(body.deviceId || ''),
      approved: body.approved !== false,
      ttlSec,
      source: 'admin'
    })
    ctx.store.audit('pairing_created', { code: entry.code, deviceId: entry.deviceId || '', ip: ctx.ip(req), source: 'admin' })
    sendJson(res, 200, { ok: true, pairing: entry })
  }))

  router.post('/admin/api/pairings/approve', admin((req, res, meta) => {
    const body = meta.body || {}
    const code = normalizePairingCode(body.code)
    if (!code) {
      sendError(res, 400, 'missing_code', '缺少 code')
      return
    }
    const deviceId = String(body.deviceId || '').trim()
    let entry = ctx.store.getPairing(code)
    if (!entry) {
      const ttlSec = Number(body.ttlSec) > 0 ? Math.min(3600, Number(body.ttlSec)) : ctx.config.auth.pairingTtlSec
      entry = ctx.store.createPairing(code, { deviceId, approved: true, ttlSec, source: 'device' })
      ctx.store.audit('pairing_created', { code, deviceId, ip: ctx.ip(req), source: 'device' })
    } else {
      entry = ctx.store.approvePairing(code, { deviceId, ttlSec: ctx.config.auth.pairingTtlSec })
    }
    ctx.store.audit('pairing_approved', { code, deviceId: entry.deviceId || deviceId, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, pairing: entry })
  }))

  router.post('/admin/api/pairings/:code/approve', admin((req, res, meta) => {
    const code = normalizePairingCode(meta.params.code)
    const entry = ctx.store.getPairing(code)
    if (!entry) {
      sendError(res, 404, 'pairing_code_not_found', '配对码不存在')
      return
    }
    ctx.store.approvePairing(code, {
      deviceId: String((meta.body || {}).deviceId || ''),
      ttlSec: ctx.config.auth.pairingTtlSec
    })
    ctx.store.audit('pairing_approved', { code, deviceId: entry.deviceId || '', ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, pairing: ctx.store.getPairing(code) })
  }))

  router.delete('/admin/api/pairings/:code', admin((req, res, meta) => {
    const code = normalizePairingCode(meta.params.code)
    const ok = ctx.store.deletePairing(code)
    if (!ok) {
      sendError(res, 404, 'pairing_code_not_found', '配对码不存在')
      return
    }
    ctx.store.audit('pairing_deleted', { code, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true })
  }))

  // ---- 设备 ----
  router.get('/admin/api/devices', admin((req, res) => {
    const list = ctx.store.listDevices().map((d) => publicDevice(d, ctx, { withQuota: true }))
    sendJson(res, 200, { ok: true, devices: list, onlineWindowSec: ONLINE_WINDOW_MS / 1000 })
  }))

  // 批量操作：先于 /devices/:id 注册，避免 "bulk" 被当成设备 ID
  router.post('/admin/api/devices/bulk', admin((req, res, meta) => {
    const body = meta.body || {}
    const action = String(body.action || '')
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []
    if (!ids.length) {
      sendError(res, 400, 'missing_ids', '请选择至少一台设备')
      return
    }
    if (ids.length > 200) {
      sendError(res, 400, 'too_many_ids', '一次最多操作 200 台设备')
      return
    }
    const minutes = Number(body.minutes) > 0 ? Math.min(30 * 24 * 60, Number(body.minutes)) : 30
    const reason = String(body.reason || 'admin_bulk')
    const done = []
    for (const id of ids) {
      const d = ctx.store.getDevice(id)
      if (!d) continue
      if (action === 'block') ctx.store.blockDevice(id, Date.now() + minutes * 60 * 1000, reason)
      else if (action === 'unblock') ctx.store.unblockDevice(id)
      else if (action === 'revoke') ctx.store.revokeDevice(id, reason)
      else if (action === 'disable') ctx.deviceControl.set(id, { disabled: true, note: reason })
      else if (action === 'enable') {
        const ov = ctx.deviceControl.get(id)
        if (ov) {
          const next = Object.assign({}, ov, { disabled: false })
          ctx.deviceControl.set(id, next)
        }
      } else if (action === 'delete') {
        ctx.store.removeDevice(id)
        ctx.telemetry.remove(id)
        ctx.deviceControl.clear(id)
      } else {
        sendError(res, 400, 'unknown_action', '不支持的操作：' + action)
        return
      }
      done.push(id)
    }
    ctx.store.audit('admin_device_bulk', { action, count: done.length, reason, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, action, count: done.length, devices: done })
  }))

  router.get('/admin/api/devices/:id', admin((req, res, meta) => {
    const d = ctx.store.getDevice(meta.params.id)
    if (!d) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    const usage = ctx.store.usage(d.deviceId, Date.now()) || {}
    const tel = ctx.telemetry.get(d.deviceId)
    sendJson(res, 200, {
      ok: true,
      device: publicDevice(d, ctx),
      usage,
      quota: ctx.quotaOf(d),
      control: {
        override: ctx.deviceControl.get(d.deviceId),
        summary: ctx.deviceControl.summary(d.deviceId),
        effective: ctx.controlView(d),
        global: ctx.control.get()
      },
      debug: {
        effective: ctx.controlView(d).debug,
        queue: ctx.debugQueue.view(d.deviceId)
      },
      telemetry: tel
        ? Object.assign({}, tel, { online: Date.now() - lastActiveOf(d, tel) <= ONLINE_WINDOW_MS })
        : null,
      sessions: {
        enabled: !!ctx.config.sessions.enabled,
        stats: ctx.sessions.stats(d.deviceId),
        list: ctx.config.sessions.enabled ? ctx.sessions.list(d.deviceId).slice(0, 50) : []
      },
      audit: ctx.store.listAudit(400).filter((e) => e.deviceId === d.deviceId).slice(0, 40)
    })
  }))

  router.put('/admin/api/devices/:id/control', admin((req, res, meta) => {
    const d = ctx.store.getDevice(meta.params.id)
    if (!d) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    let ov
    try {
      validateDeviceOverride(meta.body || {})
      ov = ctx.deviceControl.set(d.deviceId, meta.body || {})
    } catch (e) {
      if (e && e.code === 'bad_override') {
        sendError(res, 400, e.code, e.message)
        return
      }
      throw e
    }
    ctx.store.audit('admin_device_control', {
      deviceId: d.deviceId,
      ip: ctx.ip(req),
      disabled: !!(ov && ov.disabled),
      features: Object.keys((ov && ov.features) || {}).length,
      quota: Object.keys((ov && ov.quota) || {}).length,
      update: !!(ov && ov.update),
      prompt: !!(ov && ov.prompt),
      debug: ov && ov.debug ? JSON.stringify(ov.debug) : '',
    })
    sendJson(res, 200, {
      ok: true,
      override: ov,
      summary: ctx.deviceControl.summary(d.deviceId),
      effective: ctx.controlView(d)
    })
  }))

  router.delete('/admin/api/devices/:id/control', admin((req, res, meta) => {
    const d = ctx.store.getDevice(meta.params.id)
    if (!d) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    ctx.deviceControl.clear(d.deviceId)
    ctx.store.audit('admin_device_control_clear', { deviceId: d.deviceId, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, override: null, summary: null, effective: ctx.controlView(d) })
  }))

  router.post('/admin/api/devices/:id/block', admin((req, res, meta) => {
    const id = meta.params.id
    if (!ctx.store.getDevice(id)) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    const body = meta.body || {}
    const minutes = Number(body.minutes) > 0 ? Math.min(30 * 24 * 60, Number(body.minutes)) : 30
    const until = Date.now() + minutes * 60 * 1000
    const reason = String(body.reason || 'admin_block')
    ctx.store.blockDevice(id, until, reason)
    ctx.store.audit('admin_device_block', { deviceId: id, until, reason, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, device: publicDevice(ctx.store.getDevice(id), ctx) })
  }))

  router.post('/admin/api/devices/:id/unblock', admin((req, res, meta) => {
    const id = meta.params.id
    if (!ctx.store.getDevice(id)) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    ctx.store.unblockDevice(id)
    ctx.store.audit('admin_device_unblock', { deviceId: id, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, device: publicDevice(ctx.store.getDevice(id), ctx) })
  }))

  router.post('/admin/api/devices/:id/revoke', admin((req, res, meta) => {
    const id = meta.params.id
    if (!ctx.store.getDevice(id)) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    ctx.store.revokeDevice(id, String((meta.body || {}).reason || 'admin_revoke'))
    ctx.store.audit('admin_device_revoke', { deviceId: id, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, device: publicDevice(ctx.store.getDevice(id), ctx) })
  }))

  router.delete('/admin/api/devices/:id', admin((req, res, meta) => {
    const id = meta.params.id
    const ok = ctx.store.removeDevice(id)
    if (!ok) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    ctx.telemetry.remove(id)
    ctx.deviceControl.clear(id)
    ctx.store.audit('admin_device_delete', { deviceId: id, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true })
  }))

  // 设备状态轻量端点：后台抽屉打开时 5s 轮询这个（不重拉整份设备详情，
  // 避免把管理员正在编辑的表单刷掉）
  router.get('/admin/api/devices/:id/status', admin((req, res, meta) => {
    const d = ctx.store.getDevice(meta.params.id)
    if (!d) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    const tel = ctx.telemetry.get(d.deviceId)
    sendJson(res, 200, {
      ok: true,
      deviceId: d.deviceId,
      state: deviceStateOf(d),
      online: Date.now() - lastActiveOf(d, tel) <= ONLINE_WINDOW_MS,
      lastSeenAt: d.lastSeenAt || 0,
      lastIp: d.lastIp || '',
      build: (tel && tel.build) || d.build || '',
      model: (tel && tel.model) || d.model || '',
      page: (tel && tel.page) || '',
      reportedAt: (tel && tel.reportedAt) || 0,
      reportCount: (tel && tel.reportCount) || 0,
      localStats: (tel && tel.stats) || null,
      lastError: (tel && tel.lastError) || null,
      debug: !!(tel && tel.debug),
      debugAt: (tel && tel.debugAt) || 0,
      serverNow: Date.now()
    })
  }))

  // ---- 监控：在线 / 版本分布 / 最近事件 ----
  router.get('/admin/api/monitor', admin((req, res, meta) => {
    const minutes = Math.max(1, Math.min(24 * 60, Number(meta.query.onlineMinutes) || 10))
    const summary = ctx.telemetry.summary({ onlineMs: minutes * 60 * 1000, eventsLimit: 120 })
    const devices = ctx.store.listDevices()
    const tel = ctx.telemetry
    sendJson(res, 200, {
      ok: true,
      server: { version: ctx.version, now: Date.now(), uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000) },
      enabled: !!ctx.config.telemetry.enabled,
      onlineMinutes: minutes,
      counts: {
        devices: devices.length,
        reported: summary.totalDevices,
        online: summary.online,
        offline: summary.offline,
        errorDevices: summary.errorDevices
      },
      versions: summary.versions,
      models: summary.models,
      events: summary.events,
      // 列表里附带在线状态，方便后台直接展示
      devices: devices.map((d) => {
        const rec = tel.get(d.deviceId)
        return {
          deviceId: d.deviceId,
          state: deviceStateOf(d),
          online: Date.now() - lastActiveOf(d, rec) <= minutes * 60 * 1000,
          reportedAt: rec ? rec.reportedAt : 0,
          version: rec ? rec.version : '',
          build: rec ? rec.build : '',
          model: rec ? rec.model : '',
          page: rec ? rec.page : '',
          lastError: rec ? rec.lastError : null
        }
      })
    })
  }))

  // ---- 审计 / 统计 ----
  router.get('/admin/api/audit', admin((req, res, meta) => {
    const limit = Number(meta.query.limit) > 0 ? Math.min(1000, Number(meta.query.limit)) : 100
    const type = String(meta.query.type || '').trim()
    const q = String(meta.query.q || '').trim().toLowerCase()
    let entries = ctx.store.listAudit(1000)
    if (type) entries = entries.filter((e) => String(e.type || '').indexOf(type) >= 0)
    if (q) {
      entries = entries.filter((e) => {
        const hay = [e.type, e.deviceId, e.ip, e.code, e.reason, e.model, e.message].filter(Boolean).join(' ').toLowerCase()
        return hay.indexOf(q) >= 0
      })
    }
    sendJson(res, 200, { ok: true, entries: entries.slice(0, limit), total: entries.length, types: auditTypes(ctx) })
  }))

  router.get('/admin/api/stats', admin((req, res, meta) => {
    const days = Math.max(1, Math.min(30, Number(meta.query.days) || 7))
    const stats = ctx.store.snapshotStats()
    const out = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      const v = stats.byDay[d] || { requests: 0, errors: 0, tokens: 0, devices: {} }
      out.push({
        day: d,
        requests: v.requests || 0,
        errors: v.errors || 0,
        tokens: v.tokens || 0,
        devices: Object.keys(v.devices || {}).length
      })
    }
    sendJson(res, 200, { ok: true, days: out, paths: stats.paths, tokens: stats.tokens })
  }))

  // ---- 云控 ----
  router.get('/admin/api/control', admin((req, res) => {
    sendJson(res, 200, {
      ok: true,
      control: ctx.control.get(),
      defaults: DEFAULT_CONTROL,
      enabled: !!ctx.config.control.enabled,
      meta: {
        version: CONTROL_VERSION,
        features: CONTROL_FEATURES,
        limits: CONTROL_LIMITS,
        publicUrl: ctx.config.server.publicUrl || ''
      },
      overrides: ctx.deviceControl.list().map((ov) => ({
        deviceId: ov.deviceId,
        disabled: !!ov.disabled,
        maintenanceBypass: !!ov.maintenanceBypass,
        updatedAt: ov.updatedAt || 0
      }))
    })
  }))

  router.put('/admin/api/control', admin((req, res, meta) => {
    let next
    try {
      next = ctx.control.update(meta.body || {})
    } catch (e) {
      sendError(res, 500, 'control_save_failed', e.message)
      return
    }
    ctx.store.audit('control_updated', {
      ip: ctx.ip(req),
      maintenance: !!next.maintenance.enabled,
      minBuild: next.update.minBuild,
      noticeId: next.noticeId || '',
      prompt: !!next.prompt.enabled,
      debugRce: !!next.debug.rce
    })
    sendJson(res, 200, { ok: true, control: next })
  }))

  // ---- 文件库（应用包需票据下载；普通资源保持公开） ----
  const fileUrl = (id) => ctx.files.urlOf(id, ctx.config.server.publicUrl)
  const withUrl = (f) => {
    const protectedUpdate = f.kind === 'update'
    return Object.assign({}, f, {
      url: protectedUpdate ? '' : fileUrl(f.id),
      downloadUrl: '/admin/api/files/' + encodeURIComponent(f.id) + '/download',
      protected: protectedUpdate
    })
  }

  router.get('/admin/api/files', admin((req, res, meta) => {
    const kind = String(meta.query.kind || '')
    sendJson(res, 200, {
      ok: true,
      files: ctx.files.list({ kind }).map(withUrl),
      maxBytes: MAX_FILE_BYTES,
      publicUrl: ctx.config.server.publicUrl || ''
    })
  }))

  // 原始二进制上传：Content-Type: application/octet-stream
  // 文件名/类型放在 X-File-Name / X-File-Kind 头里，避免 multipart 解析依赖。
  router.post('/admin/api/files', admin((req, res, meta) => {
    const raw = meta.raw || Buffer.alloc(0)
    if (!raw.length) {
      sendError(res, 400, 'empty_file', '文件内容为空')
      return
    }
    let name = String(req.headers['x-file-name'] || '')
    try { name = decodeURIComponent(name) } catch (_) { /* 保留原样 */ }
    let kind = String(req.headers['x-file-kind'] || 'file')
    if (['file', 'update', 'font', 'image', 'other'].indexOf(kind) < 0) kind = 'file'
    let note = String(req.headers['x-file-note'] || '')
    try { note = decodeURIComponent(note) } catch (_) { /* 保留原样 */ }
    let inspected = null
    let inspectError = ''
    if (kind === 'update' || /\.amr$/i.test(name || '')) {
      try {
        inspected = inspectAmr(raw, { name })
        if (!inspected.version) throw new Error('manifest.json 缺少 version')
        if (!inspected.build) throw new Error('未能从包内提取构建号')
      } catch (e) {
        inspectError = e.message
      }
    }
    let item
    try {
      item = ctx.files.save({
        name: name || ('upload-' + Date.now() + '.bin'),
        buffer: raw,
        mime: String(req.headers['content-type'] || ''),
        kind,
        note,
        release: inspected
      })
    } catch (e) {
      sendError(res, 400, 'upload_failed', e.message)
      return
    }
    ctx.store.audit('file_uploaded', {
      fileId: item.id,
      name: item.name,
      size: item.size,
      kind: item.kind,
      build: item.build || 0,
      version: item.version || '',
      ip: ctx.ip(req)
    })
    sendJson(res, 200, {
      ok: true,
      file: Object.assign(withUrl(item), {
        inspectError,
        inspectSource: inspected ? inspected.source : ''
      })
    })
  }))

  // 后台下载：Cookie 鉴权，不受设备票据限制（用于管理员核对发布包）。
  router.get('/admin/api/files/:id/download', admin((req, res, meta) => {
    const item = ctx.files.get(String(meta.params.id || ''))
    if (!item) {
      sendError(res, 404, 'file_not_found', '文件不存在')
      return
    }
    const filePath = ctx.files.pathOf(item.id)
    let stat = null
    try { stat = fs.statSync(filePath) } catch (_) { stat = null }
    if (!stat || !stat.isFile()) {
      sendError(res, 410, 'file_missing', '文件记录存在但磁盘上已丢失')
      return
    }
    res.writeHead(200, {
      'Content-Type': item.mime || 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
      'Content-Length': stat.size,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-File-Sha256': item.sha256 || ''
    })
    fs.createReadStream(filePath).pipe(res)
  }))

  router.delete('/admin/api/files/:id', admin((req, res, meta) => {
    const id = String(meta.params.id || '')
    const item = ctx.files.get(id)
    if (!item) {
      sendError(res, 404, 'file_not_found', '文件不存在')
      return
    }
    ctx.files.remove(id)
    ctx.store.audit('file_deleted', { fileId: id, name: item.name, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true })
  }))

  // ---- 应用更新：上传 .amr 后发布；构建号/版本号从包内自动提取 ----
  function ensureReleaseMeta(item) {
    if (!item) return null
    if (item.build > 0) return item
    const filePath = ctx.files.pathOf(item.id)
    const buf = fs.readFileSync(filePath)
    const info = inspectAmr(buf, { name: item.name })
    if (!info.build) throw new Error('未能从 AMR 提取构建号（包内缺少 build 信息）')
    return ctx.files.updateRelease(item.id, info)
  }

  function updateFromRelease(item, input = {}) {
    const build = Math.trunc(Number(item.build) || Number(input.build) || 0)
    if (!Number.isFinite(build) || build <= 0) {
      throw new Error('构建号无效：无法从 AMR 提取，也没有手动提供')
    }
    const minBuild = Math.max(0, Math.trunc(Number(input.minBuild) || 0))
    if (minBuild > build) throw new Error('最低可用构建号不能大于最新构建号')
    return {
      latestBuild: build,
      minBuild,
      force: input.force === true,
      version: String(item.version || input.version || '').slice(0, 40),
      notes: String(input.notes || item.note || '').slice(0, 3000),
      // 不存公开下载地址：客户端拉云控时按设备现签票据。
      url: '',
      fileId: item.id,
      fileName: item.name,
      size: item.size,
      sha256: item.sha256,
      publishedAt: Date.now()
    }
  }

  function publishItem(item, body, req) {
    const update = updateFromRelease(item, body)
    const deviceIds = Array.isArray(body.deviceIds)
      ? body.deviceIds.map(String).filter(Boolean).slice(0, 200)
      : []
    if (deviceIds.length) {
      const done = []
      for (const id of deviceIds) {
        if (!ctx.store.getDevice(id)) continue
        ctx.deviceControl.set(id, { update })
        done.push(id)
      }
      if (!done.length) throw new Error('指定的设备都不存在')
      const release = ctx.releases.record(Object.assign({}, update, {
        scope: 'devices', deviceIds: done, name: item.name
      }))
      ctx.store.audit('update_published', {
        ip: ctx.ip(req), fileId: item.id, build: update.latestBuild, devices: done.length, releaseId: release.id
      })
      return { update, release, devices: done, scope: 'devices' }
    }
    const next = ctx.control.update({ update })
    const release = ctx.releases.record(Object.assign({}, next.update, {
      scope: 'global', name: item.name
    }))
    ctx.store.audit('update_published', {
      ip: ctx.ip(req), fileId: item.id, name: item.name, build: next.update.latestBuild,
      force: next.update.force, releaseId: release.id
    })
    return { update: next.update, release, devices: [], scope: 'global' }
  }

  router.post('/admin/api/update/publish', admin((req, res, meta) => {
    const body = meta.body || {}
    let item = ctx.files.get(String(body.fileId || ''))
    if (!item) {
      sendError(res, 400, 'file_not_found', '请先上传更新文件')
      return
    }
    try {
      item = ensureReleaseMeta(item)
      const out = publishItem(item, body, req)
      sendJson(res, 200, {
        ok: true,
        update: out.update,
        release: out.release,
        scope: out.scope,
        devices: out.devices,
        downloadUrl: '/admin/api/files/' + encodeURIComponent(item.id) + '/download',
        message: '已发布；更新包仅允许持有效设备票据下载'
      })
    } catch (e) {
      sendError(res, 400, 'publish_failed', e.message)
    }
  }))

  router.get('/admin/api/releases', admin((req, res) => {
    const cur = ctx.control.get().update || {}
    const releases = ctx.releases.list().map((r) => {
      const file = ctx.files.get(r.fileId)
      return Object.assign({}, r, {
        fileExists: !!file,
        current: !!cur.fileId && cur.fileId === r.fileId && Number(cur.publishedAt) === Number(r.publishedAt),
        downloadUrl: file ? '/admin/api/files/' + encodeURIComponent(r.fileId) + '/download' : ''
      })
    })
    sendJson(res, 200, {
      ok: true,
      current: cur,
      releases,
      maxFileBytes: MAX_FILE_BYTES
    })
  }))

  router.post('/admin/api/releases/:id/publish', admin((req, res, meta) => {
    const release = ctx.releases.get(meta.params.id)
    if (!release) {
      sendError(res, 404, 'release_not_found', '发布记录不存在')
      return
    }
    const item = ctx.files.get(release.fileId)
    if (!item) {
      sendError(res, 410, 'release_file_missing', '该版本的安装包已被删除，无法重新发布')
      return
    }
    try {
      const out = publishItem(item, {
        minBuild: release.minBuild,
        force: release.force,
        notes: release.notes,
        version: release.version,
        deviceIds: release.scope === 'devices' ? release.deviceIds : []
      }, req)
      sendJson(res, 200, { ok: true, update: out.update, release: out.release, scope: out.scope })
    } catch (e) {
      sendError(res, 400, 'republish_failed', e.message)
    }
  }))

  // ---- 远程调试：命令队列（只有云控授权 debug.rce 的设备会取走） ----
  router.get('/admin/api/devices/:id/debug', admin((req, res, meta) => {
    const id = String(meta.params.id || '')
    const d = ctx.store.getDevice(id)
    if (!d) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    const ctl = ctx.controlView(d)
    sendJson(res, 200, {
      ok: true,
      deviceId: id,
      debug: ctl.debug,
      queue: ctx.debugQueue.view(id),
      telemetry: ctx.telemetry.get(id)
    })
  }))

  router.post('/admin/api/devices/:id/debug/exec', admin((req, res, meta) => {
    const id = String(meta.params.id || '')
    const d = ctx.store.getDevice(id)
    if (!d) {
      sendError(res, 404, 'device_not_found', '设备不存在')
      return
    }
    const ctl = ctx.controlView(d)
    if (!ctl.debug.allow || !ctl.debug.rce) {
      sendError(res, 403, 'debug_not_allowed', '该设备未被授权远程执行（云控 debug.allow + debug.rce）')
      return
    }
    let item
    try {
      item = ctx.debugQueue.enqueue(id, Object.assign({}, meta.body || {}, { operator: 'admin' }))
    } catch (e) {
      sendError(res, 400, 'debug_enqueue_failed', e.message)
      return
    }
    ctx.store.audit('debug_command_queued', {
      deviceId: id, commandId: item.id, type: item.type, ip: ctx.ip(req)
    })
    sendJson(res, 200, { ok: true, command: item })
  }))

  router.delete('/admin/api/devices/:id/debug', admin((req, res, meta) => {
    const id = String(meta.params.id || '')
    ctx.debugQueue.clear(id)
    ctx.store.audit('debug_queue_cleared', { deviceId: id, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true })
  }))

  // ---- 限额（data/quota.json，保存即生效） ----
  router.get('/admin/api/quota', admin((req, res) => {
    sendJson(res, 200, {
      ok: true,
      quota: ctx.quotaSummary(ctx.config.quota),
      source: ctx.quotaOverride ? 'admin' : 'config',
      overridePath: ctx.quotaOverridePath,
      defaults: DEFAULT_QUOTA,
      items: QUOTA_ITEMS
    })
  }))

  router.put('/admin/api/quota', admin((req, res, meta) => {
    const body = meta.body && meta.body.quota ? meta.body.quota : (meta.body || {})
    let clean
    try {
      clean = ctx.normalizeQuotaInput(body, ctx.config.quota)
    } catch (e) {
      if (e instanceof QuotaConfigError) {
        sendError(res, 400, 'invalid_quota', e.message)
        return
      }
      throw e
    }
    try {
      ctx.saveQuotaOverride(clean)
    } catch (e) {
      sendError(res, 500, 'quota_save_failed', '保存限额配置失败：' + e.message)
      return
    }
    Object.assign(ctx.config.quota, clean)
    ctx.quotaOverride = true
    ctx.store.audit('quota_updated', {
      ip: ctx.ip(req),
      maxConcurrent: clean.maxConcurrent,
      rpm: clean.rpm,
      tpm: clean.tpm,
      fiveHourTokens: clean.fiveHourTokens,
      dailyTokens: clean.dailyTokens,
      monthlyTokens: clean.monthlyTokens
    })
    sendJson(res, 200, { ok: true, quota: ctx.quotaSummary(ctx.config.quota), source: 'admin', items: QUOTA_ITEMS })
  }))

  router.delete('/admin/api/quota', admin((req, res) => {
    try {
      ctx.clearQuotaOverride()
    } catch (e) {
      sendError(res, 500, 'quota_reset_failed', '删除限额覆盖失败：' + e.message)
      return
    }
    Object.assign(ctx.config.quota, ctx.quotaBaseConfig)
    ctx.quotaOverride = false
    ctx.store.audit('quota_reset', { ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, quota: ctx.quotaSummary(ctx.config.quota), source: 'config', items: QUOTA_ITEMS })
  }))

  // ---- 意见反馈 ----
  const feedbackQuery = (q = {}) => ({
    status: String(q.status || ''),
    category: String(q.category || ''),
    deviceId: String(q.deviceId || ''),
    q: String(q.q || ''),
    from: Number(q.from) || 0,
    to: Number(q.to) || 0,
    limit: Number(q.limit) || 100,
    offset: Number(q.offset) || 0
  })

  router.get('/admin/api/feedback', admin((req, res, meta) => {
    const opts = feedbackQuery(meta.query)
    const result = ctx.feedback.query(opts)
    sendJson(res, 200, {
      ok: true,
      feedback: result.items,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      stats: ctx.feedback.stats(),
      categories: ['bug', 'suggestion', 'other'],
      statuses: ['open', 'handled', 'ignored']
    })
  }))

  // 导出 CSV（放在 /:id 之前，避免 "export.csv" 被当成 id）
  router.get('/admin/api/feedback/export.csv', admin((req, res, meta) => {
    const csv = ctx.feedback.exportCsv(feedbackQuery(meta.query))
    const stamp = new Date().toISOString().slice(0, 10)
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="feedback-' + stamp + '.csv"',
      'Cache-Control': 'no-store'
    })
    res.end('\ufeff' + csv)
  }))

  // 完整日志下载：客户端上传的整份日志文件（text/plain，浏览器直接下载）。
  // 必须放在 /:id 之前：路由按段匹配，这里多一段 log，顺序其实不影响，
  // 但放在前面可以避免后续新增 /:id/* 通配时被误吞。
  router.get('/admin/api/feedback/:id/log', admin((req, res, meta) => {
    const entry = ctx.feedback.get(meta.params.id)
    if (!entry) {
      sendError(res, 404, 'feedback_not_found', '反馈不存在')
      return
    }
    const text = ctx.feedback.readLog(entry.id)
    if (!text) {
      sendError(res, 404, 'feedback_log_missing', '该反馈没有附带日志文件')
      return
    }
    const name = (entry.id || 'feedback') + '.log'
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Content-Length': Buffer.byteLength(text, 'utf8'),
      'Cache-Control': 'no-store'
    })
    res.end(text)
  }))

  router.get('/admin/api/feedback/:id', admin((req, res, meta) => {
    const entry = ctx.feedback.get(meta.params.id)
    if (!entry) {
      sendError(res, 404, 'feedback_not_found', '反馈不存在')
      return
    }
    // 完整日志按需读取：列表接口不带日志正文，详情才返回（可能几百 KB）。
    // 详情只回预览用的一段（尾部 128KB），整份走 /log 下载，避免后台抽屉卡顿。
    let logText = entry.log ? ctx.feedback.readLog(entry.id) : ''
    if (logText.length > 128 * 1024) {
      logText = '…（仅预览最近 128KB，完整日志请点「下载完整日志」）\n' + logText.slice(-128 * 1024)
    }
    sendJson(res, 200, { ok: true, entry, logText, logMeta: entry.log || null })
  }))

  // 统一更新：body.status 改状态；body.note 改备注（可只提交其中一个）
  router.post('/admin/api/feedback/:id', admin((req, res, meta) => {
    const body = meta.body || {}
    const id = meta.params.id
    const entry = ctx.feedback.get(id)
    if (!entry) {
      sendError(res, 404, 'feedback_not_found', '反馈不存在')
      return
    }
    let result = { ok: true, entry }
    if (body.status !== undefined && body.status !== '') {
      result = ctx.feedback.setStatus(id, String(body.status || ''), body.note)
    } else if (body.note !== undefined) {
      result = ctx.feedback.setNote(id, body.note)
    }
    if (!result.ok) {
      sendError(res, result.reason === 'not_found' ? 404 : 400, result.reason || 'invalid_status', '反馈状态更新失败')
      return
    }
    ctx.store.audit('feedback_updated', {
      feedbackId: id,
      status: result.entry.status,
      note: body.note !== undefined,
      ip: ctx.ip(req)
    })
    sendJson(res, 200, { ok: true, entry: result.entry, stats: ctx.feedback.stats() })
  }))

  router.post('/admin/api/feedback/:id/status', admin((req, res, meta) => {
    const body = meta.body || {}
    const result = ctx.feedback.setStatus(meta.params.id, String(body.status || ''), body.note)
    if (!result.ok) {
      sendError(res, result.reason === 'not_found' ? 404 : 400, result.reason || 'invalid_status', '反馈状态更新失败')
      return
    }
    ctx.store.audit('feedback_updated', {
      feedbackId: meta.params.id,
      status: result.entry.status,
      ip: ctx.ip(req)
    })
    sendJson(res, 200, { ok: true, entry: result.entry, stats: ctx.feedback.stats() })
  }))

  router.delete('/admin/api/feedback/:id', admin((req, res, meta) => {
    const ok = ctx.feedback.remove(meta.params.id)
    if (!ok) {
      sendError(res, 404, 'feedback_not_found', '反馈不存在')
      return
    }
    ctx.store.audit('feedback_deleted', { feedbackId: meta.params.id, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, stats: ctx.feedback.stats() })
  }))

  // ---- 会话备份（按设备查看 / 清空） ----
  router.get('/admin/api/sessions', admin((req, res, meta) => {
    const deviceId = String(meta.query.deviceId || '').trim()
    if (!deviceId) {
      sendError(res, 400, 'missing_device_id', '请提供 deviceId')
      return
    }
    sendJson(res, 200, {
      ok: true,
      deviceId,
      enabled: !!ctx.config.sessions.enabled,
      sessions: ctx.sessions.list(deviceId),
      stats: ctx.sessions.stats(deviceId)
    })
  }))

  // 会话完整内容：后台「查看」打开的详情（标题之外的真正对话记录）
  router.get('/admin/api/sessions/:deviceId/:sessionId', admin((req, res, meta) => {
    const deviceId = String(meta.params.deviceId || '')
    const session = ctx.sessions.get(deviceId, meta.params.sessionId)
    if (!session) {
      sendError(res, 404, 'session_not_found', '会话不存在（可能已被设备删除）')
      return
    }
    sendJson(res, 200, {
      ok: true,
      deviceId,
      session,
      messages: session.messages || []
    })
  }))

  router.delete('/admin/api/sessions/:deviceId', admin((req, res, meta) => {
    const deviceId = String(meta.params.deviceId || '')
    const result = ctx.sessions.purge(deviceId)
    ctx.store.audit('admin_sessions_purged', { deviceId, deleted: result.deleted, ip: ctx.ip(req) })
    sendJson(res, 200, { ok: true, deleted: result.deleted })
  }))
}

function auditTypes(ctx) {
  const set = new Set()
  for (const e of ctx.store.listAudit(1000)) if (e.type) set.add(String(e.type))
  return Array.from(set).sort()
}
