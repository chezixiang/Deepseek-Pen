// 远程调试命令队列：后台给"开启调试模式且被授权 RCE"的设备下发一次性命令，
// 设备轮询取走、执行、回传结果。
//
// 安全边界：
//   1) 只有 /v1/control 下发的 debug.rce=true 的设备能取命令（server.js 判定）；
//   2) 命令只在内存/小文件里短存，默认 24 小时过期；
//   3) 结果只保留最近 N 条，避免设备刷爆磁盘。
//
// 存储：data/debug.json

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX_COMMANDS = 30
const MAX_RESULTS = 40
const TTL_MS = 24 * 3600 * 1000

function text(v, max) {
  return String(v == null ? '' : v).slice(0, max)
}

export class DebugQueue {
  constructor({ dataDir, maxCommands = MAX_COMMANDS, maxResults = MAX_RESULTS } = {}) {
    this.file = path.join(dataDir || 'data', 'debug.json')
    this.maxCommands = Math.max(1, Number(maxCommands) || MAX_COMMANDS)
    this.maxResults = Math.max(1, Number(maxResults) || MAX_RESULTS)
    this.devices = {}
    this._waiters = [] // 长轮询等待者（takeWait 注册，enqueue 唤醒）
    this._timer = null
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        const devices = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {}
        for (const [id, rec] of Object.entries(devices)) {
          this.devices[id] = {
            commands: Array.isArray(rec.commands) ? rec.commands.slice(-this.maxCommands) : [],
            results: Array.isArray(rec.results) ? rec.results.slice(-this.maxResults) : []
          }
        }
      }
    } catch (e) {
      process.stderr.write('[debug] 读取失败（从空开始）：' + e.message + '\n')
      this.devices = {}
    }
    return this.devices
  }

  _scheduleWrite() {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, 300)
    if (this._timer.unref) this._timer.unref()
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), devices: this.devices }), 'utf8')
      try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
      fs.renameSync(tmp, this.file)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* 忽略 */ }
      process.stderr.write('[debug] 写入失败：' + e.message + '\n')
    }
  }

  _rec(deviceId) {
    const id = String(deviceId || '')
    if (!this.devices[id]) this.devices[id] = { commands: [], results: [] }
    return this.devices[id]
  }

  /**
   * 入队一条命令。
   * @param {string} deviceId
   * @param {{type?:string, code?:string, cmd?:string, title?:string, operator?:string}} input
   */
  enqueue(deviceId, input = {}) {
    const id = String(deviceId || '')
    if (!id) throw new Error('缺少 deviceId')
    const type = ['eval', 'shell'].indexOf(String(input.type || 'eval')) >= 0 ? String(input.type || 'eval') : 'eval'
    const code = text(input.code, 20000)
    const cmd = text(input.cmd, 4000)
    if (type === 'eval' && !code.trim()) throw new Error('代码不能为空')
    if (type === 'shell' && !cmd.trim()) throw new Error('命令不能为空')
    const rec = this._rec(id)
    // shell 命令可指定超时（秒），设备端等待命令产物的时间上限（2~60，默认走设备端 15s）
    let timeoutSec
    if (type === 'shell') {
      const ts = Math.trunc(Number(input.timeoutSec) || 0)
      timeoutSec = ts > 0 ? Math.min(60, Math.max(2, ts)) : undefined
    }
    const item = {
      id: 'cmd_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
      type,
      code: type === 'eval' ? code : '',
      cmd: type === 'shell' ? cmd : '',
      timeoutSec,
      title: text(input.title, 120),
      operator: text(input.operator, 60),
      createdAt: Date.now(),
      deliveredAt: 0
    }
    rec.commands.push(item)
    // 只保留未取走的 + 最近取走的，避免无限增长
    if (rec.commands.length > this.maxCommands) rec.commands = rec.commands.slice(-this.maxCommands)
    this._scheduleWrite()
    // 即时唤醒长轮询中的设备：命令在入队的同一毫秒就可被取走
    this._wake(id)
    return item
  }

  /** 设备轮询：返回未过期的命令，并标记已投递（同一命令不会重复投递） */
  take(deviceId) {
    const rec = this._rec(deviceId)
    const now = Date.now()
    rec.commands = rec.commands.filter((c) => now - (c.createdAt || 0) <= TTL_MS)
    const out = rec.commands.filter((c) => !c.deliveredAt)
    const ts = Date.now()
    for (const c of out) c.deliveredAt = ts
    if (out.length) this._scheduleWrite()
    return out
  }

  /**
   * 长轮询：最多等待 waitMs，直到有命令可取或超时。
   * 让「后台下发 → 设备执行」的延迟从最长 pollSec（客户端轮询间隔）
   * 降到命令入队后的一个网络往返，等效主动推送。
   * enqueue() 会即时唤醒等待者；超时兜底返回当次 take() 结果（可能为空数组）。
   * @returns {Promise<Array>}
   */
  takeWait(deviceId, waitMs = 0) {
    const wait = Math.max(0, Math.min(30000, Math.trunc(Number(waitMs) || 0)))
    const first = this.take(deviceId)
    if (first.length || wait <= 0) return Promise.resolve(first)
    return new Promise((resolve) => {
      let settled = false
      const finish = (commands) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._waiters = this._waiters.filter((w) => w !== wake)
        resolve(commands || [])
      }
      const wake = () => {
        if (settled) return
        const got = this.take(deviceId)
        if (got.length) finish(got)
      }
      this._waiters.push(wake)
      const timer = setTimeout(() => finish(this.take(deviceId)), wait)
      if (timer.unref) timer.unref()
    })
  }

  /** 唤醒该设备的所有长轮询等待者（enqueue 后调用；单进程内同步注册无竞态） */
  _wake(deviceId) {
    const id = String(deviceId || '')
    for (const w of this._waiters.slice()) {
      try { w(id) } catch (_) { /* 忽略单个唤醒失败 */ }
    }
  }

  /** 设备回传执行结果 */
  complete(deviceId, input = {}) {
    const rec = this._rec(deviceId)
    const id = text(input.id, 64)
    if (!id) return null
    rec.commands = rec.commands.filter((c) => c.id !== id)
    const entry = {
      id,
      ok: !!input.ok,
      output: text(input.output, 12000),
      error: text(input.error, 4000),
      durationMs: Math.max(0, Math.trunc(Number(input.durationMs) || 0)),
      at: Date.now()
    }
    rec.results.push(entry)
    if (rec.results.length > this.maxResults) rec.results = rec.results.slice(-this.maxResults)
    this._scheduleWrite()
    return entry
  }

  view(deviceId) {
    const rec = this.devices[String(deviceId || '')] || { commands: [], results: [] }
    const now = Date.now()
    return {
      deviceId: String(deviceId || ''),
      pending: rec.commands.filter((c) => !c.deliveredAt && now - (c.createdAt || 0) <= TTL_MS),
      delivered: rec.commands.filter((c) => c.deliveredAt && now - (c.createdAt || 0) <= TTL_MS),
      results: rec.results.slice().reverse()
    }
  }

  clear(deviceId) {
    const id = String(deviceId || '')
    const had = !!this.devices[id]
    delete this.devices[id]
    if (had) this._scheduleWrite()
    return had
  }

  close() {
    this.flush()
  }
}
