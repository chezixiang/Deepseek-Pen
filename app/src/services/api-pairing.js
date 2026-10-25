import { clientHeaders, isPaired, signRequest, urlPath } from './api-auth.js'
import { httpRequest, validateExternalUrl } from './http.js'
import { upstreamRootUrl } from './store.js'

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


export { PairError, authRoot, checkUrl$1, normalizePairResp, normalizeRefreshResp, pairDevice, refreshDeviceToken, revokeDeviceToken, signedAuthCall };
