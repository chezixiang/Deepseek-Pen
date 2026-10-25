import http from 'http';
import { isPaired, signRequest, urlPath, randomHex } from './api-auth.js'

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

// ---------- 设备配对鉴权（防搬运，见 api-auth.js / api-pairing.js） ----------
//
// 普通模式（未配对）：Authorization: Bearer <apiKey>，与旧版行为完全一致。
// 配对模式：Bearer <deviceToken> + 每请求 HMAC 签名头（X-Ds-*）。
// 端点+Key 明文存在设备上，抠出来就能搭反代倒卖；配对模式把认证换成
// 短期设备令牌 + 签名，抓包拿走的凭证几小时即废，服务端还可按 deviceId 吊销。

// 配对模式下的鉴权头（http.js 普通请求用）。未配对返回 {}，调用方保持旧行为。
function pairedAuthHeaders(auth, method, url, body) {
  if (!isPaired(auth)) return {}
  const { headers } = signRequest({
    method,
    path: urlPath(url),
    body: body || '',
    deviceId: auth.deviceId,
    secret: auth.signSecret,
    ts: Date.now(),
    nonce: randomHex(16)
  });
  return headers
}

// 配对模式下 SSE 走 curl -K 配置文件而非命令行 -H：
// 命令行的参数会出现在设备进程列表里（ps 可见），等于把令牌/密钥摊开。
// 配置文件与 reqFile 同命运（$dataDir 写入、用完即删）。
function cfgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, '')
}

// 生成配对模式的 curl 配置（请求方法 / 全部头 / body 文件 / TLS 锁定 / URL）。
// reqFile 传完整路径：curl 的工作目录不确定，相对路径会找不到 body 文件。
function buildCurlConfig({ url, reqFile, deviceToken, sigHeaders, tlsPin }) {
  let cfg = 'request = "POST"\n';
  cfg += 'header = "Content-Type: application/json"\n';
  cfg += 'header = "Authorization: Bearer ' + cfgEsc(deviceToken) + '"\n';
  const keys = Object.keys(sigHeaders);
  for (let i = 0; i < keys.length; i++) {
    cfg += 'header = "' + cfgEsc(keys[i]) + ': ' + cfgEsc(sigHeaders[keys[i]]) + '"\n';
  }
  if (tlsPin) {
    // 证书公钥锁定（SPKI）：中间人即使有受信 CA 也换不掉证书，防抓包改包。
    // 形如 sha256//Base64(SPKI)，由服务端管理员提供；留空不启用。
    cfg += 'pinnedpubkey = "' + cfgEsc(tlsPin) + '"\n';
  }
  cfg += 'data = "@' + cfgEsc(reqFile) + '"\n';
  cfg += 'url = "' + cfgEsc(url) + '"\n';
  return cfg
}

/**
 * 流式（SSE）对话请求。
 * 设备框架的 $falcon.jsapi.http 不支持增量回调，因此这里用后台 curl -N 写文件 +
 * 轮询文件的方式实现逐字/逐段渲染。
 * @param {Object} opts { baseUrl, apiKey, modeKey, messages, thinking, search, timeout,
 *                        authMode, modelId, conversationId, auth }
 *   auth 为设备配对材料（可选）：{ deviceId, deviceToken, signSecret, expiresAt, tlsPin }
 * @param {Object} handlers { onDelta(text, full), onReasoning(text, full) }
 * @returns {Promise<{content, reasoning, finishReason, usage}>}
 */


export { buildCurlConfig, cfgEsc, httpRequest, isUnusableHost, pairedAuthHeaders, parseBody, parseHost, validateExternalUrl };
