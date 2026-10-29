// 上游 Provider 客户端：把请求转发给真正的 OpenAI 兼容服务（DeepSeek 官方或其它）。
//
// 职责边界：
//   - 只做"带密钥的转发"，不做协议转换（客户端本来就发 OpenAI 格式）；
//   - 不缓冲 SSE：收到一块转发一块，客户端断连立即 abort 上游；
//   - 不把 provider key / 上游原始错误细节回给设备（避免泄露账号信息）。

export class ProviderError extends Error {
  constructor(code, message, status = 502, detail = '') {
    super(message || code)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

// 上游内容审核误拦识别：第三方镜像/公益中转渠道常见 sensitive_words_detected、
// 敏感词拦截等报错，对完全正常的提问（实证案例："高考听障人士怎么听英语听力"
// 被 rule91 渠道连续 8 次误拦）也会命中。这类错误重试通常还是同一渠道，无法
// 自愈；必须给用户一句可解释、可行动的话，而不是裸的英文错误 + request id。
const MODERATION_RE = /sensitive[_ ]?words?|敏感词|内容审核|content[_ ]?filter|moderation/i

/**
 * 识别上游报错里的"内容审核拦截"类错误。
 * @returns {{code:string, message:string}|null} 命中返回映射结果，否则 null
 */
export function classifyUpstreamError(message) {
  const m = String(message || '')
  if (!MODERATION_RE.test(m)) return null
  return {
    code: 'moderation_blocked',
    // 文案注意：设备端 mapApiError 有一组正则兜底（rate/limit/auth/key/token/
    // invalid 等子串会改写文案），这句必须避开这些词，才能原样透传到气泡上。
    message: '内容被中转渠道的安全审核拦截（多为机器误判，与提问本身无关）：可换个说法再试，或稍后再试；若反复出现请联系管理员。'
  }
}

function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '')
  const s = String(suffix || '').replace(/^\/+/, '')
  return b + '/' + s
}

function httpErrorMessage(text, status) {
  const raw = String(text || '').trim()
  try {
    const obj = JSON.parse(raw)
    const msg = obj && obj.error && (obj.error.message || obj.error.code)
    if (msg) return String(msg).slice(0, 300)
    if (obj && obj.message) return String(obj.message).slice(0, 300)
  } catch (_) { /* 非 JSON */ }
  return raw ? raw.slice(0, 300) : '上游返回 HTTP ' + status
}

export class ProviderClient {
  constructor(config, { fetchImpl } = {}) {
    this.cfg = config.provider || {}
    this.fetchImpl = fetchImpl || globalThis.fetch
  }

  get configured() {
    return !!(this.cfg.baseUrl && this.cfg.apiKey)
  }

  // 兼容后台保存后的旧调用点。模型目录现在完全由后台配置决定，
  // 不再缓存上游 /models 的结果。
  invalidateModels() {}

  /**
   * 对外（客户端 /v1/models）可见的模型目录。
   *
   * 只读取内置服务后台配置，不请求上游：provider.models 是管理员显式
   * 声明的目录，modelMap 的键是显式声明的别名，defaultModel 也必须可用。
   * 这样客户端看到的列表与服务端实际接受的模型严格一致。
   */
  catalogModels() {
    const ids = []
    const seen = new Set()
    const add = (value) => {
      const id = String(value || '').trim()
      if (!id || seen.has(id)) return
      seen.add(id)
      ids.push({ id, owned_by: this.cfg.name || 'upstream' })
    }
    for (const id of this.cfg.models || []) add(id)
    for (const id of Object.keys(this.cfg.modelMap || {})) add(id)
    add(this.cfg.defaultModel)
    return ids
  }

  /**
   * 把客户端模型名解析成上游模型名，并拒绝后台未声明的模型。
   * @param {string} name 客户端请求的 model（空值使用 defaultModel）
   * @param {{validate?: boolean}} opts validate=false 仅供后台连接探测
   * @returns {{requested: string, upstream: string}}
   */
  resolveModel(name, { validate = true } = {}) {
    const requested = String(name || '').trim() || String(this.cfg.defaultModel || '').trim()
    if (!requested) {
      throw new ProviderError('model_required', '请求缺少 model，且服务端未配置默认模型', 400)
    }
    if (validate) {
      const allowed = new Set(this.catalogModels().map((m) => m.id))
      if (!allowed.has(requested)) {
        const available = Array.from(allowed)
        throw new ProviderError(
          'unsupported_model',
          '不支持的模型：' + requested + '。内置服务可用模型：' + (available.length ? available.join('、') : '未配置'),
          400
        )
      }
    }
    const map = this.cfg.modelMap || {}
    return { requested, upstream: map[requested] || requested }
  }

  mapModel(name) {
    return this.resolveModel(name).upstream
  }

  headers(extra = {}) {
    return Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': this.cfg.userAgent || 'deepseek-pen-upstream/1.0'
    }, this.cfg.extraHeaders || {}, extra, {
      // 必须最后覆盖：不允许 extraHeaders 里意外带出别的 Authorization
      'Authorization': 'Bearer ' + this.cfg.apiKey
    })
  }

  /**
   * 发起一次上游请求。返回的 response 需要调用方消费完毕后调用 cleanup()，
   * 以清除总超时定时器（流式请求的总超时由业务侧按 idle 语义另行管理）。
   */
  async request(path, { method = 'POST', body, signal, timeoutMs } = {}) {
    if (!this.configured) {
      throw new ProviderError(
        'provider_not_configured',
        '上游服务尚未配置（provider.baseUrl / provider.apiKey 为空）',
        503
      )
    }
    const ctl = new AbortController()
    let abortedBy = ''
    const onAbort = () => {
      abortedBy = 'client'
      ctl.abort()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    const total = Number(timeoutMs) || Number(this.cfg.timeoutMs) || 300000
    const timer = setTimeout(() => {
      abortedBy = 'timeout'
      ctl.abort()
    }, total)
    if (timer.unref) timer.unref()

    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    try {
      const resp = await this.fetchImpl(joinUrl(this.cfg.baseUrl, path), {
        method,
        headers: this.headers(),
        body,
        signal: ctl.signal,
        redirect: 'follow'
      })
      return { resp, cleanup, abortedBy: () => abortedBy }
    } catch (e) {
      cleanup()
      if (abortedBy === 'client') {
        throw new ProviderError('client_aborted', '客户端已断开', 499)
      }
      if (abortedBy === 'timeout') {
        throw new ProviderError('provider_timeout', '上游响应超时', 504)
      }
      throw new ProviderError('provider_unreachable', '无法连接上游服务：' + (e && e.message ? e.message : String(e)), 502)
    }
  }

  async chat(bodyText, { signal, timeoutMs } = {}) {
    return this.request('chat/completions', { method: 'POST', body: bodyText, signal, timeoutMs })
  }

  /**
   * 管理后台「测试连接」：真实请求一次 Provider，不静默回退配置。
   * @param {Object} opts { chat, model }
   * @returns {{ok:boolean, status?:number, latencyMs:number, models?:string[], model?:string, code?:string, message?:string}}
   */
  async probe({ chat = false, model = '' } = {}) {
    const started = Date.now()
    if (!this.configured) {
      return { ok: false, code: 'provider_not_configured', message: '尚未填写上游地址或 API Key', latencyMs: 0 }
    }
    let cleanup = null
    try {
      const r = await this.request('models', { method: 'GET', timeoutMs: 15000 })
      cleanup = r.cleanup
      const text = await r.resp.text()
      const latencyMs = Date.now() - started
      if (!r.resp.ok) {
        return {
          ok: false,
          status: r.resp.status,
          code: 'provider_http_' + r.resp.status,
          message: httpErrorMessage(text, r.resp.status),
          latencyMs
        }
      }
      let ids = []
      try {
        const obj = JSON.parse(text)
        ids = (Array.isArray(obj && obj.data) ? obj.data : [])
          .map((m) => String((m && m.id) || ''))
          .filter(Boolean)
      } catch (_) { /* 有些 Provider 的 /models 不是标准 JSON */ }

      if (!chat) return { ok: true, status: r.resp.status, latencyMs, models: ids }

      // 进一步发一条最小对话，验证 Key 对该模型真的有权限（max_tokens:1，消耗极小）。
      // 探测允许使用尚未保存到目录的模型，因此不做 unsupported_model 校验。
      const useModel = this.resolveModel(model, { validate: false }).upstream
      const body = JSON.stringify({
        model: useModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
      const r2 = await this.chat(body, { timeoutMs: 25000 })
      try {
        const text2 = await r2.resp.text()
        const latency2 = Date.now() - started
        if (!r2.resp.ok) {
          return {
            ok: false,
            status: r2.resp.status,
            code: 'provider_http_' + r2.resp.status,
            message: httpErrorMessage(text2, r2.resp.status),
            latencyMs: latency2,
            models: ids,
            model: useModel
          }
        }
        return { ok: true, status: r2.resp.status, latencyMs: latency2, models: ids, model: useModel, chatOk: true }
      } finally {
        r2.cleanup()
      }
    } catch (e) {
      return {
        ok: false,
        code: e && e.code ? e.code : 'probe_failed',
        message: e && e.message ? e.message : String(e),
        latencyMs: Date.now() - started
      }
    } finally {
      if (cleanup) cleanup()
    }
  }

  // 兼容旧调用：服务端 /v1/models 只返回后台目录，绝不透传上游请求。
  models() {
    return this.catalogModels()
  }

  // 上游错误体里常有账号/余额信息，统一截断并只取 message
  static async describeError(resp, limit = 64 * 1024) {
    let text = ''
    try {
      text = await resp.text()
    } catch (_) {
      return { message: '上游返回 HTTP ' + resp.status, raw: '' }
    }
    const clipped = text.length > limit ? text.slice(0, limit) : text
    let message = ''
    try {
      const obj = JSON.parse(clipped)
      message = (obj && obj.error && (obj.error.message || obj.error.code)) || (obj && obj.message) || ''
    } catch (_) {
      message = clipped.slice(0, 300)
    }
    return { message: String(message || ('上游返回 HTTP ' + resp.status)), raw: clipped }
  }
}
