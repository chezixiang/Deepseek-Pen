// 错误分类：把后端/上游的错误语义翻译成"应用该怎么做"。
//
// 单独成模块的理由：这些判定必须能在宿主机上单测（设备原生模块在 node 里 import
// 不了），而它们决定的是**要不要继续发请求**——判错会把用户账号送进禁言。
//
// 核心区分（bug 1）：
//   - 服务繁忙 / Overloaded：只是当前没有空闲账号，等一会自己会好，可以重试；
//   - 上游限流 / RateLimited：上游正在限这条链路，**继续重试会被判定为异常客户端
//     并升级为禁言**。必须明确告诉用户"等待，不要连点发送"，并且应用侧停止自动续发。

/**
 * 上游限流的错误码（后端 ds-free-api 的 upstream_rate_limited）。
 * 与"服务繁忙（overloaded，只是暂时没空闲账号）"分开。
 */
export function isRateLimitCode(code) {
  return String(code || '').toLowerCase() === 'upstream_rate_limited'
}

/**
 * 限流文案兜底匹配（后端未给独立错误码时，按话术识别）。
 * 注意不要把"服务繁忙"这类通用文案算进来——那会把可正常重试的请求误拦成限流。
 */
export function isRateLimitText(text) {
  const t = String(text || '')
  return /上游限流|rate limited|rate_limit_reached|所有账号均在限流|upstream_rate_limited/i.test(t)
}

/**
 * 疑似账号被上游限制/禁言（只有这类才值得记入"账号异常"取证；401/限流不算）。
 * 限流是"暂时别发"，封禁/禁言是"这个账号有问题"，两者的用户动作完全不同。
 */
export function isAccountSuspension(text) {
  return /禁言|被限制|封禁|空\s*SSE|empty sse|账号已被/i.test(String(text || ''))
}

/** 综合判定：这次失败是否属于"上游限流，必须停止续发" */
export function isRateLimitedError(err) {
  if (!err) return false
  if (err.rateLimited) return true
  if (isRateLimitCode(err.code)) return true
  return isRateLimitText(err.message)
}
