// 远程调试轮询：只在「设备开启调试模式 + 云控授权 debug.rce」时运行。
//
// 云控 v3 的授权分两层：
//   debug.allow  是否允许这台设备响应调试暗号（设置页连续点版本号 + 密钥）
//   debug.rce    是否允许远程执行（本模块）
// 服务端每次拉云控都会带最新授权；这里用调用方传入的 control 文档判断。
//
// 支持两类命令（服务端 debug-queue 已内置两种类型）：
//   type=eval    JS 代码，在页面沙箱里跑（new Function，提供极少量只读 helper）
//   type=shell   shell 命令，走 native.execShell（root）。execShell 无回显且异步，
//                约定：输出重定向到应用数据目录的结果文件，尾部追加 __RCE_EXIT:<code>
//                哨兵行，轮询读回；超时（默认 15s，可由 cmd.timeoutSec 指定）后放弃。
//
// 安全边界：命令只接受服务端下发的队列内容；shell 以 root 运行，风险等同部署
// 后端时的既有 execShell 使用面，靠云控 debug.allow/rce 双开关约束。
// 执行结果（成功/异常/耗时）回传后台，便于在「设备 → 调试控制台」查看。

import { ensureUpstreamAuth, upstreamBase, fetchDebugCommands, reportDebugResult, debugGate } from './cloud-control.js'
import { execShell, shellAvailable, readFile, sleep, shq, dataDirBase, joinPath } from './native.js'
import { BUILD_NUM, appLog, appLogError, debugLog } from './store.js'

let active = false
let loopGen = 0
let currentKey = ''

// 长轮询参数：服务端最多挂住 25s（须小于 Nginx proxy_read_timeout 60s）；
// HTTP 硬超时 = 挂住时长 + 12s 余量（native http 模块的实现会再加 5s 兜底）。
const LP_WAIT_SEC = 25
const LP_HTTP_TIMEOUT_MS = (LP_WAIT_SEC + 12) * 1000

// shell 命令超时上限与输出截断长度（服务端 complete() 会再按 12000 字符截断）
const SHELL_DEFAULT_TIMEOUT_SEC = 15
const SHELL_MAX_TIMEOUT_SEC = 60
const SHELL_OUTPUT_MAX = 12000
const RCE_EXIT_MARK = '__RCE_EXIT:'

function safeStringify(value) {
  try {
    if (value === undefined) return 'undefined'
    if (typeof value === 'string') return value.slice(0, 8000)
    const text = JSON.stringify(value)
    return text && text.length > 8000 ? text.slice(0, 8000) + '…' : String(text)
  } catch (e) {
    return String(value)
  }
}

// 在页面上下文执行代码；提供极少量只读 helper（build/now/log），
// 不暴露 settings/凭据，避免一条命令把设备令牌带出去。
function executeRemote(code) {
  const started = Date.now()
  const helpers = {
    build: Number(BUILD_NUM) || 0,
    now: Date.now(),
    log: function () {
      const parts = []
      for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]))
      appLog('[rce] ' + parts.join(' '))
      return true
    }
  }
  try {
    // 允许命令体直接写 return；用 Function 而非 eval，避免污染当前作用域
    const fn = new Function('__ds', '"use strict";\n' + String(code || ''))
    const result = fn(helpers)
    return { ok: true, output: safeStringify(result), durationMs: Date.now() - started }
  } catch (e) {
    const message = e && e.stack ? String(e.stack) : String(e)
    appLogError('rce.exec', e, message.slice(0, 200))
    return { ok: false, error: message.slice(0, 4000), durationMs: Date.now() - started }
  }
}

// 执行 shell 命令并回收 stdout/stderr/exit code。
// execShell 异步且无回显（native.js 既有约定），所以把输出整体重定向到结果文件，
// 命令结束后追加哨兵行；这里轮询哨兵出现为止。root 运行，文件对应用进程可读
// 需要 chmod（个别机型应用进程非 root，读不了 root 的 0600 文件）。
async function executeShellCommand(cmd, timeoutSec) {
  const started = Date.now()
  if (!shellAvailable()) {
    return { ok: false, error: '设备不支持 execShell（Global 不可用）', durationMs: 0 }
  }
  const timeoutMs = Math.min(SHELL_MAX_TIMEOUT_SEC, Math.max(2, Number(timeoutSec) || SHELL_DEFAULT_TIMEOUT_SEC)) * 1000
  const out = joinPath(dataDirBase(), 'rce-out-' + String(cmd.id || 'x').replace(/[^a-zA-Z0-9_-]/g, '') + '.txt')
  const quoted = shq(out)
  execShell('rm -f ' + quoted + ' 2>/dev/null || true')
  // 子 shell 收编全部输出；命令本身可能带换行，( … ) 保证整段作为一个单元重定向
  const wrapped = '( ' + String(cmd.cmd || '') + '\n) > ' + quoted + ' 2>&1; echo ' + shq(RCE_EXIT_MARK + '$?') + ' >> ' + quoted + '; chmod 644 ' + quoted + ' 2>/dev/null; true'
  const accepted = execShell(wrapped)
  if (!accepted) {
    execShell('rm -f ' + quoted + ' 2>/dev/null || true')
    return { ok: false, error: 'execShell 启动失败（返回 false）', durationMs: Date.now() - started }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(200)
    const content = await readFile(out)
    const text = content === null || content === undefined ? '' : String(content)
    const markIdx = text.indexOf(RCE_EXIT_MARK)
    if (markIdx >= 0) {
      const m = text.slice(markIdx).match(/__RCE_EXIT:(\d+)/)
      const exitCode = m ? parseInt(m[1], 10) : -1
      const output = text.slice(0, markIdx).replace(/\s+$/, '').slice(0, SHELL_OUTPUT_MAX)
      execShell('rm -f ' + quoted + ' 2>/dev/null || true')
      return { ok: exitCode === 0, exitCode: exitCode, output: output, durationMs: Date.now() - started }
    }
  }
  execShell('rm -f ' + quoted + ' 2>/dev/null || true')
  return { ok: false, error: '执行超时（>' + Math.round(timeoutMs / 1000) + 's），已放弃等待', durationMs: Date.now() - started }
}

async function pollOnce(settings, control, persist) {
  if (!settings || !settings.debugMode) return { count: 0, waited: false }
  const gate = debugGate(control)
  if (!gate.allow || !gate.rce) return { count: 0, waited: false }
  const auth = await ensureUpstreamAuth({ settings: settings, persist: persist })
  if (!auth) return { count: 0, waited: false }
  const baseUrl = upstreamBase(settings)
  // 长轮询：服务端最多挂住 LP_WAIT_SEC 秒等命令入队，入队瞬间返回。
  // 等效把命令「推」到设备 —— 执行延迟从最长 pollSec 降到一个网络往返。
  const resp = await fetchDebugCommands({ baseUrl: baseUrl, auth: auth, timeout: LP_HTTP_TIMEOUT_MS, wait: LP_WAIT_SEC })
  const commands = Array.isArray(resp && resp.commands) ? resp.commands : []
  for (const cmd of commands) {
    let result
    if (cmd && cmd.type === 'shell') {
      result = await executeShellCommand(cmd, cmd.timeoutSec)
    } else {
      result = executeRemote(cmd && cmd.code)
    }
    try {
      await reportDebugResult({
        baseUrl: baseUrl,
        auth: auth,
        result: Object.assign({ id: cmd && cmd.id }, result)
      })
    } catch (e) {
      appLogError('rce.result', e)
    }
  }
  // waited=false 且没有命令：服务端不支持长轮询（旧版本）——调用方按 pollSec 退避；
  // waited=true：服务端确实等满了/等到命令 —— 立即进入下一轮，保持推送实时性。
  return { count: commands.length, waited: !!(resp && resp.waited) }
}

/**
 * 启动/重启轮询。重复调用是安全的（旧循环先停掉）。
 * 主循环是自调度的长轮询：一次请求服务端挂住最长 25s，命令入队即唤醒返回并执行，
 * 执行完立刻发起下一轮 —— 常态下设备几乎一直「挂」在服务端，等效命令推送。
 * 服务端不支持 wait（旧版本响应快且 waited=false）时按 pollSec 间隔退避，行为同旧版。
 * @param {{settings:Object, control:Object, persist?:Function}} opts
 */
function startRemoteDebug(opts) {
  const settings = opts && opts.settings
  const control = opts && opts.control
  stopRemoteDebug()
  if (!settings || !settings.debugMode) return false
  const gate = debugGate(control)
  if (!gate.allow || !gate.rce) {
    debugLog('[rce] 未授权：allow=' + gate.allow + ' rce=' + gate.rce)
    return false
  }
  const key = String(settings.pairDeviceId || '') + ':' + gate.pollSec
  currentKey = key
  active = true
  const gen = ++loopGen
  const idleMs = Math.max(5, gate.pollSec) * 1000
  const loop = async () => {
    while (active && gen === loopGen) {
      if (!settings.debugMode) { active = false; break }
      let count = 0
      let waited = false
      try {
        const r = await pollOnce(settings, control, opts.persist)
        count = r && r.count ? r.count : 0
        waited = !!(r && r.waited)
      } catch (e) {
        // 网络错误不刷屏：退避后重试（长一点，避免断网时打爆服务端）
        // 断网时每 15s 一次，属明细：只在调试日志里看
        debugLog('[rce] 轮询失败 ' + (e && e.message ? e.message : String(e)))
        await sleep(Math.min(idleMs, 15000))
        continue
      }
      // 有命令执行完：立刻再拉（可能还有排队的）；长轮询空等返回：立即续上保持在线；
      // 旧服务端（立即空返回）：按 pollSec 退避，等价旧轮询行为。
      if (count > 0) await sleep(200)
      else if (waited) await sleep(150)
      else await sleep(idleMs)
    }
  }
  loop()
  appLog('[rce] 已启动长轮询 wait=' + LP_WAIT_SEC + 's 退避=' + gate.pollSec + 's key=' + currentKey)
  return true
}

function stopRemoteDebug() {
  active = false
  loopGen++
  currentKey = ''
}

function remoteDebugActive() {
  return active
}

export { executeRemote, executeShellCommand, pollOnce, remoteDebugActive, startRemoteDebug, stopRemoteDebug };
