import { clientHeaders, isPaired, signRequest, sha256Hex, tokenExpiringSoon, urlPath, uuidV4 } from './api-auth.js'
import { refreshDeviceToken } from './api-pairing.js'
import { httpRequest, validateExternalUrl } from './http.js'
import { BUILD_NUM, UPSTREAM_ENROLL_TOKEN, appLog, isUpstreamMode, readFile, resolveBackendBaseUrl, upstreamRootUrl } from './store.js'

// 上游网关的客户端 SDK（静默注册 / 云控 / 配额 / 会话备份 / 反馈）。

const CLIENT_BUILD = BUILD_NUM;
const CLIENT_VERSION = '0.1.5-build-' + BUILD_NUM;

class UpstreamError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data || null;
  }
}

// 设置对象 → 签名材料（未注册返回 null，与 api-auth.isPaired 同口径）
function deviceAuth(settings) {
  const s = settings || {};
  if (!s.pairDeviceId || !s.pairToken || !s.pairSecret) return null
  return {
    deviceId: String(s.pairDeviceId),
    deviceToken: String(s.pairToken),
    signSecret: String(s.pairSecret),
    expiresAt: Number(s.pairExpiresAt) || 0,
    tlsPin: s.pairTlsPin || ''
  }
}

function upstreamBase(settings) {
  const s = settings || {};
  const resolved = s.effectiveBaseUrl || resolveBackendBaseUrl({
    backendMode: s.backendMode,
    baseUrl: s.baseUrl,
    upstreamBaseUrl: s.upstreamBaseUrl,
    defaultBaseUrl: ''
  });
  return String(resolved || '').replace(/\/+$/, '')
}

function checkUrl(url) {
  const err = validateExternalUrl(url);
  if (err) throw new UpstreamError('BAD_URL', err)
}

function apiError(resp, fallback) {
  const d = resp && resp.data;
  const e = d && d.error;
  return new UpstreamError(
    (e && e.code) || ('HTTP_' + (resp && resp.statusCode)),
    (e && e.message) || fallback || ('HTTP ' + (resp && resp.statusCode)),
    d
  )
}

function ensureAuth(auth) {
  if (!isPaired(auth)) throw new UpstreamError('NOT_REGISTERED', '设备尚未注册')
}

/**
 * 生成设备标识。
 *
 * 优先用网卡 MAC 做哈希：卸载重装后 $dataDir 会被清空，若标识每次都随机，
 * 同一台笔会被服务端当成新设备（设备数虚增、旧会话也恢复不回来）。
 * 读不到 MAC（权限/网卡名不同）时回退随机 UUID——功能不受影响，只是丢了可恢复性。
 * 注意：execShell 在设备上无回显，必须用 fs 读 sysfs 文件；只上传哈希，不上传原始 MAC。
 */
async function stableDeviceId() {
  const candidates = ['/sys/class/net/wlan0/address', '/sys/class/net/eth0/address', '/sys/class/net/wlan1/address'];
  for (const file of candidates) {
    try {
      const raw = await readFile(file);
      const m = String(raw || '').match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/);
      if (m) {
        return 'pen-' + sha256Hex('deepseek-pen:' + m[0].toLowerCase()).slice(0, 32)
      }
    } catch (e) { /* 换下一个网卡 */ }
  }
  return uuidV4()
}

// ---------- 注册 ----------

/**
 * 静默注册：拿到设备令牌 + 签名密钥。服务端可能要求 X-Ds-Enroll（构建期常量）。
 * @returns {Promise<{deviceToken, signSecret, expiresAt, quota, controlVersion}>}
 */
async function registerDevice({ baseUrl, deviceId, timeout = 15000, enrollToken = UPSTREAM_ENROLL_TOKEN }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const root = upstreamRootUrl(base);
  const url = root + '/device/register';
  checkUrl(url);
  const headers = clientHeaders();
  headers['Content-Type'] = 'application/json';
  if (enrollToken) headers['X-Ds-Enroll'] = String(enrollToken);
  const resp = await httpRequest({
    url,
    method: 'POST',
    timeout,
    headers,
    data: JSON.stringify({
      deviceId: String(deviceId || ''),
      build: String(CLIENT_BUILD),
      version: CLIENT_VERSION,
      platform: 'dictpen'
    })
  });
  if (resp.statusCode === 0) {
    throw new UpstreamError('NETWORK', resp.error || '无法连接服务器')
  }
  if (resp.statusCode >= 400) {
    const err = apiError(resp, '设备注册失败');
    throw err
  }
  const d = resp.data || {};
  const deviceToken = String(d.deviceToken || '').trim();
  const signSecret = String(d.signSecret || '').trim();
  if (!deviceToken || !signSecret) {
    throw new UpstreamError('BAD_RESPONSE', '注册响应缺少凭证')
  }
  return {
    deviceToken,
    signSecret,
    expiresAt: Number(d.expiresAt) || 0,
    quota: d.quota || null,
    controlVersion: Number(d.controlVersion) || 0
  }
}

// 同一时刻只允许一个注册/续期流程：两个页面同时进来会互相把对方的令牌顶掉。
let authInflight = null;
// 最近一次注册/续期失败原因：UI 用它区分"没网"和"被服务端拒绝"
let lastAuthError = null;

function getLastAuthError() {
  return lastAuthError
}

/**
 * 确保本机有可用的设备凭证（静默）。永不抛出：失败返回 null，由调用方按"未连接"处理。
 *
 * @param {Object} opts
 * @param {Object} opts.settings  loadSettings() 的结果（会被就地更新）
 * @param {Function} [opts.persist] 保存设置的函数（通常是 saveSettings）
 * @param {boolean} [opts.force] 忽略现有凭证，强制重新注册
 */
function ensureUpstreamAuth(opts = {}) {
  if (authInflight) return authInflight
  const run = doEnsureUpstreamAuth(opts);
  authInflight = run.then(
    (v) => { authInflight = null; return v },
    (e) => { authInflight = null; return null }
  );
  return authInflight
}

async function doEnsureUpstreamAuth({ settings, persist, force = false, timeout = 15000 } = {}) {
  const s = settings || {};
  if (!isUpstreamMode(s.backendMode)) return null
  const baseUrl = upstreamBase(s);
  if (!baseUrl) {
    appLog('[upstream] 构建未预置上游地址，跳过注册');
    return null
  }

  let changed = false;
  if (!s.pairDeviceId) {
    s.pairDeviceId = await stableDeviceId();
    changed = true;
  }
  let auth = deviceAuth(s);
  const needsRegister = force || !auth;

  if (!needsRegister) {
    // 令牌还有 2 小时以上：直接复用
    if (!tokenExpiringSoon(auth, 2 * 60 * 60 * 1000)) {
      lastAuthError = null;
      return auth
    }
    try {
      const r = await refreshDeviceToken({ baseUrl, auth, timeout });
      s.pairToken = r.deviceToken;
      if (r.signSecret) s.pairSecret = r.signSecret;
      s.pairExpiresAt = r.expiresAt;
      changed = true;
      lastAuthError = null;
      appLog('[upstream] 设备令牌已静默续期 expiresAt=' + r.expiresAt);
      if (changed && typeof persist === 'function') await persist();
      return deviceAuth(s)
    } catch (e) {
      appLog('[upstream] 令牌续期失败，尝试重新注册：' + (e && e.message ? e.message : String(e)));
      if (e && e.code === 'NETWORK') {
        // 网络问题：旧令牌可能仍然有效，先继续用，避免一次断网就清空凭证
        lastAuthError = { code: 'NETWORK', message: e.message || '网络不可用', at: Date.now() };
        return auth
      }
    }
  }

  try {
    const r = await registerDevice({ baseUrl, deviceId: s.pairDeviceId, timeout });
    s.pairToken = r.deviceToken;
    s.pairSecret = r.signSecret;
    s.pairExpiresAt = r.expiresAt;
    s.lastEnrollAt = Date.now();
    s.pairTlsPin = s.pairTlsPin || '';
    if (r.quota) s.quotaCache = r.quota;
    if (typeof persist === 'function') await persist();
    lastAuthError = null;
    appLog('[upstream] 设备已静默注册 deviceId=' + s.pairDeviceId);
    return deviceAuth(s)
  } catch (e) {
    const code = e && e.code ? e.code : 'UNKNOWN';
    lastAuthError = { code, message: e && e.message ? e.message : String(e), at: Date.now() };
    appLog('[upstream] 静默注册失败 code=' + code + ' ' + (e && e.message ? e.message : String(e)));
    return null
  }
}

// ---------- 通用签名调用 ----------

async function signedCall({ baseUrl, auth, method = 'GET', path, body, timeout = 15000 }) {
  ensureAuth(auth);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  // path 形如 /v1/control：拼到网关根上（去掉 base 末尾的 /v1）
  const root = upstreamRootUrl(base);
  const url = root + path;
  checkUrl(url);
  const bodyText = body === undefined || body === null ? '' : JSON.stringify(body);
  const { headers } = signRequest({
    method,
    path: urlPath(url),
    body: bodyText,
    deviceId: auth.deviceId,
    secret: auth.signSecret,
    ts: Date.now()
  });
  if (bodyText) headers['Content-Type'] = 'application/json';
  headers['Authorization'] = 'Bearer ' + auth.deviceToken;
  const resp = await httpRequest({
    url,
    method,
    headers,
    data: bodyText || undefined,
    timeout
  });
  if (resp.statusCode === 0) {
    throw new UpstreamError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode >= 400) {
    throw apiError(resp, '请求失败（HTTP ' + resp.statusCode + '）')
  }
  return resp.data || {}
}

// ---------- 云控 / 配额 ----------

async function fetchControl({ baseUrl, auth, timeout = 12000 }) {
  return signedCall({ baseUrl, auth, method: 'GET', path: '/v1/control', timeout })
}

async function fetchDeviceStatus({ baseUrl, auth, timeout = 12000 }) {
  return signedCall({ baseUrl, auth, method: 'GET', path: '/v1/me', timeout })
}

// ---------- 会话备份 ----------
//
// 本地为主库：推送的是整条会话快照；删除是硬删除。
// 用 POST 而不是 PUT（设备 Falcon http 模块对 PUT/DELETE 支持不稳定，
// 网关同时接受 PUT 与 POST，见 upstream/server.js）。

async function pushSession({ baseUrl, auth, conversation, messages, timeout = 20000 }) {
  const conv = conversation || {};
  if (!conv.id) throw new UpstreamError('BAD_SESSION', '会话缺少 id')
  const path = '/v1/sessions/' + encodeURIComponent(String(conv.id));
  const body = {
    title: String(conv.title || '新对话').slice(0, 60),
    mode: conv.mode || 'fast',
    thinking: conv.thinking !== false,
    search: conv.search === true,
    createdAt: Number(conv.createdAt) || Date.now(),
    updatedAt: Number(conv.updatedAt) || Date.now(),
    messages: (Array.isArray(messages) ? messages : []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content || '',
      reasoning: m.reasoning || '',
      error: m.error || '',
      createdAt: m.createdAt,
      pending: !!m.pending,
      revisions: m.revisions,
      activeRevision: m.activeRevision,
      attempts: m.attempts,
      activeAttempt: m.activeAttempt,
      // dataUrl 有几 MB，绝不上传；只保留路径
      images: Array.isArray(m.images) ? m.images.map((i) => ({ name: i.name, path: i.path })) : []
    }))
  };
  return signedCall({ baseUrl, auth, method: 'POST', path, body, timeout })
}

async function listRemoteSessions({ baseUrl, auth, timeout = 15000 }) {
  const d = await signedCall({ baseUrl, auth, method: 'GET', path: '/v1/sessions', timeout });
  return Array.isArray(d.data) ? d.data : []
}

async function fetchRemoteSession({ baseUrl, auth, sessionId, timeout = 20000 }) {
  return signedCall({
    baseUrl,
    auth,
    method: 'GET',
    path: '/v1/sessions/' + encodeURIComponent(String(sessionId)),
    timeout
  })
}

async function deleteRemoteSession({ baseUrl, auth, sessionId, timeout = 15000 }) {
  return signedCall({
    baseUrl,
    auth,
    method: 'POST',
    path: '/v1/sessions/' + encodeURIComponent(String(sessionId)) + '/delete',
    body: {},
    timeout
  })
}

async function purgeRemoteSessions({ baseUrl, auth, timeout = 15000 }) {
  return signedCall({ baseUrl, auth, method: 'POST', path: '/v1/sessions/purge', body: {}, timeout })
}

// ---------- 意见反馈 ----------

async function submitFeedback({ baseUrl, auth, category, text, contact, diagnostics, timeout = 20000 }) {
  return signedCall({
    baseUrl,
    auth,
    method: 'POST',
    path: '/v1/feedback',
    timeout,
    body: {
      category: category || 'other',
      text: String(text || ''),
      contact: String(contact || ''),
      build: String(CLIENT_BUILD),
      version: CLIENT_VERSION,
      diagnostics: diagnostics || {}
    }
  })
}

// 云控的客户端侧：归一化、更新判定、维护/公告判定、配额文案。

const CONTROL_VERSION = 1;

const DEFAULT_CONTROL = {
  version: CONTROL_VERSION,
  updatedAt: 0,
  announcement: { id: '', title: '', body: '', level: 'info', active: false, until: 0 },
  maintenance: { enabled: false, message: '', until: 0 },
  features: { chat: true, search: true, images: true, thinking: true, feedback: true, sessions: true },
  update: { latestBuild: 0, minBuild: 0, force: false, version: '', notes: '', url: '', publishedAt: 0 },
  models: [],
  notice: '',
  quotaHint: ''
};

function str(v, max = 2000) {
  const s = String(v == null ? '' : v);
  return s.length > max ? s.slice(0, max) : s
}

function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return fallback
}

function int(v, fallback = 0) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback
}

const LEVELS = ['info', 'warn', 'critical'];

function level(v) {
  const s = str(v, 16);
  return LEVELS.indexOf(s) >= 0 ? s : 'info'
}

/**
 * 把服务端/缓存里的任意结构归一成客户端可安全读取的形状。
 * 旧缓存缺字段、服务端升级加字段都不能让页面报错。
 */
function normalizeControl(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const a = src.announcement && typeof src.announcement === 'object' ? src.announcement : {};
  const m = src.maintenance && typeof src.maintenance === 'object' ? src.maintenance : {};
  const f = src.features && typeof src.features === 'object' ? src.features : {};
  const u = src.update && typeof src.update === 'object' ? src.update : {};
  return {
    version: int(src.version, CONTROL_VERSION),
    updatedAt: int(src.updatedAt, 0),
    announcement: {
      id: str(a.id, 64),
      title: str(a.title, 120),
      body: str(a.body, 3000),
      level: level(a.level),
      active: bool(a.active, false),
      until: int(a.until, 0)
    },
    maintenance: {
      enabled: bool(m.enabled, false),
      message: str(m.message, 500),
      until: int(m.until, 0)
    },
    features: {
      chat: bool(f.chat, true),
      search: bool(f.search, true),
      images: bool(f.images, true),
      thinking: bool(f.thinking, true),
      feedback: bool(f.feedback, true),
      sessions: bool(f.sessions, true)
    },
    update: {
      latestBuild: int(u.latestBuild, 0),
      minBuild: int(u.minBuild, 0),
      force: bool(u.force, false),
      version: str(u.version, 40),
      notes: str(u.notes, 3000),
      url: str(u.url, 500),
      publishedAt: int(u.publishedAt, 0)
    },
    models: Array.isArray(src.models) ? src.models.map((x) => str(x && x.id ? x.id : x, 80)).filter(Boolean).slice(0, 40) : [],
    notice: str(src.notice, 1000),
    quotaHint: str(src.quotaHint, 500)
  }
}

function maintenanceActive(control, now = Date.now()) {
  const c = control || DEFAULT_CONTROL;
  const m = c.maintenance || {};
  if (!m.enabled) return false
  const until = Number(m.until) || 0;
  return !until || until > now
}

// 当前应该弹的公告（未过期、有 id、未被用户关闭）
function activeAnnouncement(control, seenId, now = Date.now()) {
  const c = control || DEFAULT_CONTROL;
  const a = c.announcement || {};
  if (!a.active || !a.id) return null
  if (Number(a.until) && Number(a.until) <= now) return null
  if (seenId && a.id === seenId) return null
  return a
}

/**
 * 更新判定。
 *   - buildNum < minBuild        → force（低于最低可用版本，必须更新）
 *   - buildNum < latestBuild     → update.force ? force : optional
 *   - 其它                        → none
 * @returns {{state:'none'|'optional'|'force', latestBuild:number, minBuild:number, version:string, notes:string, url:string}}
 */
function updateGate(control, buildNum = BUILD_NUM) {
  const c = control || DEFAULT_CONTROL;
  const u = c.update || {};
  const latest = Number(u.latestBuild) || 0;
  const min = Number(u.minBuild) || 0;
  const current = Number(buildNum) || 0;
  const info = {
    latestBuild: latest,
    minBuild: min,
    version: u.version || '',
    notes: u.notes || '',
    url: u.url || '',
    currentBuild: current
  };
  if (current > 0 && min > 0 && current < min) return Object.assign({ state: 'force' }, info)
  if (current > 0 && latest > 0 && current < latest) {
    return Object.assign({ state: u.force ? 'force' : 'optional' }, info)
  }
  return Object.assign({ state: 'none' }, info)
}

// 千分位（设备 QuickJS 不保证有 Intl）
function fmtNum(n) {
  const s = String(Math.round(Number(n) || 0));
  let out = '';
  let count = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    out = s.charAt(i) + out;
    count++;
    if (count % 3 === 0 && i > 0) out = ',' + out;
  }
  return out
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return fmtNum(v)
}

/**
 * 配额文案（设置页/抽屉共用）。
 * quota 结构见 upstream/server.js 的 quotaOf()：
 *   { enabled, requests:{limit,used,remaining,resetAt}, tokens:{...}, monthly:{...} }
 */
function quotaText(quota) {
  const q = quota || {};
  if (!q || q.enabled === false) return '不限额度'
  const parts = [];
  const reqLimit = Number(q.requests && q.requests.limit) || 0;
  const tokLimit = Number(q.tokens && q.tokens.limit) || 0;
  const monLimit = Number(q.monthly && q.monthly.limit) || 0;
  if (reqLimit > 0) {
    const left = Math.max(0, reqLimit - (Number(q.requests.used) || 0));
    parts.push('今日剩余 ' + fmtNum(left) + ' 次');
  }
  if (tokLimit > 0) {
    const left = Math.max(0, tokLimit - (Number(q.tokens.used) || 0));
    parts.push('今日剩余 ' + fmtTokens(left) + ' tokens');
  }
  if (monLimit > 0) {
    const left = Math.max(0, monLimit - (Number(q.monthly.used) || 0));
    parts.push('本月剩余 ' + fmtTokens(left) + ' tokens');
  }
  if (!parts.length) return '不限额度'
  return parts.join(' · ')
}

// 额度紧张（剩余不足 10%）时客户端用警示色提示
function quotaLow(quota) {
  const q = quota || {};
  if (!q || q.enabled === false) return false
  if (q.exhausted) return true
  const check = (o) => {
    const limit = Number(o && o.limit) || 0;
    if (limit <= 0) return false
    const used = Number(o && o.used) || 0;
    return used / limit >= 0.9
  };
  return check(q.requests) || check(q.tokens) || check(q.monthly)
}

function quotaExhausted(quota) {
  const q = quota || {};
  return !!(q && q.exhausted)
}

// 距离配额重置还有多久（文案用）
function fmtReset(resetAt, now = Date.now()) {
  const t = Number(resetAt) || 0;
  if (!t) return ''
  const diff = t - now;
  if (diff <= 0) return '即将重置'
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 1) return h + ' 小时 ' + m + ' 分钟后重置'
  return Math.max(1, m) + ' 分钟后重置'
}



export { CLIENT_BUILD, CLIENT_VERSION, CONTROL_VERSION, DEFAULT_CONTROL, LEVELS, UpstreamError, activeAnnouncement, apiError, authInflight, bool, checkUrl, deleteRemoteSession, deviceAuth, doEnsureUpstreamAuth, ensureAuth, ensureUpstreamAuth, fetchControl, fetchDeviceStatus, fetchRemoteSession, fmtNum, fmtReset, fmtTokens, getLastAuthError, int, lastAuthError, level, listRemoteSessions, maintenanceActive, normalizeControl, purgeRemoteSessions, pushSession, quotaExhausted, quotaLow, quotaText, registerDevice, signedCall, stableDeviceId, str, submitFeedback, updateGate, upstreamBase };
