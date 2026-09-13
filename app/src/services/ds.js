// ds-free-api 的 OpenAI 兼容客户端（非流式）。
// 会话是「无状态」的：每次请求都把完整历史作为 messages 发给后端，
// 因此「重试 / 修改」只需本地裁剪历史后重新请求。

import { httpRequest, validateExternalUrl } from './http.js'
import { readImageDataUrl } from './images.js'
import { execShell, writeFile, readFile, sleep, shq, stopStream, joinPath, dataDirBase } from './native.js'

import { getActiveBackendBaseUrl } from './backend-health.js'

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/**
 * 把用户填写的服务地址拼成完整接口 URL。
 *
 * 用户填的地址两种写法都常见：`http://host:22217` 和 `http://host:22217/v1`
 * （设置页默认值本身就带 /v1）。旧代码无条件再拼一个 `/v1/...`，
 * 结果是 `…/v1/v1/chat/completions` → 404，并被错报成"接口不存在，请检查服务地址"。
 * 这里检测尾部是否已有 /v1 再决定是否补。
 */
export function apiUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const suffix = String(path || '').replace(/^\/+/, '')
  const root = /\/v1$/.test(base) ? base : base + '/v1'
  return root + '/' + suffix
}

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
export function stripInternalTags(text) {
  if (!text) return text
  return String(text)
    .replace(/<\|tool_calls_begin\|>/gi, '')
    .replace(/<\|tool_calls_end\|>/gi, '')
    .replace(/<\|tool_call_begin\|>/gi, '')
    .replace(/<\|tool_call_end\|>/gi, '')
    .replace(/<\|begin_of_function\|>/gi, '')
    .replace(/<\|end_of_function\|>/gi, '')
    .replace(/<\|tool▁calls▁begin\|>/gi, '')
    .replace(/<\|tool▁calls▁end\|>/gi, '')
    .replace(/<\|tool▁call▁begin\|>/gi, '')
    .replace(/<\|tool▁call▁end\|>/gi, '')
    .replace(/<\|[^|]{1,40}\|>/g, '')
    .replace(/<invoke>/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<parameter>/gi, '')
    .replace(/<\/parameter>/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
}

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
    throw new DsError('HTTP_' + resp.statusCode, '账号可能已被封禁或限制（HTTP ' + resp.statusCode + '）：请到设置页更换账号')
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
    throw new DsError('HTTP_' + resp.statusCode, '账号可能已被封禁或限制（HTTP ' + resp.statusCode + '）：请到设置页更换账号')
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

function authError(authMode) {
  // 内置 ds-free-api：401 通常是账号未登录/过期；OpenAI 端点：检查 key
  return authMode === 'builtin'
    ? '未认证：请到设置页配置 DeepSeek 账号和密码'
    : '鉴权失败：请检查 API Key'
}

function mapHttpStatus(code, authMode) {
  const map = {
    400: '请求格式有误（400）',
    401: authError(authMode),
    403: '没有访问权限（403）',
    404: '接口不存在，请检查服务地址是否正确',
    429: '请求过于频繁，请稍后再试',
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
  if (msg.indexOf('overload') >= 0 || msg.indexOf('rate') >= 0 || msg.indexOf('busy') >= 0 || msg.indexOf('limit') >= 0) {
    return '服务繁忙或触发限流，请稍后重试'
  }
  if (msg.indexOf('auth') >= 0 || msg.indexOf('key') >= 0 || msg.indexOf('token') >= 0 || msg.indexOf('unauthorized') >= 0 || msg.indexOf('invalid') >= 0) {
    return authError(authMode)
  }
  if (msg.indexOf('model') >= 0) {
    return '模型不可用，请检查模型配置'
  }
  return e.message || e.type || '服务返回了错误'
}

// 解析 SSE 文本流：按空行切分完整事件，返回已完成事件列表和剩余未完成 buffer。
function parseSse(buffer) {
  const events = []
  let rest = String(buffer || '').replace(/\r\n/g, '\n')
  let idx
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const part = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const dataLines = []
    const lines = part.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.indexOf('data:') === 0) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'))
    }
  }
  return { events, rest }
}

/**
 * 流式（SSE）对话请求。
 * 设备框架的 $falcon.jsapi.http 不支持增量回调，因此这里用后台 curl -N 写文件 +
 * 轮询文件的方式实现逐字/逐段渲染。
 * @param {Object} opts 同 chat()
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
  let done = false
  let raw = null
  const start = Date.now()

  try {
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

        for (let i = 0; i < parsed.events.length; i++) {
          const data = parsed.events[i]
          if (data === '[DONE]') {
            done = true
            break
          }
          let obj = null
          try {
            obj = JSON.parse(data)
          } catch (e) {
            continue
          }
          if (obj && obj.error) {
            throw new DsError('API', mapApiError(obj, authMode), obj.error)
          }
          // DeepSeek 自动生成的会话标题（仅 thinking=OFF 且 search=OFF 时下发，#9）
          if (obj && obj.ds_title) {
            dsTitle = obj.ds_title
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

      // curl 已把错误信息写进文件且没有任何 SSE 数据时，提前结束而不是傻等超时
      if (!done && Date.now() - start > 5000 && raw) {
        const txt = String(raw)
        if (txt.indexOf('data:') < 0) {
          if (txt.indexOf('curl:') >= 0) {
            throw new DsError('NETWORK', txt.replace(/^curl:\s*/, '').split('\n')[0] || '无法连接服务器，请检查服务地址')
          }
          // 某些后端在 stream:true 下仍可能直接返回 JSON 错误
          const trimmed = txt.trim()
          if (trimmed.indexOf('{') === 0) {
            try {
              const obj = JSON.parse(trimmed)
              if (obj && obj.error) {
                throw new DsError('API', mapApiError(obj, authMode), obj.error)
              }
            } catch (e) {
              if (e instanceof DsError) throw e
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

    return { content: stripInternalTags(content), reasoning: stripInternalTags(reasoning), dsTitle, finishReason: 'stop', usage: null }
  } finally {
    stopStream(token)
    try { execShell('rm -f ' + shq(reqFile) + ' ' + shq(outFile) + ' || true') } catch (e) { /* 忽略 */ }
  }
}

/**
 * 发送一次对话请求。
 * @param {Object} opts
 *  - baseUrl, apiKey, modeKey, messages(已由 buildMessages 构建), thinking, search, timeout
 *  - modelId: OpenAI 兼容端点的自定义模型 ID（可选，留空使用 modeKey 对应默认模型）
 * @returns {Promise<{content, reasoning, finishReason, usage}>}
 */
export async function chat({ baseUrl, apiKey, modeKey, messages, thinking, search, timeout = 120000, authMode = 'builtin', modelId = '', conversationId = '' }) {
  const mode = getMode(modeKey)
  const effectiveBaseUrl = authMode === 'builtin' ? getActiveBackendBaseUrl() : (baseUrl || DEFAULT_BASE_URL)
  const url = apiUrl(effectiveBaseUrl, 'chat/completions')

  // 校验用户填写的端点：仅 http/https、需可用主机名；局域网地址允许（自建服务的正常形态）
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
    stream: false
  }
  // 会话标识：后端据此做持久会话复用（同 chatStream）
  if (conversationId) body.user = String(conversationId)

  // 深度思考：后端默认开启，仅当关闭时显式传 none
  if (thinking === false) {
    body.reasoning_effort = 'none'
  }

  // 联网搜索：显式开启/关闭，避免依赖后端默认值
  body.web_search_options = { search_context_size: search ? 'high' : 'none' }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey

  const resp = await httpRequest({ url, method: 'POST', headers, data: JSON.stringify(body), timeout })

  if (resp.statusCode === 0) {
    throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络与服务地址')
  }

  let payload = resp.data
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch (e) {
      throw new DsError('PARSE', '响应解析失败，请重试')
    }
  }

  if (payload && payload.error) {
    throw new DsError('API', mapApiError(payload, authMode), payload.error)
  }

  if (resp.statusCode >= 400) {
    throw new DsError('HTTP_' + resp.statusCode, mapHttpStatus(resp.statusCode, authMode))
  }

  const choice = payload && payload.choices && payload.choices[0]
  if (!choice || !choice.message) {
    throw new DsError('EMPTY', '模型未返回内容，请重试')
  }

  const content = choice.message.content || ''
  const reasoning = choice.message.reasoning_content || choice.message.reasoning || ''
  if (!content && !reasoning) {
    throw new DsError('EMPTY', '模型未返回内容，请重试')
  }

  return {
    content: stripInternalTags(content),
    reasoning: stripInternalTags(reasoning),
    dsTitle: (payload && payload.ds_title) || null,
    finishReason: choice.finish_reason,
    usage: payload.usage
  }
}
