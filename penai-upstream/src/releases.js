// 发布记录 + 更新包临时下载票据。
//
// 更新包不能继续使用公开的 /files URL：文件 ID 一旦被分享就能无限下载。
// 这里为每次发布保留历史，并签发短时 HMAC 票据；票据只允许下载指定文件，
// 默认 30 分钟有效。密钥持久化在 data/release-secret（0600），重启不失效。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HISTORY_LIMIT = 120

function nowMs() {
  return Date.now()
}

function randomId() {
  return 'rel_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex')
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s) {
  const pad = String(s || '').replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(pad + '='.repeat((4 - pad.length % 4) % 4), 'base64')
}

export class ReleaseManager {
  constructor({ dataDir = 'data', ttlSec = 1800 } = {}) {
    this.dir = dataDir || 'data'
    this.metaFile = path.join(this.dir, 'releases.json')
    this.secretFile = path.join(this.dir, 'release-secret')
    this.ttlSec = Math.max(60, Math.min(6 * 3600, Number(ttlSec) || 1800))
    this.items = []
    this.secret = this._loadSecret()
    this.load()
  }

  _loadSecret() {
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      const raw = fs.readFileSync(this.secretFile, 'utf8').trim()
      if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
    } catch (_) { /* 首次启动 */ }
    const secret = crypto.randomBytes(32)
    const tmp = this.secretFile + '.tmp-' + process.pid
    fs.writeFileSync(tmp, secret.toString('hex') + '\n', 'utf8')
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows */ }
    fs.renameSync(tmp, this.secretFile)
    return secret
  }

  load() {
    try {
      if (!fs.existsSync(this.metaFile)) return
      const raw = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.items) ? raw.items : [])
      this.items = list.filter((x) => x && x.id && x.fileId).map((x) => ({
        id: String(x.id),
        fileId: String(x.fileId),
        name: String(x.name || ''),
        build: Math.max(0, Math.trunc(Number(x.build) || 0)),
        version: String(x.version || ''),
        minBuild: Math.max(0, Math.trunc(Number(x.minBuild) || 0)),
        force: !!x.force,
        notes: String(x.notes || '').slice(0, 3000),
        size: Math.max(0, Math.trunc(Number(x.size) || 0)),
        sha256: String(x.sha256 || ''),
        scope: x.scope === 'devices' ? 'devices' : 'global',
        deviceIds: Array.isArray(x.deviceIds) ? x.deviceIds.map(String).slice(0, 200) : [],
        publishedAt: Math.max(0, Math.trunc(Number(x.publishedAt) || 0))
      }))
    } catch (e) {
      process.stderr.write('[releases] 读取发布历史失败（从空开始）：' + e.message + '\n')
      this.items = []
    }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.metaFile), { recursive: true })
    const payload = { version: 1, updatedAt: nowMs(), items: this.items }
    const tmp = this.metaFile + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows */ }
    fs.renameSync(tmp, this.metaFile)
  }

  list() {
    return this.items.slice().sort((a, b) => b.publishedAt - a.publishedAt)
  }

  get(id) {
    return this.items.filter((x) => x.id === String(id || ''))[0] || null
  }

  record(input = {}) {
    const item = {
      id: randomId(),
      fileId: String(input.fileId || ''),
      name: String(input.name || ''),
      build: Math.max(0, Math.trunc(Number(input.build != null ? input.build : input.latestBuild) || 0)),
      version: String(input.version || '').slice(0, 40),
      minBuild: Math.max(0, Math.trunc(Number(input.minBuild) || 0)),
      force: !!input.force,
      notes: String(input.notes || '').slice(0, 3000),
      size: Math.max(0, Math.trunc(Number(input.size) || 0)),
      sha256: String(input.sha256 || ''),
      scope: input.scope === 'devices' ? 'devices' : 'global',
      deviceIds: Array.isArray(input.deviceIds) ? input.deviceIds.map(String).slice(0, 200) : [],
      publishedAt: Math.max(0, Math.trunc(Number(input.publishedAt) || nowMs()))
    }
    if (!item.fileId || !item.build) throw new Error('发布记录缺少文件或构建号')
    this.items.push(item)
    if (this.items.length > HISTORY_LIMIT) this.items = this.items.slice(-HISTORY_LIMIT)
    this._write()
    return item
  }

  /** 签发票据：只绑定一个文件，过期后不可用。 */
  ticket(fileId, { deviceId = '', ttlSec = 0, now = nowMs() } = {}) {
    const exp = now + Math.max(60, Math.min(6 * 3600, Number(ttlSec) || this.ttlSec)) * 1000
    const payload = b64url(JSON.stringify({ f: String(fileId || ''), d: String(deviceId || ''), e: exp }))
    const sig = b64url(crypto.createHmac('sha256', this.secret).update(payload).digest())
    return { token: payload + '.' + sig, expiresAt: exp }
  }

  verifyTicket(fileId, token, now = nowMs()) {
    const raw = String(token || '')
    const cut = raw.lastIndexOf('.')
    if (cut <= 0) return false
    const payload = raw.slice(0, cut)
    const sig = raw.slice(cut + 1)
    const expected = b64url(crypto.createHmac('sha256', this.secret).update(payload).digest())
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
    let data
    try { data = JSON.parse(fromB64url(payload).toString('utf8')) } catch (_) { return false }
    if (!data || String(data.f) !== String(fileId || '')) return false
    return Number(data.e) > now
  }

  downloadPath(item, token) {
    return '/files/' + encodeURIComponent(item.id) + '/' + encodeURIComponent(item.name) +
      '?ticket=' + encodeURIComponent(token)
  }

  downloadUrl(item, publicBase, deviceId) {
    const t = this.ticket(item.id, { deviceId })
    const base = String(publicBase || '').replace(/\/+$/, '')
    return base + this.downloadPath(item, t.token)
  }
}

export { HISTORY_LIMIT }
