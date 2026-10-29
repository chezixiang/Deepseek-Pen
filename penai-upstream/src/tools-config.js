// 网页搜索/抓取代理（tools）运行时配置：管理后台可改、落盘、热生效。
//
// 与 provider-config 同一套模式：
//   - config.json / 环境变量是初始值；管理后台保存后写 data/tools.json（0600）覆盖；
//   - API Key 只写不读：GET 只返回是否已设置 + 掩码，永不回传明文；
//   - 保存后原地改 config.tools（ToolsClient 与路由都读同一对象引用），无需重启。

import fs from 'node:fs'
import path from 'node:path'

const OVERRIDE_KEYS = [
  'enabled',
  'baseUrl',
  'apiKey',
  'userAgent',
  'timeoutMs',
  'perDayPerDevice',
  'maxInflight',
  'maxCount',
  'fetchMaxChars',
  'resultMaxChars'
]

export class ToolsConfigError extends Error {}

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function maskKey(key) {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 8) return '****'
  return s.slice(0, 3) + '****' + s.slice(-4)
}

/**
 * 校验并归一管理后台提交的 tools 配置。
 * 未提交的字段不返回（调用方合并到当前值）；apiKey 为空表示"保持不变"。
 */
export function normalizeToolsInput(input, current = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const out = {}

  if (src.enabled !== undefined) {
    out.enabled = src.enabled === true || src.enabled === 'true' || src.enabled === 1
  }

  if (src.baseUrl !== undefined) {
    const baseUrl = text(src.baseUrl, 500).replace(/\/+$/, '')
    if (!baseUrl) throw new ToolsConfigError('搜索服务地址不能为空')
    if (!/^https?:\/\//i.test(baseUrl)) throw new ToolsConfigError('搜索服务地址必须以 http:// 或 https:// 开头')
    if (/\s/.test(baseUrl)) throw new ToolsConfigError('搜索服务地址不能包含空格')
    out.baseUrl = baseUrl
  }

  if (src.clearKey === true) {
    out.apiKey = ''
  } else if (typeof src.apiKey === 'string' && src.apiKey.trim()) {
    const key = src.apiKey.trim()
    if (key.length > 4096) throw new ToolsConfigError('API Key 过长')
    out.apiKey = key
  }

  if (src.userAgent !== undefined) {
    out.userAgent = text(src.userAgent, 200) || current.userAgent || 'deepseek-pen-upstream/1.0'
  }

  for (const [k, min, max] of [
    ['timeoutMs', 1000, 120000],
    ['perDayPerDevice', 0, 1000000],
    ['maxInflight', 1, 256],
    ['maxCount', 1, 50],
    ['fetchMaxChars', 1000, 100000],
    ['resultMaxChars', 100, 20000]
  ]) {
    if (src[k] === undefined) continue
    const n = Number(src[k])
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new ToolsConfigError(k + ' 超出范围（' + min + '~' + max + '）')
    }
    out[k] = Math.trunc(n)
  }

  return out
}

// 供管理后台展示：不包含 apiKey 明文
export function redactTools(tools) {
  const t = tools || {}
  const out = {}
  for (const k of OVERRIDE_KEYS) {
    if (k === 'apiKey') continue
    if (t[k] !== undefined) out[k] = t[k]
  }
  out.apiKeySet = !!t.apiKey
  out.apiKeyMasked = maskKey(t.apiKey)
  return out
}

// ---------- 持久化 ----------

export function toolsOverridePath(dataDir) {
  return path.join(dataDir, 'tools.json')
}

export function loadToolsOverride(dataDir) {
  const file = toolsOverridePath(dataDir)
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const t = raw && raw.tools
    if (!t || typeof t !== 'object') return null
    const out = normalizeToolsInput(t, {})
    // 显式保存的空 Key 代表"管理员清空了密钥"，必须原样保留
    if (Object.prototype.hasOwnProperty.call(t, 'apiKey')) out.apiKey = String(t.apiKey || '')
    return out
  } catch (e) {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()) } catch (_) { /* 忽略 */ }
    return null
  }
}

export function saveToolsOverride(dataDir, tools) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = toolsOverridePath(dataDir)
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    tools
  }
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows */ }
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch (_) { /* Windows */ }
  return file
}

export function clearToolsOverride(dataDir) {
  const file = toolsOverridePath(dataDir)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

/** 把覆盖合并到 config.tools（原地修改，ToolsClient 立即生效） */
export function applyToolsOverride(config, tools) {
  if (!tools) return false
  let applied = false
  for (const k of OVERRIDE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(tools, k)) continue
    // apiKey 允许为空串：那是管理员显式清除密钥，不能让 config.json 的旧 key 复活
    if (k !== 'apiKey' && tools[k] === undefined) continue
    config.tools[k] = tools[k]
    applied = true
  }
  return applied
}

export function cloneTools(tools) {
  return JSON.parse(JSON.stringify(tools || {}))
}
