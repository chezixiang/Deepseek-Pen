// 防反代：签名只能挡住"偷到 token 直接重放"，挡不住"连签名密钥一起偷走再搭反代"。
// 这里做的是后者——用一组行为信号给每个设备打分，命中阈值即临时封禁并留审计。
//
// 信号选择原则：
//   - 只取"正常词典笔不会出现、反代/脚本几乎必然出现"的特征；
//   - 单项分值不足以封禁，避免移动网络切换、时区/时钟误差这类误伤；
//   - 所有判定可解释（reasons 里带分值与原因），管理后台能直接看到为什么封。

export const KNOWN_DEVICE_PATHS = new Set([  '/v1/chat/completions',
  '/v1/models',
  '/v1/me',
  '/v1/control',
  '/v1/update/ticket',
  '/v1/telemetry',
  '/v1/feedback',
  // 联网搜索/抓取代理：客户端 tool call 的执行点，不能算未知路径
  // （每次 +50 风险、三次即被自动封禁）
  '/v1/tools/search',
  '/v1/tools/fetch',
  '/v1/sessions',
  '/v1/sessions/purge',
  // 调试模式：被授权的设备按 pollSec 轮询命令/回传结果，不能算未知路径
  '/v1/debug/commands',
  '/v1/debug/results',
  '/auth/refresh',
  '/auth/revoke',
  '/device/register'
])

// 带路径参数的设备接口（会话 id 在路径里），按前缀判定。
// 漏掉它们会把每一次会话备份都算成"未知路径"（+50 风险），
// 客户端正常同步几轮就被自动封禁。
const KNOWN_DEVICE_PREFIXES = ['/v1/sessions/']

// 典型扫描器路径特征：路径穿越、配置文件、常见后台、云元数据
const SCAN_PATTERNS = [
  /\.\./,
  /%2e%2e/i,
  /\/\.env/i,
  /\/\.git/i,
  /\/etc\//i,
  /wp-admin/i,
  /phpmyadmin/i,
  /\/actuator/i,
  /\/console/i,
  /169\.254\.169\.254/,
  /\/server-status/i
]

const CLIENT_RE = /^(deepseek-pen|pen-miniapp)\/[0-9A-Za-z._-]+$/

export function stripQuery(path) {
  const s = String(path || '/')
  const i = s.indexOf('?')
  return i >= 0 ? s.slice(0, i) : s
}

export function classifyPath(path) {
  const p = stripQuery(path)
  for (const re of SCAN_PATTERNS) {
    if (re.test(path) || re.test(p)) return 'scan'
  }
  if (KNOWN_DEVICE_PATHS.has(p)) return 'known'
  for (const prefix of KNOWN_DEVICE_PREFIXES) {
    if (p.startsWith(prefix)) return 'known'
  }
  return 'unknown'
}

// IPv4 取 /24，IPv6 取 /48：同一个出口网段内的地址变化不算"跨网络"
export function ipBucket(ip) {
  const s = String(ip || '').trim()
  if (!s) return 'unknown'
  if (s.indexOf(':') >= 0) {
    const parts = s.toLowerCase().split(':').filter(Boolean)
    return parts.slice(0, 3).join(':') + '::/48'
  }
  const p = s.split('.')
  if (p.length === 4) return p.slice(0, 3).join('.') + '.0/24'
  return s
}

export function uaAllowed(ua, patterns) {
  const s = String(ua || '').toLowerCase()
  if (!s) return false
  const list = Array.isArray(patterns) ? patterns : []
  for (const p of list) {
    if (p && s.indexOf(String(p).toLowerCase()) >= 0) return true
  }
  return false
}

export function clientHeaderValid(value) {
  return CLIENT_RE.test(String(value || '').trim())
}

/**
 * 纯函数风险评分，便于单测。
 * @returns {{score:number, reasons:Array<{code:string,points:number,detail?:string}>}}
 */
export function computeRisk(ctx, guardCfg) {
  const cfg = guardCfg || {}
  const reasons = []
  const add = (code, points, detail) => {
    if (points > 0) reasons.push({ code, points, detail: detail || '' })
  }

  if (!ctx.hasClientHeader) {
    add('client_header_missing', cfg.requireClientHeader ? 30 : 8)
  } else if (!ctx.clientValid) {
    add('client_header_malformed', 15, String(ctx.client || '').slice(0, 64))
  }

  if (!ctx.uaAllowed) {
    add('ua_not_allowed', 20, String(ctx.ua || '(空)').slice(0, 80))
  }

  const maxIps = Number(cfg.maxIpsPerHour) || 6
  if (Number(ctx.ipCount1h) > maxIps) {
    add('ip_diversity', 25, ctx.ipCount1h + ' 个网段/小时（上限 ' + maxIps + '）')
  }

  const minSamples = Number(cfg.rhythmMinSamples) || 12
  const cvThreshold = Number(cfg.rhythmCvThreshold) || 0.08
  if (Number(ctx.samples) >= minSamples && Number.isFinite(ctx.intervalCv) && ctx.intervalCv < cvThreshold) {
    add('rhythm_too_uniform', 18, 'CV=' + Number(ctx.intervalCv).toFixed(3))
  }

  if (ctx.headerHashChanged) add('header_order_changed', 8)

  if (ctx.pathClass === 'scan') {
    add('path_scan', Number(cfg.scanPathPenalty) || 80, String(ctx.path || '').slice(0, 120))
  } else if (ctx.pathClass === 'unknown') {
    add('unknown_path', Number(cfg.unknownPathPenalty) || 50, String(ctx.path || '').slice(0, 120))
  }

  if (Number(ctx.bodyBytes) > 4 * 1024 * 1024) add('large_body', 8, String(ctx.bodyBytes))

  const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0))
  return { score, reasons }
}

function cvOf(times) {
  if (!times || times.length < 3) return { samples: 0, cv: NaN }
  const gaps = []
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1]
    if (g >= 0) gaps.push(g)
  }
  if (gaps.length < 2) return { samples: gaps.length, cv: NaN }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  if (mean <= 0) return { samples: gaps.length, cv: NaN }
  const variance = gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length
  return { samples: gaps.length, cv: Math.sqrt(variance) / mean }
}

export class DeviceGuard {
  constructor({ config, store, now = Date.now }) {
    this.config = config
    this.store = store
    this.now = now
    this.runtime = new Map()
    this._lastWarnAt = new Map()
  }

  _rt(deviceId) {
    let r = this.runtime.get(deviceId)
    if (!r) {
      r = { times: [], ips: new Map(), headerHash: '', concurrent: 0, lastSeenAt: 0, strikes: [] }
      this.runtime.set(deviceId, r)
    }
    if (!r.strikes) r.strikes = []
    return r
  }

  _headerHash(req) {
    // Node 保留收到的头顺序；反代/脚本常改头顺序或删减头
    const names = []
    for (const k of Object.keys(req.headers || {})) names.push(k)
    return names.join(',')
  }

  /**
   * 记录一次签名请求并评估风险。
   * @returns {{score, reasons, blocked, warn, retryAfterSec}}
   */
  assess(device, req, { path: reqPath, rawBody, clientIp: ip }) {
    const cfg = this.config.guard || {}
    const now = this.now()
    const rt = this._rt(device.deviceId)

    // 节奏样本（只留最近 20 个）
    rt.times.push(now)
    if (rt.times.length > 20) rt.times.shift()
    rt.lastSeenAt = now

    // IP 多样性（1 小时窗口）
    const bucket = ipBucket(ip)
    rt.ips.set(bucket, now)
    let ipCount1h = 0
    for (const [k, t] of rt.ips) {
      if (now - t > 3600 * 1000) rt.ips.delete(k)
      else ipCount1h += 1
    }

    const hh = this._headerHash(req)
    const headerHashChanged = !!rt.headerHash && rt.headerHash !== hh
    rt.headerHash = hh

    const client = String(req.headers['x-ds-client'] || '')
    const ua = String(req.headers['user-agent'] || '')
    const rhythm = cvOf(rt.times)

    const { score: signalScore, reasons } = computeRisk({
      hasClientHeader: !!client,
      clientValid: clientHeaderValid(client),
      client,
      ua,
      uaAllowed: uaAllowed(ua, cfg.allowedUaPatterns),
      ipCount1h,
      samples: rhythm.samples,
      intervalCv: rhythm.cv,
      headerHashChanged,
      pathClass: classifyPath(reqPath),
      path: reqPath,
      bodyBytes: rawBody ? rawBody.length : 0
    }, cfg)

    // 与持久化的历史风险做半衰期 10 分钟的叠加：反复触发才会累积到封禁
    const prevAt = Number(device.riskUpdatedAt) || now
    const prev = Number(device.risk) || 0
    const decayed = prev * Math.pow(0.5, Math.max(0, now - prevAt) / (10 * 60 * 1000))
    const score = Math.min(100, Math.max(signalScore, Math.round(decayed * 10) / 10))

    // 单次风险可能不足以封禁（例如"未知路径"50 分），但短时间反复触发就是扫描/反代。
    // 三次警告窗口（10 分钟）内累计 3 次即视为持续异常。
    rt.strikes = (rt.strikes || []).filter((t) => now - t < 10 * 60 * 1000)
    if (signalScore >= (Number(cfg.warnThreshold) || 50)) rt.strikes.push(now)
    const strikeBlock = rt.strikes.length >= 3

    let blocked = false
    let retryAfterSec = 0
    if (cfg.enabled && cfg.blockOnHighRisk && (score >= (Number(cfg.riskThreshold) || 70) || strikeBlock)) {
      const until = now + (Number(cfg.blockDurationSec) || 1800) * 1000
      this.store.blockDevice(device.deviceId, until, reasons.map((r) => r.code).join(',') || 'repeated_risk')
      this.store.audit('device_blocked', {
        deviceId: device.deviceId,
        ip,
        score,
        strikes: rt.strikes.length,
        reasons,
        until
      })
      blocked = true
      retryAfterSec = Math.ceil((until - now) / 1000)
      rt.strikes = []
    } else if (cfg.enabled && score >= (Number(cfg.warnThreshold) || 50)) {
      const last = this._lastWarnAt.get(device.deviceId) || 0
      if (now - last > 5 * 60 * 1000) {
        this._lastWarnAt.set(device.deviceId, now)
        this.store.audit('risk_warn', { deviceId: device.deviceId, ip, score, reasons })
      }
    }

    // 风险分持久化（随 touch 一起防抖落盘）
    this.store.touchDevice(device.deviceId, {
      risk: score,
      riskUpdatedAt: now,
      lastIp: ip || device.lastIp || '',
      lastSeenAt: now
    })

    return { score, reasons, blocked, warn: score >= (Number(cfg.warnThreshold) || 50), retryAfterSec }
  }

  enter(deviceId) {
    const rt = this._rt(deviceId)
    rt.concurrent += 1
    return rt.concurrent
  }

  leave(deviceId) {
    const rt = this._rt(deviceId)
    rt.concurrent = Math.max(0, rt.concurrent - 1)
    return rt.concurrent
  }

  concurrent(deviceId) {
    return this._rt(deviceId).concurrent
  }

  status(deviceId) {
    const rt = this.runtime.get(deviceId)
    if (!rt) return { concurrent: 0, ips: 0, samples: 0, cv: null }
    const now = this.now()
    let ips = 0
    for (const t of rt.ips.values()) if (now - t <= 3600 * 1000) ips += 1
    const rhythm = cvOf(rt.times)
    return {
      concurrent: rt.concurrent,
      ips,
      samples: rhythm.samples,
      cv: Number.isFinite(rhythm.cv) ? Math.round(rhythm.cv * 1000) / 1000 : null,
      strikes: (rt.strikes || []).filter((t) => now - t < 10 * 60 * 1000).length
    }
  }

  sweep() {
    const now = this.now()
    for (const [id, rt] of this.runtime) {
      for (const [k, t] of rt.ips) if (now - t > 3600 * 1000) rt.ips.delete(k)
      // 10 分钟没活动的设备运行时状态可以直接丢（风险分已持久化）
      if (now - (rt.lastSeenAt || 0) > 10 * 60 * 1000 && rt.concurrent === 0) this.runtime.delete(id)
    }
    const cfg = this.config.guard || {}
    if (cfg.enabled) {
      const nowTs = this.now()
      for (const d of Object.values(this.store.state.devices)) {
        if (d.risk && nowTs - (d.riskUpdatedAt || 0) > 30 * 60 * 1000 && d.risk > 0) {
          d.risk = 0
          d.riskUpdatedAt = nowTs
        }
      }
    }
  }
}
