// 意见 / Bug 反馈收件箱。
//
// 客户端在设置页填写，附带诊断信息（版本、构建号、设备、日志）。
// 存 data/feedback.json（小体量，原子写）；管理后台可查看与标记处理状态。
//
// 完整日志单独落盘：客户端上传的是整份日志文件（应用日志当前+上一份、
// 后端日志当前+上一份），动辄几百 KB。塞进 feedback.json 会让整个收件箱
// 每次改动都重写一遍（2000 条 × 几百 KB），所以日志写 data/feedback-logs/<id>.log，
// feedback.json 里只留元信息（行数/字符数/是否截断/分段）。
// 不做自动外发（邮件/IM）——网关零依赖，接入通知属于部署侧的事。

import fs from 'node:fs'
import path from 'node:path'

const MAX_TEXT = 4000
const MAX_CONTACT = 120
// 诊断整体上限：应用日志尾部是主要构成（客户端附带 ~100 行），64KB 足够且可控
const MAX_DIAG_BYTES = 65536
// 日志类字段单独放宽：普通字段（如 mode/theme）2KB 足够，日志尾部要能看出现场
const LOG_FIELD_MAX = 24000
const LOG_FIELDS = new Set(['log', 'backendLog', 'logOld', 'backendLogOld'])
// 完整日志文件上限（字符）：客户端自己会截到 512KB，这里再兜一道防绕过
const MAX_LOG_CHARS = 2 * 1024 * 1024

export const FEEDBACK_CATEGORIES = ['bug', 'suggestion', 'other']
export const FEEDBACK_STATUS = ['open', 'handled', 'ignored']

function str(v, max) {
  const s = String(v == null ? '' : v)
  return s.length > max ? s.slice(0, max) : s
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

// 完整日志载荷归一：客户端发 { name, text, lines, chars, truncated, parts }
function normalizeLogPayload(input) {
  if (!input) return null
  const raw = typeof input === 'string' ? input : (input && input.text)
  const full = String(raw || '')
  if (!full.trim()) return null
  const text = full.length > MAX_LOG_CHARS ? full.slice(-MAX_LOG_CHARS) : full
  const parts = Array.isArray(input && input.parts)
    ? input.parts.slice(0, 8).map((p) => ({
        name: str(p && p.name, 120),
        lines: Math.max(0, Math.trunc(Number(p && p.lines) || 0)),
        chars: Math.max(0, Math.trunc(Number(p && p.chars) || 0))
      }))
    : []
  return {
    name: str((input && input.name) || 'ds-app.log', 80).replace(/[^\w.\-]/g, '') || 'ds-app.log',
    text,
    lines: Math.max(0, Math.trunc(Number(input && input.lines) || 0)) || text.split('\n').filter(Boolean).length,
    chars: Math.max(0, Math.trunc(Number(input && input.chars) || 0)) || text.length,
    truncated: (input && input.truncated === true) || text.length < full.length,
    parts
  };
}

function sanitizeDiagnostics(input) {
  if (!input || typeof input !== 'object') return {}
  const out = {}
  for (const key of Object.keys(input)) {
    if (out && Object.keys(out).length >= 20) break
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) continue
    const v = input[key]
    if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v
    } else if (v != null) {
      out[key] = str(v, LOG_FIELDS.has(key) ? LOG_FIELD_MAX : 2000)
    }
  }
  // 整体字节上限：日志尾部是最容易超的一块
  try {
    const text = JSON.stringify(out)
    if (text.length > MAX_DIAG_BYTES) {
      // 超限时优先保日志尾部（定位现场用），先砍其它大字段再整体截断
      for (const key of Object.keys(out)) {
        if (typeof out[key] === 'string' && !LOG_FIELDS.has(key) && out[key].length > 200) {
          out[key] = out[key].slice(0, 200)
        }
      }
      const text2 = JSON.stringify(out)
      if (text2.length <= MAX_DIAG_BYTES) return out
      return { note: '诊断信息过大，已截断', log: String(out.log || '').slice(-LOG_FIELD_MAX) }
    }
  } catch (_) {
    return {}
  }
  return out
}

export class FeedbackStore {
  constructor({ dataDir, maxEntries = 2000, flushDelayMs = 400 } = {}) {
    this.dataDir = dataDir || 'data'
    this.file = path.join(this.dataDir, 'feedback.json')
    // 完整日志文件目录（与 feedback.json 同级，便于整目录备份/清理）
    this.logDir = path.join(this.dataDir, 'feedback-logs')
    this.maxEntries = Math.max(10, Number(maxEntries) || 2000)
    this.flushDelayMs = flushDelayMs
    this.entries = []
    this.timer = null
    this._closed = false
    this.load()
  }

  _logPath(id) {
    return path.join(this.logDir, String(id || 'unknown') + '.log')
  }

  /** 写入完整日志文件；失败只记 stderr，不影响反馈入库 */
  _writeLog(id, log) {
    if (!id || !log || !log.text) return null
    try {
      fs.mkdirSync(this.logDir, { recursive: true })
      const file = this._logPath(id)
      fs.writeFileSync(file, log.text, 'utf8')
      try { fs.chmodSync(file, 0o600) } catch (_) { /* Windows 无意义 */ }
      return {
        name: id + '.log',
        bytes: Buffer.byteLength(log.text, 'utf8'),
        lines: log.lines,
        chars: log.chars,
        truncated: log.truncated === true,
        parts: log.parts || [],
        at: Date.now()
      }
    } catch (e) {
      process.stderr.write('[feedback] 日志写入失败：' + e.message + '\n')
      return null
    }
  }

  /** 读完整日志（后台详情/下载用）；不存在返回 '' */
  readLog(id) {
    if (!id) return ''
    try {
      const file = this._logPath(id)
      if (!fs.existsSync(file)) return ''
      return fs.readFileSync(file, 'utf8')
    } catch (e) {
      process.stderr.write('[feedback] 日志读取失败：' + e.message + '\n')
      return ''
    }
  }

  _removeLog(id) {
    if (!id) return
    try {
      const file = this._logPath(id)
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (e) { /* 尽力而为，残留文件不影响功能 */ }
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.entries = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.entries) ? raw.entries : [])
      }
    } catch (e) {
      process.stderr.write('[feedback] 读取失败（从空开始）：' + e.message + '\n')
      this.entries = []
    }
    return this.entries
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
      fs.writeFileSync(tmp, JSON.stringify(this.entries), 'utf8')
      try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
      fs.renameSync(tmp, this.file)
    } catch (e) {
      process.stderr.write('[feedback] 写入失败：' + e.message + '\n')
    }
  }

  _schedule() {
    if (this._closed) {
      this._write()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this._write()
    }, this.flushDelayMs)
    if (this.timer.unref) this.timer.unref()
  }

  countToday(deviceId, now = Date.now()) {
    const day = dayKey(now)
    const id = String(deviceId || '')
    return this.entries.filter((e) => e && e.deviceId === id && dayKey(Number(e.at) || 0) === day).length
  }

  add({ deviceId, category, text, contact = '', diagnostics = {}, logs = null, client = '', ip = '', build = '', version = '' }) {
    const cat = FEEDBACK_CATEGORIES.indexOf(category) >= 0 ? category : 'other'
    const body = str(text, MAX_TEXT).trim()
    if (!body) return { ok: false, reason: 'empty_text' }
    const entry = {
      id: 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      deviceId: str(deviceId, 128),
      category: cat,
      text: body,
      contact: str(contact, MAX_CONTACT),
      diagnostics: sanitizeDiagnostics(diagnostics),
      // 完整日志单独落盘，entry 里只留元信息（避免 feedback.json 被日志撑爆）
      log: null,
      client: str(client, 120),
      build: str(build, 40),
      version: str(version, 40),
      ip: str(ip, 64),
      status: 'open',
      handledAt: 0,
      note: ''
    };
    const normalizedLog = normalizeLogPayload(logs);
    if (normalizedLog) entry.log = this._writeLog(entry.id, normalizedLog);
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      const dropped = this.entries.slice(0, this.entries.length - this.maxEntries);
      for (const old of dropped) this._removeLog(old && old.id);
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this._schedule();
    return { ok: true, entry }
  }

  _match(e, { status = '', category = '', deviceId = '', q = '', from = 0, to = 0 } = {}) {
    if (!e) return false
    if (status && e.status !== status) return false
    if (category && e.category !== category) return false
    if (deviceId && e.deviceId !== deviceId) return false
    const at = Number(e.at) || 0
    if (from && at < Number(from)) return false
    if (to && at > Number(to)) return false
    if (q) {
      const hay = [e.text, e.contact, e.deviceId, e.category, e.status, e.note, e.build, e.version, e.client]
        .filter(Boolean).join(' ').toLowerCase()
      if (hay.indexOf(String(q).toLowerCase()) < 0) return false
    }
    return true
  }

  /** 兼容旧调用：返回筛选后的数组（最新在前） */
  list({ limit = 100, status = '', category = '', deviceId = '', q = '', from = 0, to = 0 } = {}) {
    return this.query({ limit, status, category, deviceId, q, from, to }).items
  }

  /** 后台详情：分页 + 筛选 + 总数 */
  query({ limit = 100, offset = 0, status = '', category = '', deviceId = '', q = '', from = 0, to = 0 } = {}) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 100))
    const skip = Math.max(0, Math.trunc(Number(offset) || 0))
    const opts = { status, category, deviceId, q, from, to }
    const all = this.entries.filter((e) => this._match(e, opts)).slice().reverse()
    return {
      items: all.slice(skip, skip + n),
      total: all.length,
      offset: skip,
      limit: n
    }
  }

  get(id) {
    const key = String(id || '')
    return this.entries.filter((e) => e && e.id === key)[0] || null
  }

  setStatus(id, status, note = '') {
    if (FEEDBACK_STATUS.indexOf(status) < 0) return { ok: false, reason: 'invalid_status' }
    const entry = this.entries.find((e) => e && e.id === id)
    if (!entry) return { ok: false, reason: 'not_found' }
    entry.status = status
    if (note !== undefined && note !== null) entry.note = str(note, 500)
    entry.handledAt = status === 'open' ? 0 : Date.now()
    this._schedule()
    return { ok: true, entry }
  }

  /** 只改备注（状态不变），便于排查时留痕 */
  setNote(id, note) {
    const entry = this.entries.find((e) => e && e.id === id)
    if (!entry) return { ok: false, reason: 'not_found' }
    entry.note = str(note, 500)
    entry.notedAt = Date.now()
    this._schedule()
    return { ok: true, entry }
  }

  remove(id) {
    const key = String(id || '')
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e && e.id !== key)
    const changed = this.entries.length !== before
    if (changed) {
      this._removeLog(key)
      this._schedule()
    }
    return changed
  }

  stats(now = Date.now()) {
    const day = dayKey(now)
    const byStatus = { open: 0, handled: 0, ignored: 0 }
    const byCategory = {}
    const devices = {}
    let today = 0
    for (const e of this.entries) {
      if (!e) continue
      byStatus[e.status] = (byStatus[e.status] || 0) + 1
      byCategory[e.category] = (byCategory[e.category] || 0) + 1
      if (e.deviceId) devices[e.deviceId] = (devices[e.deviceId] || 0) + 1
      if (dayKey(Number(e.at) || 0) === day) today += 1
    }
    return {
      total: this.entries.length,
      open: byStatus.open || 0,
      handled: byStatus.handled || 0,
      ignored: byStatus.ignored || 0,
      today,
      byStatus,
      byCategory,
      devices: Object.keys(devices).length
    }
  }

  /** 导出 CSV（后台"导出"按钮直接下载） */
  exportCsv(opts = {}) {
    const rows = this.query(Object.assign({ limit: 1000 }, opts)).items
    const cols = ['id', 'at', 'deviceId', 'category', 'status', 'text', 'contact', 'note', 'version', 'build', 'client', 'ip']
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, '\\n') + '"'
    const lines = [cols.join(',')]
    for (const r of rows) {
      lines.push(cols.map((c) => esc(c === 'at' ? new Date(Number(r.at) || 0).toISOString() : r[c])).join(','))
    }
    return lines.join('\r\n')
  }

  close() {
    this._closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this._write()
  }
}
