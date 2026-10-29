import { BUILD_NUM } from './store.js'

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
const CLIENT_VERSION$1 = '0.2.0-build-' + BUILD_NUM;

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

// 设备令牌只对签发它的服务有效。设置里同时存着「内置服务」和「自定义端点」两套
// 地址，切换模式后旧的设备令牌还在——拿着 A 服务的令牌去请求 B 服务，必然 401，
// 而且报错会被解释成"令牌过期"，把用户引到错误的处置上。
// 这里只比较主机名：协议、端口、/v1 前缀、路径写法都不影响归属判断。
function urlHost(url) {
  const m = String(url || '').trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : ''
}

function isSameHost(a, b) {
  const ha = urlHost(a);
  const hb = urlHost(b);
  if (!ha || !hb) return false
  return ha === hb
}


export { AUTH_HEADER_DEVICE_ID, AUTH_HEADER_NONCE, AUTH_HEADER_SIGNATURE, AUTH_HEADER_TIMESTAMP, CLIENT_HEADER, CLIENT_ID, CLIENT_VERSION$1, PAIRING_ALPHABET, PAIRING_CODE_LEN, SHA256_K, clientHeaders, generatePairingCode, hmacSha256Hex, isPaired, isSameHost, maskDeviceId, randByte, randomHex, rotr, sha256Bytes, sha256Hex, signRequest, signatureBase, toHex, tokenExpiringSoon, urlHost, urlPath, utf8Bytes, uuidV4 };
