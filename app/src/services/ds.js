// ds-free-api 的 OpenAI 兼容客户端（流式 SSE；应用侧始终走 chatStream）。
// 会话是「无状态」的：每次请求都把完整历史作为 messages 发给后端，
// 因此「重试 / 修改」只需本地裁剪历史后重新请求。

import { httpRequest, validateExternalUrl } from './http.js'
import { readImageDataUrl } from './images.js'
import { execShell, writeFile, readFile, sleep, shq, stopStream, joinPath, dataDirBase } from './native.js'

import { getActiveBackendBaseUrl } from './backend-health.js'
import { isRateLimitCode, isRateLimitText, isAccountSuspension } from './error-classify.js'
// 纯文本/解析函数抽到 ds-text.js（无设备依赖，可在 Node 里回归测试）
import { apiUrl as _apiUrl, stripInternalTags as _stripInternalTags } from './ds-text.js'

export const apiUrl = _apiUrl
export const stripInternalTags = _stripInternalTags

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

// 模型模式。
//
// 2026-09-12 官方公告"快速、专家、识图模式已合并升级"：new.jsonl 的
// client/settings?scope=model 实证 expert / vision 已 enabled:false，
// 只剩 model_type="default"，且它 file_feature.vision=true —— 也就是说
// 同一个模型同时具备日常对话、图片理解、复杂问题求解，图片/思考/联网都是开关。
// 因此这里只保留一个模式，且它允许携带图片（vision: true）。
// 旧的 'expert' / 'vision' 仅保留为别名，把历史会话映射到 default，不再展示。
export const MODES = [
  { key: 'fast', label: '智能模式', model: 'deepseek-default', vision: true }
]

// 历史会话里可能存着 expert / vision，统一折叠到唯一模式
const LEGACY_MODE_KEYS = ['expert', 'vision']

export function getMode(key) {
  if (LEGACY_MODE_KEYS.indexOf(key) >= 0) return MODES[0]
  return MODES.find((m) => m.key === key) || MODES[0]
}

export function isVisionMode(key) {
  return getMode(key).vision
}

// 移除模型回复中可能泄露的内部协议标签，防止发给 DeepSeek 官方 API 或展示给用户导致封号。
// 注意：标签替换为空串，且只折叠水平空白（[ \t]），不能吞掉换行——
// 旧版 /\s{2,}/g 会把模型的空行/段落分隔符一并压成空格，导致换行丢失（#14）。
// stripInternalTags / collapseOutsideFences 已抽到 ds-text.js（文件顶部转发导出）

// 把应用内消息转成 OpenAI messages；跳过占位/错误消息；图片按需转 data URL。
// assistant 内容在发送前清洗内部协议标签，避免把 <|begin_of_function|> 等标记
// 回传给 DeepSeek 官方 API 触发风控（与返回时的 stripInternalTags 双向保障）。
export async function buildMessages(messages, systemPrompt) {
  const list = []
  if (systemPrompt) list.push({ role: 'system', content: systemPrompt })

  for (const m of messages) {
    if (m.pending || m.error) continue
    if (m.role === 'assistant') {
      list.push({ role: 'assistant', content: stripInternalTags(m.content || '') })
    } else {
      const images = m.images || []
      const parts = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const img of images) {
        // 缓存 dataUrl：同一张图只压缩/base64 一次，避免多轮对话重复处理累积内存
        if (!img.dataUrl) {
          img.dataUrl = await readImageDataUrl(img.path)
        }
        if (img.dataUrl) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
      }
      if (parts.length === 0) {
        list.push({ role: 'user', content: m.content || '' })
      } else if (parts.length === 1 && parts[0].type === 'text') {
        list.push({ role: 'user', content: parts[0].text })
      } else {
        list.push({ role: 'user', content: parts })
      }
    }
  }
  return list
}

class DsError extends Error {
  constructor(code, message, raw) {
    super(message)
    this.code = code
    this.raw = raw
  }
}

/**
 * 探测后端是否可达、账号池是否就绪（不走鉴权，/health 是公开端点）。
 *
 * 用途：401 有两类完全不同的成因，处理方式也完全相反 ——
 *  1) 上游账号真的被封禁/禁言（错误码来自 DeepSeek）；
 *  2) 应用与本机后端没对上：key 未同步、后端没起来、账号池是空的。
 * 旧实现把所有 401 都写成"账号可能已被封禁，请更换账号"，把第 2 类用户
 * 引向换账号（白折腾，还会把一个好账号从池子里误判掉）。报错前先问一次
 * /health，用后端自己的状态说话。
 */
async function probeBackend({ authMode, baseUrl, apiKey, timeout = 5000 }) {
  const root = authMode === 'builtin'
    ? getActiveBackendBaseUrl()
    : String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const headers = {}
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
  try {
    const resp = await httpRequest({ url: root + '/health', method: 'GET', headers, timeout })
    if (resp.statusCode === 0) return { reachable: false, error: resp.error || '连接失败' }
    if (resp.statusCode !== 200 || !resp.data) return { reachable: true, ok: false, statusCode: resp.statusCode }
    const accounts = (resp.data && resp.data.accounts) || {}
    return { reachable: true, ok: true, total: accounts.total || 0, idle: accounts.idle || 0 }
  } catch (e) {
    return { reachable: false, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 把一次 401/403 翻译成"该去修哪里"的提示（见 probeBackend 的成因说明）。
 * 只在真的收到鉴权失败状态码时调用——正常路径不产生额外请求。
 */
async function describeAuthFailure({ authMode, baseUrl, apiKey, statusCode, payload }) {
  const apiMsg = payload && payload.error && (payload.error.code || payload.error.message)
  if (authMode !== 'builtin') {
    return '服务端返回 ' + statusCode + '（未授权）：请检查服务地址与 API Key' +
      (apiMsg ? '（' + apiMsg + '）' : '')
  }
  const probe = await probeBackend({ authMode, baseUrl, apiKey })
  if (!probe.reachable) {
    return '无法连接本机后端服务（' + (probe.error || '连接失败') + '）：这会导致鉴权失败，请先在设置页确认后端已启动'
  }
  if (!probe.ok) {
    return '本机后端健康检查异常（HTTP ' + (probe.statusCode || '?') + '）：请到登录页重新保存账号以重启后端'
  }
  if (!probe.total) {
    return '本机后端没有可用的 DeepSeek 账号（未登录或登录失败）：请到登录页重新登录，而不是更换账号'
  }
  return '本机后端未接受当前 API Key（应用配置与后端不一致，后端现有账号 ' + probe.total + ' 个）：请到登录页重新保存账号以同步密钥'
}

/**
 * 拉取云端会话列表（#10 同步已有对话）。
 * 后端 /v1/cloud-sessions → ds-free-api GET /chat_session/fetch_page（无 PoW，仅鉴权）。
 * 返回 [{ id, title, updated_at }]，仅会话元信息（消息内容需要额外的历史接口，暂不拉取）。
 */
export async function listCloudSessions({ baseUrl, apiKey, authMode, timeout = 20000 }) {
  const effectiveBaseUrl = authMode === 'builtin' ? getActiveBackendBaseUrl() : (baseUrl || DEFAULT_BASE_URL)
  const url = apiUrl(effectiveBaseUrl, 'cloud-sessions')
  if (authMode === 'openai') {
    const err = validateExternalUrl(url)
    if (err) {
      throw new DsError('BAD_URL', err)
    }
  }
  const headers = {}
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
  const resp = await httpRequest({ url, method: 'GET', headers, timeout })
  if (resp.statusCode === 0) {
    throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    // 401 不等于封号：先分辨是"后端没连上/没账号/key 失配"还是上游真限制（bug 4）
    throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
      authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data
    }))
  }
  if (resp.statusCode >= 400) {
    const apiMsg = resp.data && resp.data.error && resp.data.error.message
    throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode, authMode))
  }
  const list = resp.data && resp.data.data
  if (!Array.isArray(list)) {
    throw new DsError('PARSE', '同步失败：响应格式异常')
  }
  return list
}

/**
 * 拉取远端声明的模型列表（自定义端点的模型选择，bug 6）。
 * 标准 OpenAI 兼容端点提供 GET /v1/models；部分自建服务只在根路径挂 /models，
 * 因此先试 /v1/models，404 时回退到 /models，避免"服务明明可用却报接口不存在"。
 * 返回 [{ id, ownedBy }]。
 */
export async function listRemoteModels({ baseUrl, apiKey, authMode = 'openai', timeout = 20000 }) {
  const effectiveBaseUrl = authMode === 'builtin' ? getActiveBackendBaseUrl() : (baseUrl || DEFAULT_BASE_URL)
  const base = String(effectiveBaseUrl || '').replace(/\/+$/, '')
  const v1Url = apiUrl(base, 'models')
  const candidates = /\/v1$/.test(base) ? [v1Url] : [v1Url, base + '/models']
  const headers = {}
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey

  let lastErr = null
  for (const url of candidates) {
    if (authMode === 'openai') {
      const err = validateExternalUrl(url)
      if (err) throw new DsError('BAD_URL', err)
    }
    const resp = await httpRequest({ url, method: 'GET', headers, timeout })
    if (resp.statusCode === 0) {
      throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络与服务地址')
    }
    if (resp.statusCode === 404) {
      lastErr = new DsError('HTTP_404', '接口不存在（已尝试 ' + candidates.join('、') + '）：请确认服务地址是否为 OpenAI 兼容端点')
      continue
    }
    if (resp.statusCode === 401 || resp.statusCode === 403) {
      throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
        authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data
      }))
    }
    if (resp.statusCode >= 400) {
      const apiMsg = resp.data && resp.data.error && resp.data.error.message
      throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode, authMode))
    }
    const list = resp.data && resp.data.data
    if (!Array.isArray(list)) {
      throw new DsError('PARSE', '模型列表响应格式异常（应为 { data: [{ id }] }）')
    }
    return list
      .map((m) => ({ id: String((m && m.id) || '').trim(), ownedBy: String((m && m.owned_by) || '') }))
      .filter((m) => m.id)
  }
  throw lastErr || new DsError('PARSE', '模型列表拉取失败')
}

/**
 * 拉取云端会话的消息内容（#10 完整同步）。
 * 返回 [{ role: 'user'|'assistant', content, reasoning }]（fragments 已拼接）。
 */
export async function listCloudSessionMessages({ baseUrl, apiKey, authMode, sessionId, timeout = 20000 }) {
  const effectiveBaseUrl = authMode === 'builtin' ? getActiveBackendBaseUrl() : (baseUrl || DEFAULT_BASE_URL)
  const url = apiUrl(effectiveBaseUrl, 'cloud-sessions/' + encodeURIComponent(sessionId) + '/messages')
  if (authMode === 'openai') {
    const err = validateExternalUrl(url)
    if (err) {
      throw new DsError('BAD_URL', err)
    }
  }
  const headers = {}
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
  const resp = await httpRequest({ url, method: 'GET', headers, timeout })
  if (resp.statusCode === 0) {
    throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
      authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data
    }))
  }
  if (resp.statusCode >= 400) {
    const apiMsg = resp.data && resp.data.error && resp.data.error.message
    throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode, authMode))
  }
  const list = resp.data && resp.data.data
  if (!Array.isArray(list)) {
    throw new DsError('PARSE', '拉取会话内容失败：响应格式异常')
  }
  return list
}

/**
 * 删除云端会话（bug 3：删除本地对话时必须连带删云端）。
 * 后端 /v1/cloud-sessions/{id} → ds-free-api POST /chat_session/delete。
 * 不删的话，下次「同步」会把这条会话重新导回本地（用户看到"删了又回来"）。
 */
export async function deleteCloudSession({ baseUrl, apiKey, authMode, sessionId, timeout = 20000 }) {
  const effectiveBaseUrl = authMode === 'builtin' ? getActiveBackendBaseUrl() : (baseUrl || DEFAULT_BASE_URL)
  const url = apiUrl(effectiveBaseUrl, 'cloud-sessions/' + encodeURIComponent(sessionId))
  if (authMode === 'openai') {
    const err = validateExternalUrl(url)
    if (err) throw new DsError('BAD_URL', err)
  }
  const headers = {}
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
  // 用 POST 而非 DELETE：笔端 Falcon http 模块不支持 DELETE（发出去得到 405），
  // 后端 /v1/cloud-sessions/{id} 同时接受 DELETE 与 POST（语义同官方 /chat_session/delete）。
  const resp = await httpRequest({ url, method: 'POST', headers, data: {}, timeout })
  if (resp.statusCode === 0) {
    throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
      authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data
    }))
  }
  if (resp.statusCode >= 400) {
    const apiMsg = resp.data && resp.data.error && resp.data.error.message
    throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode, authMode))
  }
  return true
}

function authError(authMode) {
  // 401 的两种成因必须分清：本机后端 key 失配（重新保存账号即可）与上游账号被封禁
  // （才需要换账号）。旧文案一律说"账号异常"，把前者也推去换账号。
  return authMode === 'builtin'
    ? '未认证：本机后端未接受当前请求（API Key 未同步或账号池为空）。请到登录页重新保存账号；仍失败再查账号是否被限制'
    : '鉴权失败：请检查 API Key'
}

function mapHttpStatus(code, authMode) {
  const map = {
    400: '请求格式有误（400）',
    401: authError(authMode),
    403: '没有访问权限（403）',
    404: '接口不存在，请检查服务地址是否正确',
    429: '请求过于频繁：请等待一段时间再发送，不要连续重试（连续发送会导致账号被禁言）',
    500: '服务端内部错误，请稍后重试',
    502: '服务网关错误（502），请稍后重试',
    503: authMode === 'builtin' ? '后端未配置 DeepSeek 账号，请到设置页填写账号密码' : '服务暂时不可用（503），请稍后重试',
    504: '请求超时（504），请稍后重试'
  }
  return map[code] || `请求失败（HTTP ${code}）`
}

function mapApiError(payload, authMode) {
  const e = payload && payload.error
  if (!e) return '服务返回了未知错误'
  // ds-free-api 常见错误语义转成更友好的话术
  const code = (e.code || '').toLowerCase()
  const msg = (e.message || e.type || '').toLowerCase()
  // 未配置 DeepSeek 账号：明确提示去设置页填写，而非笼统的"服务繁忙"
  if (code === 'no_accounts_configured' || code === 'no_accounts' || msg.indexOf('no accounts configured') >= 0) {
    return '未配置 DeepSeek 账号：请到设置页填写账号密码'
  }
  // 上游限流（账号已进入退避）：必须明确告诉用户"别再发了"。
  // 旧文案"服务繁忙，请稍后重试"会被理解成"再试一下就好"，而连点发送正是
  // 账号被上游升级为禁言的直接原因（bug 1）。这里给出退避提示 + 明确劝阻。
  if (code === 'upstream_rate_limited' || msg.indexOf('rate limited') >= 0) {
    return e.message || '上游限流中：请等待一段时间再发送（连续发送会被判定为异常客户端，可能导致账号被禁言）'
  }
  // 禁言提示原文直通（后端已提取"由于违反用户使用规范，你的账号已被禁言至 …"，含到期时间）
  if (msg.indexOf('禁言') >= 0) {
    return e.message || e.type || '账号已被禁言'
  }
  // 账号被限制/封禁（后端空 SSE 流等，#4）：给出直观提示而非技术细节
  if (msg.indexOf('被限制') >= 0 || msg.indexOf('封禁') >= 0 || msg.indexOf('空 sse') >= 0 || msg.indexOf('empty sse') >= 0) {
    return '当前 DeepSeek 账号可能已被限制或禁言：请到设置页更换账号，或等待一段时间后重试'
  }
  if (code === 'invalid_api_token' || code === 'authentication_error' || msg.indexOf('invalid api token') >= 0) {
    return authError(authMode)
  }
  // 限流/繁忙判定用词边界（\b），避免子串误伤：'rate' 曾匹配 "gene**rate**"，
  // 'key' 曾匹配 "mon**key**"，把普通错误误报成限流/鉴权问题
  if (
    code === 'overloaded' ||
    /\boverload/.test(msg) ||
    /\brate\b/.test(msg) ||
    /\bbusy\b/.test(msg) ||
    /\blimit(ed)?\b/.test(msg)
  ) {
    return '服务繁忙或触发限流：请等待一段时间再发送，不要连续重试（连续发送会被判定为异常客户端，可能导致账号被禁言）'
  }
  if (/\bauth\b/.test(msg) || /\bkey\b/.test(msg) || /\btoken\b/.test(msg) || /unauthorized/.test(msg) || /invalid/.test(msg)) {
    return authError(authMode)
  }
  if (msg.indexOf('model') >= 0) {
    return '模型不可用，请检查模型配置'
  }
  return e.message || e.type || '服务返回了错误'
}

// parseSse 已抽到 ds-text.js；这里引入使用（喂着每一条流式消息）
import { parseSse } from './ds-text.js'

/**
 * 流式（SSE）对话请求。
 * 设备框架的 $falcon.jsapi.http 不支持增量回调，因此这里用后台 curl -N 写文件 +
 * 轮询文件的方式实现逐字/逐段渲染。
 * @param {Object} opts { baseUrl, apiKey, modeKey, messages, thinking, search, timeout,
 *                        authMode, modelId, conversationId }
 * @param {Object} handlers { onDelta(text, full), onReasoning(text, full) }
 * @returns {Promise<{content, reasoning, finishReason, usage}>}
 */
export async function chatStream(opts, handlers = {}) {
  const { baseUrl, apiKey, modeKey, messages, thinking, search, timeout = 300000, authMode = 'builtin', modelId = '', conversationId = '' } = opts
  const isCancelled = handlers.isCancelled || function () { return false }
  const mode = getMode(modeKey)
  const effectiveBaseUrl = authMode === 'builtin' ? getActiveBackendBaseUrl() : (baseUrl || DEFAULT_BASE_URL)
  const url = apiUrl(effectiveBaseUrl, 'chat/completions')

  if (authMode === 'openai') {
    const err = validateExternalUrl(url)
    if (err) {
      throw new DsError('BAD_URL', err)
    }
  }

  // OpenAI 兼容端点：优先用设置的自定义模型 ID，缺省回退 deepseek-v4-flash；
  // 内置端点始终用模式默认模型（deepseek-*，走 ds-free-api 账号池）
  const model = authMode === 'openai' ? (modelId || 'deepseek-v4-flash') : mode.model
  const body = {
    model,
    messages,
    stream: true
  }
  // 会话标识：后端据此做持久会话复用（历史由 DeepSeek 服务端持有，不再上传历史文件）
  if (conversationId) body.user = String(conversationId)
  if (thinking === false) {
    body.reasoning_effort = 'none'
  }
  body.web_search_options = { search_context_size: search ? 'high' : 'none' }

  const token = 'dsstream_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
  const reqFile = joinPath(dataDirBase(), token + '.req.json')
  const outFile = joinPath(dataDirBase(), token + '.out.txt')

  if (isCancelled()) {
    throw new DsError('CANCELLED', '已停止')
  }

  await writeFile(reqFile, JSON.stringify(body))

  let cmd = 'curl -s -N -m ' + Math.ceil(timeout / 1000) + ' -X POST'
  cmd += ' -H "Content-Type: application/json"'
  if (apiKey) {
    // API Key 只做简单清洗，避免破坏 shell 引号
    cmd += ' -H "Authorization: Bearer ' + String(apiKey).replace(/["\\]/g, '') + '"'
  }
  cmd += ' -d @' + shq(reqFile) + ' ' + shq(url) + ' > ' + shq(outFile) + ' 2>&1 &'
  execShell(cmd)
  if (handlers.onToken) handlers.onToken(token)

  let buffer = ''
  let lastLen = 0
  let content = ''
  let reasoning = ''
  let dsTitle = null
  let dsSessionId = null
  let done = false
  let raw = null
  const start = Date.now()

  try {
    // 事件处理抽成闭包：finish 之后还可能跟着 usage / ds_title / ds_session_id 等
    // 尾随 chunk（空 choices），它们到达时往往已在本批次之外——循环退出后要再读一次，
    // 否则这些尾巴会被丢掉（会话 id 丢了，同步就会重复导入，bug 3）。
    const handleEvents = (events) => {
      for (let i = 0; i < events.length; i++) {
        const data = events[i]
        if (data === '[DONE]') {
          done = true
          continue
        }
        let obj = null
        try {
          obj = JSON.parse(data)
        } catch (e) {
          continue
        }
        if (obj && obj.error) {
          // 上游限流用独立错误码，调用方据此停止自动续发（bug 1）
          const errCode = String(obj.error.code || '')
          if (isRateLimitCode(errCode) || isRateLimitText(obj.error.message)) {
            const err = new DsError('RATE_LIMITED', mapApiError(obj, authMode), obj.error)
            err.rateLimited = true
            throw err
          }
          throw new DsError('API', mapApiError(obj, authMode), obj.error)
        }
        // DeepSeek 自动生成的会话标题（会话首条消息时下发，#9）
        if (obj && obj.ds_title) {
          dsTitle = obj.ds_title
          continue
        }
        // 本对话的云端会话 id（后端在流末尾以尾随 chunk 下发，用于同步去重）
        if (obj && obj.ds_session_id) {
          dsSessionId = obj.ds_session_id
          continue
        }
        const choice = obj && obj.choices && obj.choices[0]
        if (!choice) continue
        const delta = choice.delta || {}
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content
          if (handlers.onReasoning) handlers.onReasoning(delta.reasoning_content, reasoning)
        }
        if (delta.content) {
          content += delta.content
          if (handlers.onDelta) handlers.onDelta(delta.content, content)
        }
        if (choice.finish_reason) {
          done = true
        }
      }
    }

    while (!done && !isCancelled() && Date.now() - start < timeout) {
      await sleep(200)
      raw = await readFile(outFile)
      if (raw) {
        const txt = String(raw)
        if (txt.length < lastLen) {
          // 文件被清理/重建时重置
          buffer = ''
          lastLen = 0
        }
        const chunk = txt.slice(lastLen)
        lastLen = txt.length
        buffer += chunk

        const parsed = parseSse(buffer)
        buffer = parsed.rest
        handleEvents(parsed.events)
      }

      // curl 已把错误信息写进文件且没有任何 SSE 数据时，提前结束而不是傻等超时
      if (!done && Date.now() - start > 5000 && raw) {
        const txt = String(raw)
        if (txt.indexOf('data:') < 0) {
          if (txt.indexOf('curl:') >= 0) {
            throw new DsError('NETWORK', txt.replace(/^curl:\s*/, '').split('\n')[0] || '无法连接服务器，请检查服务地址')
          }
          // 某些后端在 stream:true 下仍可能直接返回 JSON 错误（curl -s 不保留
          // HTTP 状态码，所以从 body 里的 '{' 起尝试解析，不再要求首字符是 '{'）
          const trimmed = txt.trim()
          const brace = trimmed.indexOf('{')
          if (brace >= 0) {
            let obj = null
            try {
              obj = JSON.parse(trimmed.slice(brace))
            } catch (e) {
              obj = null
            }
            if (obj && obj.error) {
              const errCode = String(obj.error.code || '')
              // 鉴权类错误同样要走成因诊断：本机后端 key 失配 / 账号池为空 / 真被封
              if (/invalid_api_token|authentication_error|unauthorized/i.test(errCode)) {
                throw new DsError('HTTP_401', await describeAuthFailure({
                  authMode, baseUrl, apiKey, statusCode: 401, payload: obj
                }))
              }
              // 上游限流用独立错误码，调用方据此停止自动续发（bug 1）
              if (isRateLimitCode(errCode) || isRateLimitText(obj.error.message)) {
                const err = new DsError('RATE_LIMITED', mapApiError(obj, authMode), obj.error)
                err.rateLimited = true
                throw err
              }
              throw new DsError('API', mapApiError(obj, authMode), obj.error)
            }
          }
        }
      }
    }

    if (isCancelled()) {
      throw new DsError('CANCELLED', '已停止')
    }
    if (!done) {
      throw new DsError('STREAM_TIMEOUT', '请求超时，请重试')
    }

    // 收尾补读：finish 之后写入的尾随 chunk（usage / ds_title / ds_session_id）
    // 可能落在下一次 200ms 轮询才可见的位置。旧版只补读一次，curl 落盘稍慢
    // 就把 ds_session_id 丢了（会话对不上号 → 同步重复导入，bug 3）。
    // 这里连续读到文件长度稳定两轮为止（至多 5 轮 ≈ 1s）。
    let stableReads = 0
    for (let i = 0; i < 5 && stableReads < 2; i++) {
      await sleep(200)
      try {
        const tailRaw = await readFile(outFile)
        const txt = tailRaw ? String(tailRaw) : ''
        if (txt.length === lastLen) {
          stableReads++
          continue
        }
        if (txt.length < lastLen) {
          // 文件被清理/重建：忽略残余，避免尾部重放
          continue
        }
        stableReads = 0
        const chunk = txt.slice(lastLen)
        lastLen = txt.length
        if (chunk) {
          const parsed = parseSse(buffer + chunk)
          buffer = parsed.rest
          handleEvents(parsed.events)
        }
      } catch (e) { /* 补读失败不影响已有结果 */ }
    }

    return { content: stripInternalTags(content), reasoning: stripInternalTags(reasoning), dsTitle, dsSessionId, finishReason: 'stop', usage: null }
  } finally {
    stopStream(token)
    try { execShell('rm -f ' + shq(reqFile) + ' ' + shq(outFile) + ' || true') } catch (e) { /* 忽略 */ }
  }
}

// 兼容既有引用：这些判定原先定义在本文件，现移到 error-classify.js（便于宿主单测）
export { isRateLimitCode, isRateLimitText, isAccountSuspension }
