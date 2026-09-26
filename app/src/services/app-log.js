// 应用侧文件日志：默认开启，写入 $dataDir/ds-app.log（追加模式）。
// 用于真机问题定位——console 输出在设备上不可见，文件日志可直接读。
// 覆盖：部署、重启、健康检查、设置加载、主题切换等关键流程。
//
// 注意：SDK fs 无 appendFile，只能 read-then-write；且 readFile 是异步（返回 Promise）。
// 之前实现未 await，导致 String(Promise)='[object Promise]' 覆盖整个文件、只剩最后一行。
// 现在用 Promise 队列串行化，保证追加且不乱序。

import fs from 'fs'

const LOG_FILE = () => String($dataDir || '/tmp/').replace(/\/+$/, '') + '/ds-app.log'
const MAX_LOG_LINES = 500

let logQueue = Promise.resolve()

// 追加一行日志（带时间戳）。串行队列保证多行不互相覆盖。失败静默，不影响主流程。
export function appLog(...args) {
  const line = new Date().toISOString() + ' | ' + args.map(String).join(' ')
  logQueue = logQueue.then(() => doAppend(line)).catch(() => {})
  return logQueue
}

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
        await fs.writeFile(LOG_FILE() + '.old', oldLines.slice(-1000).join('\n'))
      } catch (e) { /* 忽略 */ }
      trimmed = lines.slice(-MAX_LOG_LINES).join('\n')
    }
    await fs.writeFile(LOG_FILE(), trimmed)
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

// 清空应用日志（含上一份）
export async function appLogClear() {
  try { await fs.writeFile(LOG_FILE(), '') } catch (e) { /* 忽略 */ }
  try { await fs.writeFile(LOG_FILE() + '.old', '') } catch (e) { /* 忽略 */ }
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
  try { await fs.writeFile(BACKEND_LOG_FILE(0), '') } catch (e) { /* 忽略 */ }
  try { await fs.writeFile(BACKEND_LOG_FILE(1), '') } catch (e) { /* 忽略 */ }
}

// ---------- 网络抓取（ds-free-api net-capture.jsonl） ----------
// 「启用调试日志」开关联动抓取的上游报文（后端 net_capture.rs 落盘，JSONL
// 每行一个事件）。行内容是大 JSON，展示层按 600 字符截断——完整内容
// 以文件为准（$dataDir/ds-free-api/logs/net-capture.jsonl，可经 miniapp_cli 拉取）。
// gen 与后端轮转对齐：0=当前，1=.1（后端超 5MB 顺移）。
const NET_CAPTURE_FILE = (gen = 0) =>
  String($dataDir || '/tmp/').replace(/\/+$/, '') +
  '/ds-free-api/logs/net-capture.jsonl' + (gen === 1 ? '.1' : gen === 2 ? '.2' : '')

export async function netCaptureTail(n = 20, gen = 0) {
  try {
    const raw = String(await fs.readFile(NET_CAPTURE_FILE(gen)) || '')
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => (l.length > 600 ? l.slice(0, 600) + '…(' + l.length + '字符)' : l))
      .join('\n')
  } catch (e) {
    return ''
  }
}

export async function netCaptureClear() {
  for (const gen of [0, 1, 2]) {
    try { await fs.writeFile(NET_CAPTURE_FILE(gen), '') } catch (e) { /* 忽略 */ }
  }
}
