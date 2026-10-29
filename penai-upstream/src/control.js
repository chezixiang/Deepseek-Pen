// 云控：管理后台下发、客户端拉取的运行策略（协议 v4）。
//
// 定位：不发版就能调整线上客户端的行为——维护窗口、功能开关、客户端运行限制、
// 提示词注入、调试/远程执行授权、更新策略（可选/强制）、可用模型、
// 上游信息是否披露、配额说明、服务通知。
// 客户端把它当"建议"：网络不通时用本地缓存，缓存也没有就按默认值跑，
// 绝不因为云控失败而不能聊天。
//
// 存储：data/control.json（小文件，直接原子写；不走 state.json 的防抖队列）。
//
// v4 相对 v3：
//   - 删除公告系统（多条公告 / 设备定向公告 / 已读去重），只保留服务通知 notice
//   - 其余字段保持 v3 语义
//
// v3 相对 v2：
//   - 新增 prompt：提示词注入（服务端在转发前拼进 system 消息）
//   - 新增 debug：是否允许该设备响应调试暗号、是否允许远程执行、调试上报节奏
//   - 新增 upstream：上游信息是否对客户端披露（名称 / 模型目录）
//   - notice 增加 noticeId：服务通知按 id 去重弹窗
//   - update 增加 fileId/fileName/size/sha256：后台直接上传 .amr 包并发布
//   - 设备级覆盖支持 update / prompt / debug

import fs from 'node:fs'
import path from 'node:path'

export const CONTROL_VERSION = 4

// 功能开关：key 与客户端 normalizeControl 一一对应。
// critical=true 的开关关闭后会直接阻断对应操作（不只是隐藏入口）。
export const CONTROL_FEATURES = [
  { key: 'chat', label: '发送消息', hint: '关闭后客户端不能发送消息，首页只读', critical: true },
  { key: 'search', label: '联网搜索', hint: '关闭后隐藏搜索开关并强制不搜索' },
  { key: 'thinking', label: '深度思考', hint: '关闭后隐藏思考开关并强制关闭' },
  { key: 'images', label: '图片输入', hint: '关闭后隐藏相册与拍照入口', critical: true },
  { key: 'files', label: '文件输入', hint: '关闭后隐藏聊天里的文件上传入口', critical: true },
  { key: 'camera', label: '拍照', hint: '只关拍照时仍可从相册选图' },
  { key: 'sessions', label: '云端会话备份', hint: '关闭后客户端不再上传/恢复会话' },
  { key: 'feedback', label: '意见反馈', hint: '关闭后隐藏反馈入口' },
  { key: 'modelPicker', label: '模型切换', hint: '关闭后强制使用默认模型' },
  { key: 'settingsEdit', label: '修改服务配置', hint: '关闭后设置页只读，防止改坏端点' },
  { key: 'updates', label: '版本更新提示', hint: '关闭后不弹更新弹窗（不影响强制更新策略）' }
]

// 客户端运行限制：服务端下发，客户端按此执行；避免为调小上限发版。
// min/max 只做"语义边界"校验（低于它该框就失去意义），不设人工经验上限：
// 管理后台应能输入一切有意义的值（例如模型支持 1M 上下文时单条输入可给到百万级；
// 会话上限可设 2147483647 交给用户自行管理），实际约束由客户端/服务端按上下文
// 自动截断兜底。default 用于缺省值。
export const CONTROL_LIMITS = [
  { key: 'maxInputChars', label: '单条输入上限', unit: '字', min: 1, max: 2147483647, default: 4000, hint: '超出部分客户端自动截断并提示；模型上下文足够时可给到百万级' },
  { key: 'maxHistoryMessages', label: '随请求上传的历史', unit: '条', min: 0, max: 2147483647, default: 40, hint: '只取最近 N 条，0 表示只发当前消息；超出上下文由服务端自动截断' },
  { key: 'maxImageCount', label: '单条消息图片数', unit: '张', min: 0, max: 9, default: 4, hint: '0 表示不允许带图' },
  { key: 'requestTimeoutSec', label: '单次请求超时', unit: '秒', min: 10, max: 86400, default: 180, hint: '流式请求的最长等待时间' },
  { key: 'maxSessions', label: '本地会话上限', unit: '条', min: 1, max: 2147483647, default: 200, hint: '超出后客户端提示用户清理；设极大值等于交给用户自行管理' },
  { key: 'pollSec', label: '云控轮询间隔', unit: '秒', min: 60, max: 86400, default: 300, hint: '客户端多久重新拉一次云控' },
  { key: 'reportSec', label: '状态上报间隔', unit: '秒', min: 60, max: 86400, default: 300, hint: '监控心跳间隔' }
]

export const NOTICE_LEVELS = ['info', 'warn', 'critical']

export const DEFAULT_CONTROL = {
  version: CONTROL_VERSION,
  updatedAt: 0,
  // 维护：enabled=true 时客户端禁止发消息，只显示 message（设备级可开白名单）
  maintenance: { enabled: false, message: '', until: 0 },
  // 功能开关：false 时客户端隐藏/阻断对应入口
  features: {
    chat: true,
    search: true,
    thinking: true,
    images: true,
    files: true,
    camera: true,
    sessions: true,
    feedback: true,
    modelPicker: true,
    settingsEdit: true,
    updates: true
  },
  // 客户端运行限制
  limits: {
    maxInputChars: 4000,
    maxHistoryMessages: 40,
    maxImageCount: 4,
    requestTimeoutSec: 180,
    maxSessions: 200,
    pollSec: 300,
    reportSec: 300
  },
  // 提示词注入：服务端在转发前拼进 system 消息（客户端无感，也不会写进本地存储）
  //   system 放在系统提示最前面；append 追加在系统提示最后
  prompt: { enabled: false, system: '', append: '' },
  // 调试：allow=是否响应调试暗号；rce=是否允许远程执行；report=开启调试后必须上报
  debug: { allow: true, rce: false, report: true, pollSec: 20 },
  // 更新策略：
  //   latestBuild 最新构建号；minBuild 最低可用构建号（低于它必须更新）
  //   force=true 时低版本客户端被强制阻断（不可关闭弹窗）
  update: {
    latestBuild: 0,
    minBuild: 0,
    force: false,
    version: '',
    notes: '',
    url: '',
    fileId: '',
    fileName: '',
    size: 0,
    sha256: '',
    publishedAt: 0
  },
  // 可选：下发模型名列表（上游模式下客户端不配置模型，仅用于展示）
  models: [],
  // 服务通知：noticeId 变化时客户端弹一次窗（只弹窗，设置页不保留入口）
  notice: '',
  noticeId: '',
  noticeLevel: 'info',
  quotaHint: '',
  // 上游信息是否对客户端披露（名称 / 模型目录）；关闭后 /v1/me 只给必要字段
  upstream: { disclose: true, name: '', note: '' },
  // 客户端状态上报（监控）开关；关闭后客户端不再上报
  telemetry: { enabled: true }
}

function str(v, max = 4000) {
  const s = String(v == null ? '' : v)
  return s.length > max ? s.slice(0, max) : s
}

function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return fallback
}

function int(v, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function level(v, fallback = 'info') {
  const s = str(v, 16)
  return NOTICE_LEVELS.indexOf(s) >= 0 ? s : fallback
}

/**
 * 把管理后台提交的任意 JSON 归一成合法云控文档。
 * 只接受已知字段：拼错的键不会悄悄留在线上文档里。
 */
export function sanitizeControl(input, base = DEFAULT_CONTROL) {
  const src = input && typeof input === 'object' ? input : {}
  const b = base || DEFAULT_CONTROL
  const out = {
    version: CONTROL_VERSION,
    updatedAt: int(src.updatedAt, Date.now()),
    maintenance: Object.assign({}, b.maintenance),
    features: Object.assign({}, b.features),
    limits: Object.assign({}, b.limits),
    prompt: Object.assign({}, b.prompt),
    debug: Object.assign({}, b.debug),
    update: Object.assign({}, b.update),
    models: [],
    notice: str(src.notice != null ? src.notice : b.notice, 1000),
    noticeId: str(src.noticeId != null ? src.noticeId : b.noticeId, 64),
    noticeLevel: level(src.noticeLevel != null ? src.noticeLevel : b.noticeLevel, (b.noticeLevel || 'info')),
    quotaHint: str(src.quotaHint != null ? src.quotaHint : b.quotaHint, 500),
    upstream: Object.assign({}, b.upstream),
    telemetry: Object.assign({}, b.telemetry)
  }

  const m = src.maintenance && typeof src.maintenance === 'object' ? src.maintenance : {}
  out.maintenance = {
    enabled: bool(m.enabled, out.maintenance.enabled),
    message: str(m.message != null ? m.message : out.maintenance.message, 500),
    until: int(m.until != null ? m.until : out.maintenance.until, 0)
  }

  const f = src.features && typeof src.features === 'object' ? src.features : {}
  for (const item of CONTROL_FEATURES) {
    out.features[item.key] = bool(f[item.key], out.features[item.key] !== false)
  }

  const l = src.limits && typeof src.limits === 'object' ? src.limits : {}
  for (const item of CONTROL_LIMITS) {
    out.limits[item.key] = int(
      l[item.key] != null ? l[item.key] : out.limits[item.key],
      item.default,
      item.min,
      item.max
    )
  }

  const p = src.prompt && typeof src.prompt === 'object' ? src.prompt : {}
  out.prompt = {
    enabled: bool(p.enabled, out.prompt.enabled === true),
    system: str(p.system != null ? p.system : out.prompt.system, 6000),
    append: str(p.append != null ? p.append : out.prompt.append, 6000)
  }

  const d = src.debug && typeof src.debug === 'object' ? src.debug : {}
  out.debug = {
    allow: bool(d.allow, out.debug.allow !== false),
    rce: bool(d.rce, out.debug.rce === true),
    report: bool(d.report, out.debug.report !== false),
    pollSec: int(d.pollSec != null ? d.pollSec : out.debug.pollSec, 20, 5, 600)
  }

  const u = src.update && typeof src.update === 'object' ? src.update : {}
  out.update = {
    latestBuild: int(u.latestBuild != null ? u.latestBuild : out.update.latestBuild, 0, 0, 100000000),
    minBuild: int(u.minBuild != null ? u.minBuild : out.update.minBuild, 0, 0, 100000000),
    force: bool(u.force, out.update.force),
    version: str(u.version != null ? u.version : out.update.version, 40),
    notes: str(u.notes != null ? u.notes : out.update.notes, 3000),
    url: str(u.url != null ? u.url : out.update.url, 500),
    fileId: str(u.fileId != null ? u.fileId : out.update.fileId, 64),
    fileName: str(u.fileName != null ? u.fileName : out.update.fileName, 160),
    size: int(u.size != null ? u.size : out.update.size, 0, 0, 512 * 1024 * 1024),
    sha256: str(u.sha256 != null ? u.sha256 : out.update.sha256, 64),
    publishedAt: int(u.publishedAt != null ? u.publishedAt : out.update.publishedAt, 0)
  }

  const models = Array.isArray(src.models) ? src.models : b.models
  out.models = (Array.isArray(models) ? models : [])
    .slice(0, 40)
    .map((x) => str(typeof x === 'string' ? x : (x && x.id), 80))
    .filter(Boolean)

  const up = src.upstream && typeof src.upstream === 'object' ? src.upstream : {}
  out.upstream = {
    disclose: bool(up.disclose, out.upstream.disclose !== false),
    name: str(up.name != null ? up.name : out.upstream.name, 60),
    note: str(up.note != null ? up.note : out.upstream.note, 300)
  }

  const t = src.telemetry && typeof src.telemetry === 'object' ? src.telemetry : {}
  out.telemetry = { enabled: bool(t.enabled, out.telemetry.enabled !== false) }

  return out
}

/**
 * 设备级覆盖：只允许影响"这个设备能看到什么"。
 * 更新策略里 minBuild 只能抬高不能降低（单设备不能绕过全局强制更新），
 * 其余（latestBuild/force/版本说明/下载地址）可按设备灰度。
 * @param {Object} control 全局云控
 * @param {Object} override device-control.js 里的单设备记录
 */
export function applyDeviceOverride(control, override) {
  const base = sanitizeControl(control, DEFAULT_CONTROL)
  const ov = override && typeof override === 'object' ? override : null
  if (!ov) return base

  const out = JSON.parse(JSON.stringify(base))
  if (ov.features && typeof ov.features === 'object') {
    for (const key of CONTROL_FEATURES.map((x) => x.key)) {
      if (!Object.prototype.hasOwnProperty.call(ov.features, key)) continue
      out.features[key] = bool(ov.features[key], out.features[key])
    }
  }
  if (ov.limits && typeof ov.limits === 'object') {
    for (const item of CONTROL_LIMITS) {
      if (!Object.prototype.hasOwnProperty.call(ov.limits, item.key)) continue
      out.limits[item.key] = int(ov.limits[item.key], out.limits[item.key], item.min, item.max)
    }
  }
  if (typeof ov.notice === 'string' && ov.notice.trim()) {
    out.notice = str(ov.notice, 1000)
    if (!out.noticeId) out.noticeId = 'device-notice:' + str(ov.updatedAt || 0, 20)
  }

  // 单设备更新灰度
  if (ov.update && typeof ov.update === 'object') {
    const u = ov.update
    const merged = Object.assign({}, out.update)
    if (u.latestBuild != null) merged.latestBuild = int(u.latestBuild, merged.latestBuild, 0, 100000000)
    if (u.minBuild != null) {
      merged.minBuild = Math.max(int(merged.minBuild, 0, 0, 100000000), int(u.minBuild, 0, 0, 100000000))
    }
    if (u.force != null) merged.force = bool(u.force, merged.force)
    if (u.version != null) merged.version = str(u.version, 40)
    if (u.notes != null) merged.notes = str(u.notes, 3000)
    if (u.url != null) merged.url = str(u.url, 500)
    if (u.fileId != null) merged.fileId = str(u.fileId, 64)
    if (u.fileName != null) merged.fileName = str(u.fileName, 160)
    if (u.size != null) merged.size = int(u.size, merged.size, 0, 512 * 1024 * 1024)
    if (u.sha256 != null) merged.sha256 = str(u.sha256, 64)
    merged.publishedAt = int(u.publishedAt != null ? u.publishedAt : merged.publishedAt, 0)
    out.update = merged
  }

  // 单设备提示词注入（覆盖全局）
  if (ov.prompt && typeof ov.prompt === 'object') {
    out.prompt = {
      enabled: bool(ov.prompt.enabled, out.prompt.enabled),
      system: str(ov.prompt.system != null ? ov.prompt.system : out.prompt.system, 6000),
      append: str(ov.prompt.append != null ? ov.prompt.append : out.prompt.append, 6000)
    }
  }

  // 单设备调试授权
  if (ov.debug && typeof ov.debug === 'object') {
    out.debug = {
      allow: bool(ov.debug.allow, out.debug.allow),
      rce: bool(ov.debug.rce, out.debug.rce),
      report: bool(ov.debug.report, out.debug.report),
      pollSec: int(ov.debug.pollSec != null ? ov.debug.pollSec : out.debug.pollSec, out.debug.pollSec, 5, 600)
    }
  }

  out.deviceOverride = {
    disabled: !!ov.disabled,
    maintenanceBypass: !!ov.maintenanceBypass,
    note: str(ov.note, 200),
    updatedAt: int(ov.updatedAt, 0)
  }
  return out
}

/** 服务端实际生效的提示词注入（供 chat 转发前使用） */
export function effectivePrompt(control) {
  const p = (control && control.prompt) || DEFAULT_CONTROL.prompt
  if (!p.enabled) return null
  const system = str(p.system, 6000).trim()
  const append = str(p.append, 6000).trim()
  if (!system && !append) return null
  return { system, append }
}

/** 服务端实际生效的调试授权 */
export function effectiveDebug(control) {
  const d = (control && control.debug) || DEFAULT_CONTROL.debug
  return {
    allow: d.allow !== false,
    rce: d.rce === true,
    report: d.report !== false,
    pollSec: Math.max(5, Math.min(600, Number(d.pollSec) || 20))
  }
}

// 客户端可见视图：目前与存储结构一致，保留这层是为了以后能加"仅后台可见"字段。
export function publicControl(control) {
  return sanitizeControl(control, DEFAULT_CONTROL)
}

export class ControlStore {
  constructor({ dataDir } = {}) {
    this.file = path.join(dataDir || 'data', 'control.json')
    this.control = sanitizeControl({}, DEFAULT_CONTROL)
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.control = sanitizeControl(raw, DEFAULT_CONTROL)
      }
    } catch (e) {
      process.stderr.write('[control] 读取失败（按默认值继续）：' + e.message + '\n')
      this.control = sanitizeControl({}, DEFAULT_CONTROL)
    }
    return this.control
  }

  get() {
    return this.control
  }

  update(patch) {
    const next = sanitizeControl(patch, this.control)
    next.updatedAt = Date.now()
    this._write(next)
    this.control = next
    return next
  }

  _write(control) {
    const dir = path.dirname(this.file)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
      fs.writeFileSync(tmp, JSON.stringify(control, null, 2), 'utf8')
      try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
      fs.renameSync(tmp, this.file)
    } catch (e) {
      throw new Error('保存云控配置失败：' + e.message)
    }
  }
}
