// 管理后台密码认证。
//
// 设计：
//   - 密码用 scrypt 加盐哈希后写入 data/admin-auth.json（0600），不保存明文；
//   - 登录成功后签发随机会话令牌，放在 HttpOnly + SameSite=Strict Cookie 中；
//   - 会话令牌只在内存保存 SHA-256，进程重启后需要重新登录；
//   - 连续失败按 IP 限速，避免后台登录被暴力尝试。
//
// 首次部署可通过 POST /admin/api/auth/setup 从本机回环地址设置密码，
// 之后只能在后台「安全」页修改，不再依赖固定 admin token。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isLoopback } from './http.js'

export const ADMIN_COOKIE = 'penai_admin_session'
export const ADMIN_SESSION_TTL_SEC = 12 * 3600
const PASSWORD_MIN = 8
const PASSWORD_MAX = 200
const LOGIN_FAIL_LIMIT = 5
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

export class AdminAuthError extends Error {
  constructor(code, message, status = 400, retryAfterSec = 0) {
    super(message || code)
    this.code = code
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

function authFilePath(dataDir) {
  return path.join(dataDir, 'admin-auth.json')
}

function parseCookies(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '')
  const out = {}
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), derived.toString('base64')].join('$')
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!N || !r || !p) return false
  let salt
  let expected
  try {
    salt = Buffer.from(parts[4], 'base64')
    expected = Buffer.from(parts[5], 'base64')
  } catch (_) {
    return false
  }
  if (!salt.length || !expected.length) return false
  try {
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p })
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch (_) {
    return false
  }
}

function normalizePassword(value) {
  const password = String(value == null ? '' : value)
  if (password.length < PASSWORD_MIN) {
    throw new AdminAuthError('password_too_short', '密码至少需要 ' + PASSWORD_MIN + ' 位')
  }
  if (password.length > PASSWORD_MAX) {
    throw new AdminAuthError('password_too_long', '密码不能超过 ' + PASSWORD_MAX + ' 位')
  }
  return password
}

function isHttps(req) {
  return !!(
    (req && req.socket && req.socket.encrypted) ||
    String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https'
  )
}

export function adminCookie(token, expiresAt, secure) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return ADMIN_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge +
    (secure ? '; Secure' : '')
}

export function clearAdminCookie() {
  return ADMIN_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
}

export class AdminAuth {
  constructor({ dataDir, now = Date.now, sessionTtlSec = ADMIN_SESSION_TTL_SEC } = {}) {
    this.dataDir = dataDir
    this.now = now
    this.sessionTtlSec = sessionTtlSec
    this.file = authFilePath(dataDir)
    this.passwordHash = ''
    this.sessions = new Map() // sha256(token) -> { expiresAt, createdAt }
    this.failures = new Map() // ip -> { count, resetAt }
    this._load()
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw.passwordHash === 'string' && raw.passwordHash.startsWith('scrypt$')) {
        this.passwordHash = raw.passwordHash
      }
    } catch (_) {
      // 文件损坏时保持未初始化，管理员可通过本机 setup 重新设置。
      this.passwordHash = ''
    }
  }

  get configured() {
    return !!this.passwordHash
  }

  _persist(password) {
    const hash = hashPassword(password)
    fs.mkdirSync(this.dataDir, { recursive: true })
    const tmp = this.file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    const payload = { version: 1, passwordHash: hash, updatedAt: this.now() }
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows */ }
    fs.renameSync(tmp, this.file)
    try { fs.chmodSync(this.file, 0o600) } catch (_) { /* Windows */ }
    this.passwordHash = hash
  }

  _checkFailureLimit(ip) {
    const now = this.now()
    const entry = this.failures.get(ip)
    if (!entry) return
    if (entry.resetAt <= now) {
      this.failures.delete(ip)
      return
    }
    if (entry.count >= LOGIN_FAIL_LIMIT) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      throw new AdminAuthError('too_many_login_attempts', '登录尝试过于频繁，请 ' + Math.ceil(retryAfterSec / 60) + ' 分钟后再试', 429, retryAfterSec)
    }
  }

  _recordFailure(ip) {
    const now = this.now()
    const entry = this.failures.get(ip)
    if (!entry || entry.resetAt <= now) {
      this.failures.set(ip, { count: 1, resetAt: now + LOGIN_FAIL_WINDOW_MS })
      return
    }
    entry.count += 1
  }

  _newSession() {
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = this.now() + this.sessionTtlSec * 1000
    this.sessions.set(crypto.createHash('sha256').update(token).digest('hex'), {
      createdAt: this.now(),
      expiresAt
    })
    return { token, expiresAt }
  }

  canSetupFrom(ip, req) {
    const forwarded = req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])
    return !this.configured && isLoopback(ip) && !forwarded
  }

  setup(password, { ip = '', req = null } = {}) {
    if (this.configured) {
      throw new AdminAuthError('already_configured', '管理员密码已经设置，请直接登录', 409)
    }
    if (!this.canSetupFrom(ip, req)) {
      throw new AdminAuthError('setup_local_only', '首次设置密码只允许从服务器本机执行', 403)
    }
    this._persist(normalizePassword(password))
    this.failures.clear()
    return this._newSession()
  }

  login(password, { ip = '' } = {}) {
    if (!this.configured) {
      throw new AdminAuthError('admin_setup_required', '管理员密码尚未设置，请先在服务器本机初始化', 401)
    }
    this._checkFailureLimit(ip)
    if (!verifyPassword(String(password == null ? '' : password), this.passwordHash)) {
      this._recordFailure(ip)
      throw new AdminAuthError('admin_unauthorized', '密码不正确', 401)
    }
    this.failures.delete(ip)
    return this._newSession()
  }

  authenticate(req) {
    const token = parseCookies(req)[ADMIN_COOKIE]
    if (!token) return { ok: false, reason: 'missing_session' }
    const key = crypto.createHash('sha256').update(token).digest('hex')
    const session = this.sessions.get(key)
    if (!session) return { ok: false, reason: 'invalid_session' }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key)
      return { ok: false, reason: 'expired_session' }
    }
    return { ok: true, expiresAt: session.expiresAt }
  }

  logout(req) {
    const token = parseCookies(req)[ADMIN_COOKIE]
    if (!token) return false
    return this.sessions.delete(crypto.createHash('sha256').update(token).digest('hex'))
  }

  changePassword(currentPassword, nextPassword) {
    if (!this.configured) {
      throw new AdminAuthError('admin_setup_required', '管理员密码尚未设置', 401)
    }
    if (!verifyPassword(String(currentPassword == null ? '' : currentPassword), this.passwordHash)) {
      throw new AdminAuthError('current_password_invalid', '当前密码不正确', 400)
    }
    this._persist(normalizePassword(nextPassword))
    // 改密后所有旧会话立即失效，并为当前浏览器签发新会话。
    this.sessions.clear()
    this.failures.clear()
    return this._newSession()
  }

  logoutAll() {
    const count = this.sessions.size
    this.sessions.clear()
    return count
  }

  status(req) {
    return {
      configured: this.configured,
      authenticated: this.authenticate(req).ok
    }
  }
}

export { isHttps }
