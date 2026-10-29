// Provider（真正的上游）运行时配置：管理后台可改、落盘、热生效。
//
// 设计：
//   - config.json 是初始值；管理后台保存后写 data/provider.json（0600）作为覆盖；
//   - 覆盖只合并 provider.*，不动 server/admin/auth/guard 等；
//   - API Key 只写不读：GET 只返回是否已设置 + 掩码，永不回传明文；
//   - 保存后原地改 config.provider（ProviderClient 持有同一对象引用），无需重启。

import fs from 'node:fs'
import path from 'node:path'

export const PROVIDER_PRESETS = [
  {
    id: 'new-api-local',
    name: '本机 new-api',
    baseUrl: 'http://127.0.0.1:3000/v1',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'glm-5.3-flash', 'mimo-v2.6-flash']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    defaultModel: '',
    models: []
  }
]

const OVERRIDE_KEYS = [
  'name',
  'baseUrl',
  'apiKey',
  'defaultModel',
  'models',
  'modelMap',
  'userAgent',
  'timeoutMs',
  'idleTimeoutMs',
  'maxResponseBytes',
  'modelsCacheSec',
  'extraHeaders'
]

export class ProviderConfigError extends Error {}

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function maskKey(key) {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 8) return '****'
  return s.slice(0, 3) + '****' + s.slice(-4)
}

function uniqueStrings(list, maxItems, maxLen) {
  const out = []
  const seen = new Set()
  for (const item of list) {
    const s = text(item, maxLen)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

function parseModelMap(input) {
  const map = {}
  if (input == null) return map
  if (typeof input === 'string') {
    for (const line of input.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i <= 0) throw new ProviderConfigError('模型映射格式应为「客户端模型=上游模型」，每行一条')
      const k = text(t.slice(0, i), 120)
      const v = text(t.slice(i + 1), 120)
      if (!k || !v) throw new ProviderConfigError('模型映射左右两侧都不能为空')
      map[k] = v
    }
    return map
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    for (const [k0, v0] of Object.entries(input)) {
      const k = text(k0, 120)
      const v = text(v0, 120)
      if (k && v) map[k] = v
    }
    return map
  }
  throw new ProviderConfigError('modelMap 必须是对象或「a=b」多行文本')
}

/**
 * 校验并归一管理后台提交的 provider 配置。
 * 未提交的字段不返回（调用方合并到当前值）；apiKey 为空表示"保持不变"。
 */
export function normalizeProviderInput(input, current = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const out = {}

  if (src.name !== undefined) {
    const name = text(src.name, 64)
    if (!name) throw new ProviderConfigError('Provider 名称不能为空')
    out.name = name
  }

  if (src.baseUrl !== undefined) {
    const baseUrl = text(src.baseUrl, 500).replace(/\/+$/, '')
    if (!baseUrl) throw new ProviderConfigError('上游地址不能为空')
    if (!/^https?:\/\//i.test(baseUrl)) throw new ProviderConfigError('上游地址必须以 http:// 或 https:// 开头')
    if (/\s/.test(baseUrl)) throw new ProviderConfigError('上游地址不能包含空格')
    if (/^https?:\/\/[^/]*@/i.test(baseUrl)) throw new ProviderConfigError('上游地址不能携带用户名密码')
    out.baseUrl = baseUrl
  }

  if (src.clearKey === true) {
    out.apiKey = ''
  } else if (typeof src.apiKey === 'string' && src.apiKey.trim()) {
    const key = src.apiKey.trim()
    if (key.length > 4096) throw new ProviderConfigError('API Key 过长')
    out.apiKey = key
  }

  if (src.defaultModel !== undefined) {
    out.defaultModel = text(src.defaultModel, 120)
  }

  if (src.models !== undefined) {
    const list = Array.isArray(src.models)
      ? src.models
      : String(src.models).split(',')
    out.models = uniqueStrings(list, 100, 120)
  }

  if (src.modelMap !== undefined) {
    out.modelMap = parseModelMap(src.modelMap)
  }

  if (src.userAgent !== undefined) {
    out.userAgent = text(src.userAgent, 200) || current.userAgent || 'deepseek-pen-upstream/1.0'
  }

  for (const [k, min, max, dflt] of [
    ['timeoutMs', 1000, 3600000, 300000],
    ['idleTimeoutMs', 1000, 3600000, 120000],
    ['maxResponseBytes', 1024, 256 * 1024 * 1024, 16 * 1024 * 1024],
    ['modelsCacheSec', 0, 86400, 300]
  ]) {
    if (src[k] === undefined) continue
    const n = Number(src[k])
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new ProviderConfigError(k + ' 超出范围（' + min + '~' + max + '）')
    }
    out[k] = Math.trunc(n || dflt)
  }

  if (src.extraHeaders !== undefined) {
    if (!src.extraHeaders || typeof src.extraHeaders !== 'object' || Array.isArray(src.extraHeaders)) {
      throw new ProviderConfigError('extraHeaders 必须是对象')
    }
    const headers = {}
    for (const [k0, v0] of Object.entries(src.extraHeaders)) {
      const k = text(k0, 100)
      const v = text(v0, 500)
      if (!k) continue
      if (/^(authorization|host|content-length)$/i.test(k)) {
        throw new ProviderConfigError('extraHeaders 不允许覆盖 ' + k)
      }
      headers[k] = v
    }
    out.extraHeaders = headers
  }

  return out
}

// 供管理后台展示：不包含 apiKey 明文
export function redactProvider(provider) {
  const p = provider || {}
  const out = {}
  for (const k of OVERRIDE_KEYS) {
    if (k === 'apiKey') continue
    if (p[k] !== undefined) out[k] = p[k]
  }
  out.apiKeySet = !!p.apiKey
  out.apiKeyMasked = maskKey(p.apiKey)
  return out
}

// ---------- 持久化 ----------

export function providerOverridePath(dataDir) {
  return path.join(dataDir, 'provider.json')
}

export function loadProviderOverride(dataDir) {
  const file = providerOverridePath(dataDir)
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const p = raw && raw.provider
    if (!p || typeof p !== 'object') return null
    // 磁盘内容不可全信：密钥/地址仍要做基本归一
    const out = normalizeProviderInput(p, {})
    // 显式保存的空 Key 代表"管理员清空了密钥"，必须原样保留，
    // 否则重启后会回落到 config.json 里的旧 Key。
    if (Object.prototype.hasOwnProperty.call(p, 'apiKey')) out.apiKey = String(p.apiKey || '')
    return out
  } catch (e) {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()) } catch (_) { /* 忽略 */ }
    return null
  }
}

export function saveProviderOverride(dataDir, provider) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = providerOverridePath(dataDir)
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    provider
  }
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows */ }
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch (_) { /* Windows */ }
  return file
}

export function clearProviderOverride(dataDir) {
  const file = providerOverridePath(dataDir)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

/** 把覆盖合并到 config.provider（原地修改，ProviderClient 立即生效） */
export function applyProviderOverride(config, provider) {
  if (!provider) return false
  let applied = false
  for (const k of OVERRIDE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(provider, k)) continue
    // apiKey 允许为空串：那是管理员显式清除密钥，不能让 config.json 的旧 key 复活
    if (k !== 'apiKey' && provider[k] === undefined) continue
    config.provider[k] = provider[k]
    applied = true
  }
  return applied
}

export function cloneProvider(provider) {
  return JSON.parse(JSON.stringify(provider || {}))
}
