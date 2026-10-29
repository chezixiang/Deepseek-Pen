import { pairedAuthHeaders, buildCurlConfig, httpRequest, validateExternalUrl } from './http.js'
import { isPaired, randomHex, signRequest, urlPath, clientHeaders } from './api-auth.js'
import { readImageDataUrl } from './images.js'
import { readLocalFileDataUrl } from './files.js'
import { normalizeThinkingLevel } from './thinking-levels.js'
import { callWebTool } from './cloud-control.js'
import { DEFAULT_AUTH_MODE, isBuiltinMode, UPSTREAM_BASE_URL, isUpstreamMode, execShell, writeFileRetry, readFile, sleep, shq, stopStream, joinPath, dataDirBase, appLog, appLogError, debugLog } from './store.js'

// 错误分类：把后端/上游的错误语义翻译成"应用该怎么做"。
//
// 单独成模块的理由：这些判定必须能在宿主机上单测（设备原生模块在 node 里 import
// 不了），而它们决定的是**要不要继续发请求**——判错会把用户账号送进禁言。
//
// 核心区分（bug 1）：
//   - 服务繁忙 / Overloaded：只是当前没有空闲账号，等一会自己会好，可以重试；
//   - 上游限流 / RateLimited：上游正在限这条链路，**继续重试会被判定为异常客户端
//     并升级为禁言**。必须明确告诉用户"等待，不要连点发送"，并且应用侧停止自动续发。
//
/**
 * 上游限流的错误码（后端 ds-free-api 的 upstream_rate_limited）。
 * 与"服务繁忙（overloaded，只是暂时没空闲账号）"分开。
 */
function isRateLimitCode(code) {
  return String(code || '').toLowerCase() === 'upstream_rate_limited'
}

/**
 * 限流文案兜底匹配（后端未给独立错误码时，按话术识别）。
 * 注意不要把"服务繁忙"这类通用文案算进来——那会把可正常重试的请求误拦成限流。
 */
function isRateLimitText(text) {
  const t = String(text || '');
  return /上游限流|rate limited|rate_limit_reached|所有账号均在限流|upstream_rate_limited/i.test(t)
}

/**
 * 疑似账号被上游限制/禁言（只有这类才值得记入"账号异常"取证；401/限流不算）。
 * 限流是"暂时别发"，封禁/禁言是"这个账号有问题"，两者的用户动作完全不同。
 */
function isAccountSuspension(text) {
  return /禁言|被限制|封禁|空\s*SSE|empty sse|账号已被/i.test(String(text || ''))
}

/** 综合判定：这次失败是否属于"上游限流，必须停止续发" */
function isRateLimitedError(err) {
  if (!err) return false
  if (err.rateLimited) return true
  if (isRateLimitCode(err.code)) return true
  return isRateLimitText(err.message)
}

// 错误文案映射（纯函数，无设备依赖，可在 Node 里回归测试）。

function describeAuthError(authMode) {
  // 401 的两种成因必须分清：本机后端 key 失配（重新保存账号即可）与上游账号被封禁
  // （才需要换账号）。旧文案一律说"账号异常"，把前者也推去换账号。
  return '鉴权失败：请检查 API Key'
}

function mapHttpStatus(code, authMode) {
  const builtin = isBuiltinMode();
  const map = {
    400: '请求格式有误（400）',
    401: describeAuthError(),
    403: builtin ? '没有访问权限（403）' : '没有访问权限（403）：请检查 API Key 是否有该模型/接口的权限',
    404: '接口不存在，请检查服务地址是否为 OpenAI 兼容端点',
    429: '请求过于频繁：请等待一段时间再发送，不要连续重试',
    500: '服务端内部错误，请稍后重试',
    502: '服务网关错误（502），请稍后重试',
    503: builtin ? '后端未配置 DeepSeek 账号，请到设置页填写账号密码' : '服务暂时不可用（503），请稍后重试',
    504: '请求超时（504），请稍后重试'
  };
  return map[code] || `请求失败（HTTP ${code}）`
}

function mapApiError(payload, authMode) {
  const e = payload && payload.error;
  if (!e) return '服务返回了未知错误'
  const code = (e.code || '').toLowerCase();
  const msg = (e.message || e.type || '').toLowerCase();

  // 未配置账号（内置后端 / 某些中转站的账号池）
  if (code === 'no_accounts_configured' || code === 'no_accounts' || msg.indexOf('no accounts configured') >= 0) {
    return '服务端未配置可用账号：请检查服务地址，或联系服务商确认账号状态'
  }

  // 内置服务的模型目录拒绝：这是用户可修正的配置错误，必须原样展示
  // 服务端给出的可用模型列表，而不是包装成网络/鉴权失败。
  if (code === 'unsupported_model' || code === 'model_not_supported' || code === 'model_not_found') {
    return e.message || '请求的模型不在内置服务模型目录中，请到设置页重新拉取模型后选择'
  }

  // 内置服务的错误语义（原「我的上游」）：必须给出可操作的处置，而不是笼统的“失败”
  if (code === 'device_blocked') {
    return '设备已被内置服务临时限制（可能触发防反代检测）：请稍后重试；若持续出现，请联系服务管理员解除'
  }
  if (code === 'client_header_required' || code === 'client_header_invalid') {
    return '客户端与内置服务版本不匹配：请升级 App 后重试'
  }
  if (code === 'device_concurrency_exceeded') {
    return '同一设备并发请求过多：请等当前回复结束后再发送'
  }
  if (code === 'device_token_expired' || code === 'device_revoked' || code === 'device_not_paired') {
    return '设备令牌已失效：请到设置页「设备配对」重新配对或刷新令牌'
  }

  // 上游限流：必须明确告诉用户"别再连点"，这不是可以立刻重试的错误。
  if (code === 'upstream_rate_limited' || msg.indexOf('rate limited') >= 0) {
    return e.message || ('服务端限流中：请等待一段时间再发送，不要连续重试')
  }

  // 禁言：原文直通（服务端通常带到期时间），不包装成网络错误
  if (msg.indexOf('禁言') >= 0) {
    return e.message || e.type || '账号已被禁言'
  }

  // 被限制 / 空 SSE：内置模式提示换账号；自定义端点提示查 Key/模型/服务商
  if (msg.indexOf('被限制') >= 0 || msg.indexOf('封禁') >= 0 || msg.indexOf('空 sse') >= 0 || msg.indexOf('empty sse') >= 0) {
    return '服务端拒绝了请求（可能触发了风控或额度限制）：请检查 API Key / 模型是否可用，或联系服务商'
  }

  if (code === 'invalid_api_token' || code === 'authentication_error' || msg.indexOf('invalid api token') >= 0) {
    return describeAuthError()
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
    return '服务繁忙或触发限流：请等待一段时间再发送，不要连续重试'
  }

  if (/\bauth\b/.test(msg) || /\bkey\b/.test(msg) || /\btoken\b/.test(msg) || /unauthorized/.test(msg) || /invalid/.test(msg)) {
    return describeAuthError()
  }

  if (msg.indexOf('model') >= 0) {
    return '不支持的模型：请到设置页「从 API 拉取模型」重新选择'
  }

  return e.message || e.type || '服务返回了错误'
}

// ds.js 的纯文本/解析函数（无 native 桥、无网络依赖），独立成模块以便在 Node 里
// 做回归测试（scripts/test-ds-text.mjs）。ds.js 引用这些实现，行为不变。
//
// parseSse 喂着每一条流式消息：CRLF、跨 chunk 撕裂的事件、多行 data: 的拼接
// 都在这里，是历史上最容易出"消息丢字/重复"的地方。

// 把用户填写的服务地址拼成完整接口 URL。
//
// 用户填的地址两种写法都常见：`http://host:22217` 和 `http://host:22217/v1`
// （设置页默认值本身就带 /v1）。旧代码无条件再拼一个 `/v1/...`，
// 结果是 `…/v1/v1/chat/completions` → 404，并被错报成"接口不存在，请检查服务地址"。
// 这里检测尾部是否已有 /v1 再决定是否补。
function apiUrl$1(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').replace(/^\/+/, '');
  const root = /\/v1$/.test(base) ? base : base + '/v1';
  return root + '/' + suffix
}

// 水平空白折叠只作用于围栏（``` / ~~~）外的行：围栏内的缩进是代码语义，
// 全局折叠曾把代码块缩进全部压掉——不仅显示错，内容还会写回消息持久化、
// 作为历史回传给模型（丢语义）。标签清洗仍对全文生效（防泄露优先）。
function collapseOutsideFences(text) {
  const lines = String(text).split('\n');
  let inFence = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence;
      out.push(line);
      continue
    }
    out.push(inFence ? line : line.replace(/[ \t]{2,}/g, ' '));
  }
  return out.join('\n')
}

// 移除模型回复中可能泄露的内部协议标签，防止发给 DeepSeek 官方 API 或展示给用户导致封号。
// 注意：标签替换为空串；空白折叠只发生在围栏外——
// 旧版全局折叠既会吞掉换行（#14），也会毁掉代码缩进。
function stripInternalTags$1(text) {
  if (!text) return text
  return collapseOutsideFences(
    String(text)
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
  )
}

// 解析 SSE 文本流：按空行切分完整事件，返回已完成事件列表和剩余未完成 buffer。
// buffer 语义：上次未凑齐完整事件（缺空行结尾）的残段，调用方必须原样带回下次拼接。
function parseSse(buffer) {
  const events = [];
  let rest = String(buffer || '').replace(/\r\n/g, '\n');
  let idx;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const part = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLines = [];
    const lines = part.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('data:') === 0) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'));
    }
  }
  return { events, rest }
}

// 模型名解析（纯函数，无设备依赖，可在 Node 里回归测试）。
//
// 背景：账号登录模式暂停后，默认端点是 DeepSeek 官方 API（api.deepseek.com）。
// 官方 API 只认 `deepseek-chat` / `deepseek-reasoner`；而设置里的旧默认值
// `deepseek-v4-flash` 是网页端模型名，原样发过去会 400。
// 第三方 OpenAI 兼容端点则继续沿用旧行为（留空 → deepseek-v4-flash）。

const OFFICIAL_MODEL = 'deepseek-chat';
const FALLBACK_MODEL = 'deepseek-v4-flash';

function isOfficialDeepSeek(baseUrl) {
  return String(baseUrl || '').toLowerCase().indexOf('api.deepseek.com') >= 0
}

/**
 * @param {string} baseUrl 用户填写的服务地址
 * @param {string} modelId 设置里的模型 ID（可能为空或旧默认值）
 * @returns {string} 实际发送给端点的模型名
 */
function resolveModel(baseUrl, modelId) {
  const custom = String(modelId || '').trim();
  if (isOfficialDeepSeek(baseUrl)) {
    // 留空或仍是旧默认值 → 官方模型名
    if (!custom || custom === FALLBACK_MODEL) return OFFICIAL_MODEL
    return custom
  }
  return custom || FALLBACK_MODEL
}

// OpenAI 兼容客户端（流式 SSE；应用侧始终走 chatStream）。

const apiUrl = apiUrl$1;
const stripInternalTags = stripInternalTags$1;

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

// 模型模式。
//
// 2026-09-12 官方公告"快速、专家、识图模式已合并升级"：new.jsonl 的
// client/settings?scope=model 实证 expert / vision 已 enabled:false，
// 只剩 model_type="default"，且它 file_feature.vision=true —— 也就是说
// 同一个模型同时具备日常对话、图片理解、复杂问题求解，图片/思考/联网都是开关。
// 因此这里只保留一个模式，且它允许携带图片（vision: true）。
// 旧的 'expert' / 'vision' 仅保留为别名，把历史会话映射到 default，不再展示。
const MODES = [
  { key: 'fast', label: '智能模式', model: 'deepseek-default', vision: true }
];

// 历史会话里可能存着 expert / vision，统一折叠到唯一模式
const LEGACY_MODE_KEYS = ['expert', 'vision'];

function getMode(key) {
  if (LEGACY_MODE_KEYS.indexOf(key) >= 0) return MODES[0]
  return MODES.find((m) => m.key === key) || MODES[0]
}

// 移除模型回复中可能泄露的内部协议标签，防止发给 DeepSeek 官方 API 或展示给用户导致封号。
// 注意：标签替换为空串，且只折叠水平空白（[ \t]），不能吞掉换行——
// 旧版 /\s{2,}/g 会把模型的空行/段落分隔符一并压成空格，导致换行丢失（#14）。
// stripInternalTags / collapseOutsideFences 已抽到 ds-text.js（文件顶部转发导出）

// 把应用内消息转成 OpenAI messages；跳过占位/错误消息；图片按需转 data URL。
// assistant 内容在发送前清洗内部协议标签，避免把 <|begin_of_function|> 等标记
// 回传给 DeepSeek 官方 API 触发风控（与返回时的 stripInternalTags 双向保障）。
async function buildMessages(messages, systemPrompt) {
  const list = [];
  if (systemPrompt) list.push({ role: 'system', content: systemPrompt });

  // 文件只随最后一条用户消息发送：DeepSeek 会话内会记住已上传文件，
  // 历史里的 file part 重复提交会造成冗余上传；换设备恢复后以最近一次附件为准。
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') { lastUserIndex = i; break }
  }

  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.pending || m.error) continue
    if (m.role === 'assistant') {
      list.push({ role: 'assistant', content: stripInternalTags(m.content || '') });
    } else {
      const images = m.images || [];
      const files = mi === lastUserIndex ? (m.files || []) : [];
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of images) {
        // 缓存 dataUrl：同一张图只压缩/base64 一次，避免多轮对话重复处理累积内存
        if (!img.dataUrl) {
          img.dataUrl = await readImageDataUrl(img.path);
        }
        if (img.dataUrl) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      for (const f of files) {
        // dataUrl 只作为运行期缓存；落盘前由 store.stripImagePayloads 一并清掉。
        if (!f.dataUrl) {
          f.dataUrl = await readLocalFileDataUrl(f.path, f.name);
        }
        if (f.dataUrl) {
          parts.push({
            type: 'file',
            file: { filename: f.name, file_data: f.dataUrl }
          });
        }
      }
      if (parts.length === 0) {
        list.push({ role: 'user', content: m.content || '' });
      } else if (parts.length === 1 && parts[0].type === 'text') {
        list.push({ role: 'user', content: parts[0].text });
      } else {
        list.push({ role: 'user', content: parts });
      }
    }
  }
  return list
}

class DsError extends Error {
  constructor(code, message, raw) {
    super(message);
    this.code = code;
    this.raw = raw;
  }
}

// 错误来源前缀：内置服务网关在 error.scope 里区分错误产生方
// （gateway=网关自身，upstream=真实上游透传，见服务端 sendError）。
// 设备字体无 emoji，只用全角括号文字。
function scopePrefix(e) {
  const s = e && e.scope;
  if (s === 'upstream') return '【上游错误】';
  if (s === 'gateway') return '【网关错误】';
  return '';
}

// curl 的裸报错对用户没有信息量；把最常见的两类本地文件失败映射成可读文案。
// 「no URL specified!」= curl -K 配置文件为空/缺失 —— 上游 writeFile 静默失败的直接后果。
function friendlyCurlError(msg) {
  const t = String(msg || '');
  if (t.indexOf('no URL specified') >= 0) return '请求初始化失败（本地请求文件写入异常），请重试；若反复出现请通过意见反馈上报日志';
  if (t.indexOf("couldn't open file") >= 0) return '请求内容文件读取失败（本地存储异常），请重试；若反复出现请通过意见反馈上报日志';
  return t;
}

/**
 * 把一次 401/403 翻译成"该去修哪里"的提示（见 probeBackend 的成因说明）。
 * 只在真的收到鉴权失败状态码时调用——正常路径不产生额外请求。
 * paired=true（设备配对模式）时引导去刷新/重新配对，而不是"检查 API Key"——
 * 那个模式下根本没有 API Key 参与鉴权。
 */
async function describeAuthFailure({ authMode, baseUrl, apiKey, statusCode, payload, paired = false }) {
  const apiMsg = payload && payload.error && (payload.error.code || payload.error.message);
  {
    const pairHint = paired ? '（设备令牌可能已过期或被吊销：请到设置页「刷新令牌」或「重新配对」）' : '';
    return '服务端返回 ' + statusCode + '（未授权）：请检查服务地址与 API Key' + pairHint +
      (apiMsg ? '（' + apiMsg + '）' : '')
  }
}

/**
 * 云端会话是 ds-free-api 的私有扩展（/v1/cloud-sessions），标准 OpenAI 兼容端点没有。
 * 账号登录模式暂停后不再有本机后端，这些接口只保留代码、运行期明确拒绝，
 * 避免请求打到用户填写的第三方端点而产生 404/误导性报错。
 */
function assertCloudSyncAvailable() {
  {
    throw new DsError('UNSUPPORTED', '账号登录模式已暂停：云端会话功能暂不可用')
  }
}

/**
 * 拉取云端会话列表（#10 同步已有对话）。
 * 后端 /v1/cloud-sessions → ds-free-api GET /chat_session/fetch_page（无 PoW，仅鉴权）。
 * 返回 [{ id, title, updated_at }]，仅会话元信息（消息内容需要额外的历史接口，暂不拉取）。
 */
async function listCloudSessions({ baseUrl, apiKey, authMode, timeout = 20000 }) {
  assertCloudSyncAvailable();
  const effectiveBaseUrl = (baseUrl || DEFAULT_BASE_URL);
  const url = apiUrl(effectiveBaseUrl, 'cloud-sessions');
  {
    const err = validateExternalUrl(url);
    if (err) {
      throw new DsError('BAD_URL', err)
    }
  }
  const headers = clientHeaders();
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const resp = await httpRequest({ url, method: 'GET', headers, timeout });
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
    const apiMsg = resp.data && resp.data.error && resp.data.error.message;
    throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode))
  }
  const list = resp.data && resp.data.data;
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
async function listRemoteModels({ baseUrl, apiKey, authMode = DEFAULT_AUTH_MODE, timeout = 20000, auth = null }) {
  const effectiveBaseUrl = (baseUrl || DEFAULT_BASE_URL);
  const base = String(effectiveBaseUrl || '').replace(/\/+$/, '');
  const v1Url = apiUrl(base, 'models');
  const candidates = /\/v1$/.test(base) ? [v1Url] : [v1Url, base + '/models'];

  let lastErr = null;
  for (const url of candidates) {
    {
      const err = validateExternalUrl(url);
      if (err) throw new DsError('BAD_URL', err)
    }
    // 鉴权头按最终 URL 现算：签名覆盖路径，两个候选 URL 的签名不同
    const headers = clientHeaders();
    if (isPaired(auth)) {
      headers['Authorization'] = 'Bearer ' + auth.deviceToken;
      Object.assign(headers, pairedAuthHeaders(auth, 'GET', url, ''));
    } else if (apiKey) {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }
    const resp = await httpRequest({ url, method: 'GET', headers, timeout });
    if (resp.statusCode === 0) {
      throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络与服务地址')
    }
    if (resp.statusCode === 404) {
      lastErr = new DsError('HTTP_404', '接口不存在（已尝试 ' + candidates.join('、') + '）：请确认服务地址是否为 OpenAI 兼容端点');
      continue
    }
    if (resp.statusCode === 401 || resp.statusCode === 403) {
      throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
        authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data, paired: !!auth
      }))
    }
    if (resp.statusCode >= 400) {
      const apiMsg = resp.data && resp.data.error && resp.data.error.message;
      throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode))
    }
    const list = resp.data && resp.data.data;
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
async function listCloudSessionMessages({ baseUrl, apiKey, authMode, sessionId, timeout = 20000, auth = null }) {
  assertCloudSyncAvailable();
  const effectiveBaseUrl = (baseUrl || DEFAULT_BASE_URL);
  const url = apiUrl(effectiveBaseUrl, 'cloud-sessions/' + encodeURIComponent(sessionId) + '/messages');
  {
    const err = validateExternalUrl(url);
    if (err) {
      throw new DsError('BAD_URL', err)
    }
  }
  const headers = clientHeaders();
  if (isPaired(auth)) {
    headers['Authorization'] = 'Bearer ' + auth.deviceToken;
    Object.assign(headers, pairedAuthHeaders(auth, 'GET', url, ''));
  } else if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey;
  }
  const resp = await httpRequest({ url, method: 'GET', headers, timeout });
  if (resp.statusCode === 0) {
    throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
      authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data, paired: !!auth
    }))
  }
  if (resp.statusCode >= 400) {
    const apiMsg = resp.data && resp.data.error && resp.data.error.message;
    throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode))
  }
  const list = resp.data && resp.data.data;
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
async function deleteCloudSession({ baseUrl, apiKey, authMode, sessionId, timeout = 20000, auth = null }) {
  assertCloudSyncAvailable();
  const effectiveBaseUrl = (baseUrl || DEFAULT_BASE_URL);
  const url = apiUrl(effectiveBaseUrl, 'cloud-sessions/' + encodeURIComponent(sessionId));
  {
    const err = validateExternalUrl(url);
    if (err) throw new DsError('BAD_URL', err)
  }
  const headers = clientHeaders();
  if (isPaired(auth)) {
    headers['Authorization'] = 'Bearer ' + auth.deviceToken;
    Object.assign(headers, pairedAuthHeaders(auth, 'POST', url, '{}'));
  } else if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey;
  }
  // 用 POST 而非 DELETE：笔端 Falcon http 模块不支持 DELETE（发出去得到 405），
  // 后端 /v1/cloud-sessions/{id} 同时接受 DELETE 与 POST（语义同官方 /chat_session/delete）。
  const resp = await httpRequest({ url, method: 'POST', headers, data: {}, timeout });
  if (resp.statusCode === 0) {
    throw new DsError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new DsError('HTTP_' + resp.statusCode, await describeAuthFailure({
      authMode, baseUrl, apiKey, statusCode: resp.statusCode, payload: resp.data, paired: !!auth
    }))
  }
  if (resp.statusCode >= 400) {
    const apiMsg = resp.data && resp.data.error && resp.data.error.message;
    throw new DsError('HTTP_' + resp.statusCode, apiMsg || mapHttpStatus(resp.statusCode))
  }
  return true
}

// ---------- 设备配对鉴权（防搬运，见 api-auth.js / api-pairing.js） ----------
//
// 普通模式（未配对）：Authorization: Bearer <apiKey>，与旧版行为完全一致。
// 配对模式：Bearer <deviceToken> + 每请求 HMAC 签名头（X-Ds-*）。
// 端点+Key 明文存在设备上，抠出来就能搭反代倒卖；配对模式把认证换成
// 短期设备令牌 + 签名，抓包拿走的凭证几小时即废，服务端还可按 deviceId 吊销。

// 配对模式下的鉴权头（http.js 普通请求用）。未配对返回 {}，调用方保持旧行为。

// ---------- 联网搜索工具（tool call 注入，两种端点模式统一） ----------
//
// 新架构（网关直连 DeepSeek 官方）下，搜索一律通过工具注入实现：
// 向请求注入 web_search / fetch_page 两个工具；模型发起 tool call 后，
// 执行统一走内置服务网关 /v1/tools/search|fetch——
// DeepSeek Search/Fetch 的 Key 只存服务端（tools.json），设备侧零密钥。
// （旧架构的 web_search_options 是 ds-free-api 私有协议，官方 API 不认识，
// 会导致搜索静默失效——已于 build 183 移除。）
// 协议与 DeepSeek 官方一致：
//   POST /v1/tools/search { query, count, ori_question, need_content }
//     → { results: [{ title, url, snippet, summary, content, date, site_name, authority }] }
//   POST /v1/tools/fetch  { url }
//     → { title, content }

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网，返回结构化结果列表（标题、链接、日期、摘要）。需要实时信息、新闻、价格、资料核查等场景调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，1~128 个字符，支持 site: -site: "短语" lang: after: before: 等搜索语法' },
        count: { type: 'integer', description: '返回条数 1~20，默认 5' },
        need_content: { type: 'boolean', description: '是否返回网页正文，默认 false（摘要通常已足够）' }
      },
      required: ['query']
    }
  }
};

const FETCH_PAGE_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_page',
    description: '抓取指定网页，返回页面标题与 Markdown 正文。当用户给出具体链接、或搜索结果需要阅读全文时调用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页地址（http/https）' }
      },
      required: ['url']
    }
  }
};

// 工具轮数上限：最多执行 4 轮工具调用（每轮可含多个 tool call），防止无限循环搜索。
// 用尽后**不是直接结束**，而是摘掉 tools 再跑一轮"收尾轮"要最终答案——见循环内注释。
const MAX_TOOL_ROUNDS = 4;

// 联网能力说明：只把 tools 定义塞给模型是不够的——不少模型（GPT 系、带强安全
// 对齐的模型）坚持"我无法联网/没有实时信息"，哪怕 web_search 就在工具列表里。
// 自定义端点模式不经过内置服务网关，服务端注入帮不上忙，所以客户端自己补一份
// （文案与网关 TOOL_USE_DIRECTIVE 保持一致，两处同时命中也不会冲突）。
const SEARCH_CAPABILITY_PROMPT = '【联网能力】本次对话已开启联网工具：web_search（互联网搜索）与 fetch_page（抓取网页正文）。' +
  '当用户询问实时信息（新闻、天气、价格、股价、赛事、人物近况等）、需要核实事实，或你对答案没有把握时，' +
  '必须先调用 web_search 检索（必要时用 fetch_page 读取全文），再基于检索结果回答。' +
  '严禁声称自己无法联网、没有联网权限或无法访问实时信息；也不要把没检索到的内容说成是检索结果。';

// 把能力说明拼进首条 system；没有 system 就新建一条（不追加第二条 system，
// 部分 OpenAI 兼容端点只接受首条 system）。
function injectSearchCapability(list) {
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m && m.role === 'system') {
      const prev = typeof m.content === 'string' ? m.content : '';
      list[i] = Object.assign({}, m, { content: prev ? prev + '\n\n' + SEARCH_CAPABILITY_PROMPT : SEARCH_CAPABILITY_PROMPT });
      return
    }
  }
  list.unshift({ role: 'system', content: SEARCH_CAPABILITY_PROMPT })
}

// 收尾轮要摘掉 tools：能力说明必须一起摘，否则模型会"说要搜"却没有工具可用
function removeSearchCapability(list) {
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== 'system' || typeof m.content !== 'string') continue
    if (m.content.indexOf(SEARCH_CAPABILITY_PROMPT) < 0) continue
    const cleaned = m.content.split('\n\n' + SEARCH_CAPABILITY_PROMPT).join('').split(SEARCH_CAPABILITY_PROMPT).join('').trim();
    if (!cleaned) list.splice(i, 1);
    else list[i] = Object.assign({}, m, { content: cleaned });
    return
  }
}

// 收尾轮指令：工具轮数用尽后逼模型落地成回答。
// 用 user 角色而不是 system：部分 OpenAI 兼容端点只接受首条 system，中途插 system 会 400；
// 「连续两条 user」在主流实现里都能接受。该消息只存在于本次请求的 wireMessages，不落盘。
const FINAL_ANSWER_INSTRUCTION = '（联网工具调用次数已用完，不能再调用任何工具）请立刻基于上面已经获得的搜索结果，直接给出完整、有条理的回答；信息不足就说明缺什么，不要继续检索。';

function formatSearchResults(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return '（搜索完成，但没有找到相关结果。请基于已有知识回答，并告知用户未搜索到结果。）'
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const part = [];
    part.push('[' + (i + 1) + '] ' + String(r.title || '(无标题)'));
    if (r.url) part.push('链接: ' + r.url);
    const meta = [];
    if (r.site_name) meta.push(String(r.site_name));
    if (r.date) meta.push(String(r.date).slice(0, 10));
    if (meta.length) part.push('来源: ' + meta.join(' · '));
    const summary = String(r.summary || r.snippet || '').trim();
    if (summary) part.push('摘要: ' + summary);
    const content = String(r.content || '').trim();
    if (content) part.push('正文: ' + content.slice(0, 4000));
    lines.push(part.join('\n'));
  }
  return lines.join('\n\n')
}

/**
 * 执行一次工具调用（统一走内置服务网关，见 cloud-control.callWebTool）。
 * 失败不抛出：把错误作为工具结果文本回给模型，让它优雅降级继续回答。
 * 返回 { text, count, title }：text 是回给模型的文本；count/title 供 UI
 * 工具卡片展示（搜索结果条数、实际执行的搜索词/URL）。
 */
async function executeWebToolCall(name, argsText, ctx) {
  let args = null;
  const raw = String(argsText || '').trim();
  if (raw) {
    try {
      const v = JSON.parse(raw);
      args = v && typeof v === 'object' ? v : null;
    } catch (e) {
      args = null;
    }
  }
  if (args === null) {
    return { text: '（工具参数不是合法 JSON，无法执行。请直接基于已有知识回答。）' }
  }
  try {
    if (name === 'web_search') {
      const query = String(args.query || '').trim();
      if (!query) return { text: '（缺少搜索词 query，无法搜索。）' }
      const payload = {
        query: query.slice(0, 128),
        count: Math.min(Math.max(Math.trunc(Number(args.count) || 5), 1), 20),
        need_content: args.need_content === true
      };
      const data = await callWebTool({
        settings: ctx.settings,
        persist: ctx.persistSettings,
        kind: 'search',
        payload,
        timeout: 30000
      });
      const list = Array.isArray(data && data.results) ? data.results : [];
      return { text: formatSearchResults(data && data.results), count: list.length, title: payload.query }
    }
    if (name === 'fetch_page') {
      const url = String(args.url || '').trim();
      if (!url) return { text: '（缺少要抓取的网页地址 url。）' }
      const data = await callWebTool({
        settings: ctx.settings,
        persist: ctx.persistSettings,
        kind: 'fetch',
        payload: { url: url.slice(0, 8192) },
        timeout: 45000
      });
      const title = String((data && data.title) || '').trim();
      let content = String((data && data.content) || '').trim();
      if (!content) return { text: '（网页抓取失败或正文为空。请基于已有知识回答。）', title: url }
      if (content.length > 8000) content = content.slice(0, 8000) + '\n…（正文过长已截断）';
      return { text: (title ? '标题: ' + title + '\n\n' : '') + content, title: title || url }
    }
    return { text: '（未知工具 ' + name + '，只能使用 web_search 与 fetch_page。）' }
  } catch (e) {
    // 搜索/抓取失败会让模型"凭空回答"，用户看到的是搜索结果空——必须留一条现场
    appLogError('tool.' + name, e);
    return { text: '（联网搜索暂不可用：' + ((e && e.message) || '未知错误') + '。请基于已有知识回答，并告知用户搜索功能暂时不可用。）' }
  }
}

async function chatStream(opts, handlers = {}) {
  const { baseUrl, apiKey, modeKey, messages, thinking, search, timeout = 300000, authMode = DEFAULT_AUTH_MODE, backendMode = '', modelId = '', conversationId = '', auth = null, settings = null, persistSettings = null } = opts;
  const isCancelled = handlers.isCancelled || function () { return false };
  getMode(modeKey);
  const upstream = isUpstreamMode(backendMode);
  const effectiveBaseUrl = upstream
      ? String(baseUrl || UPSTREAM_BASE_URL || '').trim()
      : (baseUrl || DEFAULT_BASE_URL);

  if (!effectiveBaseUrl && !isBuiltinMode()) {
    throw new DsError('BAD_URL', '尚未配置「内置服务」地址：请到设置页填写或联系发布者预置')
  }
  const url = apiUrl(effectiveBaseUrl, 'chat/completions');

  {
    const err = validateExternalUrl(url);
    if (err) {
      throw new DsError('BAD_URL', err)
    }
  }

  // 上游模式：设备凭证由静默注册获得，用户不需要做任何配置。
  // 走到这里说明注册没成功（多半是断网/服务不可达），给出可重试的提示即可。
  const paired = isPaired(auth);
  if (upstream && !paired) {
    throw new DsError('NOT_PAIRED', '暂时连不上「内置服务」：请检查网络后重试（设备会自动注册，无需任何配置）')
  }

  // 内置端点始终用模式默认模型（deepseek-*，走 ds-free-api 账号池）；
  // 上游模式留空则不传 model，由网关注入它配置的默认模型（provider.modelMap 可改名）；
  // 自定义端点优先用设置的自定义模型 ID，留空 / 官方 API 的网页端模型名自动纠正。
  let model = '';
  if (upstream) model = String(modelId || '').trim();
  else model = resolveModel(effectiveBaseUrl, modelId);

  // 思考挡位：字符串挡位直传（low/medium/high/xhigh/max/minimal）；
  // 遗留布尔 true/false 与空值按当前模型的挡位表折算（见 thinking-levels.js）。
  // reasoning_effort 是标准 OpenAI 字段，不支持的实现只会忽略它。
  const effortLevel = normalizeThinkingLevel(modelId || model, thinking);
  if (effortLevel !== 'none') {
    // 每次请求都会走到这里，属于明细而不是事件：只在「启用调试日志」时落盘
    debugLog('[ds] reasoning_effort=' + effortLevel + ' (model=' + (model || '服务端默认') + ')');
  }

  // 联网搜索实现方式（新架构，两种端点模式行为一致）：
  // 统一向模型注入 web_search / fetch_page 工具（useToolSearch），模型发起
  // tool call 后由 executeWebToolCall 走内置服务网关 /v1/tools/search|fetch
  // 执行并回填（搜索服务配置在服务端 tools.json，设备侧零密钥）。
  // 旧架构的 web_search_options 是 ds-free-api 私有协议——网关直连 DeepSeek
  // 官方后官方不认识该字段，搜索会静默失效，必须走工具注入。
  const useToolSearch = search === true;

  // 工具循环要向消息列表追加 assistant(tool_calls)/tool 消息：
  // 复制一份，避免改调用方的数组。
  const wireMessages = messages.slice();
  const body = { messages: wireMessages, stream: true };
  if (model) body.model = model;
  // 会话标识：后端据此做持久会话复用（历史由 DeepSeek 服务端持有，不再上传历史文件）
  if (conversationId) body.user = String(conversationId);
  body.reasoning_effort = effortLevel;
  if (useToolSearch) {
    // tools 定义 + 能力说明一起给：只有定义时模型经常"抱着工具说上不了网"
    injectSearchCapability(wireMessages);
    body.tools = [WEB_SEARCH_TOOL, FETCH_PAGE_TOOL];
    body.tool_choice = 'auto';
  }

  // 跨轮累计：最终回答 = 各轮 content/reasoning 拼接（工具轮一般只有少量前置文本）
  let content = '';
  let reasoning = '';
  let dsTitle = null;
  let dsSessionId = null;
  // 已执行的工具轮数（只统计真的调了工具的轮次）与"是否已请求收尾轮"。
  // 两者分开：收尾轮摘掉 tools 后，即使模型仍凭空吐出 tool_calls 也不会再无限续搜。
  let toolRounds = 0;
  let finalAnswerAsked = false;

  // ---------- 工具循环 ----------
  // 每轮：起一个独立 curl（新 token/文件）→ 轮询解析 SSE → 若模型发起
  // tool call 且还有轮数配额，执行工具（走内置服务网关）→ 回填消息重发。
  for (let round = 1; ; round++) {
    const token = 'dsstream_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    const reqFile = joinPath(dataDirBase(), token + '.req.json');
    const outFile = joinPath(dataDirBase(), token + '.out.txt');
    const cfgFile = joinPath(dataDirBase(), token + '.cfg');

    if (isCancelled()) {
      throw new DsError('CANCELLED', '已停止')
    }

    const bodyText = JSON.stringify(body);
    // 写失败必须挡下：req 文件空 → curl「couldn't open file」；cfg 文件空 → curl
    //「no URL specified!」（真机确认的根因，个别机型 fs.writeFile 静默失败）。
    if (!await writeFileRetry(reqFile, bodyText)) {
      appLog('[chat] 请求体写入失败 path=' + reqFile);
      throw new DsError('NETWORK', '请求内容写入失败（本地存储异常）：请求未发出，请重试')
    }

    // 配对模式：令牌/签名头走 curl -K 配置文件（不进进程列表），并可按设置锁定 TLS 证书。
    // 普通模式：命令行 -H，与旧版完全一致（apiKey 为空时连 Authorization 都不发）。
    let cmd;
    if (paired) {
      const sig = signRequest({
        method: 'POST',
        path: urlPath(url),
        body: bodyText,
        deviceId: auth.deviceId,
        secret: auth.signSecret,
        ts: Date.now(),
        nonce: randomHex(16)
      });
      const cfg = buildCurlConfig({
        url,
        reqFile,
        deviceToken: auth.deviceToken,
        sigHeaders: sig.headers,
        tlsPin: auth.tlsPin || ''
      });
      if (!await writeFileRetry(cfgFile, cfg)) {
        appLog('[chat] 请求配置写入失败 path=' + cfgFile);
        throw new DsError('NETWORK', '请求配置写入失败（本地存储异常）：请求未发出，请重试')
      }
      cmd = 'curl -s -N -m ' + Math.ceil(timeout / 1000) + ' -K ' + shq(cfgFile) + ' > ' + shq(outFile) + ' 2>&1 &';
    } else {
      cmd = 'curl -s -N -m ' + Math.ceil(timeout / 1000) + ' -X POST';
      cmd += ' -H "Content-Type: application/json"';
      // 客户端标识：服务端（尤其是上游网关）用它区分本 App 与脚本/反代
      cmd += ' -H "X-Ds-Client: ' + clientHeaders()['X-Ds-Client'] + '"';
      if (apiKey) {
        // API Key 只做简单清洗，避免破坏 shell 引号
        cmd += ' -H "Authorization: Bearer ' + String(apiKey).replace(/["\\]/g, '') + '"';
      }
      cmd += ' -d @' + shq(reqFile) + ' ' + shq(url) + ' > ' + shq(outFile) + ' 2>&1 &';
    }
    execShell(cmd);
    if (handlers.onToken) handlers.onToken(token);

    let buffer = '';
    let lastLen = 0;
    let roundContent = '';
    let roundReasoning = '';
    let roundTitle = null;
    let roundSessionId = null;
    let roundFinishReason = '';
    const toolAcc = [];
    let done = false;
    let raw = null;
    const start = Date.now();

    try {
      // 事件处理抽成闭包：finish 之后还可能跟着 usage / ds_title / ds_session_id 等
      // 尾随 chunk（空 choices），它们到达时往往已在本批次之外——循环退出后要再读一次，
      // 否则这些尾巴会被丢掉（会话 id 丢了，同步就会重复导入，bug 3）。
      const handleEvents = (events) => {
        let badSse = 0;
        for (let i = 0; i < events.length; i++) {
          const data = events[i];
          if (data === '[DONE]') {
            done = true;
            continue
          }
          let obj = null;
          try {
            obj = JSON.parse(data);
          } catch (e) {
            // 畸形 chunk 被跳过会让回复少一段，以前完全无痕；只记前 3 条避免刷屏
            if (badSse < 3) {
              badSse++;
              appLog('[chat] SSE 解析失败（已跳过 ' + badSse + ' 条）：' + String(data).slice(0, 120));
            }
            continue
          }
          if (obj && obj.error) {
            // 上游限流用独立错误码，调用方据此停止自动续发（bug 1）
            const errCode = String(obj.error.code || '');
            if (isRateLimitCode(errCode) || isRateLimitText(obj.error.message)) {
              const err = new DsError('RATE_LIMITED', scopePrefix(obj.error) + mapApiError(obj), obj.error);
              err.rateLimited = true;
              throw err
            }
            throw new DsError('API', scopePrefix(obj.error) + mapApiError(obj), obj.error)
          }
          // DeepSeek 自动生成的会话标题（会话首条消息时下发，#9）
          if (obj && obj.ds_title) {
            roundTitle = obj.ds_title;
            continue
          }
          // 本对话的云端会话 id（后端在流末尾以尾随 chunk 下发，用于同步去重）
          if (obj && obj.ds_session_id) {
            roundSessionId = obj.ds_session_id;
            continue
          }
          const choice = obj && obj.choices && obj.choices[0];
          if (!choice) continue
          // 个别中转在 stream:true 下仍回非流式分片（choice.message 而非 delta）。
          // 旧代码只看 delta，会把整段回答连同 tool_calls 一起丢掉——用户看到空回复。
          const delta = choice.delta || choice.message || {};
          // 思考内容字段名不统一：DeepSeek 官方是 reasoning_content，部分中转
          // （new-api 系）会改叫 reasoning，或把两者都带上（内容相同）。优先取
          // reasoning_content，取不到再看 reasoning，避免同一段被拼两遍。
          const thinkDelta = (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
            ? delta.reasoning_content
            : ((typeof delta.reasoning === 'string' && delta.reasoning) ? delta.reasoning : '');
          if (thinkDelta) {
            roundReasoning += thinkDelta;
            if (handlers.onReasoning) handlers.onReasoning(thinkDelta, roundReasoning);
          }
          if (delta.content) {
            roundContent += delta.content;
            if (handlers.onDelta) handlers.onDelta(delta.content, roundContent);
          }
          // 工具调用分片：流式下 arguments 按小块到达，按 index 聚合
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : toolAcc.length;
              let slot = toolAcc[idx];
              if (!slot) slot = toolAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) slot.id = tc.id;
              if (tc.type) slot.type = tc.type;
              const fn = tc.function || {};
              if (fn.name) slot.function.name += fn.name;
              if (fn.arguments) slot.function.arguments += fn.arguments;
            }
          }
          if (choice.finish_reason) {
            done = true;
            roundFinishReason = choice.finish_reason;
          }
        }
      };

      while (!done && !isCancelled() && Date.now() - start < timeout) {
        await sleep(200);
        raw = await readFile(outFile);
        if (raw) {
          const txt = String(raw);
          if (txt.length < lastLen) {
            // 文件被清理/重建时重置
            buffer = '';
            lastLen = 0;
          }
          const chunk = txt.slice(lastLen);
          lastLen = txt.length;
          buffer += chunk;

          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          handleEvents(parsed.events);
        }

        // curl 已把错误信息写进文件且没有任何 SSE 数据时，提前结束而不是傻等超时
        if (!done && Date.now() - start > 5000 && raw) {
          const txt = String(raw);
          if (txt.indexOf('data:') < 0) {
            if (txt.indexOf('curl:') >= 0) {
              const curlMsg = txt.replace(/^curl:\s*/, '').split('\n')[0] || '无法连接服务器，请检查服务地址';
              appLog('[chat] curl 失败 ' + curlMsg.slice(0, 200));
              throw new DsError('NETWORK', friendlyCurlError(curlMsg))
            }
            // 某些后端在 stream:true 下仍可能直接返回 JSON 错误（curl -s 不保留
            // HTTP 状态码，所以从 body 里的 '{' 起尝试解析，不再要求首字符是 '{'）
            const trimmed = txt.trim();
            const brace = trimmed.indexOf('{');
            if (brace >= 0) {
              let obj = null;
              try {
                obj = JSON.parse(trimmed.slice(brace));
              } catch (e) {
                obj = null;
                // 服务端返回了非 JSON 的错误页/网关页：原文是唯一线索
                appLog('[chat] 响应不是合法 JSON：' + trimmed.slice(0, 200).replace(/\s+/g, ' '));
              }
              if (obj && obj.error) {
                const errCode = String(obj.error.code || '');
                // 鉴权类错误同样要走成因诊断：本机后端 key 失配 / 账号池为空 / 真被封；
                // 配对模式的验签失败码（docs/api-auth-protocol.md）一并纳入
                if (/invalid_api_token|authentication_error|unauthorized|signature_mismatch|device_token_expired|invalid_device_token|device_not_paired|nonce_replay|timestamp_out_of_window|missing_auth_headers/i.test(errCode)) {
                  throw new DsError('HTTP_401', await describeAuthFailure({
                    authMode, baseUrl, apiKey, statusCode: 401, payload: obj, paired: !!auth
                  }))
                }
                // 上游限流用独立错误码，调用方据此停止自动续发（bug 1）
                if (isRateLimitCode(errCode) || isRateLimitText(obj.error.message)) {
                  const err = new DsError('RATE_LIMITED', scopePrefix(obj.error) + mapApiError(obj), obj.error);
                  err.rateLimited = true;
                  throw err
                }
                throw new DsError('API', scopePrefix(obj.error) + mapApiError(obj), obj.error)
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
      let stableReads = 0;
      for (let i = 0; i < 5 && stableReads < 2; i++) {
        await sleep(200);
        try {
          const tailRaw = await readFile(outFile);
          const txt = tailRaw ? String(tailRaw) : '';
          if (txt.length === lastLen) {
            stableReads++;
            continue
          }
          if (txt.length < lastLen) {
            // 文件被清理/重建：忽略残余，避免尾部重放
            continue
          }
          stableReads = 0;
          const chunk = txt.slice(lastLen);
          lastLen = txt.length;
          if (chunk) {
            const parsed = parseSse(buffer + chunk);
            buffer = parsed.rest;
            handleEvents(parsed.events);
          }
        } catch (e) { debugLog('[chat] 补读尾随 chunk 失败：' + (e && e.message ? e.message : String(e))) }
      }

      // 聚合本轮工具调用（保证 id/类型字段完整）
      const toolCalls = [];
      for (const slot of toolAcc) {
        if (!slot || !slot.function || !slot.function.name) continue
        toolCalls.push({
          id: slot.id || ('call_' + toolCalls.length + '_' + Date.now().toString(36)),
          type: 'function',
          function: { name: slot.function.name, arguments: slot.function.arguments || '' }
        });
      }

      content += roundContent;
      reasoning += roundReasoning;
      if (!dsTitle && roundTitle) dsTitle = roundTitle;
      if (!dsSessionId && roundSessionId) dsSessionId = roundSessionId;

      // 模型发起工具调用 → 执行工具后进入下一轮；但轮数配额用尽时必须"落地"：
      // 旧实现在这里直接 break，模型刚发起的 tool_calls 既没执行、也没有后续请求，
      // 用户看到的是「我来搜索…」几行 + 搜索卡片后就再也没有回复（联网搜索后断流）。
      const wantsTools = useToolSearch && toolCalls.length > 0;
      if (!wantsTools || isCancelled()) {
        // 兜底：工具已经搜过几轮，模型这一轮却什么都没说（空 content）——
        // 再要一轮"直接作答"，否则用户看到搜索卡片之后就断流了。
        if (!wantsTools && !isCancelled() && !roundContent && toolRounds > 0 && !finalAnswerAsked) {
          finalAnswerAsked = true;
          delete body.tools;
          removeSearchCapability(wireMessages);
          wireMessages.push({ role: 'user', content: FINAL_ANSWER_INSTRUCTION });
          appLog('[ds] 工具轮后回复为空，追加收尾轮要求直接作答');
          continue
        }
        break
      }

      // 配额已经用完（收尾轮摘掉 tools 后模型仍凭空吐 tool_calls）：不能再续，直接结束，
      // 否则会每轮追加消息跑成死循环。
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        appLog('[ds] 收尾轮仍返回 tool_calls，停止续搜');
        break
      }
      toolRounds += 1;

      wireMessages.push({ role: 'assistant', content: roundContent || '', tool_calls: toolCalls });
      for (const tc of toolCalls) {
        // 工具卡片事件（UI 直观展示「进行了一次搜索」）：start 时 UI 追加
        // running 卡片，done 时按 title 更新为完成态（结果条数 + 耗时）。
        // 旧的 onToolStatus 纯文本已被卡片替代，不再调用。
        const isFetch = tc.function.name === 'fetch_page';
        let argsPreview = null;
        try { const v = JSON.parse(String(tc.function.arguments || '')); argsPreview = v && typeof v === 'object' ? v : null; } catch (e) { argsPreview = null; }
        const evTitle = argsPreview ? String((isFetch ? argsPreview.url : argsPreview.query) || '').trim().slice(0, 80) : '';
        if (handlers.onToolCall) handlers.onToolCall({ phase: 'start', kind: isFetch ? 'fetch' : 'search', title: evTitle });
        const t0 = Date.now();
        const tr = await executeWebToolCall(tc.function.name, tc.function.arguments, { settings, persistSettings });
        wireMessages.push({ role: 'tool', tool_call_id: tc.id, content: tr.text });
        if (handlers.onToolCall) handlers.onToolCall({ phase: 'done', kind: isFetch ? 'fetch' : 'search', title: tr.title || evTitle, count: tr.count || 0, durationMs: Date.now() - t0 });
      }

      // 最后一轮工具之后：摘掉 tools 并明确要求直接作答，再跑一轮拿最终答案。
      // 模型在联网场景里经常"再查一条"停不下来（实测 4 轮全是 tool_calls），
      // 只有去掉工具 + 一句硬指令才能保证用户拿到答案而不是半截旁白。
      if (toolRounds >= MAX_TOOL_ROUNDS && !finalAnswerAsked) {
        finalAnswerAsked = true;
        delete body.tools;
        removeSearchCapability(wireMessages);
        wireMessages.push({ role: 'user', content: FINAL_ANSWER_INSTRUCTION });
        appLog('[ds] 工具轮数用尽（' + toolRounds + ' 轮），去掉 tools 请求最终回答');
      }
      // 下一轮 body 重新序列化（wireMessages 已追加工具结果）
    } finally {
      stopStream(token);
      try { execShell('rm -f ' + shq(reqFile) + ' ' + shq(outFile) + ' ' + shq(cfgFile) + ' || true'); } catch (e) { /* 忽略 */ }
    }
  }

  // 思考已要求但流里没有 reasoning：责任在模型/服务端，日志留证（诊断日志可查），
  // 免得用户反复怀疑是客户端没渲染。
  if (!reasoning && effortLevel !== 'none') {
    // 每个回复都可能触发，属明细；只有排查"思考内容丢失"时才需要
    debugLog('[ds] 本次未收到 reasoning_content（model=' + (model || '服务端默认') + '）');
  }

  return { content: stripInternalTags(content), reasoning: stripInternalTags(reasoning), dsTitle, dsSessionId, finishReason: 'stop', usage: null }
}


export { DEFAULT_BASE_URL, DsError, FALLBACK_MODEL, LEGACY_MODE_KEYS, MODES, OFFICIAL_MODEL, apiUrl, apiUrl$1, assertCloudSyncAvailable, buildMessages, chatStream, collapseOutsideFences, deleteCloudSession, describeAuthError, describeAuthFailure, getMode, isAccountSuspension, isOfficialDeepSeek, isRateLimitCode, isRateLimitText, isRateLimitedError, listCloudSessionMessages, listCloudSessions, listRemoteModels, mapApiError, mapHttpStatus, parseSse, resolveModel, stripInternalTags, stripInternalTags$1 };
