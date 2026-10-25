import http from 'http';
import { BUILD_NUM, upstreamRootUrl, resolveBackendBaseUrl, isUpstreamMode, appLog, readFile, UPSTREAM_ENROLL_TOKEN } from './store.js';

// HTTP 客户端：用设备框架自带的 `http` 模块（import http from 'http'）。

// 安全约束：服务端请求 URL 仅允许 http/https。
// 外部端点（OpenAI 兼容模式，用户可填任意 URL）强制拒绝环回/私有/保留地址，防 SSRF；
// 内置 ds-free-api 模式走本机 127.0.0.1（应用自身配置、非用户输入目标），予以豁免。
// 手写解析，不依赖 URL 构造器：设备 QuickJS 运行时不保证提供 URL 全局，
// 之前 `new URL()` 抛出后一律回报"URL 格式不正确"，自定义端点在部分设备上
// 无论填什么都过不了校验。
function parseHost(url) {
  const s = String(url || '').trim();
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/);
  if (!m) return null
  const protocol = m[1].toLowerCase() + ':';
  let authority = m[2];
  // 去掉 userinfo
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  let hostname = authority;
  if (hostname.startsWith('[')) {
    // IPv6 字面量 [::1]:8080
    const close = hostname.indexOf(']');
    hostname = close > 0 ? hostname.slice(1, close) : hostname.slice(1);
  } else {
    const colon = hostname.indexOf(':');
    if (colon >= 0) hostname = hostname.slice(0, colon);
  }
  if (!hostname) return null
  return { protocol, hostname: hostname.toLowerCase() }
}

/**
 * 校验用户填写的端点地址。
 *
 * 这里**允许**内网/局域网地址：本应用的自定义端点模式的主要用途就是
 * "在 PC / 家用服务器上跑 ds-free-api，词典笔通过局域网访问"（见 README）。
 * 旧实现无条件拒绝 10./172.16-31./192.168./127. 网段，等于把该功能整体禁用
 * （用户报告"自定义 api 端点模式无法正常使用"的直接原因）。
 *
 * 仍然拒绝的是明确非法或没有意义的目标：非 http/https、缺主机名、
 * 以及 0.0.0.0 / 组播 / 链路本地这类不能作为客户端目标的地址。
 * 注意这是用户在本机设置里主动填写的地址，不是服务端代收的不可信输入，
 * 所以经典 SSRF 威胁模型在此不适用。
 */
function validateExternalUrl(url) {
  const u = parseHost(url);
  if (!u) return 'URL 格式不正确（需形如 http://192.168.1.5:22217）'
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '仅支持 http/https'
  if (isUnusableHost(u)) return '该地址不可作为服务地址（0.0.0.0/组播/链路本地）'
  return null
}

// 允许环回与私有网段（自建服务的正常形态），只拦不可用目标
function isUnusableHost(u) {
  const host = u.hostname;
  if (!host) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.').map(Number);
    if (p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
    if (p[0] === 0) return true // 0.0.0.0/8
    if (p[0] === 169 && p[1] === 254) return true // 链路本地
    if (p[0] >= 224) return true // 组播/保留
    return false
  }
  const h = host.toLowerCase();
  if (h.startsWith('fe80:')) return true
  return false
}

function parseBody(body) {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') {
    const t = body.trim();
    if (t === '') return null
    try {
      return JSON.parse(t)
    } catch (e) {
      return body
    }
  }
  return body
}

async function httpRequest({ url, method = 'GET', headers = {}, data, timeout = 30000 }) {
  const opt = { url, method, headers: headers || {}, timeout };
  if (data !== undefined && data !== null) {
    opt.data = typeof data === 'string' ? data : JSON.stringify(data);
    if (!opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
  }

  // 硬超时：比配置多留 5 秒余量，超时返回可读错误而不是挂起
  const hardTimeout = (timeout || 30000) + 5000;
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ statusCode: 0, data: null, error: '请求超时，请检查服务地址后重试' }), hardTimeout);
  });

  try {
    // 给设备侧的原始 promise 挂一个空 catch 再 race：超时赢得竞争后，
    // 原始 promise 若稍后 reject 会变成 unhandled rejection（QuickJS 上
    // 轻则刷日志，重则被框架判为致命错误）。
    const devicePromise = http.request(opt);
    if (devicePromise && typeof devicePromise.catch === 'function') {
      devicePromise.catch(() => {});
    }
    const resp = await Promise.race([devicePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    if (resp && resp.error) {
      return { statusCode: 0, data: null, error: resp.error }
    }
    const status = (resp && resp.status) || 0;
    const parsed = parseBody(resp && resp.body);
    try { console.error('DEEPSEEK_HTTP | ' + method + ' ' + url + ' => status=' + status); } catch (e) { /* 忽略 */ }
    return { statusCode: status, data: parsed, error: status >= 400 ? ('HTTP ' + status) : undefined }
  } catch (e) {
    if (timer) clearTimeout(timer);
    try { console.error('DEEPSEEK_HTTP | ' + method + ' ' + url + ' => err=' + String(e)); } catch (e2) { /* 忽略 */ }
    return { statusCode: 0, data: null, error: e && e.message ? e.message : String(e) }
  }
}

// 设备配对鉴权（纯函数：无 native 桥、无网络依赖，可在 Node 里回归测试）。

// ---------- UTF-8 ----------

// 手写 UTF-8 编码：设备运行时不保证有 TextEncoder（http.js 里手写 URL 解析是同一原因）。
function utf8Bytes(str) {
  const s = String(str == null ? '' : str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      // 代理对：两个 UTF-16 码元合成一个码点
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
        continue
      }
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out
}

// ---------- SHA-256（FIPS 180-4） ----------

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

function sha256Bytes(msg) {
  const l = msg.length;
  const padded = msg.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  // 64 位大端比特长度：聊天量级的 body 远小于 4GB，高位基本为 0，仍按标准写满 8 字节
  const bits = l * 8;
  const hi = Math.floor(bits / 4294967296);
  const lo = bits % 4294967296;
  padded.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  padded.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = ((padded[i + 4 * t] << 24) | (padded[i + 4 * t + 1] << 16) | (padded[i + 4 * t + 2] << 8) | padded[i + 4 * t + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff);
  }
  return out
}

function sha256Hex(message) {
  return toHex(sha256Bytes(utf8Bytes(message)))
}

// ---------- HMAC-SHA256（RFC 2104） ----------

function hmacSha256Hex(key, message) {
  // Array.from：调用方可能传入 Buffer/Uint8Array（测试向量），它们没有 push/map 语义
  let k = typeof key === 'string' ? utf8Bytes(key) : Array.from(key);
  if (k.length > 64) k = sha256Bytes(k);
  const block = k.slice();
  while (block.length < 64) block.push(0);
  const iPad = block.map((x) => x ^ 0x36);
  const oPad = block.map((x) => x ^ 0x5c);
  const msg = typeof message === 'string' ? utf8Bytes(message) : Array.from(message);
  const inner = sha256Bytes(iPad.concat(msg));
  return toHex(sha256Bytes(oPad.concat(inner)))
}

// ---------- 随机数 / 设备标识 ----------

// 设备侧不保证有 crypto.getRandomValues（native.js 的 uuidV4 同样用 Math.random）。
// 这里的随机数只用于 nonce / deviceId / 配对码，不承担密码学强度要求。
function randByte() {
  return (Math.random() * 256) | 0
}

function randomHex(byteLen) {
  let out = '';
  for (let i = 0; i < byteLen; i++) {
    const b = randByte();
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out
}

function uuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16)
  })
}

// 配对码字母表去掉 0/O/1/I 等易混淆字符（要在设备小屏上核对、在管理后台手输）。
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LEN = 8;

function generatePairingCode() {
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LEN; i++) {
    out += PAIRING_ALPHABET[(Math.random() * PAIRING_ALPHABET.length) | 0];
  }
  return out
}

// ---------- 请求签名 ----------

const AUTH_HEADER_DEVICE_ID = 'X-Ds-Device-Id';
const AUTH_HEADER_TIMESTAMP = 'X-Ds-Timestamp';
const AUTH_HEADER_NONCE = 'X-Ds-Nonce';
const AUTH_HEADER_SIGNATURE = 'X-Ds-Signature';

// 客户端标识：服务端用它区分"本 App"与"脚本/反代"，也是防反代的硬门槛
// （服务端 guard.requireClientHeader=true 时，缺这个头直接 403）。
// 版本号来自构建信息，管理后台可据此判断设备版本；格式必须匹配
// 服务端 /^(deepseek-pen|pen-miniapp)\/[0-9A-Za-z._-]+$/。
const CLIENT_HEADER = 'X-Ds-Client';
const CLIENT_ID = 'deepseek-pen';
const CLIENT_VERSION$1 = '0.1.5-build-' + BUILD_NUM;

function clientHeaders() {
  const h = {};
  h[CLIENT_HEADER] = CLIENT_ID + '/' + CLIENT_VERSION$1;
  return h
}

// 从完整 URL 取路径（含 query）。设备 QuickJS 不保证有 URL 构造器
// （http.js 的 parseHost 是同一原因），这里手写。
function urlPath(url) {
  const s = String(url == null ? '' : url);
  const m = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*([/?#].*)?$/);
  let rest = m ? (m[1] || '/') : s;
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  return rest || '/'
}

// 签名基串：换行分隔的六个字段，任一处被中间人改动都会导致验签失败。
// body 传完整请求体文本（GET 传空串），哈希用 SHA-256。
function signatureBase(method, path, bodyHash, ts, nonce, deviceId) {
  return [String(method).toUpperCase(), path, bodyHash, String(ts), nonce, deviceId].join('\n')
}

/**
 * 生成一次请求的签名鉴权头。
 * @param {Object} p { method, path, body, deviceId, secret, ts, nonce }
 * @returns {{ headers: Object, ts: number, nonce: string, bodyHash: string }}
 */
function signRequest(p) {
  const method = String((p && p.method) || 'GET').toUpperCase();
  const path = String((p && p.path) || '/');
  const deviceId = String((p && p.deviceId) || '');
  const secret = String((p && p.secret) || '');
  const ts = Number(p && p.ts) || Date.now();
  const nonce = String((p && p.nonce) || randomHex(16));
  const bodyHash = sha256Hex(p && p.body != null ? p.body : '');
  const sig = hmacSha256Hex(secret, signatureBase(method, path, bodyHash, ts, nonce, deviceId));
  const headers = {};
  headers[AUTH_HEADER_DEVICE_ID] = deviceId;
  headers[AUTH_HEADER_TIMESTAMP] = String(ts);
  headers[AUTH_HEADER_NONCE] = nonce;
  headers[AUTH_HEADER_SIGNATURE] = sig;
  // 客户端标识不参与签名（它是身份信号，不是凭证）；随每个签名请求一起发出。
  Object.assign(headers, clientHeaders());
  return { headers, ts, nonce, bodyHash }
}

// ---------- 配对材料 ----------

// auth = { deviceId, deviceToken, signSecret, expiresAt, tlsPin }
// 三个要件缺一不可；enabled 由用户在设置页显式开启（默认关闭，不影响普通端点）。

function isPaired(auth) {
  return !!(auth && auth.deviceId && auth.deviceToken && auth.signSecret)
}

// 令牌是否即将过期（默认 5 分钟内）。调用方据此在发请求前先刷新，避免聊到一半 401。
function tokenExpiringSoon(auth, withinMs, now) {
  if (!isPaired(auth)) return false
  const exp = Number(auth.expiresAt) || 0;
  if (!exp) return false
  const n = Number(now) || Date.now();
  return exp - n <= (Number(withinMs) || 300000)
}

// 配对材料脱敏展示（设置页用）：deviceId 与密钥都不整串显示。
function maskDeviceId(id) {
  const v = String(id || '');
  if (!v) return ''
  if (v.length <= 8) return v.slice(0, 2) + '****'
  return v.slice(0, 6) + '****' + v.slice(-4)
}

// 设备配对 / 令牌刷新 / 吊销（网络侧；协议见 docs/api-auth-protocol.md）。

class PairError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 配对/刷新/吊销挂在网关根路径（/auth/*），而 baseUrl 是 OpenAI 兼容层地址
// （通常以 /v1 结尾）。不剥掉 /v1 会请求到 /v1/auth/pair → 404。
function authRoot(baseUrl) {
  return upstreamRootUrl(baseUrl)
}

function checkUrl$1(url) {
  const err = validateExternalUrl(url);
  if (err) throw new PairError('BAD_URL', err)
}

// 配对响应归一化：token 与密钥都不可或缺（缺一个服务端就会把所有请求判 401）。
function normalizePairResp(data) {
  const d = data || {};
  const deviceToken = String(d.deviceToken || d.device_token || '').trim();
  const signSecret = String(d.signSecret || d.sign_secret || '').trim();
  let expiresAt = Number(d.expiresAt || d.expires_at || 0);
  if (!expiresAt && d.expiresIn) expiresAt = Date.now() + Number(d.expiresIn) * 1000;
  if (!deviceToken || !signSecret) {
    throw new PairError('BAD_RESPONSE', '服务端响应缺少 deviceToken / signSecret')
  }
  return { deviceToken, signSecret, expiresAt }
}

// 刷新响应：密钥允许不下发（服务端不轮换时沿用旧值）。
function normalizeRefreshResp(data, oldSecret) {
  const d = data || {};
  const deviceToken = String(d.deviceToken || d.device_token || '').trim();
  const signSecret = String(d.signSecret || d.sign_secret || '').trim() || oldSecret;
  let expiresAt = Number(d.expiresAt || d.expires_at || 0);
  if (!expiresAt && d.expiresIn) expiresAt = Date.now() + Number(d.expiresIn) * 1000;
  if (!deviceToken || !signSecret) {
    throw new PairError('BAD_RESPONSE', '服务端刷新响应缺少 deviceToken')
  }
  return { deviceToken, signSecret, expiresAt }
}

/**
 * 用配对码换取设备令牌。配对码需用户先在管理后台批准，否则服务端返回
 * 400/404/409/410，这里统一翻译成"去确认配对码"的可读提示。
 */
async function pairDevice({ baseUrl, pairingCode, deviceId, timeout = 15000 }) {
  const code = String(pairingCode || '').trim().toUpperCase();
  const dev = String(deviceId || '').trim();
  if (!code) throw new PairError('BAD_CODE', '请填写配对码')
  if (!dev) throw new PairError('BAD_DEVICE', '设备标识缺失，请重启 App 后重试')
  const url = authRoot(baseUrl) + '/auth/pair';
  checkUrl$1(url);
  const resp = await httpRequest({
    url,
    method: 'POST',
    timeout,
    headers: Object.assign({ 'Content-Type': 'application/json' }, clientHeaders()),
    data: JSON.stringify({ pairingCode: code, deviceId: dev })
  });
  if (resp.statusCode === 0) {
    throw new PairError('NETWORK', resp.error || '无法连接服务器，请检查服务地址')
  }
  if (resp.statusCode === 400 || resp.statusCode === 404 || resp.statusCode === 409 || resp.statusCode === 410) {
    const apiMsg = resp.data && resp.data.error && (resp.data.error.message || resp.data.error.code);
    throw new PairError('PAIR_' + resp.statusCode,
      apiMsg || ('配对失败（HTTP ' + resp.statusCode + '）：请确认配对码正确、未过期，且已在管理后台批准'))
  }
  if (resp.statusCode >= 400) {
    throw new PairError('HTTP_' + resp.statusCode, '配对失败（HTTP ' + resp.statusCode + '）')
  }
  return normalizePairResp(resp.data)
}

// 带签名的服务端调用（刷新/吊销）：签名头 + Bearer deviceToken 双因子。
function signedAuthCall(path, { baseUrl, auth, body, timeout }) {
  const url = authRoot(baseUrl) + path;
  checkUrl$1(url);
  const bodyText = JSON.stringify(body || {});
  const { headers } = signRequest({
    method: 'POST',
    path: urlPath(url),
    body: bodyText,
    deviceId: auth.deviceId,
    secret: auth.signSecret,
    ts: Date.now()
  });
  headers['Content-Type'] = 'application/json';
  headers['Authorization'] = 'Bearer ' + auth.deviceToken;
  return httpRequest({ url, method: 'POST', timeout: timeout || 15000, headers, data: bodyText })
}

/**
 * 刷新设备令牌（临期自动刷新 / 手动刷新）。服务端可轮换签名密钥：
 * 下发了新 signSecret 就换掉，否则沿用旧值。
 */
async function refreshDeviceToken({ baseUrl, auth, timeout = 15000 }) {
  if (!isPaired(auth)) throw new PairError('NOT_PAIRED', '尚未配对，无需刷新')
  const resp = await signedAuthCall('/auth/refresh', {
    baseUrl, auth, body: { deviceId: auth.deviceId }, timeout
  });
  if (resp.statusCode === 0) {
    throw new PairError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new PairError('TOKEN_INVALID', '设备令牌已被吊销或过期，请重新配对')
  }
  if (resp.statusCode >= 400) {
    throw new PairError('HTTP_' + resp.statusCode, '刷新失败（HTTP ' + resp.statusCode + '）')
  }
  return normalizeRefreshResp(resp.data, auth.signSecret)
}

/**
 * 解除配对：通知服务端吊销本设备令牌（best-effort）。
 * 失败不阻断本地清除——服务端不可达时用户至少能断开本地绑定。
 */
async function revokeDeviceToken({ baseUrl, auth, timeout = 10000 }) {
  if (!isPaired(auth)) return { ok: true, skipped: true }
  try {
    const resp = await signedAuthCall('/auth/revoke', {
      baseUrl, auth, body: { deviceId: auth.deviceId }, timeout
    });
    if (resp.statusCode === 0) return { ok: false, message: resp.error || '连接失败' }
    if (resp.statusCode >= 400) return { ok: false, message: 'HTTP ' + resp.statusCode }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) }
  }
}

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

export { uuidV4, generatePairingCode, pairDevice, revokeDeviceToken, getLastAuthError, fmtReset, submitFeedback, quotaText, fetchDeviceStatus, activeAnnouncement, updateGate, ensureUpstreamAuth, fetchControl, clientHeaders, httpRequest, isPaired, urlPath, randomHex, deleteRemoteSession, maintenanceActive, normalizeControl, purgeRemoteSessions, pushSession, quotaExhausted, refreshDeviceToken, signRequest, tokenExpiringSoon, upstreamBase, validateExternalUrl, listRemoteSessions, fetchRemoteSession, maskDeviceId, quotaLow };
