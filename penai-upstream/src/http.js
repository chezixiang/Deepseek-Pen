// HTTP 基础设施：原始字节读取（验签必须用原始 body）、JSON 响应、路由、错误。
// 不引框架：部署目标是一台小机器，npm install 都不需要。

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (err) => {
      if (done) return
      done = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      reject(err)
    }
    const onData = (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limitBytes) {
        fail(new HttpError(413, 'body_too_large', '请求体超过上限（' + limitBytes + ' 字节）'))
        req.resume()
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    }
    const onError = (e) => fail(new HttpError(400, 'body_read_error', e.message))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

export function parseJsonBody(buf) {
  if (!buf || buf.length === 0) return {}
  let obj
  try {
    obj = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON：' + e.message)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new HttpError(400, 'invalid_json', '请求体必须是 JSON 对象')
  }
  return obj
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, headers))
  res.end(body)
}

export function sendError(res, status, code, message, opts = {}) {
  const headers = Object.assign({}, opts.headers || {})
  if (opts.retryAfterSec) headers['Retry-After'] = String(opts.retryAfterSec)
  // scope 区分错误来源，客户端/后台据此区分：
  //   gateway  = 网关自身产生（鉴权、限额、校验、连不上上游等）
  //   upstream = 真实上游服务返回的错误（透传其 message）
  const err = {
    code: String(code),
    message: String(message || code),
    type: opts.type || 'upstream_gateway_error',
    scope: opts.scope === 'upstream' ? 'upstream' : 'gateway'
  }
  if (opts.upstreamStatus) err.upstreamStatus = Number(opts.upstreamStatus)
  sendJson(res, status, { error: err }, headers)
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = String(text == null ? '' : text)
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(body)
}

export function clientIp(req, { trustProxy = true } = {}) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for']
    if (xff) {
      const first = String(xff).split(',')[0].trim()
      if (first) return normalizeIp(first)
    }
    const real = req.headers['x-real-ip']
    if (real) return normalizeIp(String(real).trim())
  }
  return normalizeIp((req.socket && (req.socket.remoteAddress || req.socket.localAddress)) || '')
}

export function normalizeIp(ip) {
  let s = String(ip || '').trim()
  if (s.startsWith('::ffff:')) s = s.slice(7)
  if (s === '::1') return '127.0.0.1'
  // 去掉 IPv6 zone id（fe80::1%eth0）
  const pct = s.indexOf('%')
  if (pct >= 0) s = s.slice(0, pct)
  return s
}

export function isLoopback(ip) {
  const s = normalizeIp(ip)
  return s === '127.0.0.1' || s === '::1' || s.startsWith('127.')
}

// ---------- 路由 ----------

function compilePattern(pattern) {
  const parts = String(pattern).split('/').filter((p) => p !== '')
  return { parts, raw: pattern }
}

function matchParts(compiled, pathParts) {
  const params = {}
  const a = compiled.parts
  if (a.length !== pathParts.length) {
    // 末尾 * 通配
    if (!(a[a.length - 1] === '*' && pathParts.length >= a.length - 1)) return null
  }
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]
    if (seg === '*') return params
    if (seg.startsWith(':')) {
      if (pathParts[i] === undefined) return null
      params[seg.slice(1)] = decodeURIComponent(pathParts[i])
    } else if (seg !== pathParts[i]) {
      return null
    }
  }
  return pathParts.length === a.length ? params : null
}

export class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    this.routes.push({ method: String(method).toUpperCase(), compiled: compilePattern(pattern), handler, pattern })
    return this
  }

  get(pattern, handler) { return this.add('GET', pattern, handler) }
  post(pattern, handler) { return this.add('POST', pattern, handler) }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler) }
  put(pattern, handler) { return this.add('PUT', pattern, handler) }

  match(method, pathname) {
    const parts = String(pathname).split('/').filter((p) => p !== '')
    let pathMatched = false
    for (const r of this.routes) {
      const params = matchParts(r.compiled, parts)
      if (!params) continue
      pathMatched = true
      if (r.method === String(method).toUpperCase() || r.method === 'ANY') {
        return { handler: r.handler, params, pattern: r.pattern }
      }
    }
    return pathMatched ? { handler: null, params: null, methodNotAllowed: true } : null
  }
}

export function splitPath(url) {
  const s = String(url || '/')
  const q = s.indexOf('?')
  return q >= 0 ? s.slice(0, q) : s
}

export function parseQuery(url) {
  const s = String(url || '')
  const q = s.indexOf('?')
  const out = {}
  if (q < 0) return out
  const search = s.slice(q + 1)
  for (const pair of search.split('&')) {
    if (!pair) continue
    const i = pair.indexOf('=')
    const k = decodeURIComponent(i >= 0 ? pair.slice(0, i) : pair)
    const v = i >= 0 ? decodeURIComponent(pair.slice(i + 1)) : ''
    out[k] = v
  }
  return out
}
