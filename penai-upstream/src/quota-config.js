// 限额运行时配置：管理后台可改、落盘、热生效。
//
// 设计（与 provider-config.js 同款）：
//   - config.json 是初始值；后台保存后写 data/quota.json（0600）作为覆盖；
//   - 覆盖只合并 quota.*，不动 server/auth/guard/provider；
//   - 保存后原地改 config.quota（请求路径每次读取同一对象），无需重启；
//   - 0 一律表示"不限"（并发数 0 = 不限制并发）。
//
// 限额项（客户端设置页与 /v1/me 按同一份清单展示）：
//   maxConcurrent   每设备同时进行的聊天请求数
//   rpm             每分钟请求数
//   tpm             每分钟 token 数
//   fiveHourTokens  最近 5 小时滚动窗口 token 数（按小时桶近似）
//   dailyTokens     每日 token 数（UTC 日）
//   monthlyTokens   每月 token 数（UTC 月）

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_QUOTA = {
  enabled: true,
  maxConcurrent: 2,
  rpm: 20,
  tpm: 0,
  fiveHourTokens: 0,
  dailyTokens: 0,
  monthlyTokens: 0
}

export const QUOTA_FIELDS = Object.keys(DEFAULT_QUOTA)

// 展示顺序 + 文案：后台表单、健康检查、客户端额度面板共用。
// unit: requests / tokens；window: minute / fiveHour / day / month / live
export const QUOTA_ITEMS = [
  {
    key: 'rpm',
    label: '每分钟请求',
    short: 'RPM',
    unit: 'requests',
    window: 'minute',
    hint: '固定分钟窗口，到点整分钟重置'
  },
  {
    key: 'tpm',
    label: '每分钟 Token',
    short: 'TPM',
    unit: 'tokens',
    window: 'minute',
    hint: '固定分钟窗口，按上游返回的 usage 统计'
  },
  {
    key: 'fiveHourTokens',
    label: '5 小时 Token',
    short: '5H',
    unit: 'tokens',
    window: 'fiveHour',
    hint: '当前小时 + 前 4 个小时桶的滚动合计'
  },
  {
    key: 'dailyTokens',
    label: '今日 Token',
    short: '日',
    unit: 'tokens',
    window: 'day',
    hint: '按 UTC 自然日结算，次日 00:00 重置'
  },
  {
    key: 'monthlyTokens',
    label: '本月 Token',
    short: '月',
    unit: 'tokens',
    window: 'month',
    hint: '按 UTC 自然月结算，下月 1 日重置'
  },
  {
    key: 'maxConcurrent',
    label: '并发请求',
    short: '并发',
    unit: 'requests',
    window: 'live',
    hint: '同时进行中的聊天请求数，实时值'
  }
]

export class QuotaConfigError extends Error {}

function bool(v, fallback) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return fallback
}

function int(v, fallback, min, max, label) {
  if (v === '' || v === null || v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new QuotaConfigError(label + ' 必须是整数')
  }
  if (n < min) throw new QuotaConfigError(label + ' 不能小于 ' + min)
  if (n > max) throw new QuotaConfigError(label + ' 不能大于 ' + max)
  return n
}

/**
 * 把后台/配置文件里的任意输入归一成合法 quota 对象。
 * 缺省字段沿用 base（保存时就是当前值），因此可以只 PATCH 一个字段。
 */
export function normalizeQuotaInput(input, base = DEFAULT_QUOTA) {
  const src = input && typeof input === 'object' ? input : {}
  const b = Object.assign({}, DEFAULT_QUOTA, base || {})
  return {
    enabled: bool(src.enabled, b.enabled !== false),
    maxConcurrent: int(src.maxConcurrent, b.maxConcurrent, 0, 100, '并发数'),
    rpm: int(src.rpm, b.rpm, 0, 100000, 'RPM'),
    tpm: int(src.tpm, b.tpm, 0, 100000000, 'TPM'),
    fiveHourTokens: int(src.fiveHourTokens, b.fiveHourTokens, 0, 1000000000000, '5 小时 Token 数'),
    dailyTokens: int(src.dailyTokens, b.dailyTokens, 0, 1000000000000, '每日 Token 数'),
    monthlyTokens: int(src.monthlyTokens, b.monthlyTokens, 0, 1000000000000, '每月 Token 数')
  }
}

/**
 * 单设备限额覆盖：只接受明确提交的键，未提交的键保持 undefined（= 用全局值）。
 * 与 normalizeQuotaInput 的区别：这里 0 是有效值（表示该设备不限），不能当缺省。
 */
export function normalizeQuotaOverride(input) {
  const src = input && typeof input === 'object' ? input : null
  if (!src) return null
  const out = {}
  if (Object.prototype.hasOwnProperty.call(src, 'enabled')) {
    out.enabled = bool(src.enabled, true)
  }
  for (const item of QUOTA_ITEMS) {
    if (!Object.prototype.hasOwnProperty.call(src, item.key)) continue
    out[item.key] = int(src[item.key], 0, 0, item.unit === 'requests' ? 100000 : 1000000000000, item.label)
  }
  return Object.keys(out).length ? out : null
}

export function quotaOverridePath(dataDir) {
  return path.join(dataDir || 'data', 'quota.json')
}

export function loadQuotaOverride(dataDir) {
  const file = quotaOverridePath(dataDir)
  try {
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const savedAt = Number(raw.savedAt) || 0
    const quota = normalizeQuotaInput(raw.quota || raw)
    return { quota, savedAt }
  } catch (e) {
    process.stderr.write('[quota] 读取 data/quota.json 失败（忽略覆盖）：' + e.message + '\n')
    return null
  }
}

export function applyQuotaOverride(config, override) {
  if (!override || !override.quota) return false
  Object.assign(config.quota, override.quota)
  return true
}

export function saveQuotaOverride(dataDir, quota) {
  const file = quotaOverridePath(dataDir)
  const clean = normalizeQuotaInput(quota)
  const payload = { savedAt: Date.now(), quota: clean }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
  fs.renameSync(tmp, file)
  return clean
}

export function clearQuotaOverride(dataDir) {
  const file = quotaOverridePath(dataDir)
  try { fs.unlinkSync(file) } catch (_) { /* 不存在即视为已清除 */ }
}

// 给管理后台/健康检查用：把"0=不限"翻译成可读口径
export function quotaSummary(quota) {
  const q = Object.assign({}, DEFAULT_QUOTA, quota || {})
  return {
    enabled: q.enabled,
    maxConcurrent: q.maxConcurrent,
    rpm: q.rpm,
    tpm: q.tpm,
    fiveHourTokens: q.fiveHourTokens,
    dailyTokens: q.dailyTokens,
    monthlyTokens: q.monthlyTokens
  }
}
