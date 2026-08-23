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
    const trimmed = lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES).join('\n') : next
    await fs.writeFile(LOG_FILE(), trimmed)
  } catch (e) { /* 忽略 */ }
}

// 读取最近 N 行日志（供设置页"查看诊断日志"展示）
export async function appLogTail(n = 10) {
  try {
    const raw = String(await fs.readFile(LOG_FILE()) || '')
    return raw.split('\n').filter(Boolean).slice(-n).join('\n')
  } catch (e) {
    return ''
  }
}
