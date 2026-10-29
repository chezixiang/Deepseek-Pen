// 网页搜索/抓取代理客户端：把设备的 /v1/tools/search|fetch 请求转发给
// DeepSeek 官方 Search / Fetch API（https://api-docs.deepseek.com/zh-cn/guides/search）。
//
// 设计要点：
//   - DeepSeek API Key 只存在于服务端配置里，设备侧永远接触不到；
//   - 只做"带密钥的转发 + 参数钳制"，不做缓存（Search/Fetch 按次计费，
//     结果时效性强，缓存反而容易把旧闻当新闻喂给模型）；
//   - 上游错误体可能包含账号/余额信息，只取 message 回给设备。

const DEFAULT_TIMEOUT_MS = 30000

export class ToolsError extends Error {
  constructor(code, message, status = 502) {
    super(message || code)
    this.code = code
    this.status = status
  }
}

function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '')
  const s = String(suffix || '').replace(/^\/+/, '')
  return b + '/' + s
}

// 手写 host 解析（与客户端 http.js 同思路，不依赖 URL 全局）：
// fetch 的 url 参数必须含 host、http/https、不带 userinfo。
export function validateTargetUrl(u) {
  const s = String(u || '').trim()
  if (!s) return '缺少 url'
  if (s.length > 8192) return 'url 长度不能超过 8192'
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)([/?#].*)?$/)
  if (!m) return 'url 必须是含主机的 http/https 地址'
  const protocol = m[1].toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') return '仅支持 http/https'
  let authority = m[2]
  const at = authority.lastIndexOf('@')
  if (at >= 0) return 'url 不能携带用户名或密码'
  let hostname = authority
  if (hostname.startsWith('[')) {
    const close = hostname.indexOf(']')
    hostname = close > 0 ? hostname.slice(1, close) : hostname.slice(1)
  } else {
    const colon = hostname.indexOf(':')
    if (colon >= 0) hostname = hostname.slice(0, colon)
  }
  if (!hostname) return 'url 缺少主机名'
  return null
}

export class ToolsClient {
  constructor(config, { fetchImpl } = {}) {
    this.cfg = config.tools || {}
    this.fetchImpl = fetchImpl || globalThis.fetch
  }

  get configured() {
    return !!String(this.cfg.apiKey || '').trim()
  }

  async request(path, body, { signal, timeoutMs } = {}) {
    if (!this.configured) {
      throw new ToolsError(
        'tools_not_configured',
        '网页搜索服务尚未配置（tools.apiKey 为空）',
        503
      )
    }
    const ctl = new AbortController()
    let abortedBy = ''
    const onAbort = () => {
      abortedBy = 'client'
      ctl.abort()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const total = Number(timeoutMs) || Number(this.cfg.timeoutMs) || DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      abortedBy = 'timeout'
      ctl.abort()
    }, total)
    if (timer.unref) timer.unref()
    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    try {
      // 官方 Base URL 为 https://api.deepseek.com，端点带 /v1 前缀；
      // 若部署时把 baseUrl 直接配成了带 /v1 的形式，则不再重复拼接。
      const base = String(this.cfg.baseUrl || '').replace(/\/+$/, '')
      const pathWithV1 = /\/v1$/.test(base) ? path : 'v1/' + path.replace(/^\/+/, '')
      const resp = await this.fetchImpl(joinUrl(base, pathWithV1), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': this.cfg.userAgent || 'deepseek-pen-upstream/1.0',
          'Authorization': 'Bearer ' + this.cfg.apiKey
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'follow'
      })
      return { resp, cleanup, abortedBy: () => abortedBy }
    } catch (e) {
      cleanup()
      if (abortedBy === 'client') {
        throw new ToolsError('client_aborted', '客户端已断开', 499)
      }
      if (abortedBy === 'timeout') {
        throw new ToolsError('tools_timeout', '搜索服务响应超时', 504)
      }
      throw new ToolsError('tools_unreachable', '无法连接搜索服务：' + (e && e.message ? e.message : String(e)), 502)
    }
  }

  // 上游错误体只取 message，不透传原始 JSON（可能含账号信息）。
  static async describeError(resp, limit = 16 * 1024) {
    let text = ''
    try {
      text = await resp.text()
    } catch (_) {
      return { message: '搜索服务返回 HTTP ' + resp.status }
    }
    const clipped = text.length > limit ? text.slice(0, limit) : text
    let message = ''
    try {
      const obj = JSON.parse(clipped)
      message = (obj && obj.error && (obj.error.message || obj.error.code)) || (obj && obj.message) || ''
    } catch (_) {
      message = clipped.slice(0, 300)
    }
    return { message: String(message || ('搜索服务返回 HTTP ' + resp.status)) }
  }
}
