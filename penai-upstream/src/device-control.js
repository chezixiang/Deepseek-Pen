// 单设备云控覆盖：在全局云控之外，对某一台设备单独下发开关 / 限制 / 限额 /
// 更新灰度 / 提示词 / 调试授权 / 定向公告 / 备注。
//
// 用途（后台"设备详情"里操作）：
//   - 临时停用某台设备（不发消息，但仍能拉云控看到提示）
//   - 维护期间给测试机开白名单
//   - 给个别设备放宽/收紧额度，而不影响全局
//   - 灰度更新：只让这台设备看到某个构建号
//   - 给这台设备单独注入提示词 / 单独下发一条公告
//   - 只允许这台设备响应调试暗号、执行远程命令
//
// 存储：data/device-control.json（小文件，原子写；只保存显式设置过的键）。
// 与 quota.json / provider.json 一样：后台保存即生效，重启保留。

import fs from 'node:fs'
import path from 'node:path'
import { CONTROL_FEATURES, CONTROL_LIMITS } from './control.js'
import { normalizeQuotaOverride } from './quota-config.js'

const FEATURE_KEYS = CONTROL_FEATURES.map((f) => f.key)
const LIMIT_KEYS = CONTROL_LIMITS.map((l) => l.key)

function bool(v) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return false
}

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function int(v, min, max) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(min, n))
}

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/**
 * 归一单设备覆盖。未提交的键不会出现在结果里（= 沿用全局值）。
 * 提交空对象会被判定为"清空该设备覆盖"。
 */
export function sanitizeDeviceOverride(input, base = null) {
  const src = input && typeof input === 'object' ? input : {}
  const b = base && typeof base === 'object' ? base : {}
  const out = {}

  for (const key of ['disabled', 'maintenanceBypass']) {
    if (has(src, key)) out[key] = bool(src[key])
    else if (has(b, key)) out[key] = !!b[key]
  }
  if (has(src, 'note')) out.note = text(src.note, 200)
  else if (b.note) out.note = text(b.note, 200)
  if (has(src, 'notice')) out.notice = text(src.notice, 500)
  else if (b.notice) out.notice = text(b.notice, 500)

  const fsrc = src.features && typeof src.features === 'object' ? src.features : null
  const fbase = b.features && typeof b.features === 'object' ? b.features : null
  const features = {}
  for (const key of FEATURE_KEYS) {
    if (fsrc && has(fsrc, key)) features[key] = bool(fsrc[key])
    else if (fbase && has(fbase, key)) features[key] = !!fbase[key]
  }
  if (Object.keys(features).length) out.features = features

  const lsrc = src.limits && typeof src.limits === 'object' ? src.limits : null
  const lbase = b.limits && typeof b.limits === 'object' ? b.limits : null
  const limits = {}
  for (const item of CONTROL_LIMITS) {
    if (lsrc && has(lsrc, item.key)) {
      limits[item.key] = int(lsrc[item.key], item.min, item.max)
    } else if (lbase && has(lbase, item.key)) {
      limits[item.key] = int(lbase[item.key], item.min, item.max)
    }
  }
  if (Object.keys(limits).length) out.limits = limits

  // quota: null / 缺省 = 不覆盖；显式提交对象才记录
  if (has(src, 'quota')) {
    const q = normalizeQuotaOverride(src.quota)
    if (q) out.quota = q
  } else if (b.quota) {
    out.quota = Object.assign({}, b.quota)
  }

  // ---- 更新灰度 ----
  const usrc = src.update && typeof src.update === 'object' ? src.update : null
  const ubase = b.update && typeof b.update === 'object' ? b.update : null
  if (usrc || ubase) {
    const u = {}
    const pick = (k) => (usrc && has(usrc, k) ? usrc[k] : (ubase ? ubase[k] : undefined))
    const lb = pick('latestBuild')
    const mb = pick('minBuild')
    const fo = pick('force')
    const ve = pick('version')
    const no = pick('notes')
    const ur = pick('url')
    const fid = pick('fileId')
    const fn = pick('fileName')
    const sz = pick('size')
    const sh = pick('sha256')
    const pa = pick('publishedAt')
    if (lb !== undefined) u.latestBuild = int(lb, 0, 100000000)
    if (mb !== undefined) u.minBuild = int(mb, 0, 100000000)
    if (fo !== undefined) u.force = bool(fo)
    if (ve !== undefined) u.version = text(ve, 40)
    if (no !== undefined) u.notes = text(no, 3000)
    if (ur !== undefined) u.url = text(ur, 500)
    if (fid !== undefined) u.fileId = text(fid, 64)
    if (fn !== undefined) u.fileName = text(fn, 160)
    if (sz !== undefined) u.size = int(sz, 0, 512 * 1024 * 1024)
    if (sh !== undefined) u.sha256 = text(sh, 64)
    if (pa !== undefined) u.publishedAt = int(pa, 0, Number.MAX_SAFE_INTEGER)
    if (Object.keys(u).length) out.update = u
  }

  // ---- 提示词 ----
  const psrc = src.prompt && typeof src.prompt === 'object' ? src.prompt : null
  const pbase = b.prompt && typeof b.prompt === 'object' ? b.prompt : null
  if (psrc || pbase) {
    const p = {}
    const pick = (k) => (psrc && has(psrc, k) ? psrc[k] : (pbase ? pbase[k] : undefined))
    const en = pick('enabled')
    const sy = pick('system')
    const ap = pick('append')
    if (en !== undefined) p.enabled = bool(en)
    if (sy !== undefined) p.system = text(sy, 6000)
    if (ap !== undefined) p.append = text(ap, 6000)
    if (Object.keys(p).length) out.prompt = p
  }

  // ---- 调试授权 ----
  const dsrc = src.debug && typeof src.debug === 'object' ? src.debug : null
  const dbase = b.debug && typeof b.debug === 'object' ? b.debug : null
  if (dsrc || dbase) {
    const d = {}
    const pick = (k) => (dsrc && has(dsrc, k) ? dsrc[k] : (dbase ? dbase[k] : undefined))
    const al = pick('allow')
    const rc = pick('rce')
    const rp = pick('report')
    const ps = pick('pollSec')
    if (al !== undefined) d.allow = bool(al)
    if (rc !== undefined) d.rce = bool(rc)
    if (rp !== undefined) d.report = bool(rp)
    if (ps !== undefined) d.pollSec = int(ps, 5, 600)
    if (Object.keys(d).length) out.debug = d
  }

  return out
}

export function deviceControlPath(dataDir) {
  return path.join(dataDir || 'data', 'device-control.json')
}

/**
 * 校验后台提交的单设备覆盖：宁可明确报错，也不要静默 clamp。
 * @throws {Error} code = 'bad_override'
 */
export function validateDeviceOverride(input) {
  if (input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    const err = new Error('请求体必须是 JSON 对象')
    err.code = 'bad_override'
    throw err
  }
  const src = input || {}
  const f = src.features
  if (f !== undefined && (typeof f !== 'object' || Array.isArray(f) || f === null)) {
    const err = new Error('features 必须是对象')
    err.code = 'bad_override'
    throw err
  }
  if (f) {
    for (const key of Object.keys(f)) {
      if (FEATURE_KEYS.indexOf(key) < 0) {
        const err = new Error('未知的功能开关：' + key)
        err.code = 'bad_override'
        throw err
      }
    }
  }
  const l = src.limits
  if (l !== undefined && (typeof l !== 'object' || Array.isArray(l) || l === null)) {
    const err = new Error('limits 必须是对象')
    err.code = 'bad_override'
    throw err
  }
  if (l) {
    for (const key of Object.keys(l)) {
      const item = CONTROL_LIMITS.filter((x) => x.key === key)[0]
      if (!item) {
        const err = new Error('未知的客户端限制：' + key)
        err.code = 'bad_override'
        throw err
      }
      const n = Number(l[key])
      if (!Number.isFinite(n) || n < item.min || n > item.max) {
        const err = new Error(item.label + ' 需在 ' + item.min + '~' + item.max + ' 之间')
        err.code = 'bad_override'
        throw err
      }
    }
  }
  if (src.quota !== undefined && src.quota !== null) {
    if (typeof src.quota !== 'object' || Array.isArray(src.quota)) {
      const err = new Error('quota 必须是对象或 null')
      err.code = 'bad_override'
      throw err
    }
    for (const [key, val] of Object.entries(src.quota)) {
      if (key === 'enabled') continue
      const item = ['maxConcurrent', 'rpm', 'tpm', 'fiveHourTokens', 'dailyTokens', 'monthlyTokens'].indexOf(key) >= 0
      const n = Number(val)
      if (!item) {
        const err = new Error('未知的限额项：' + key)
        err.code = 'bad_override'
        throw err
      }
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error('限额项 ' + key + ' 不能为负数')
        err.code = 'bad_override'
        throw err
      }
    }
  }
  if (src.update !== undefined) {
    if (typeof src.update !== 'object' || Array.isArray(src.update) || src.update === null) {
      const err = new Error('update 必须是对象')
      err.code = 'bad_override'
      throw err
    }
    for (const key of ['latestBuild', 'minBuild']) {
      if (src.update[key] === undefined) continue
      const n = Number(src.update[key])
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error('构建号不能为负数')
        err.code = 'bad_override'
        throw err
      }
    }
  }
  if (src.prompt !== undefined) {
    if (typeof src.prompt !== 'object' || Array.isArray(src.prompt) || src.prompt === null) {
      const err = new Error('prompt 必须是对象')
      err.code = 'bad_override'
      throw err
    }
  }
  if (src.debug !== undefined) {
    if (typeof src.debug !== 'object' || Array.isArray(src.debug) || src.debug === null) {
      const err = new Error('debug 必须是对象')
      err.code = 'bad_override'
      throw err
    }
    if (src.debug.pollSec !== undefined) {
      const n = Number(src.debug.pollSec)
      if (!Number.isFinite(n) || n < 5 || n > 600) {
        const err = new Error('调试轮询间隔需在 5~600 秒之间')
        err.code = 'bad_override'
        throw err
      }
    }
  }
  return true
}

export class DeviceControlStore {
  constructor({ dataDir } = {}) {
    this.file = deviceControlPath(dataDir)
    this.map = {}
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        const devices = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {}
        for (const [id, ov] of Object.entries(devices)) {
          const clean = sanitizeDeviceOverride(ov, null)
          if (Object.keys(clean).length) this.map[String(id)] = clean
        }
      }
    } catch (e) {
      process.stderr.write('[device-control] 读取失败（忽略覆盖）：' + e.message + '\n')
      this.map = {}
    }
    return this.map
  }

  _write() {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const payload = { version: 2, updatedAt: Date.now(), devices: this.map }
    const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
    fs.renameSync(tmp, this.file)
  }

  get(deviceId) {
    const id = String(deviceId || '')
    const ov = this.map[id]
    return ov ? Object.assign({ deviceId: id }, ov) : null
  }

  list() {
    return Object.keys(this.map).map((id) => Object.assign({ deviceId: id }, this.map[id]))
  }

  /** 合并式保存；结果为空则等同于清除该设备覆盖。 */
  set(deviceId, patch) {
    const id = String(deviceId || '')
    if (!id) throw new Error('缺少 deviceId')
    const next = sanitizeDeviceOverride(patch, this.map[id] || null)
    if (!Object.keys(next).length) {
      delete this.map[id]
      this._write()
      return null
    }
    next.updatedAt = Date.now()
    this.map[id] = next
    this._write()
    return Object.assign({ deviceId: id }, next)
  }

  clear(deviceId) {
    const id = String(deviceId || '')
    const had = !!this.map[id]
    delete this.map[id]
    if (had) this._write()
    return had
  }

  /** 后台列表用的紧凑摘要 */
  summary(deviceId) {
    const ov = this.get(deviceId)
    if (!ov) return null
    const off = Object.keys(ov.features || {}).filter((k) => ov.features[k] === false)
    const quotaKeys = Object.keys(ov.quota || {})
    return {
      disabled: !!ov.disabled,
      maintenanceBypass: !!ov.maintenanceBypass,
      note: ov.note || '',
      notice: ov.notice || '',
      updatedAt: ov.updatedAt || 0,
      featuresOff: off,
      limits: Object.keys(ov.limits || {}),
      quotaOverride: quotaKeys.length ? ov.quota : null,
      updateOverride: ov.update || null,
      promptOverride: ov.prompt ? { enabled: !!ov.prompt.enabled, chars: (ov.prompt.system || '').length + (ov.prompt.append || '').length } : null,
      debug: ov.debug || null
    }
  }
}
