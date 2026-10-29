// 会话云端备份。
//
// 定位：**本地才是主库**。客户端每次回答结束把这条会话整体推一份上来，
// 删除时同步删除；设备换机/重装后本地为空时可以从这里拉回。
// 因此这里不做冲突合并、不做增量：一次 PUT 就是该会话的最新快照（last-write-wins）。
//
// 存储：data/sessions/<sha256(deviceId) 前 24 位>.json
//   - 不塞进 state.json：那个文件每 400ms 就可能被整体重写一次，
//     会话正文动辄几十 KB，放进去会把每次状态落盘都放大；
//   - 每设备一个文件，读写互不影响；写入用 tmp + rename 原子替换；
//   - 图片只留 path（base64 有几 MB，且网关没有回传图片的用途）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FILE_VERSION = 1
const FLUSH_DELAY_MS = 300
const MAX_TEXT = 200 * 1024
const MAX_REASONING = 100 * 1024
const MAX_TITLE = 120
const MAX_MESSAGES_KEEP = 300

function clip(value, max) {
  const s = String(value == null ? '' : value)
  return s.length > max ? s.slice(0, max) : s
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function sanitizeImages(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 8).map((img) => ({
    name: clip(img && img.name, 120),
    path: clip(img && img.path, 300)
  })).filter((img) => img.path)
}

function sanitizeVersions(list, isUser) {
  if (!Array.isArray(list)) return []
  return list.slice(-8).map((v) => {
    const out = {
      content: clip(v && v.content, MAX_TEXT),
      createdAt: num(v && v.createdAt)
    }
    if (isUser) out.images = sanitizeImages(v && v.images)
    else {
      out.reasoning = clip(v && v.reasoning, MAX_REASONING)
      out.error = clip(v && v.error, 500)
    }
    return out
  })
}

// 只保留客户端渲染需要、且体积可控的字段。
// 明确丢弃 dataUrl / pending / 内部临时标记：它们要么巨大，要么是本地状态。
export function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return null
  const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : '')
  if (!role) return null
  const out = {
    id: clip(m.id, 80),
    role,
    content: clip(m.content, MAX_TEXT),
    createdAt: num(m.createdAt)
  }
  if (role === 'user') {
    out.images = sanitizeImages(m.images)
    const revs = sanitizeVersions(m.revisions, true)
    if (revs.length) {
      out.revisions = revs
      out.activeRevision = Math.max(0, Math.min(revs.length - 1, num(m.activeRevision, revs.length - 1)))
    }
  } else {
    out.reasoning = clip(m.reasoning, MAX_REASONING)
    out.error = clip(m.error, 500)
    const attempts = sanitizeVersions(m.attempts, false)
    if (attempts.length) {
      out.attempts = attempts
      out.activeAttempt = Math.max(0, Math.min(attempts.length - 1, num(m.activeAttempt, attempts.length - 1)))
    }
  }
  return out
}

export function sanitizeSession(input, limits = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const maxMessages = Math.max(1, num(limits.maxMessagesPerSession, 300))
  const session = {
    title: clip(src.title || '新对话', MAX_TITLE),
    mode: clip(src.mode || 'fast', 32),
    thinking: src.thinking !== false,
    search: src.search === true,
    createdAt: num(src.createdAt, Date.now()),
    updatedAt: num(src.updatedAt, Date.now())
  }
  if (Array.isArray(src.messages)) {
    const list = src.messages.map(sanitizeMessage).filter(Boolean)
    session.messages = list.slice(-maxMessages)
    session.messageCount = session.messages.length
    session.trimmed = list.length > maxMessages
  }
  return session
}

function safeId(id) {
  const s = String(id || '').trim()
  return /^[A-Za-z0-9._:-]{1,80}$/.test(s) ? s : ''
}

export class SessionStore {
  constructor({ dataDir, limits = {}, flushDelayMs = FLUSH_DELAY_MS } = {}) {
    this.dir = path.join(dataDir, 'sessions')
    this.limits = {
      maxPerDevice: Math.max(1, num(limits.maxPerDevice, 300)),
      maxMessagesPerSession: Math.max(1, num(limits.maxMessagesPerSession, 300)),
      maxDevicesCached: Math.max(1, num(limits.maxDevicesCached, 200))
    }
    this.flushDelayMs = flushDelayMs
    this.cache = new Map() // deviceId -> { doc, timer, path }
    this._closed = false
  }

  _fileFor(deviceId) {
    const hash = crypto.createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 24)
    return path.join(this.dir, hash + '.json')
  }

  _empty(deviceId) {
    return { v: FILE_VERSION, deviceId: String(deviceId), updatedAt: 0, sessions: {} }
  }

  _load(deviceId) {
    const key = String(deviceId)
    const hit = this.cache.get(key)
    if (hit) return hit
    const file = this._fileFor(key)
    let doc = this._empty(key)
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
          doc = {
            v: FILE_VERSION,
            deviceId: key,
            updatedAt: num(raw.updatedAt),
            sessions: raw.sessions
          }
        }
      }
    } catch (e) {
      // 单设备文件损坏不能影响其它设备：改名留档后从空开始
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()) } catch (_) { /* 忽略 */ }
      doc = this._empty(key)
    }
    const slot = { doc, timer: null, path: file }
    this.cache.set(key, slot)
    this._evict()
    return slot
  }

  _evict() {
    const max = this.limits.maxDevicesCached
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      const slot = this.cache.get(oldest)
      if (slot && slot.timer) {
        clearTimeout(slot.timer)
        this._write(slot)
      }
      this.cache.delete(oldest)
    }
  }

  _write(slot) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = slot.path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
      fs.writeFileSync(tmp, JSON.stringify(slot.doc), 'utf8')
      try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
      fs.renameSync(tmp, slot.path)
    } catch (e) {
      process.stderr.write('[sessions] 写入失败：' + e.message + '\n')
    }
  }

  _schedule(slot) {
    if (this._closed) {
      this._write(slot)
      return
    }
    if (slot.timer) return
    slot.timer = setTimeout(() => {
      slot.timer = null
      this._write(slot)
    }, this.flushDelayMs)
    if (slot.timer.unref) slot.timer.unref()
  }

  list(deviceId) {
    const doc = this._load(deviceId).doc
    return Object.keys(doc.sessions).map((id) => {
      const s = doc.sessions[id] || {}
      return {
        id,
        title: s.title || '新对话',
        mode: s.mode || 'fast',
        thinking: s.thinking !== false,
        search: s.search === true,
        createdAt: num(s.createdAt),
        updatedAt: num(s.updatedAt),
        messageCount: Array.isArray(s.messages) ? s.messages.length : num(s.messageCount)
      }
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  get(deviceId, sessionId) {
    const id = safeId(sessionId)
    if (!id) return null
    const doc = this._load(deviceId).doc
    const s = doc.sessions[id]
    if (!s) return null
    return Object.assign({ id }, s)
  }

  /**
   * 整体覆盖一条会话（last-write-wins）。messages 缺省表示"只更新元数据"。
   * @returns {{ok:boolean, reason?:string, session?:Object}}
   */
  put(deviceId, sessionId, input) {
    const id = safeId(sessionId)
    if (!id) return { ok: false, reason: 'invalid_session_id' }
    const slot = this._load(deviceId)
    const doc = slot.doc
    const prev = doc.sessions[id] || null
    const clean = sanitizeSession(input, this.limits)
    if (!Array.isArray(input && input.messages) && prev) {
      clean.messages = prev.messages
      clean.messageCount = prev.messageCount
      clean.trimmed = prev.trimmed
    }
    if (!clean.messages) clean.messages = []
    if (!clean.createdAt) clean.createdAt = prev ? prev.createdAt : Date.now()
    clean.rev = (prev && prev.rev ? prev.rev : 0) + 1
    clean.updatedAt = Math.max(num(clean.updatedAt), prev ? num(prev.updatedAt) : 0)

    doc.sessions[id] = clean
    // 超出上限时丢最旧的（按 updatedAt）
    const ids = Object.keys(doc.sessions)
    if (ids.length > this.limits.maxPerDevice) {
      ids.sort((a, b) => num(doc.sessions[a].updatedAt) - num(doc.sessions[b].updatedAt))
      for (const old of ids.slice(0, ids.length - this.limits.maxPerDevice)) delete doc.sessions[old]
    }
    doc.updatedAt = Date.now()
    this._schedule(slot)
    return {
      ok: true,
      session: {
        id,
        rev: clean.rev,
        updatedAt: clean.updatedAt,
        messageCount: clean.messageCount || 0,
        trimmed: !!clean.trimmed
      }
    }
  }

  remove(deviceId, sessionId) {
    const id = safeId(sessionId)
    if (!id) return { ok: false, reason: 'invalid_session_id' }
    const slot = this._load(deviceId)
    if (!slot.doc.sessions[id]) return { ok: true, deleted: 0 }
    delete slot.doc.sessions[id]
    slot.doc.updatedAt = Date.now()
    this._schedule(slot)
    return { ok: true, deleted: 1 }
  }

  purge(deviceId) {
    const slot = this._load(deviceId)
    const n = Object.keys(slot.doc.sessions).length
    slot.doc.sessions = {}
    slot.doc.updatedAt = Date.now()
    this._schedule(slot)
    return { ok: true, deleted: n }
  }

  stats(deviceId) {
    const doc = this._load(deviceId).doc
    const ids = Object.keys(doc.sessions)
    let messages = 0
    for (const id of ids) messages += Array.isArray(doc.sessions[id].messages) ? doc.sessions[id].messages.length : 0
    return { sessions: ids.length, messages, updatedAt: num(doc.updatedAt) }
  }

  close() {
    this._closed = true
    for (const slot of this.cache.values()) {
      if (slot.timer) {
        clearTimeout(slot.timer)
        slot.timer = null
      }
      this._write(slot)
    }
    this.cache.clear()
  }
}

export { MAX_MESSAGES_KEEP }
