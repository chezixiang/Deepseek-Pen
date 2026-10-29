// 设备配对与请求签名（服务端实现，规范见 docs/api-auth-protocol.md）。
//
// 签名基串：METHOD\nPATH\nBODY_SHA256\nTIMESTAMP\nNONCE\nDEVICE_ID
// 签名值：HMAC-SHA256(signSecret, 基串)，十六进制小写。
// PATH 必须用原始请求行（含 query），BODY_SHA256 必须用原始字节——
// 任何"先 JSON 再序列化"的做法都会让哈希对不上（字段顺序/空格/Unicode 转义）。

import crypto from 'node:crypto'

export const SIGNATURE_WINDOW_SEC = 300

export const AUTH_HEADER = {
  deviceId: 'x-ds-device-id',
  timestamp: 'x-ds-timestamp',
  nonce: 'x-ds-nonce',
  signature: 'x-ds-signature'
}

// 配对码字母表去掉 0/O/1/I 等易混淆字符（要在设备小屏上核对、在后台手输）
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function sha256Hex(input) {
  const h = crypto.createHash('sha256')
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) h.update(input)
  else h.update(String(input == null ? '' : input), 'utf8')
  return h.digest('hex')
}

export function hmacHex(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message), 'utf8').digest('hex')
}

// 常量时间比较：长度不同直接失败；长度相同用 timingSafeEqual
export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8')
  const y = Buffer.from(String(b == null ? '' : b), 'utf8')
  if (x.length !== y.length) return false
  try {
    return crypto.timingSafeEqual(x, y)
  } catch (_) {
    return false
  }
}

export function signatureBase({ method, path, bodyHash, ts, nonce, deviceId }) {
  return [
    String(method || '').toUpperCase(),
    String(path || '/'),
    String(bodyHash || ''),
    String(ts),
    String(nonce || ''),
    String(deviceId || '')
  ].join('\n')
}

// 原始 HTTP 头在 Node 里是小写，但单元测试/嵌入式调用可能传原始大小写。
// 统一大小写不敏感读取，避免"两边签名都对、只是取不到头"的假失败。
function headerValue(headers, name) {
  if (!headers) return ''
  if (headers[name] !== undefined) return String(headers[name])
  const lower = String(name).toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return String(headers[k])
  }
  return ''
}

export function randomHex(byteLen) {
  return crypto.randomBytes(byteLen).toString('hex')
}

export function newDeviceToken() {
  return randomHex(32) // 64 hex
}

export function newSignSecret() {
  return randomHex(32)
}

export function generatePairingCode(len = 8) {
  let out = ''
  for (let i = 0; i < len; i++) out += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)]
  return out
}

export function normalizePairingCode(code) {
  return String(code || '').toUpperCase().replace(/[\s-]/g, '')
}

/**
 * 校验一次设备签名请求。所有失败都返回稳定错误码，便于客户端分类与审计。
 * @returns {{ok: true, token: string, ts: number, nonce: string} | {ok: false, code: string, message: string, status: number}}
 */
export function verifyDeviceRequest({
  headers,
  method,
  path,
  rawBody,
  device,
  now = Date.now(),
  windowSec = SIGNATURE_WINDOW_SEC,
  nonceCache = null
}) {
  const h = headers || {}
  const deviceId = headerValue(h, AUTH_HEADER.deviceId).trim()
  const tsRaw = headerValue(h, AUTH_HEADER.timestamp).trim()
  const nonce = headerValue(h, AUTH_HEADER.nonce).trim()
  const signature = headerValue(h, AUTH_HEADER.signature).trim()

  if (!deviceId || !tsRaw || !nonce || !signature) {
    return { ok: false, status: 401, code: 'missing_auth_headers', message: '缺少 X-Ds-* 签名头' }
  }
  const ts = Number(tsRaw)
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, status: 401, code: 'invalid_timestamp', message: 'X-Ds-Timestamp 不是合法毫秒时间戳' }
  }
  if (Math.abs(now - ts) > windowSec * 1000) {
    return { ok: false, status: 401, code: 'timestamp_out_of_window', message: '请求时间与服务器相差超过 ' + windowSec + ' 秒，请校准设备时间' }
  }
  if (!/^[0-9a-f]{16,128}$/i.test(nonce)) {
    return { ok: false, status: 401, code: 'invalid_nonce', message: 'X-Ds-Nonce 格式不正确（应为十六进制随机串）' }
  }
  if (nonceCache && nonceCache.has(deviceId, nonce)) {
    return { ok: false, status: 401, code: 'nonce_replay', message: '检测到重放请求（nonce 已使用）' }
  }

  if (!device) {
    return { ok: false, status: 401, code: 'device_not_paired', message: '设备未配对或令牌已失效' }
  }
  if (device.revokedAt) {
    return { ok: false, status: 401, code: 'device_revoked', message: '该设备已被吊销，请重新配对' }
  }
  if (device.blockedUntil && device.blockedUntil > now) {
    const retry = Math.ceil((device.blockedUntil - now) / 1000)
    return {
      ok: false,
      status: 403,
      code: 'device_blocked',
      message: '设备因异常流量被临时限制，请 ' + retry + ' 秒后再试',
      retryAfterSec: retry
    }
  }
  if (device.expiresAt && device.expiresAt < now) {
    return { ok: false, status: 401, code: 'device_token_expired', message: '设备令牌已过期，请刷新或重新配对' }
  }

  const auth = headerValue(h, 'authorization')
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) {
    return { ok: false, status: 401, code: 'invalid_device_token', message: '缺少 Bearer 设备令牌' }
  }
  const tokenHash = sha256Hex(token)
  if (!device.tokenHash || !constantTimeEqual(tokenHash, device.tokenHash)) {
    return { ok: false, status: 401, code: 'invalid_device_token', message: '设备令牌无效（可能已被刷新或吊销）' }
  }

  const bodyHash = sha256Hex(rawBody || Buffer.alloc(0))
  const base = signatureBase({ method, path, bodyHash, ts, nonce, deviceId })
  const expect = hmacHex(device.secret, base)
  if (!constantTimeEqual(signature.toLowerCase(), expect)) {
    return { ok: false, status: 401, code: 'signature_mismatch', message: '请求签名校验失败（请求体或路径被改动）' }
  }

  if (nonceCache) nonceCache.add(deviceId, nonce, now)
  return { ok: true, token, ts, nonce }
}

// ---------- nonce 防重放 ----------

export class NonceCache {
  constructor({ ttlMs = SIGNATURE_WINDOW_SEC * 1000, max = 200000 } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    this.map = new Map() // key -> seenAt
  }

  _key(deviceId, nonce) {
    return deviceId + ':' + nonce
  }

  has(deviceId, nonce, now = Date.now()) {
    const k = this._key(deviceId, nonce)
    const seen = this.map.get(k)
    if (!seen) return false
    if (now - seen > this.ttlMs) {
      this.map.delete(k)
      return false
    }
    return true
  }

  add(deviceId, nonce, now = Date.now()) {
    this.map.set(this._key(deviceId, nonce), now)
    if (this.map.size > this.max) this._evict(now)
  }

  _evict(now) {
    // 先清过期，再按插入顺序丢最老的 10%
    for (const [k, t] of this.map) {
      if (now - t > this.ttlMs) this.map.delete(k)
    }
    if (this.map.size <= this.max) return
    const drop = Math.max(1, Math.floor(this.max * 0.1))
    let n = 0
    for (const k of this.map.keys()) {
      this.map.delete(k)
      if (++n >= drop) break
    }
  }

  sweep(now = Date.now()) {
    for (const [k, t] of this.map) {
      if (now - t > this.ttlMs) this.map.delete(k)
    }
    return this.map.size
  }

  get size() {
    return this.map.size
  }
}

// ---------- 令牌桶限速（每设备） ----------

export class TokenBucket {
  constructor({ capacity = 20, perMinute = 20, maxKeys = 10000 } = {}) {
    this.capacity = Math.max(1, capacity)
    this.ratePerSec = Math.max(0.001, perMinute / 60)
    this.maxKeys = maxKeys
    this.map = new Map() // key -> {tokens, updatedAt}
  }

  take(key, now = Date.now()) {
    let b = this.map.get(key)
    if (!b) {
      b = { tokens: this.capacity, updatedAt: now }
      this.map.set(key, b)
      if (this.map.size > this.maxKeys) {
        const first = this.map.keys().next().value
        if (first !== undefined) this.map.delete(first)
      }
    }
    const elapsed = Math.max(0, now - b.updatedAt) / 1000
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.ratePerSec)
    b.updatedAt = now
    if (b.tokens < 1) {
      const retryAfterSec = Math.ceil((1 - b.tokens) / this.ratePerSec)
      return { ok: false, retryAfterSec, remaining: 0 }
    }
    b.tokens -= 1
    return { ok: true, retryAfterSec: 0, remaining: Math.floor(b.tokens) }
  }

  reset(key) {
    this.map.delete(key)
  }

  get size() {
    return this.map.size
  }
}

// ---------- 固定窗口失败计数（配对码爆破 / 签名爆破） ----------

export class FailWindow {
  constructor({ limit = 10, windowMs = 10 * 60 * 1000 } = {}) {
    this.limit = limit
    this.windowMs = windowMs
    this.map = new Map() // key -> {count, resetAt}
  }

  hit(key, now = Date.now()) {
    let e = this.map.get(key)
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs }
      this.map.set(key, e)
    }
    e.count += 1
    return { count: e.count, limited: e.count > this.limit, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) }
  }

  peek(key, now = Date.now()) {
    const e = this.map.get(key)
    if (!e || e.resetAt <= now) return { count: 0, limited: false, retryAfterSec: 0 }
    return { count: e.count, limited: e.count >= this.limit, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) }
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.map) if (e.resetAt <= now) this.map.delete(k)
  }
}
