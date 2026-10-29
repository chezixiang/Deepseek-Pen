// 客户端状态上报（监控）：客户端每次进入设置页/启动时带一份轻量快照，
// 后台"监控"页据此看到设备在线、版本分布、模型、最近错误。
//
// 设计：
//   - 只保留每台设备的最新一份快照 + 最近 N 条事件，不存历史序列（文件不会膨胀）；
//   - 写入合并防抖（500ms），进程退出前 flush；
//   - 字段全部按白名单归一，客户端上报什么都进不了后台 HTML。

import fs from 'node:fs'
import path from 'node:path'

const MAX_EVENTS_PER_DEVICE = 30
const MAX_EVENT_TEXT = 300
const FLUSH_DELAY_MS = 500

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function num(v) {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function time(v) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  // 允许客户端时钟偏差，但不要写进 1970 或 2100
  const now = Date.now()
  if (n > now + 24 * 3600 * 1000) return now
  if (n < now - 30 * 24 * 3600 * 1000) return now
  return n
}

function sanitizeEvent(e) {
  if (!e || typeof e !== 'object') return null
  const type = text(e.type, 32)
  if (!type) return null
  return {
    t: time(e.t),
    type,
    code: text(e.code, 48),
    message: text(e.message, MAX_EVENT_TEXT)
  }
}

export function sanitizeReport(body) {
  const src = body && typeof body === 'object' ? body : {}
  const stats = src.stats && typeof src.stats === 'object' ? src.stats : {}
  const err = src.lastError && typeof src.lastError === 'object' ? src.lastError : null
  const events = Array.isArray(src.events) ? src.events.slice(0, 10).map(sanitizeEvent).filter(Boolean) : []
  return {
    version: text(src.version, 40),
    build: text(src.build, 40),
    model: text(src.model, 80),
    page: text(src.page, 32),
    backendMode: text(src.backendMode, 24),
    theme: text(src.theme, 12),
    // 调试模式：客户端开启后必须上报（云控 debug.report 决定是否强制）
    debug: !!src.debug,
    debugAt: src.debug ? time(src.debugAt) : 0,
    rce: !!src.rce,
    controlVersion: num(src.controlVersion),
    stats: {
      conversations: num(stats.conversations),
      messages: num(stats.messages),
      sending: !!stats.sending
    },
    lastError: err
      ? { code: text(err.code, 48), message: text(err.message, MAX_EVENT_TEXT), at: time(err.at) }
      : null,
    events
  }
}

export function telemetryPath(dataDir) {
  return path.join(dataDir || 'data', 'telemetry.json')
}

export class TelemetryStore {
  constructor({ dataDir, maxDevices = 500, maxEventsPerDevice = MAX_EVENTS_PER_DEVICE } = {}) {
    this.file = telemetryPath(dataDir)
    this.maxDevices = Math.max(10, Number(maxDevices) || 500)
    this.maxEvents = Math.max(5, Number(maxEventsPerDevice) || MAX_EVENTS_PER_DEVICE)
    this.devices = {}
    this._timer = null
    this._closed = false
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return this
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const devices = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {}
      for (const [id, rec] of Object.entries(devices)) {
        if (!rec || typeof rec !== 'object') continue
        const clean = sanitizeReport(rec)
        this.devices[String(id)] = Object.assign(clean, {
          reportedAt: time(rec.reportedAt),
          firstSeenAt: time(rec.firstSeenAt || rec.reportedAt),
          reportCount: num(rec.reportCount),
          ip: text(rec.ip, 64),
          events: (Array.isArray(rec.events) ? rec.events : []).slice(-this.maxEvents).map(sanitizeEvent).filter(Boolean)
        })
      }
    } catch (e) {
      process.stderr.write('[telemetry] 读取失败（忽略历史）：' + e.message + '\n')
      this.devices = {}
    }
    return this
  }

  schedule() {
    if (this._closed || this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flushNow()
    }, FLUSH_DELAY_MS)
    if (this._timer.unref) this._timer.unref()
  }

  flushNow() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    const payload = { version: 1, updatedAt: Date.now(), devices: this.devices }
    const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
      fs.renameSync(tmp, this.file)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* 忽略 */ }
      process.stderr.write('[telemetry] 写入失败：' + e.message + '\n')
    }
  }

  close() {
    this._closed = true
    this.flushNow()
  }

  record(deviceId, body, { ip = '' } = {}) {
    const id = String(deviceId || '')
    if (!id) return null
    const now = Date.now()
    const clean = sanitizeReport(body)
    const prev = this.devices[id] || null
    const events = (prev && Array.isArray(prev.events) ? prev.events : []).concat(clean.events)
    const rec = Object.assign(clean, {
      reportedAt: now,
      firstSeenAt: prev ? prev.firstSeenAt : now,
      reportCount: (prev ? num(prev.reportCount) : 0) + 1,
      ip: text(ip, 64) || (prev ? prev.ip : ''),
      events: events.slice(-this.maxEvents)
    })
    this.devices[id] = rec
    this._prune()
    this.schedule()
    return rec
  }

  _prune() {
    const ids = Object.keys(this.devices)
    if (ids.length <= this.maxDevices) return
    ids.sort((a, b) => (this.devices[a].reportedAt || 0) - (this.devices[b].reportedAt || 0))
    for (const id of ids.slice(0, ids.length - this.maxDevices)) delete this.devices[id]
  }

  get(deviceId) {
    return this.devices[String(deviceId || '')] || null
  }

  list() {
    return Object.keys(this.devices)
      .map((id) => Object.assign({ deviceId: id }, this.devices[id]))
      .sort((a, b) => (b.reportedAt || 0) - (a.reportedAt || 0))
  }

  remove(deviceId) {
    const id = String(deviceId || '')
    const had = !!this.devices[id]
    delete this.devices[id]
    if (had) this.schedule()
    return had
  }

  /**
   * 监控页聚合：在线（默认 10 分钟内有上报）、版本分布、最近错误、事件流。
   */
  summary({ onlineMs = 10 * 60 * 1000, eventsLimit = 60 } = {}) {
    const now = Date.now()
    const list = this.list()
    const versions = {}
    const models = {}
    const events = []
    let online = 0
    let errorDevices = 0
    for (const rec of list) {
      if (now - (rec.reportedAt || 0) <= onlineMs) online += 1
      const ver = rec.version || '未知'
      versions[ver] = (versions[ver] || 0) + 1
      const model = rec.model || '未上报'
      models[model] = (models[model] || 0) + 1
      if (rec.lastError && rec.lastError.code) errorDevices += 1
      for (const e of rec.events || []) events.push(Object.assign({ deviceId: rec.deviceId }, e))
    }
    events.sort((a, b) => (b.t || 0) - (a.t || 0))
    return {
      totalDevices: list.length,
      online,
      offline: Math.max(0, list.length - online),
      errorDevices,
      versions: Object.keys(versions).map((k) => ({ version: k, count: versions[k] })).sort((a, b) => b.count - a.count),
      models: Object.keys(models).map((k) => ({ model: k, count: models[k] })).sort((a, b) => b.count - a.count),
      events: events.slice(0, eventsLimit),
      updatedAt: now
    }
  }
}
