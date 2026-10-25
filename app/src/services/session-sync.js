import { validateExternalUrl, clientHeaders, httpRequest, isPaired, signRequest, urlPath, randomHex, pushSession, deleteRemoteSession, purgeRemoteSessions, listRemoteSessions, fetchRemoteSession, ensureUpstreamAuth, upstreamBase } from './cloud-control.js';
import { readdir, mkdir, dataDirBase, joinPath, exists, statSize, shq, execShell, waitForFile, sleep, isBuiltinMode, DEFAULT_AUTH_MODE, isUpstreamMode, UPSTREAM_BASE_URL, writeFile, readFile, stopStream, appLog, uid$1 as uid, normalizeMessages } from './store.js';

// 相册图片：用 import fs 直接读 /userdisk/Pictures（真机已验证可读），

const ALBUM = '/userdisk/Pictures';
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];

// 压缩目标：最长边 512px、JPEG 质量 3（ffmpeg -q:v 2-31，越小越好），
// 单图 base64 后约几十 KB，足够 DeepSeek 识图且不撑爆 QuickJS 内存。
function ext(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''
}

// 单图硬上限：压缩产物超过这个体积就不参与发送。
// 设备只有 ~1GB 内存，data URL 还要再涨 1/3；历史上"大图撑爆 QuickJS 导致设备
// 卡死/重启"就是这么来的（见文件头注释）。注意压缩失败时 compressImage 会
// 回落到原图路径（常见好几 MB），这里必须拦，宁可不发也不能把设备搞挂。
const MAX_IMAGE_BYTES = 900 * 1024;
const MAX_BASE64_CHARS = 1280 * 1024;

// 相册缩略图是串行生成的，但用户可以在转换中途进入相机。
// 保存每个 ffmpeg 的 pid 文件，以便切换页面时精确终止当前任务，
// 不用 pkill 全局 ffmpeg。
let thumbGeneration = 0;
const activeThumbJobs = new Set();

function stopThumbJob(pidFile) {
  execShell(
    'if [ -s ' + shq(pidFile) + ' ]; then kill -TERM "$(cat ' + shq(pidFile) + ')" 2>/dev/null || true; fi; rm -f ' +
      shq(pidFile) + ' 2>/dev/null || true'
  );
}

function cancelThumbJobs() {
  thumbGeneration += 1;
  for (const pidFile of activeThumbJobs) stopThumbJob(pidFile);
}

function isImage(name) {
  return IMAGE_EXTS.indexOf(ext(name)) >= 0
}

/**
 * 列出相册图片，返回 [{ name, path }]。
 */
async function listAlbum() {
  const names = await readdir(ALBUM);
  if (!Array.isArray(names)) {
    throw new Error('无法访问相册 /userdisk/Pictures')
  }
  return names
    .filter((n) => isImage(n))
    .map((n) => ({ name: n, path: ALBUM + '/' + n }))
}

// 把源路径映射成稳定的压缩缓存名（djb2）：同一张图会被反复发送
// （重试 / 修改 / 多轮携带），命中缓存可省掉重复的 ffmpeg 调用。
function pathKey(p) {
  const s = String(p || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36)
}

/**
 * 为相册列表生成缩略图（256px），返回缩略图路径；失败返回原图路径。
 *
 * 必须用缩略图渲染列表：相册里是相机原图（12MP），几十张原图同时进入
 * image 解码队列会堵死渲染线程——真机表现为"相册浮层全黑"（连头部
 * 都画不出来）。缩略图按 djb2 缓存，重复打开不重做。
 */
async function ensureThumb(srcPath) {
  await mkdir(dataDirBase());
  const dst = joinPath(dataDirBase(), 'thumb_' + pathKey(srcPath) + '.jpg');
  if (await exists(dst) && (await statSize(dst)) > 0) return dst

  const okFile = dst + '.ok';
  const pidFile = dst + '.pid';
  const generation = thumbGeneration;
  activeThumbJobs.add(pidFile);
  const cmd =
    "( printf '%s\\n' \"$$\" > " + shq(pidFile) + '; ' +
    'ffmpeg -y -i ' + shq(srcPath) +
    ' -vf ' + shq('scale=256:256:force_original_aspect_ratio=decrease') +
    ' -q:v 5 ' + shq(dst) +
    ' > /dev/null 2>&1 & child=$!; ' +
    "trap 'kill -9 \"$child\" 2>/dev/null || true' TERM INT; " +
    'wait $child; rc=$?; if [ $rc -eq 0 ]; then echo done > ' + shq(okFile) + '; fi )';
  execShell(cmd);
  try {
    const ok = await waitForFile(okFile, 15000, () => generation !== thumbGeneration);
    if (generation !== thumbGeneration || ok === null) {
      stopThumbJob(pidFile);
      return srcPath
    }
    await sleep(80);
    return dst
  } finally {
    activeThumbJobs.delete(pidFile);
    execShell('rm -f ' + shq(okFile) + ' ' + shq(pidFile) + ' 2>/dev/null || true');
  }
}

/**
 * 压缩图片到 $dataDir 下的临时文件，返回压缩后的绝对路径；失败时返回原图路径。
 * 用 ffmpeg scale 到最长边 MAX_DIM 内，并转成 JPEG。
 */
async function compressImage(srcPath) {
  await mkdir(dataDirBase());
  const dst = joinPath(dataDirBase(), 'img_' + pathKey(srcPath) + '.jpg');
  if (await exists(dst) && (await statSize(dst)) > 0) return dst

  const okFile = dst + '.ok';
  const cmd = 'ffmpeg -y -i ' + shq(srcPath) +
    ' -vf ' + shq('scale=512:512:force_original_aspect_ratio=decrease') +
    ' -q:v 3 ' + shq(dst) +
    ' > /dev/null 2>&1; echo done > ' + shq(okFile);

  execShell(cmd);
  const ok = await waitForFile(okFile, 20000);
  execShell('rm -f ' + shq(okFile) + ' 2>/dev/null || true');
  if (ok === null) return srcPath
  await sleep(200);
  return dst
}

/**
 * 把本地图片转成 base64 data URL（先压缩）。execShell 无回显，故 base64 输出落盘后读回。
 * 超过体积上限（或压缩不可用导致回落到原图）时返回 null —— 调用方应据此提示用户，
 * 而不是把几 MB 的图片内联进消息（那是设备重启的已知诱因）。
 */
async function readImageDataUrl(path) {
  const compressed = await compressImage(path);
  // stat 取不到体积（个别机型 fs.stat 不可用）时放行，靠下面的 base64 长度二次拦截
  const size = await statSize(compressed);
  if (size > MAX_IMAGE_BYTES) return null

  const id = Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  const out = joinPath(dataDirBase(), 'b64_' + id + '.txt');

  // busybox base64 默认每 76 字符换行，JS 侧统一去空白即可。
  execShell('base64 ' + shq(compressed) + ' > ' + shq(out));

  const b64 = await waitForFile(out, 20000);
  if (b64 === null) return null
  execShell('rm -f ' + shq(out) + ' 2>/dev/null || true');

  const clean = String(b64).replace(/\s+/g, '');
  if (clean.length > MAX_BASE64_CHARS) return null

  const name = String(compressed).split('/').pop();
  const extName = ext(name);
  const mime = (extName === 'png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${clean}`
}

// 错误分类：把后端/上游的错误语义翻译成"应用该怎么做"。
//
// 单独成模块的理由：这些判定必须能在宿主机上单测（设备原生模块在 node 里 import
// 不了），而它们决定的是**要不要继续发请求**——判错会把用户账号送进禁言。
//
// 核心区分（bug 1）：
//   - 服务繁忙 / Overloaded：只是当前没有空闲账号，等一会自己会好，可以重试；
//   - 上游限流 / RateLimited：上游正在限这条链路，**继续重试会被判定为异常客户端
//     并升级为禁言**。必须明确告诉用户"等待，不要连点发送"，并且应用侧停止自动续发。

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

  // 上游网关（「我的上游」模式）的错误语义：必须给出可操作的处置，而不是笼统的“失败”
  if (code === 'device_blocked') {
    return '设备已被上游临时限制（可能触发防反代检测）：请稍后重试；若持续出现，请联系服务管理员解除'
  }
  if (code === 'client_header_required' || code === 'client_header_invalid') {
    return '客户端与上游版本不匹配：请升级 App 后重试'
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
    return '模型不可用，请检查模型配置'
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

  for (const m of messages) {
    if (m.pending || m.error) continue
    if (m.role === 'assistant') {
      list.push({ role: 'assistant', content: stripInternalTags(m.content || '') });
    } else {
      const images = m.images || [];
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of images) {
        // 缓存 dataUrl：同一张图只压缩/base64 一次，避免多轮对话重复处理累积内存
        if (!img.dataUrl) {
          img.dataUrl = await readImageDataUrl(img.path);
        }
        if (img.dataUrl) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
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
function pairedAuthHeaders(auth, method, url, body) {
  if (!isPaired(auth)) return {}
  const { headers } = signRequest({
    method,
    path: urlPath(url),
    body: body || '',
    deviceId: auth.deviceId,
    secret: auth.signSecret,
    ts: Date.now(),
    nonce: randomHex(16)
  });
  return headers
}

// 配对模式下 SSE 走 curl -K 配置文件而非命令行 -H：
// 命令行的参数会出现在设备进程列表里（ps 可见），等于把令牌/密钥摊开。
// 配置文件与 reqFile 同命运（$dataDir 写入、用完即删）。
function cfgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, '')
}

// 生成配对模式的 curl 配置（请求方法 / 全部头 / body 文件 / TLS 锁定 / URL）。
// reqFile 传完整路径：curl 的工作目录不确定，相对路径会找不到 body 文件。
function buildCurlConfig({ url, reqFile, deviceToken, sigHeaders, tlsPin }) {
  let cfg = 'request = "POST"\n';
  cfg += 'header = "Content-Type: application/json"\n';
  cfg += 'header = "Authorization: Bearer ' + cfgEsc(deviceToken) + '"\n';
  const keys = Object.keys(sigHeaders);
  for (let i = 0; i < keys.length; i++) {
    cfg += 'header = "' + cfgEsc(keys[i]) + ': ' + cfgEsc(sigHeaders[keys[i]]) + '"\n';
  }
  if (tlsPin) {
    // 证书公钥锁定（SPKI）：中间人即使有受信 CA 也换不掉证书，防抓包改包。
    // 形如 sha256//Base64(SPKI)，由服务端管理员提供；留空不启用。
    cfg += 'pinnedpubkey = "' + cfgEsc(tlsPin) + '"\n';
  }
  cfg += 'data = "@' + cfgEsc(reqFile) + '"\n';
  cfg += 'url = "' + cfgEsc(url) + '"\n';
  return cfg
}

/**
 * 流式（SSE）对话请求。
 * 设备框架的 $falcon.jsapi.http 不支持增量回调，因此这里用后台 curl -N 写文件 +
 * 轮询文件的方式实现逐字/逐段渲染。
 * @param {Object} opts { baseUrl, apiKey, modeKey, messages, thinking, search, timeout,
 *                        authMode, modelId, conversationId, auth }
 *   auth 为设备配对材料（可选）：{ deviceId, deviceToken, signSecret, expiresAt, tlsPin }
 * @param {Object} handlers { onDelta(text, full), onReasoning(text, full) }
 * @returns {Promise<{content, reasoning, finishReason, usage}>}
 */
async function chatStream(opts, handlers = {}) {
  const { baseUrl, apiKey, modeKey, messages, thinking, search, timeout = 300000, authMode = DEFAULT_AUTH_MODE, backendMode = '', modelId = '', conversationId = '', auth = null } = opts;
  const isCancelled = handlers.isCancelled || function () { return false };
  getMode(modeKey);
  const upstream = isUpstreamMode(backendMode);
  const effectiveBaseUrl = upstream
      ? String(baseUrl || UPSTREAM_BASE_URL || '').trim()
      : (baseUrl || DEFAULT_BASE_URL);

  if (!effectiveBaseUrl && !isBuiltinMode()) {
    throw new DsError('BAD_URL', '尚未配置「我的上游」地址：请到设置页填写或联系发布者预置')
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
    throw new DsError('NOT_PAIRED', '暂时连不上「我的上游」：请检查网络后重试（设备会自动注册，无需任何配置）')
  }

  // 内置端点始终用模式默认模型（deepseek-*，走 ds-free-api 账号池）；
  // 上游模式留空则不传 model，由网关注入它配置的默认模型（provider.modelMap 可改名）；
  // 自定义端点优先用设置的自定义模型 ID，留空 / 官方 API 的网页端模型名自动纠正。
  let model = '';
  if (upstream) model = String(modelId || '').trim();
  else model = resolveModel(effectiveBaseUrl, modelId);

  const body = { messages, stream: true };
  if (model) body.model = model;
  // 会话标识：后端据此做持久会话复用（历史由 DeepSeek 服务端持有，不再上传历史文件）
  if (conversationId) body.user = String(conversationId);
  if (thinking === false) {
    body.reasoning_effort = 'none';
  }
  body.web_search_options = { search_context_size: search ? 'high' : 'none' };

  const token = 'dsstream_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  const reqFile = joinPath(dataDirBase(), token + '.req.json');
  const outFile = joinPath(dataDirBase(), token + '.out.txt');
  const cfgFile = joinPath(dataDirBase(), token + '.cfg');

  if (isCancelled()) {
    throw new DsError('CANCELLED', '已停止')
  }

  const bodyText = JSON.stringify(body);
  await writeFile(reqFile, bodyText);

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
    await writeFile(cfgFile, cfg);
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
  let content = '';
  let reasoning = '';
  let dsTitle = null;
  let dsSessionId = null;
  let done = false;
  let raw = null;
  const start = Date.now();

  try {
    // 事件处理抽成闭包：finish 之后还可能跟着 usage / ds_title / ds_session_id 等
    // 尾随 chunk（空 choices），它们到达时往往已在本批次之外——循环退出后要再读一次，
    // 否则这些尾巴会被丢掉（会话 id 丢了，同步就会重复导入，bug 3）。
    const handleEvents = (events) => {
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
          continue
        }
        if (obj && obj.error) {
          // 上游限流用独立错误码，调用方据此停止自动续发（bug 1）
          const errCode = String(obj.error.code || '');
          if (isRateLimitCode(errCode) || isRateLimitText(obj.error.message)) {
            const err = new DsError('RATE_LIMITED', mapApiError(obj), obj.error);
            err.rateLimited = true;
            throw err
          }
          throw new DsError('API', mapApiError(obj), obj.error)
        }
        // DeepSeek 自动生成的会话标题（会话首条消息时下发，#9）
        if (obj && obj.ds_title) {
          dsTitle = obj.ds_title;
          continue
        }
        // 本对话的云端会话 id（后端在流末尾以尾随 chunk 下发，用于同步去重）
        if (obj && obj.ds_session_id) {
          dsSessionId = obj.ds_session_id;
          continue
        }
        const choice = obj && obj.choices && obj.choices[0];
        if (!choice) continue
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (handlers.onReasoning) handlers.onReasoning(delta.reasoning_content, reasoning);
        }
        if (delta.content) {
          content += delta.content;
          if (handlers.onDelta) handlers.onDelta(delta.content, content);
        }
        if (choice.finish_reason) {
          done = true;
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
            throw new DsError('NETWORK', txt.replace(/^curl:\s*/, '').split('\n')[0] || '无法连接服务器，请检查服务地址')
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
                const err = new DsError('RATE_LIMITED', mapApiError(obj), obj.error);
                err.rateLimited = true;
                throw err
              }
              throw new DsError('API', mapApiError(obj), obj.error)
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
      } catch (e) { /* 补读失败不影响已有结果 */ }
    }

    return { content: stripInternalTags(content), reasoning: stripInternalTags(reasoning), dsTitle, dsSessionId, finishReason: 'stop', usage: null }
  } finally {
    stopStream(token);
    try { execShell('rm -f ' + shq(reqFile) + ' ' + shq(outFile) + ' ' + shq(cfgFile) + ' || true'); } catch (e) { /* 忽略 */ }
  }
}

// Emoji 字体（实验）：下载 NotoColorEmoji 并通过 dom.addRule 注册，

const FONT_DIR = () => joinPath(dataDirBase(), 'fonts');
const FONT_PATH = () => joinPath(FONT_DIR(), 'NotoColorEmoji.ttf');
// NotoColorEmoji v2.047 实际约 10MB；阈值取 8MB，避免被 CDN 错误页/截断响应
// （几十 KB 到几 MB）当成成功下载后注册出一个坏字体。
const MIN_FONT_SIZE = 8 * 1024 * 1024;

// 主源 + 备源（jsdelivr 主/子域）
const FONT_URLS = [
  'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/fonts/NotoColorEmoji.ttf',
  'https://fastly.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/fonts/NotoColorEmoji.ttf'
];

const EMOJI_FONT_FAMILY = 'NotoColorEmoji';

// 注册结果缓存，避免重复 addRule
let registered = false;

// 取 dom 模块并说明失败原因。
// 原实现把三种完全不同的情况（无 weex 全局 / 无 requireModule / 模块无 addRule）
// 都压成一句"dom 模块不可用"，并 catch 掉框架的真实报错，导致用户报告无法定位。
// 现在分别返回原因，并把 requireModule 抛出的异常带出来。
function resolveDomModule() {
  if (typeof weex === 'undefined' || !weex) {
    return { dom: null, reason: '当前运行环境没有 weex 全局对象' }
  }
  if (typeof weex.requireModule !== 'function') {
    return { dom: null, reason: 'weex.requireModule 不存在（框架版本不支持）' }
  }
  let mod = null;
  try {
    mod = weex.requireModule('dom');
  } catch (e) {
    return {
      dom: null,
      reason: 'requireModule("dom") 抛出异常：' + (e && e.message ? e.message : String(e))
    }
  }
  if (!mod) {
    return { dom: null, reason: 'dom 模块未在本设备注册' }
  }
  if (typeof mod.addRule !== 'function') {
    const keys = (() => {
      try { return Object.keys(mod).join(',') } catch (e) { return '不可枚举' }
    })();
    return {
      dom: null,
      reason: 'dom 模块缺少 addRule 接口（本设备固件不支持动态注册字体）；可用接口：' + (keys || '无')
    }
  }
  return { dom: mod, reason: '' }
}

/**
 * 确保 emoji 字体已就绪并注册。返回 { ok, message }。
 * 流程：已存在且非空 → 直接注册；否则逐个源 curl 下载（-L 跟随重定向）→ 校验大小 → 注册。
 *
 * 注意：字体注册依赖 weex dom.addRule('fontFace')。本项目探针
 * （.probe/jsframework.txt 等）中未发现 addRule 实现，多数词典笔固件不支持，
 * 因此本功能预期在部分设备上直接返回 ok:false —— 这是能力缺失，不是 bug，
 * 界面据此降级为普通渲染。
 */
async function ensureEmojiFont() {
  const { dom, reason } = resolveDomModule();
  if (!dom) {
    appLog('[emoji] 字体注册不可用：' + reason);
    return { ok: false, message: '设备不支持字体注册（' + reason + '）' }
  }
  if (registered) return { ok: true, message: '已注册' }

  const path = FONT_PATH();
  let size = (await exists(path)) ? await statSize(path) : 0;
  if (!size || size < MIN_FONT_SIZE) {
    const dir = FONT_DIR();
    const tmp = path + '.part';
    const resultFile = joinPath(dataDirBase(), 'emoji-font-result.txt');
    let downloaded = false;
    for (const url of FONT_URLS) {
      appLog('[emoji] 下载字体: ' + url);
      try {
        execShell('rm -f ' + shq(resultFile) + ' ' + shq(tmp) + ' 2>/dev/null || true');
        const cmd =
          'mkdir -p ' + shq(dir) + ' && ' +
          'curl -L -s -m 300 ' + shq(url) + ' -o ' + shq(tmp) + ' && ' +
          'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile);
        execShell(cmd);
        // 等待下载完成（最长 5 分钟）
        const result = String(await waitForFile(resultFile, 300000) || '');
        if (result.indexOf('ok') === 0) {
          size = await statSize(tmp);
          if (size >= MIN_FONT_SIZE) {
            execShell('mv -f ' + shq(tmp) + ' ' + shq(path));
            downloaded = true;
            break
          }
        }
      } catch (e) {
        appLog('[emoji] 下载异常 ' + (e && e.message ? e.message : String(e)));
      }
    }
    try { execShell('rm -f ' + shq(path + '.part') + ' ' + shq(resultFile)); } catch (e) { /* 忽略 */ }
    if (!downloaded) {
      // 带上最后一次拿到的字节数：区分"完全没下到"和"下到一半/拿到错误页"
      const msg = size > 0
        ? '下载不完整（只拿到 ' + Math.round(size / 1024) + 'KB，需要约 10MB），请检查网络后重试'
        : '下载失败（检查网络后重试，字体约 10MB）';
      appLog('[emoji] ' + msg);
      return { ok: false, message: msg }
    }
  }

  try {
    dom.addRule('fontFace', {
      fontFamily: EMOJI_FONT_FAMILY,
      src: "url('file://" + path + "')"
    });
    registered = true;
    appLog('[emoji] 字体已注册: ' + path);
    return { ok: true, message: 'Emoji 字体已就绪' }
  } catch (e) {
    const msg = '字体注册失败：' + (e && e.message ? e.message : String(e));
    appLog('[emoji] ' + msg);
    return { ok: false, message: msg }
  }
}

// 会话云同步（上游模式）。

// 每个会话一个防抖定时器：连续修改（重试、修改消息）只上传最后一次。
const timers = {};
const PUSH_DELAY_MS = 1200;

async function authCtx(settings, persist) {
  if (!settings || !settings.upstreamMode) return null
  const auth = await ensureUpstreamAuth({ settings, persist });
  if (!auth) return null
  return { baseUrl: upstreamBase(settings), auth }
}

/**
 * 排队推送一条会话（覆盖式快照）。
 * @param {Object} p { settings, conversation, messages, persist }
 */
function queueSessionPush({ settings, conversation, messages, persist }) {
  const s = settings || {};
  const conv = conversation || {};
  if (!s.upstreamMode || !conv.id) return
  const key = String(conv.id);
  if (timers[key]) clearTimeout(timers[key]);
  const snapshot = Array.isArray(messages) ? messages.slice() : [];
  timers[key] = setTimeout(() => {
    delete timers[key];
    pushNow({ settings: s, conversation: conv, messages: snapshot, persist });
  }, PUSH_DELAY_MS);
  if (timers[key].unref) timers[key].unref();
}

// 立即推送（删除前/退出时可调用；正常路径走 queueSessionPush）
async function pushNow({ settings, conversation, messages, persist }) {
  const ctx = await authCtx(settings, persist);
  if (!ctx) return { ok: false, reason: 'no_auth' }
  try {
    const r = await pushSession({
      baseUrl: ctx.baseUrl,
      auth: ctx.auth,
      conversation,
      messages
    });
    conversation.remoteSyncedAt = Date.now();
    return { ok: true, result: r }
  } catch (e) {
    appLog('[sync] 会话上传失败 ' + (conversation && conversation.id) + '：' + (e && e.message ? e.message : String(e)));
    return { ok: false, message: e && e.message ? e.message : String(e) }
  }
}

// 删除云端会话（本地已删完再调；失败只记录）
async function syncDelete({ settings, conversation, persist }) {
  const conv = conversation || {};
  if (!settings || !settings.upstreamMode || !conv.id) return { ok: true, skipped: true }
  const ctx = await authCtx(settings, persist);
  if (!ctx) return { ok: false, reason: 'no_auth' }
  try {
    await deleteRemoteSession({ baseUrl: ctx.baseUrl, auth: ctx.auth, sessionId: conv.cloudId || conv.id });
    appLog('[sync] 已删除云端会话 ' + (conv.cloudId || conv.id));
    return { ok: true }
  } catch (e) {
    appLog('[sync] 删除云端会话失败 ' + (conv.id) + '：' + (e && e.message ? e.message : String(e)));
    return { ok: false, message: e && e.message ? e.message : String(e) }
  }
}

// 清空全部云端会话（设置页「清空全部对话」）
async function syncPurgeAll({ settings, persist }) {
  if (!settings || !settings.upstreamMode) return { ok: true, skipped: true }
  const ctx = await authCtx(settings, persist);
  if (!ctx) return { ok: false, reason: 'no_auth' }
  try {
    const r = await purgeRemoteSessions({ baseUrl: ctx.baseUrl, auth: ctx.auth });
    appLog('[sync] 已清空云端会话 ' + (r && r.deleted ? r.deleted : 0) + ' 条');
    return { ok: true, deleted: (r && r.deleted) || 0 }
  } catch (e) {
    appLog('[sync] 清空云端会话失败：' + (e && e.message ? e.message : String(e)));
    return { ok: false, message: e && e.message ? e.message : String(e) }
  }
}

function remoteToMessages(list) {
  const out = [];
  let seq = 0;
  const now = Date.now();
  const mapImages = (imgs) => (Array.isArray(imgs) ? imgs : [])
    .filter((i) => i && i.path)
    .map((i) => ({ name: i.name || '', path: i.path }));
  for (const m of list || []) {
    if (!m || !m.role) continue
    if (m.role === 'user') {
      const revisions = Array.isArray(m.revisions) && m.revisions.length
        ? m.revisions.map((r) => ({
          content: r.content || '',
          images: mapImages(r.images),
          createdAt: Number(r.createdAt) || now
        }))
        : null;
      out.push({
        id: String(m.id || uid('u')),
        role: 'user',
        content: m.content || '',
        images: mapImages(m.images),
        createdAt: Number(m.createdAt) || (now + seq++),
        revisions: revisions || undefined,
        activeRevision: typeof m.activeRevision === 'number' ? m.activeRevision : undefined
      });
    } else {
      const attempts = Array.isArray(m.attempts) && m.attempts.length
        ? m.attempts.map((a) => ({
          id: uid('a'),
          content: a.content || '',
          reasoning: a.reasoning || '',
          error: a.error || '',
          pending: false,
          createdAt: Number(a.createdAt) || now
        }))
        : null;
      out.push({
        id: String(m.id || uid('a')),
        role: 'assistant',
        content: m.content || '',
        reasoning: m.reasoning || '',
        error: m.error || '',
        pending: false,
        createdAt: Number(m.createdAt) || (now + seq++),
        attempts: attempts || undefined,
        activeAttempt: typeof m.activeAttempt === 'number' ? m.activeAttempt : undefined
      });
    }
  }
  return normalizeMessages(out)
}

function remoteToConversation(remote) {
  return {
    // 直接用远端 id 作为本地 id：下次推送仍是同一条，不会产生第二份备份
    id: String(remote.id),
    title: String(remote.title || '新对话').slice(0, 30),
    mode: remote.mode || 'fast',
    thinking: remote.thinking !== false,
    search: remote.search === true,
    createdAt: Number(remote.createdAt) || Date.now(),
    updatedAt: Number(remote.updatedAt) || Date.now(),
    cloudId: String(remote.id),
    cloudLoaded: true,
    remoteSyncedAt: Date.now()
  }
}

/**
 * 拉取本地缺失的会话（重装/换机恢复，或设置页手动恢复）。
 * @param {Object} p { settings, existingIds, max, persist }
 * @returns {Promise<Array<{conversation, messages}>>}
 */
async function pullMissing({ settings, existingIds = [], max = 20, persist } = {}) {
  const ctx = await authCtx(settings, persist);
  if (!ctx) return []
  let list = [];
  try {
    list = await listRemoteSessions({ baseUrl: ctx.baseUrl, auth: ctx.auth });
  } catch (e) {
    appLog('[sync] 拉取云端会话列表失败：' + (e && e.message ? e.message : String(e)));
    return []
  }
  const have = {};
  for (const id of existingIds) have[String(id)] = true;
  const todo = list
    .filter((s) => s && s.id && !have[String(s.id)] && (Number(s.messageCount) || 0) > 0)
    .slice(0, Math.max(1, Number(max) || 20));

  const out = [];
  for (const s of todo) {
    try {
      const detail = await fetchRemoteSession({ baseUrl: ctx.baseUrl, auth: ctx.auth, sessionId: s.id });
      out.push({
        conversation: remoteToConversation(detail),
        messages: remoteToMessages(detail.messages)
      });
    } catch (e) {
      appLog('[sync] 拉取云端会话失败 ' + s.id + '：' + (e && e.message ? e.message : String(e)));
    }
  }
  if (out.length) appLog('[sync] 已从云端恢复 ' + out.length + ' 条会话');
  return out
}

export { MODES, listCloudSessionMessages, buildMessages, cancelThumbJobs, deleteCloudSession, ensureEmojiFont, chatStream, getMode, isRateLimitedError, isAccountSuspension, listAlbum, ensureThumb, listCloudSessions, stripInternalTags, listRemoteModels, syncPurgeAll, pullMissing, queueSessionPush, readImageDataUrl, syncDelete };
