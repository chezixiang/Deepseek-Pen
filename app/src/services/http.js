// HTTP 客户端：用设备框架自带的 `http` 模块（import http from 'http'）。
// 这是真正异步的请求（真机实测不阻塞主线程），POST 用 data 字段，返回 {body, headers, status}。
// 注意：设备 http 模块偶发不返回（promise 挂起），这里用 Promise.race 加硬超时兜底，
// 避免 UI 一直显示"正在思考"。

import http from 'http'

// 安全约束：服务端请求 URL 仅允许 http/https。
// 外部端点（OpenAI 兼容模式，用户可填任意 URL）强制拒绝环回/私有/保留地址，防 SSRF；
// 内置 ds-free-api 模式走本机 127.0.0.1（应用自身配置、非用户输入目标），予以豁免。
function parseHost(url) {
  try {
    return new URL(url)
  } catch (e) {
    return null
  }
}

function isPrivateOrLoopback(u) {
  const host = u.hostname
  if (!host) return true
  // 环回
  if (host === 'localhost' || host === '::1') return true
  // IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.').map(Number)
    if (p[0] === 127) return true
    if (p[0] === 10) return true
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 169 && p[1] === 254) return true
    if (p[0] === 0) return true
    if (p[0] >= 224) return true
    return false
  }
  // IPv6 简判：链路本地/环回/唯一本地
  const h = host.toLowerCase()
  if (h.startsWith('fe80:')) return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true
  return false
}

export function validateExternalUrl(url) {
  const u = parseHost(url)
  if (!u) return 'URL 格式不正确'
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '仅支持 http/https'
  if (isPrivateOrLoopback(u)) return '不允许访问内网地址'
  return null
}

function parseBody(body) {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') {
    const t = body.trim()
    if (t === '') return null
    try {
      return JSON.parse(t)
    } catch (e) {
      return body
    }
  }
  return body
}

export async function httpRequest({ url, method = 'GET', headers = {}, data, timeout = 30000 }) {
  const opt = { url, method, headers: headers || {}, timeout }
  if (data !== undefined && data !== null) {
    opt.data = typeof data === 'string' ? data : JSON.stringify(data)
    if (!opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json'
  }

  // 硬超时：比配置多留 5 秒余量，超时返回可读错误而不是挂起
  const hardTimeout = (timeout || 30000) + 5000
  let timer = null
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ statusCode: 0, data: null, error: '请求超时，请检查服务地址后重试' }), hardTimeout)
  })

  try {
    const resp = await Promise.race([http.request(opt), timeoutPromise])
    if (timer) clearTimeout(timer)
    if (resp && resp.error) {
      return { statusCode: 0, data: null, error: resp.error }
    }
    const status = (resp && resp.status) || 0
    const parsed = parseBody(resp && resp.body)
    try { console.error('DEEPSEEK_HTTP | ' + method + ' ' + url + ' => status=' + status) } catch (e) { /* 忽略 */ }
    return { statusCode: status, data: parsed, error: status >= 400 ? ('HTTP ' + status) : undefined }
  } catch (e) {
    if (timer) clearTimeout(timer)
    try { console.error('DEEPSEEK_HTTP | ' + method + ' ' + url + ' => err=' + String(e)) } catch (e2) { /* 忽略 */ }
    return { statusCode: 0, data: null, error: e && e.message ? e.message : String(e) }
  }
}
