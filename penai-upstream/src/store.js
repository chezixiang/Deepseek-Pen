// 持久化：设备令牌、配对码、封禁状态、用量统计、审计日志。
//
// 存储选型说明：
//   - 目标是"一台小机器上零依赖就能跑"，不引数据库；状态写单个 JSON，
//     原子替换（tmp + rename），重启后设备不必重新配对；
//   - 审计日志单独写 JSONL，避免状态文件被日志撑大；
//   - 设备签名密钥必须可读（验签要用），因此状态文件含密钥：权限 0600，
//     部署时不要把 data/ 放进静态目录或公开仓库。

import fs from 'node:fs'
import path from 'node:path'

const STATE_VERSION = 1
const AUDIT_RING_MAX = 800
const FLUSH_DELAY_MS = 400

function nowIsoDay(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

// 配额按 UTC 日 / UTC 月结算：与审计/统计使用的 ISO 日期一致，
// 避免服务器时区变化导致"同一天被重置两次"。
export function dayKey(ts = Date.now()) {
  return nowIsoDay(ts)
}

export function monthKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7)
}

export function nextDayAt(ts = Date.now()) {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

export function nextMonthAt(ts = Date.now()) {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

// 分钟 / 小时窗口（RPM、TPM、5 小时 Token 用固定窗口，实现简单且可解释）
export function minuteKey(ts = Date.now()) {
  return Math.floor(ts / 60000)
}

export function hourKey(ts = Date.now()) {
  return Math.floor(ts / 3600000)
}

export function nextMinuteAt(ts = Date.now()) {
  return (minuteKey(ts) + 1) * 60000
}

export function nextHourAt(ts = Date.now()) {
  return (hourKey(ts) + 1) * 3600000
}

// 最近 5 小时 token：current hour + 前 4 个小时桶。
// 固定小时桶是有意为之：笔端请求量小，精确到分钟的滚动窗口收益很低，
// 却要在每次请求时遍历/裁剪大量时间点。
export function fiveHourTokensOf(device, now = Date.now()) {
  if (!device || !device.hourBuckets) return 0
  const h = hourKey(now)
  let sum = 0
  for (const key of Object.keys(device.hourBuckets)) {
    const k = Number(key)
    if (Number.isFinite(k) && k > h - 5 && k <= h) sum += Number(device.hourBuckets[key]) || 0
  }
  return sum
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: Date.now(),
    devices: {},
    pairings: {},
    stats: {
      since: Date.now(),
      requests: 0,
      errors: 0,
      blocks: 0,
      pairingsCreated: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      byDay: {},
      paths: {}
    }
  }
}

export class Store {
  constructor({ dataDir, flushDelayMs = FLUSH_DELAY_MS } = {}) {
    this.dataDir = dataDir
    this.statePath = path.join(dataDir, 'state.json')
    this.auditPath = path.join(dataDir, 'audit.log')
    this.flushDelayMs = flushDelayMs
    this.state = emptyState()
    this.auditRing = []
    this._timer = null
    this._writing = false
    this._dirtyAgain = false
    this._closed = false
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    if (fs.existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
        this.state = this._migrate(raw)
      } catch (e) {
        // 状态损坏不能静默清空：留档后重来，运维还能捞回设备列表
        const backup = this.statePath + '.corrupt-' + Date.now()
        try { fs.copyFileSync(this.statePath, backup) } catch (_) { /* 忽略 */ }
        this.state = emptyState()
        this.audit('state_reset', { reason: 'corrupt', backup })
      }
    }
    this.prunePairings(Date.now())
    this._chmodPrivate(this.statePath)
    return this
  }

  _migrate(raw) {
    const base = emptyState()
    if (!raw || typeof raw !== 'object') return base
    const state = {
      version: STATE_VERSION,
      createdAt: raw.createdAt || Date.now(),
      devices: raw.devices && typeof raw.devices === 'object' ? raw.devices : {},
      pairings: raw.pairings && typeof raw.pairings === 'object' ? raw.pairings : {},
      stats: Object.assign(base.stats, raw.stats || {})
    }
    state.stats.tokens = Object.assign({ prompt: 0, completion: 0, total: 0 }, (raw.stats && raw.stats.tokens) || {})
    state.stats.byDay = (raw.stats && raw.stats.byDay) || {}
    state.stats.paths = (raw.stats && raw.stats.paths) || {}
    for (const d of Object.values(state.devices)) {
      if (!d.createdAt) d.createdAt = Date.now()
      if (!d.requestCount) d.requestCount = 0
      if (!d.tokenCount) d.tokenCount = 0
      // 老状态文件没有日/月用量字段：从当天开始计，历史累计仍在 tokenCount
      if (!d.usageDay) d.usageDay = dayKey()
      if (!d.usageMonth) d.usageMonth = monthKey()
      if (d.dayRequests === undefined) d.dayRequests = 0
      if (d.dayTokens === undefined) d.dayTokens = 0
      if (d.monthRequests === undefined) d.monthRequests = 0
      if (d.monthTokens === undefined) d.monthTokens = 0
      if (d.minuteRequests === undefined) d.minuteRequests = 0
      if (d.minuteTokens === undefined) d.minuteTokens = 0
      if (d.usageMinute === undefined) d.usageMinute = 0
      if (!d.hourBuckets || typeof d.hourBuckets !== 'object') d.hourBuckets = {}
      if (d.revoked === true) d.revokedAt = d.revokedAt || Date.now()
      if (d.blocked === true && !d.blockedUntil) d.blockedUntil = Date.now() + 1800 * 1000
    }
    return state
  }

  _chmodPrivate(file) {
    try { fs.chmodSync(file, 0o600) } catch (_) { /* Windows 上无意义 */ }
  }

  // ---------- 写入 ----------

  schedule() {
    if (this._closed) return
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flushNow()
    }, this.flushDelayMs)
    if (this._timer.unref) this._timer.unref()
  }

  flushNow() {
    if (this._writing) {
      this._dirtyAgain = true
      return
    }
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._writing = true
    this._dirtyAgain = false
    const tmp = this.statePath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      this._chmodPrivate(tmp)
      fs.renameSync(tmp, this.statePath)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* 忽略 */ }
      // 落盘失败不能中断服务：内存状态仍然可用，下次再试
      process.stderr.write('[store] 写入状态失败：' + e.message + '\n')
    } finally {
      this._writing = false
      if (this._dirtyAgain) {
        this._dirtyAgain = false
        if (this._closed) this.flushNow()
        else this.schedule()
      }
    }
  }

  close() {
    this._closed = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this.flushNow()
  }

  // ---------- 审计 ----------

  audit(type, data = {}) {
    const entry = Object.assign({ t: Date.now(), type: String(type) }, data)
    this.auditRing.push(entry)
    if (this.auditRing.length > AUDIT_RING_MAX) this.auditRing.shift()
    try {
      fs.appendFile(this.auditPath, JSON.stringify(entry) + '\n', () => {})
    } catch (_) { /* 审计失败不影响业务 */ }
    return entry
  }

  listAudit(limit = 100) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 100))
    return this.auditRing.slice(-n).reverse()
  }

  // ---------- 配对码 ----------

  prunePairings(now = Date.now()) {
    let changed = false
    for (const [code, p] of Object.entries(this.state.pairings)) {
      if (!p) { delete this.state.pairings[code]; changed = true; continue }
      // 过期后保留 1 小时供管理端看到"已过期"，之后清理
      if (p.expiresAt && p.expiresAt + 3600 * 1000 < now) {
        delete this.state.pairings[code]
        changed = true
      }
    }
    return changed
  }

  getPairing(code) {
    return this.state.pairings[String(code || '').toUpperCase()] || null
  }

  createPairing(code, { deviceId = '', approved = false, ttlSec = 600, source = 'admin' } = {}) {
    const c = String(code || '').toUpperCase()
    const entry = {
      code: c,
      deviceId: deviceId ? String(deviceId) : '',
      approved: !!approved,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlSec * 1000,
      used: false,
      usedAt: 0,
      source
    }
    this.state.pairings[c] = entry
    this.state.stats.pairingsCreated += 1
    this.schedule()
    return entry
  }

  approvePairing(code, { deviceId = '', ttlSec = 0 } = {}) {
    const c = String(code || '').toUpperCase()
    const entry = this.state.pairings[c]
    if (!entry) return null
    entry.approved = true
    if (deviceId) entry.deviceId = String(deviceId)
    // 重新批准已过期的码时顺延有效期（管理后台"重新批准"按钮的语义）
    if (ttlSec > 0 && (!entry.expiresAt || entry.expiresAt < Date.now() + 30 * 1000)) {
      entry.expiresAt = Date.now() + ttlSec * 1000
    }
    this.schedule()
    return entry
  }

  consumePairing(code, deviceId) {
    const c = String(code || '').toUpperCase()
    const entry = this.state.pairings[c]
    if (!entry) return null
    if (entry.used) return null
    if (entry.deviceId && entry.deviceId !== deviceId) return null
    entry.used = true
    entry.usedAt = Date.now()
    entry.deviceId = deviceId
    this.schedule()
    return entry
  }

  listPairings() {
    return Object.values(this.state.pairings)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => Object.assign({}, p))
  }

  deletePairing(code) {
    const c = String(code || '').toUpperCase()
    const had = !!this.state.pairings[c]
    delete this.state.pairings[c]
    if (had) this.schedule()
    return had
  }

  // ---------- 设备 ----------

  getDevice(deviceId) {
    return this.state.devices[String(deviceId || '')] || null
  }

  putDevice(device) {
    this.state.devices[device.deviceId] = device
    this.schedule()
    return device
  }

  issueDevice(deviceId, { tokenHash, secret, expiresAt, ua = '', ip = '', client = '', build = '', model = '', source = 'pair' }) {
    const id = String(deviceId)
    const prev = this.state.devices[id] || {}
    const device = Object.assign({}, prev, {
      deviceId: id,
      tokenHash,
      secret,
      createdAt: prev.createdAt || Date.now(),
      issuedAt: Date.now(),
      expiresAt,
      revokedAt: 0,
      lastSeenAt: Date.now(),
      firstIp: prev.firstIp || ip || '',
      lastIp: ip || prev.lastIp || '',
      ua: ua || prev.ua || '',
      client: client || prev.client || '',
      build: build || prev.build || '',
      model: model || prev.model || '',
      enrollSource: prev.enrollSource || source,
      enrolledAt: prev.enrolledAt || Date.now(),
      enrollCount: (prev.enrollCount || 0) + (prev.deviceId ? 1 : 0),
      requestCount: prev.requestCount || 0,
      errorCount: prev.errorCount || 0,
      tokenCount: prev.tokenCount || 0,
      dayRequests: prev.dayRequests || 0,
      dayTokens: prev.dayTokens || 0,
      monthRequests: prev.monthRequests || 0,
      monthTokens: prev.monthTokens || 0,
      // 分钟窗口：RPM / TPM
      minuteRequests: prev.minuteRequests || 0,
      minuteTokens: prev.minuteTokens || 0,
      // 小时桶：{ [epochHour]: tokens }，用于 5 小时 Token 窗口
      hourBuckets: prev.hourBuckets || {},
      usageMinute: prev.usageMinute || 0
    })
    this.state.devices[id] = device
    this.schedule()
    return device
  }

  countDevices() {
    return Object.keys(this.state.devices).length
  }

  // 日/月/分钟用量滚动：跨窗口时把对应计数清零（读写两侧都调用，
  // 保证"只读配额"时看到的也是当前窗口的数字）。
  rollUsage(device, now = Date.now()) {
    if (!device) return null
    const day = dayKey(now)
    const month = monthKey(now)
    if (device.usageDay !== day) {
      device.usageDay = day
      device.dayRequests = 0
      device.dayTokens = 0
    }
    if (device.usageMonth !== month) {
      device.usageMonth = month
      device.monthRequests = 0
      device.monthTokens = 0
    }
    const minute = minuteKey(now)
    if (device.usageMinute !== minute) {
      device.usageMinute = minute
      device.minuteRequests = 0
      device.minuteTokens = 0
    }
    // 小时桶只留最近 6 小时，避免状态文件无限增长
    if (!device.hourBuckets || typeof device.hourBuckets !== 'object') device.hourBuckets = {}
    const h = hourKey(now)
    for (const key of Object.keys(device.hourBuckets)) {
      const k = Number(key)
      if (!Number.isFinite(k) || k <= h - 6) delete device.hourBuckets[key]
    }
    return device
  }

  usage(deviceId, now = Date.now()) {
    const d = this.getDevice(deviceId)
    if (!d) return null
    this.rollUsage(d, now)
    return {
      day: d.usageDay,
      requests: d.dayRequests || 0,
      tokens: d.dayTokens || 0,
      month: d.usageMonth,
      monthRequests: d.monthRequests || 0,
      monthTokens: d.monthTokens || 0,
      minuteRequests: d.minuteRequests || 0,
      minuteTokens: d.minuteTokens || 0,
      minuteResetAt: nextMinuteAt(now),
      fiveHourTokens: fiveHourTokensOf(d, now),
      fiveHourResetAt: nextHourAt(now)
    }
  }

  rotateToken(deviceId, { tokenHash, secret, expiresAt }) {
    const d = this.getDevice(deviceId)
    if (!d) return null
    d.tokenHash = tokenHash
    if (secret) d.secret = secret
    d.expiresAt = expiresAt
    d.issuedAt = Date.now()
    this.schedule()
    return d
  }

  touchDevice(deviceId, patch = {}) {
    const d = this.getDevice(deviceId)
    if (!d) return null
    Object.assign(d, patch)
    this.schedule()
    return d
  }

  revokeDevice(deviceId, reason = '') {
    const d = this.getDevice(deviceId)
    if (!d) return null
    d.revokedAt = Date.now()
    d.revokeReason = String(reason || '')
    this.schedule()
    return d
  }

  blockDevice(deviceId, untilMs, reason = '') {
    const d = this.getDevice(deviceId)
    if (!d) return null
    d.blockedUntil = Math.max(Number(untilMs) || 0, Date.now())
    d.blockReason = String(reason || '')
    this.state.stats.blocks += 1
    this.schedule()
    return d
  }

  unblockDevice(deviceId) {
    const d = this.getDevice(deviceId)
    if (!d) return null
    d.blockedUntil = 0
    d.blockReason = ''
    this.schedule()
    return d
  }

  removeDevice(deviceId) {
    const id = String(deviceId || '')
    const had = !!this.state.devices[id]
    delete this.state.devices[id]
    if (had) this.schedule()
    return had
  }

  listDevices() {
    return Object.values(this.state.devices)
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .map((d) => Object.assign({}, d))
  }

  // ---------- 统计 ----------

  recordRequest({ deviceId, path: reqPath, status, durationMs = 0, billable = false }) {
    const now = Date.now()
    const day = nowIsoDay(now)
    const s = this.state.stats
    s.requests += 1
    if (status >= 400) s.errors += 1
    s.paths[reqPath] = (s.paths[reqPath] || 0) + 1
    if (!s.byDay[day]) s.byDay[day] = { requests: 0, errors: 0, tokens: 0, devices: {} }
    const d = s.byDay[day]
    d.requests += 1
    if (status >= 400) d.errors += 1
    if (deviceId) {
      d.devices[deviceId] = (d.devices[deviceId] || 0) + 1
      const dev = this.getDevice(deviceId)
      if (dev) {
        this.rollUsage(dev, now)
        dev.requestCount = (dev.requestCount || 0) + 1
        // 配额只统计"真正产生用量"的聊天请求：
        // /v1/me、会话备份、云控轮询都是客户端维持运行的内部请求，
        // 把它们算进额度会让用户"没聊天却掉额度"。
        if (billable) {
          dev.dayRequests = (dev.dayRequests || 0) + 1
          dev.monthRequests = (dev.monthRequests || 0) + 1
          dev.minuteRequests = (dev.minuteRequests || 0) + 1
        }
        if (status >= 400) dev.errorCount = (dev.errorCount || 0) + 1
      }
    }
    // 只留 30 天
    const keys = Object.keys(s.byDay)
    if (keys.length > 30) {
      keys.sort()
      for (const k of keys.slice(0, keys.length - 30)) delete s.byDay[k]
    }
    this.schedule()
  }

  recordTokens(deviceId, usage) {
    if (!usage || typeof usage !== 'object') return
    const prompt = Number(usage.prompt_tokens) || 0
    const completion = Number(usage.completion_tokens) || 0
    const total = Number(usage.total_tokens) || prompt + completion
    if (!prompt && !completion && !total) return
    const s = this.state.stats
    s.tokens.prompt += prompt
    s.tokens.completion += completion
    s.tokens.total += total
    const day = nowIsoDay(Date.now())
    if (!s.byDay[day]) s.byDay[day] = { requests: 0, errors: 0, tokens: 0, devices: {} }
    s.byDay[day].tokens += total
    const d = this.getDevice(deviceId)
    if (d) {
      const nowTs = Date.now()
      this.rollUsage(d, nowTs)
      d.tokenCount = (d.tokenCount || 0) + total
      d.dayTokens = (d.dayTokens || 0) + total
      d.monthTokens = (d.monthTokens || 0) + total
      d.minuteTokens = (d.minuteTokens || 0) + total
      const h = hourKey(nowTs)
      if (!d.hourBuckets || typeof d.hourBuckets !== 'object') d.hourBuckets = {}
      d.hourBuckets[h] = (Number(d.hourBuckets[h]) || 0) + total
    }
    this.schedule()
  }

  snapshotStats() {
    return JSON.parse(JSON.stringify(this.state.stats))
  }
}
