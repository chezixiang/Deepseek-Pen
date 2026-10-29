// 应用侧文件日志：默认开启，写入 $dataDir/ds-app.log（追加模式）。
// 用于真机问题定位——console 输出在设备上不可见，文件日志可直接读。
//
// 统一入口（本模块是唯一写入方，页面/服务一律从这里记录）：
//   appLog          普通事件（流程节点、状态变更）
//   appLogError     所有报错：统一格式 [error] scope: code=… message @调用位置
//   appLogSetting   设置项变更：统一格式 [settings] key: 旧值 -> 新值（敏感字段脱敏）
//   debugLog        调试明细：仅在「启用调试日志」时落盘，默认不产生噪声
//   buildLogBundle  反馈用完整日志文件（应用日志当前+上一份、后端日志当前+上一份）
//
// 注意：SDK fs 无 appendFile，只能 read-then-write；且 readFile 是异步（返回 Promise）。
// 之前实现未 await，导致 String(Promise)='[object Promise]' 覆盖整个文件、只剩最后一行。
// 现在用 Promise 队列串行化，保证追加且不乱序。
//
// OS 4.9.7 兼容：该系统的 falcon fs 没有 fs.writeFile（真机确认），read-then-write
// 的写一半永远失败 → 日志文件根本不存在 → 反馈附带日志为空。这里在 fs 写失败时
// 走 shell 追加兜底（printf >> 追加 + 哨兵同步，见 shell-write.js）；
// fs.readFile 在 4.9.7 上可用（curl 输出文件能被读回即铁证）。

import fs from 'fs'
import globalModule from 'global'
import { shellAppendLine, shellTruncate } from './shell-write.js'

// 本模块不 import native.js（native.js → appLog 循环依赖），自建最小 shell 桥
function _g() {
  try { return new globalModule.Global() } catch (e) { return null }
}

function _shq(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'"
}

function _execShell(cmd) {
  try {
    const g = _g();
    return g && typeof g.execShell === 'function' ? g.execShell(cmd) : false
  } catch (e) {
    return false
  }
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function _waitForFile(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const c = await fs.readFile(path);
      if (c !== null && c !== undefined && String(c) !== '') return String(c)
    } catch (e) { /* 未出现继续等 */ }
    await _sleep(150)
  }
  return null
}

const _shellBridge = {
  execShell: (cmd) => _execShell(cmd),
  shq: (s) => _shq(s),
  waitForFile: (p, t) => _waitForFile(p, t),
  sleep: (ms) => _sleep(ms),
  dataDirBase: () => String($dataDir || '/tmp').replace(/\/+$/, ''),
  joinPath: (b, ...p) => {
    let out = String(b == null ? '' : b).replace(/\/+$/, '')
    for (const part of p) {
      const seg = String(part == null ? '' : part).replace(/^\/+/, '').replace(/\/+$/, '')
      if (seg) out += '/' + seg
    }
    return out
  }
}

const LOG_FILE = () => String($dataDir || '/tmp/').replace(/\/+$/, '') + '/ds-app.log'
const MAX_LOG_LINES = 500
// 上一份日志保留上限（约 2 倍于当前文件，给"事发前"留证据）
const OLD_LOG_MAX_LINES = 1000
// 反馈附带的完整日志上限（字符）：单条反馈不宜超过几百 KB，
// 超限时保留最近部分并明确标注，避免把设备内存/网络拖垮。
const LOG_BUNDLE_MAX_CHARS = 512 * 1024

let logQueue = Promise.resolve()
// 调试明细开关：默认关闭（每次都写会让日志被输入/渲染事件淹没）
let logVerbose = false

export function setLogVerbose(v) {
  logVerbose = !!v
}

export function isLogVerbose() {
  return logVerbose
}

// 追加一行日志（带时间戳）。串行队列保证多行不互相覆盖。失败静默，不影响主流程。
export function appLog(...args) {
  const line = new Date().toISOString() + ' | ' + args.map(String).join(' ')
  logQueue = logQueue.then(() => doAppend(line)).catch(() => {})
  return logQueue
}

/**
 * 统一错误文本：code + message + 第一条业务调用位置。
 * 堆栈不整段落盘（设备上动辄上千字符，几行就挤满 500 行窗口），
 * 只取第一帧，足以定位是哪个模块哪一行抛的。
 */
export function errText(e) {
  if (e === null || e === undefined) return 'unknown'
  if (typeof e !== 'object') {
    const s = String(e)
    return s.length > 600 ? s.slice(0, 600) + '…' : s
  }
  const code = e.code ? ' code=' + String(e.code) : ''
  const raw = e.message ? String(e.message) : String(e)
  // 单条错误信息限长：HTTP 响应体/上游原文偶尔上千字符，一行就能挤掉半屏日志
  const msg = raw.length > 600 ? raw.slice(0, 600) + '…' : raw
  let where = ''
  const stack = e.stack ? String(e.stack) : ''
  if (stack) {
    const lines = stack.split('\n')
    for (let i = 1; i < lines.length && i < 5; i++) {
      const l = lines[i].trim()
      if (l.indexOf('at ') === 0) { where = ' @' + l.slice(3, 123); break }
    }
  }
  return code + ' ' + msg + where
}

// 所有报错都走这里：scope 用模块名（chat/http/deploy/settings…），extra 放上下文。
export function appLogError(scope, e, extra) {
  const tail = extra === undefined || extra === null || extra === '' ? '' : ' ' + String(extra)
  return appLog('[error] ' + String(scope || 'app') + ':' + errText(e) + tail)
}

// ---------- 设置项变更 ----------
// 敏感字段只记"是否已设置 + 长度"，绝不明文落盘（日志会被上传/导出）。
// systemPrompt 属于用户内容，同样只记长度。
const SECRET_KEY_RE = /(apikey|api_key|token|secret|pass|password|dsuser|dsaccount|systemprompt)/i

function maskSettingValue(key, v) {
  if (v === undefined) return '(未设置)'
  if (v === null) return '(空)'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  if (SECRET_KEY_RE.test(String(key || ''))) {
    return s ? '已设置(len=' + s.length + ')' : '(空)'
  }
  if (!s) return '(空)'
  if (s.length > 160) return s.slice(0, 160) + '…(' + s.length + ' 字符)'
  return s
}

/** 记录一次设置项变更（值相同则不写，避免保存时刷屏） */
export function appLogSetting(key, from, to) {
  const a = from === undefined ? '(未设置)' : String(from)
  const b = to === undefined ? '(未设置)' : String(to)
  if (a === b) return Promise.resolve()
  return appLog('[settings] ' + key + ': ' + maskSettingValue(key, from) + ' -> ' + maskSettingValue(key, to))
}

/** 调试明细：只有「启用调试日志」时才落盘，避免正常使用刷满日志窗口 */
export function debugLog(...args) {
  if (!logVerbose) return Promise.resolve()
  const text = args.join(' ')
  try { console.error('DSLOG | ' + text) } catch (e) { /* 设备上不可见，忽略 */ }
  return appLog('[debug] ' + text)
}

// shell 追加模式的轮转计数：fs 写失败时每 300 行用 shell 收敛一次文件大小
let shellAppendCount = 0

async function doAppend(line) {
  try {
    let prev = ''
    try {
      const raw = await fs.readFile(LOG_FILE())
      if (raw) prev = String(raw)
    } catch (e) { /* 首次写入，无旧文件 */ }
    const next = (prev ? prev.replace(/^\[object Promise\]\n?/, '') + '\n' : '') + line
    const lines = next.split('\n')
    let trimmed = next
    if (lines.length > MAX_LOG_LINES) {
      // 轮转保留（bug 修复）：被挤出的较旧内容转入 .old（尾部 1000 行），
      // 不再直接丢弃——否则封号等事故发生前的日志无从查证
      const overflow = lines.slice(0, lines.length - MAX_LOG_LINES).join('\n')
      try {
        let prevOld = ''
        try {
          const oldRaw = await fs.readFile(LOG_FILE() + '.old')
          if (oldRaw) prevOld = String(oldRaw)
        } catch (e) { /* 无上一份 */ }
        const merged = (prevOld ? prevOld + '\n' : '') + overflow
        const oldLines = merged.split('\n')
        await fs.writeFile(LOG_FILE() + '.old', oldLines.slice(-OLD_LOG_MAX_LINES).join('\n'))
      } catch (e) { /* 忽略 */ }
      trimmed = lines.slice(-MAX_LOG_LINES).join('\n')
    }
    let written = false
    try {
      const r = await fs.writeFile(LOG_FILE(), trimmed)
      written = r !== false
    } catch (e) { written = false }
    if (!written) {
      // OS 4.9.7：无 fs.writeFile —— shell 逐行追加（文件已由本路径用 shell 创建，readFile 可读）
      const ok = await shellAppendLine(_shellBridge, LOG_FILE(), line)
      if (ok) {
        shellAppendCount++;
        if (shellAppendCount % 300 === 0) {
          // shell 收敛大小：保留尾部 450 行（.old 轮转在此模式下从简）
          _execShell('tail -n 450 ' + _shq(LOG_FILE()) + ' > ' + _shq(LOG_FILE()) + '.tmp && mv ' + _shq(LOG_FILE()) + '.tmp ' + _shq(LOG_FILE()) + '; true')
        }
      }
    }
  } catch (e) { /* 忽略 */ }
}

// 读取日志：gen=0 当前文件，gen=1 上一份（轮转保留的 .old）
export async function appLogTail(n = 10, gen = 0) {
  try {
    const path = LOG_FILE() + (gen === 1 ? '.old' : '')
    const raw = String(await fs.readFile(path) || '')
    return raw.split('\n').filter(Boolean).slice(-n).join('\n')
  } catch (e) {
    return ''
  }
}

// 清空应用日志（含上一份）。OS 4.9.7 无 fs.writeFile：shell : > 截断兜底
export async function appLogClear() {
  try {
    const r = await fs.writeFile(LOG_FILE(), '')
    if (r === false) throw new Error('fs write unavailable')
  } catch (e) { await shellTruncate(_shellBridge, LOG_FILE()).catch(() => {}) }
  try {
    const r = await fs.writeFile(LOG_FILE() + '.old', '')
    if (r === false) throw new Error('fs write unavailable')
  } catch (e) { await shellTruncate(_shellBridge, LOG_FILE() + '.old').catch(() => {}) }
}

// ---------- 后端日志（ds-free-api runtime.log） ----------
// build 22 起 ds-free-api 部署在 $dataDir/ds-free-api，fs 可直接读。
// 直接用 fs 而不经 native.js，避免与 native.js → appLog 的循环依赖。
// gen=1 读 runtime.log.1（native.js 截断时保留的上一份，尾部 800 行）。
const BACKEND_LOG_FILE = (gen = 0) =>
  String($dataDir || '/tmp/').replace(/\/+$/, '') +
  '/ds-free-api/logs/runtime.log' + (gen === 1 ? '.1' : '')

export async function backendLogTail(n = 100, gen = 0) {
  try {
    const raw = String(await fs.readFile(BACKEND_LOG_FILE(gen)) || '')
    return raw.split('\n').filter(Boolean).slice(-n).join('\n')
  } catch (e) {
    return ''
  }
}

export async function backendLogClear() {
  for (const gen of [0, 1]) {
    try {
      const r = await fs.writeFile(BACKEND_LOG_FILE(gen), '')
      if (r === false) throw new Error('fs write unavailable')
    } catch (e) { await shellTruncate(_shellBridge, BACKEND_LOG_FILE(gen)).catch(() => {}) }
  }
}

// ---------- 完整日志（反馈附件用） ----------
// 与 appLogTail 的区别：这里返回**整个文件**（当前 + 轮转的上一份），
// 不再只取尾部 N 行——用户反馈时最需要的是事发前后的完整现场。
async function _readTextFile(path) {
  try {
    const raw = await fs.readFile(path)
    if (raw === null || raw === undefined) return ''
    // 历史 bug 留下的首行脏数据，读的时候顺手清掉
    return String(raw).replace(/^\[object Promise\]\n?/, '')
  } catch (e) {
    return ''
  }
}

export async function readAppLogFull(gen = 0) {
  return _readTextFile(LOG_FILE() + (gen === 1 ? '.old' : ''))
}

export async function readBackendLogFull(gen = 0) {
  return _readTextFile(BACKEND_LOG_FILE(gen))
}

/**
 * 打包一份可直接当附件上传的完整日志文件。
 *
 * 顺序按时间从旧到新：应用日志.old → 应用日志 → 后端日志.1 → 后端日志，
 * 每段带独立分隔头。backend=false 时只取应用日志（自定义端点模式没有本机后端）。
 *
 * @returns {Promise<{text:string, lines:number, chars:number, truncated:boolean, parts:Array}>}
 */
export async function buildLogBundle({ includeBackend = true, maxChars = LOG_BUNDLE_MAX_CHARS } = {}) {
  // 先把队列里待写的日志落完，避免把"正在写一半"的文件读进附件
  try { await logQueue } catch (e) { /* 写失败不影响读取已有内容 */ }
  const files = [
    { name: 'ds-app.log.old（应用日志·上一份）', text: await readAppLogFull(1) },
    { name: 'ds-app.log（应用日志·当前）', text: await readAppLogFull(0) }
  ]
  if (includeBackend) {
    files.push({ name: 'runtime.log.1（后端日志·上一份）', text: await readBackendLogFull(1) })
    files.push({ name: 'runtime.log（后端日志·当前）', text: await readBackendLogFull(0) })
  }
  const parts = []
  let body = ''
  for (const f of files) {
    const text = String(f.text || '').replace(/[\r\n]+$/, '')
    if (!text) continue
    const lineCount = text.split('\n').filter(Boolean).length
    if (!lineCount) continue
    parts.push({ name: f.name, lines: lineCount, chars: text.length })
    body += '===== ' + f.name + '（' + lineCount + ' 行）=====\n' + text + '\n\n'
  }
  let truncated = false
  if (body.length > maxChars) {
    truncated = true
    const cut = body.slice(body.length - maxChars)
    // 从第一个完整行开始，避免首行被截成半行
    const nl = cut.indexOf('\n')
    body = '===== 日志超过 ' + Math.round(maxChars / 1024) + 'KB，已保留最近部分（省略最早内容）=====\n' +
      (nl >= 0 ? cut.slice(nl + 1) : cut)
  }
  return {
    text: body,
    lines: body ? body.split('\n').filter(Boolean).length : 0,
    chars: body.length,
    truncated,
    parts
  }
}


// ---------- 网络抓取（ds-free-api net-capture.jsonl） ----------
// 「启用调试日志」开关联动抓取的上游报文（后端 net_capture.rs 双向落盘，
// JSONL 每行一个事件，文件可达 20MB）。**读取走 native.js 的 readNetCaptureTail**
// （shell tail，避免整读进 QuickJS）；这里只提供清空（writeFile 空串即截断）。
const NET_CAPTURE_FILE = (gen = 0) =>
  String($dataDir || '/tmp/').replace(/\/+$/, '') +
  '/ds-free-api/logs/net-capture.jsonl' + (gen === 1 ? '.1' : gen === 2 ? '.2' : '')

export async function netCaptureClear() {
  for (const gen of [0, 1, 2]) {
    try {
      const r = await fs.writeFile(NET_CAPTURE_FILE(gen), '')
      if (r === false) throw new Error('fs write unavailable')
    } catch (e) { await shellTruncate(_shellBridge, NET_CAPTURE_FILE(gen)).catch(() => {}) }
  }
}
