// 会话与消息的本地持久化，优先写入 $dataDir 下的 JSON 文件（重启不丢），
// 同时保留 $falcon.jsapi.storage 作为兼容/兜底。
// 键约定：
//   ds:conversations -> [{ id, title, mode, thinking, search, createdAt, updatedAt }]
//   ds:msgs:<id>     -> [{ id, role, content, images, reasoning, error, pending, createdAt, revisions?, attempts? }]
//   ds:settings      -> 见 DEFAULT_SETTINGS
//   ds:active        -> 当前会话 id（字符串）

import { storageSet, storageGet, storageRemove, readFile, writeFile, dsConfigPath, joinPath, dataDirBase } from './native.js'
import { tomlStringValue, stripTomlComments, sectionBody, accountSections, accountIdFromSection } from './toml-config.js'
import { appLog } from './app-log.js'
import { BUILD_NUM } from './build-info.js'
// 纯函数（normalize/uid/脱敏等）抽到 store-schema.js：无 native 依赖，可在 Node 里回归测试。
// 这里转发导出，保持对外 API 不变。
import {
  uid as _uid,
  normalizeConversation as _normalizeConversation,
  normalizeMessages as _normalizeMessages,
  stripImagePayloads as _stripImagePayloads,
  maskAccountId as _maskAccountId
} from './store-schema.js'

export const uid = _uid
export const normalizeConversation = _normalizeConversation
export const normalizeMessages = _normalizeMessages

// 应用版本号：格式 "主.次.修订 build N"。build N 由 scripts/build-wrapper.js
// 在每次构建时对 build-info.js 的 BUILD_NUM 自动 +1（#17），便于用户确认是否更新。
export const APP_VERSION = '0.1.4 build ' + BUILD_NUM

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
  // 流式输出（SSE）已固定开启，不再提供开关：非流式分支在设备上体验差
  // （整段等完才出字），且两条路径要各自维护错误处理。旧设置里的 sse 字段被忽略。
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

// 账号显示名缓存（ds:accounts）与当前活动账号（ds:activeAccount）。
// 声明在文件靠前位置：loadSettings 里的"配置读不到"兜底要用到 KEY_ACCOUNTS。
const KEY_ACCOUNTS = 'ds:accounts'
const KEY_ACTIVE_ACCOUNT = 'ds:activeAccount'

async function readLocalApiKey() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    if (!raw) return ''
    // [[api_keys]] 段可能不是第一个段：先定位段，再在段内取值
    const seg = sectionBody(raw, '[[api_keys]]')
    const key = tomlStringValue(seg, 'key').trim()
    return key
  } catch (e) {
    return ''
  }
}

// 从本机 ds-free-api config.toml 读取已配置的登录账号（邮箱或手机号），用于设置页回填。
async function readLocalDsUser() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    if (!raw) return ''
    const secs = accountSections(raw)
    for (let i = 0; i < secs.length; i++) {
      const a = accountIdFromSection(secs[i])
      if (a.id) return a.id
    }
    return ''
  } catch (e) {
    return ''
  }
}

// 判断本机 ds-free-api config.toml 是否已配置账号密码（用于设置页显示"已配置"状态）。
//
// 判定口径从"密码非空"放宽为"有账号标识且有密码"：后端（toml crate）在密码含
// 双引号/反斜杠时会写成**单引号字面量**、含换行时写成多行字符串，旧正则只认双引号，
// 于是把已登录的账号读成"未配置" → 进账号页就被弹去登录页（bug 2）。
//
// 另外区分"读不到配置"与"确实没账号"：前者（文件暂时读不到，例如后端正在重写/
// 部署中）不能当作未登录，否则一次瞬时读失败就会把用户踢到登录页。
async function readLocalDsConfigured() {
  const state = await readLocalDsConfiguredState()
  return state.configured
}

/// 返回 { readable, configured }：readable=false 表示配置文件这次没读到（不代表没账号）
export async function readLocalDsConfiguredState() {
  try {
    const raw = await readFile(dsConfigPath())
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      return { readable: false, configured: false }
    }
    const secs = accountSections(stripTomlComments(raw))
    for (let i = 0; i < secs.length; i++) {
      const a = accountIdFromSection(secs[i])
      const pass = tomlStringValue(secs[i], 'password').trim()
      if (a.id && pass) return { readable: true, configured: true }
    }
    return { readable: true, configured: false }
  } catch (e) {
    return { readable: false, configured: false }
  }
}

// 应用侧缓存里是否还记着账号（ds:accounts）。仅用于"配置暂时读不到"时兜底判断：
// 用户主动退出登录会走 removeAccountById 清掉这个缓存，所以它非空 =
// 上一次确实是登录状态，不该因为一次读失败就把人踢去登录页。
async function hasCachedAccount() {
  try {
    const list = await getJSON(KEY_ACCOUNTS, [])
    return Array.isArray(list) && list.length > 0
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

// 本机已配置的密码（原样，仅用于设置页掩码显示）。
// 走通用取值器以兼容后端可能写出的各种字符串形态（见 tomlStringValue）。
function readLocalDsPassRaw(raw) {
  if (!raw) return ''
  const secs = accountSections(raw)
  for (let i = 0; i < secs.length; i++) {
    const pass = tomlStringValue(secs[i], 'password')
    if (pass) return pass
  }
  return ''
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
  let okFile = false
  try {
    okFile = await writeFile(filePathFor(key), text)
  } catch (e) {
    okFile = false
  }
  if (!okFile) {
    // 文件写失败（磁盘满/权限）时清空旧文件：getJSON 是文件优先，
    // 留着旧内容会把刚写进 storage 的新值永久遮住（读到的是过期数据）
    try { await writeFile(filePathFor(key), '') } catch (e) { /* 尽力而为 */ }
  }
  await storageSet(key, text)
  return true
}

async function removeJSON(key) {
  await writeFile(filePathFor(key), '')
  await storageRemove(key)
  return true
}

// 兼容旧会话的 normalizeConversation 已抽到 store-schema.js（文件顶部转发导出）

export async function loadConversations() {
  const list = await getJSON(KEY_CONVERSATIONS, [])
  return (Array.isArray(list) ? list : []).map(_normalizeConversation)
}

export async function saveConversations(list) {
  return setJSON(KEY_CONVERSATIONS, list)
}

export async function loadMessages(convId) {
  const list = await getJSON(msgKey(convId), [])
  return _normalizeMessages(Array.isArray(list) ? list : [])
}

// 落盘前剥图片 payload 的 stripImagePayloads 已抽到 store-schema.js

export async function saveMessages(convId, list) {
  return setJSON(msgKey(convId), _stripImagePayloads(list))
}

// 兼容旧数据的 normalizeMessages 已抽到 store-schema.js（文件顶部转发导出）

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
  const cfgState = await readLocalDsConfiguredState()
  if (cfgState.readable) {
    merged.dsConfigured = cfgState.configured
    merged.dsConfigReadable = true
  } else {
    // 配置这次没读到（后端正在重写/部署中）：不能据此判定"未登录"——
    // 那会把已登录用户踢去登录页（bug 2）。用应用侧缓存兜底：
    // 缓存里还有账号说明上次确实是登录状态，维持"已配置"，等下次读取刷新。
    const cached = await hasCachedAccount()
    merged.dsConfigured = cached || !!merged.dsUser
    merged.dsConfigReadable = false
    appLog('[store] config.toml 本次未读到，dsConfigured 回退为 ' + merged.dsConfigured + '（缓存账号=' + cached + '）')
  }
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

// ---------- 账号（专用登录页） ----------
// 账号真源是后端 config.toml 的 [[accounts]] 段（native.updateDsFreeApiAccount 写入）。
// 这里只把 config 与用户输入的显示名缓存合并成登录页要的视图。
//
// 多账号暂缓：ds-free-api 的 config.toml 支持多个 [[accounts]]，但应用侧写入函数
// （native.js updateDsFreeApiAccount / clearDsFreeApiAccount）只改写*第一个*段，
// 所以登录页按「单账号」呈现——列出 config 里已有的账号、标出当前使用的一个。
// 多账号完整增删需后端 /admin API 配合（后端已具备 add_account/remove_account 能力）。
// KEY_ACCOUNTS / KEY_ACTIVE_ACCOUNT 两个键常量声明在文件上方（loadSettings 的兜底逻辑要用）。

/// 解析 config.toml 中全部 [[accounts]] 段（只取标识字段，不读密码）
function parseAllAccounts(raw) {
  if (!raw) return []
  const out = []
  const secs = accountSections(raw)
  for (let i = 0; i < secs.length; i++) {
    const a = accountIdFromSection(secs[i])
    if (a.id) out.push({ id: a.id, email: a.email, mobile: a.mobile })
  }
  return out
}

// 账号显示名脱敏 maskAccountId 已抽到 store-schema.js（顶部以 _maskAccountId 引入）

/// 账号列表（登录页用）：config.toml 账号 + 活动标记
export async function loadAccountList() {
  let fromConfig = []
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()))
    if (!raw) {
      // 配置读不到时列表会静默为空、界面显示"未登录"，用户看不到原因。
      // 记一条日志便于定位（真正的重建由 native.ensureDsConfig 负责）。
      appLog('[store] 账号列表为空：config.toml 缺失或不可读（' + dsConfigPath() + '）')
    }
    fromConfig = parseAllAccounts(raw)
  } catch (e) { /* 忽略 */ }

  let cached = []
  try {
    const v = await getJSON(KEY_ACCOUNTS, [])
    cached = Array.isArray(v) ? v : []
  } catch (e) { /* 忽略 */ }

  const active = (await getJSON(KEY_ACTIVE_ACCOUNT, '')) || ''
  const merged = fromConfig.map((a) => {
    const hit = cached.find((c) => c.id === a.id)
    return {
      id: a.id,
      display: hit && hit.display ? hit.display : _maskAccountId(a.id),
      active: a.id === active,
      state: ''
    }
  })
  if (merged.length && !merged.some((m) => m.active)) merged[0].active = true
  return merged
}

/// 记住账号（应用侧缓存；真源仍是 config.toml）
export async function upsertAccount(id) {
  try {
    const list = await getJSON(KEY_ACCOUNTS, [])
    const arr = Array.isArray(list) ? list : []
    const key = String(id || '').trim()
    if (!key) return false
    if (!arr.some((a) => a.id === key)) {
      arr.push({ id: key, display: _maskAccountId(key), addedAt: Date.now() })
      await setJSON(KEY_ACCOUNTS, arr.slice(-10))
    }
    return true
  } catch (e) {
    return false
  }
}

/// 从缓存移除指定 id 的账号（登录页「移除」用）。
/// 注意：账号真源是 config.toml，真正退出登录要调 native.clearDsFreeApiAccount()；
/// 这里只负责清掉显示名缓存，避免移除后还留着旧昵称。
export async function removeAccountById(id) {
  try {
    const key = String(id || '').trim()
    if (!key) return false
    const list = await getJSON(KEY_ACCOUNTS, [])
    const arr = (Array.isArray(list) ? list : []).filter((a) => a && a.id !== key)
    await setJSON(KEY_ACCOUNTS, arr)
    return true
  } catch (e) {
    return false
  }
}

/// 设置当前活动账号（登录页切换用）
export async function setActiveAccount(id) {
  try {
    await setJSON(KEY_ACTIVE_ACCOUNT, String(id || ''))
    return true
  } catch (e) {
    return false
  }
}

/// 读取当前活动账号
export async function loadActiveAccount() {
  try {
    return (await getJSON(KEY_ACTIVE_ACCOUNT, '')) || ''
  } catch (e) {
    return ''
  }
}
