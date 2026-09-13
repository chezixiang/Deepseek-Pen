// 会话与消息的本地持久化，优先写入 $dataDir 下的 JSON 文件（重启不丢），
// 同时保留 $falcon.jsapi.storage 作为兼容/兜底。
// 键约定：
//   ds:conversations -> [{ id, title, mode, thinking, search, createdAt, updatedAt }]
//   ds:msgs:<id>     -> [{ id, role, content, images, reasoning, error, pending, createdAt, revisions?, attempts? }]
//   ds:settings      -> 见 DEFAULT_SETTINGS
//   ds:active        -> 当前会话 id（字符串）

import { storageSet, storageGet, storageRemove, readFile, writeFile, dsConfigPath, joinPath, dataDirBase } from './native.js'
import { appLog } from './app-log.js'
import { BUILD_NUM } from './build-info.js'

// 应用版本号：格式 "主.次.修订 build N"。build N 由 scripts/build-wrapper.js
// 在每次构建时对 build-info.js 的 BUILD_NUM 自动 +1（#17），便于用户确认是否更新。
export const APP_VERSION = '0.1.1 build ' + BUILD_NUM

const KEY_CONVERSATIONS = 'ds:conversations'
const KEY_SETTINGS = 'ds:settings'
const KEY_ACTIVE = 'ds:active'
const msgKey = (id) => `ds:msgs:${id}`

// 不把 API Key 硬编码进源码：默认留空，运行期从本机 ds-free-api 配置读取。
export const DEFAULT_SETTINGS = {
  // authMode: 'builtin' 内置 ds-free-api（填 DeepSeek 官方账号密码）；
  //            'openai'  OpenAI 兼容端点（填 baseUrl + apiKey）
  authMode: 'builtin',
  dsUser: '',
  dsPass: '',
  // OpenAI 兼容端点默认指向 DeepSeek 官方 API；内置模式运行期被 getActiveBackendBaseUrl 覆盖
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  // OpenAI 兼容端点的自定义模型 ID；默认 deepseek-v4-flash
  openaiModelId: 'deepseek-v4-flash',
  defaultMode: 'fast',
  defaultThinking: true,
  defaultSearch: false,
  defaultExpandThinking: true,
  sse: true,
  systemPrompt: '',
  portrait: false,
  debugMode: false,
  debugLog: false,
  // Emoji 字体（实验）：联网下载 NotoColorEmoji 并注册，解决 emoji 白块
  emojiFont: false,
  // 深色模式：'light' | 'dark'（词典笔无系统深色，去掉 auto）
  theme: 'light'
}

// 本机 ds-free-api 的配置文件（用户在设备上自行配置的凭据，读取而非硬编码）。
// 已迁移到应用 data 目录（build 22），fs 可直接读取——旧 /userdisk 路径在部分设备读不到。

// 去掉 TOML 中以 # 开头的注释行，避免把示例/注释误判为真实配置。
function stripTomlComments(raw) {
  return String(raw || '')
    .split('\n')
    .filter((line) => line.trim().indexOf('#') !== 0)
    .join('\n')
}

async function readLocalApiKey() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    if (!raw) return ''
    const m = raw.match(/\[\[api_keys\]\]\s*key\s*=\s*"([^"]+)"/)
    if (m) return m[1]
    const m2 = raw.match(/\[\[api_keys\]\]\s*key\s*=\s*'([^']+)'/)
    if (m2) return m2[1]
    return ''
  } catch (e) {
    return ''
  }
}

// 从本机 ds-free-api config.toml 读取已配置的登录账号（邮箱或手机号），用于设置页回填。
async function readLocalDsUser() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    if (!raw) return ''
    // 优先邮箱，其次手机号
    const em = raw.match(/\[\[accounts\]\][\s\S]*?email\s*=\s*"([^"]*)"/)
    const mob = raw.match(/\[\[accounts\]\][\s\S]*?mobile\s*=\s*"([^"]*)"/)
    const email = em && em[1] ? em[1].trim() : ''
    const mobile = mob && mob[1] ? mob[1].trim() : ''
    return email || mobile || ''
  } catch (e) {
    return ''
  }
}

// 判断本机 ds-free-api config.toml 是否已配置账号密码（用于设置页显示"已配置"状态）。
async function readLocalDsConfigured() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    if (!raw) return false
    const acc = readLocalDsPassRaw(raw)
    return !!acc
  } catch (e) {
    return false
  }
}

// 读取本机已配置的 DeepSeek 密码（仅用于设置页显示掩码，不写入应用设置存储）。
export async function readLocalDsPass() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    return readLocalDsPassRaw(raw)
  } catch (e) {
    return ''
  }
}

function readLocalDsPassRaw(raw) {
  if (!raw) return ''
  const dq = raw.match(/\[\[accounts\]\][\s\S]*?password\s*=\s*"([^"]*)"/)
  if (dq && dq[1]) return dq[1]
  const sq = raw.match(/\[\[accounts\]\][\s\S]*?password\s*=\s*'([^']*)'/)
  return sq && sq[1] ? sq[1] : ''
}

let seq = 0
export function uid(prefix = 'id') {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

function filePathFor(key) {
  // ds:conversations -> ds_conversations.json；ds:msgs:xxx -> ds_msgs_xxx.json
  // 必须走 joinPath：$dataDir 的尾斜杠在不同机型上不一致，直接相加会得到
  // `/data/…ds_conversations.json`（缺分隔符）或 `//`（重复分隔符）。
  const safe = String(key).replace(/[^a-zA-Z0-9_]/g, '_')
  return joinPath(dataDirBase(), safe + '.json')
}

async function getJSON(key, fallback) {
  // 优先读文件（持久化），再回退到框架 storage
  const fileRaw = await readFile(filePathFor(key))
  if (fileRaw !== null && fileRaw !== undefined && String(fileRaw).trim() !== '') {
    try {
      return JSON.parse(String(fileRaw))
    } catch (e) { /* 文件损坏则继续走 storage */ }
  }
  const raw = await storageGet(key)
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    return JSON.parse(raw)
  } catch (e) {
    return fallback
  }
}

async function setJSON(key, value) {
  const text = JSON.stringify(value)
  // 文件与 storage 双写，保证重启后仍在
  await writeFile(filePathFor(key), text)
  await storageSet(key, text)
  return true
}

async function removeJSON(key) {
  await writeFile(filePathFor(key), '')
  await storageRemove(key)
  return true
}

// 兼容旧会话：补全 mode / thinking / search 等字段，避免旧数据因字段缺失导致开关失效。
export function normalizeConversation(c) {
  return Object.assign({
    mode: 'fast',
    thinking: true,
    search: false
  }, c || {})
}

export async function loadConversations() {
  const list = await getJSON(KEY_CONVERSATIONS, [])
  return (Array.isArray(list) ? list : []).map(normalizeConversation)
}

export async function saveConversations(list) {
  return setJSON(KEY_CONVERSATIONS, list)
}

export async function loadMessages(convId) {
  const list = await getJSON(msgKey(convId), [])
  return normalizeMessages(Array.isArray(list) ? list : [])
}

export async function saveMessages(convId, list) {
  return setJSON(msgKey(convId), list)
}

// 兼容旧数据：给用户消息补 revisions，给助手消息补 attempts。
// 新版「重试 / 修改」不再覆盖旧内容，而是把每次结果作为版本保存在同一气泡里。
export function normalizeMessages(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const m of list) {
    const msg = Object.assign({}, m)
    if (msg.role === 'user') {
      if (!Array.isArray(msg.revisions) || msg.revisions.length === 0) {
        msg.revisions = [{
          content: msg.content || '',
          images: msg.images || [],
          createdAt: msg.createdAt
        }]
      }
      if (typeof msg.activeRevision !== 'number' || !msg.revisions[msg.activeRevision]) {
        msg.activeRevision = msg.revisions.length - 1
      }
      const rev = msg.revisions[msg.activeRevision]
      msg.content = rev.content || ''
      msg.images = rev.images || []
    } else if (msg.role === 'assistant') {
      if (!Array.isArray(msg.attempts) || msg.attempts.length === 0) {
        msg.attempts = [{
          id: msg.id,
          content: msg.content || '',
          reasoning: msg.reasoning || '',
          error: msg.error || '',
          pending: !!msg.pending,
          createdAt: msg.createdAt
        }]
      }
      if (typeof msg.activeAttempt !== 'number' || !msg.attempts[msg.activeAttempt]) {
        msg.activeAttempt = msg.attempts.length - 1
      }
      const att = msg.attempts[msg.activeAttempt]
      if (att) {
        msg.content = att.content || ''
        msg.reasoning = att.reasoning || ''
        msg.error = att.error || ''
        msg.pending = !!att.pending
      }
    }
    out.push(msg)
  }
  return out
}

export async function deleteMessages(convId) {
  await removeJSON(msgKey(convId))
}

export async function loadSettings() {
  const s = await getJSON(KEY_SETTINGS, {})
  const merged = Object.assign({}, DEFAULT_SETTINGS, s || {})
  // 旧版设置里可能有 theme:'auto'（已移除跟随系统），归一为 light 避免深色判断失效
  if (merged.theme === 'auto') {
    merged.theme = 'light'
    appLog('[store] 检测到旧设置 theme=auto，已迁移为 light')
  }
  appLog('[store] loadSettings theme=' + merged.theme + ' authMode=' + merged.authMode + ' baseUrl=' + merged.baseUrl + ' apiKey=' + (merged.apiKey ? '已设置' : '空') + ' openaiModelId=' + (merged.openaiModelId || '(空)'))
  // 内置模式：API Key 权威来源是本机 ds-free-api config（每次保存账号都会生成新 key）。
  // 若设置存储缓存了旧 key，会与 config 失配导致 401 未认证——所以内置模式总是从 config 读。
  if (merged.authMode === 'builtin') {
    merged.apiKey = await readLocalApiKey()
  }
  // OpenAI 兼容端点下**不再**回填本机 key：本机 ds-free-api 的 key 对外部端点毫无意义，
  // 却会被当成 Bearer 发给第三方服务（既泄露本机凭据，又让"401 未授权"看起来像端点故障，
  // 用户报告"自定义 api 端点模式无法正常使用"的一部分）。留空就让报错说清缺 key。
  // 内置模式下，若设置页未填过 DS 账号，回填本机 ds-free-api 已配置的账号（避免显示空白误导）
  if (merged.authMode === 'builtin' && !merged.dsUser) {
    merged.dsUser = await readLocalDsUser()
  }
  // 记录本机是否已配置账号密码，供设置页显示"已配置"状态（不回填明文密码）
  merged.dsConfigured = await readLocalDsConfigured()
  return merged
}

export async function saveSettings(s) {
  return setJSON(KEY_SETTINGS, s)
}

export async function loadActiveId() {
  return getJSON(KEY_ACTIVE, null)
}

export async function saveActiveId(id) {
  return setJSON(KEY_ACTIVE, id)
}

// ---------- 账号异常取证 ----------
// 记录疑似封号/禁言/鉴权失败事件（首次检出时间回答"什么时候封的"）。
// 持久化在 ds:trouble，最多保留 20 条。
const KEY_TROUBLE = 'ds:trouble'

export async function recordAccountTrouble(kind, message) {
  try {
    const list = await getJSON(KEY_TROUBLE, [])
    const arr = Array.isArray(list) ? list : []
    arr.push({ t: Date.now(), kind: String(kind || ''), message: String(message || '').slice(0, 200) })
    await setJSON(KEY_TROUBLE, arr.slice(-20))
  } catch (e) { /* 忽略 */ }
}

export async function loadAccountTrouble() {
  try {
    const list = await getJSON(KEY_TROUBLE, [])
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}
