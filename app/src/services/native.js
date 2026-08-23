// 设备原生能力封装（已通过真机探针验证）。
// 本设备（X7 Pro）与 SDK 文档不同：langningchen 不存在；storage/fs 通过 import 可用；
// 但 import storage 的 setStorage 会失败，持久化改用 $falcon.jsapi.storage（对象参数）。
// execShell（global.Global）是无回显、异步的（返回 boolean），命令输出需重定向到文件后用 fs.readFile 读回。

import fs from 'fs'
import globalModule from 'global'
import { appLog } from './app-log.js'
import {
  openTextEditor as coreOpenTextEditor,
  closeTextEditor,
  isAsrEnabled as coreIsAsrEnabled,
  INPUT_TYPES
} from '@dictpen/core'

// ========== 错误码定义（10000 起） ==========
// 结构：模块编号(10) + 功能编号(10-70) + 位置编号(01-99)
export const ERR = Object.freeze({
  SYS_UNKNOWN: 10001,
  SYS_EXCEPTION: 10002,
  FS_READ_FAILED: 10101,
  FS_WRITE_FAILED: 10102,
  DS_CONFIG_NOT_FOUND: 10201,
  DS_CONFIG_PARSE_ERROR: 10202,
  DS_CONFIG_NO_ACCOUNTS: 10203,
  DS_CONFIG_APIKEY_PARSE: 10204,
  DS_CONFIG_USER_PARSE: 10205,
  DS_CONFIG_PASS_PARSE: 10206,
  PROC_KILL_FAILED: 10301,
  PROC_START_FAILED: 10302,
  PROC_BINARY_MISSING: 10303,
  PROC_WORKDIR_MISSING: 10304,
  CONFIG_BACKUP_FAILED: 10401,
  CONFIG_WRITE_TEMP_FAILED: 10402,
  CONFIG_CP_FAILED: 10403,
  DEPLOY_COPY_FAILED: 10404,
  DEPLOY_CHMOD_FAILED: 10405,
  CONFIG_WRITE_FAILED: 10406,
  DEPLOY_ARCH_MISMATCH: 10407,
  DEPLOY_SHELL_UNAVAILABLE: 10408,
  DEPLOY_VERIFY_FAILED: 10409,
  NET_CONNECT_FAILED: 10501,
  NET_START_TIMEOUT: 10502,
  NET_HEALTH_FAILED: 10503,
})

// $dataDir 无尾斜杠时补上，统一拼接路径，避免文件名拼进目录名
function joinDataDir(name) {
  const base = String($dataDir || '/tmp/')
  return (base.endsWith('/') ? base : base + '/') + name
}

function makeErr(code, msg) {
  return { ok: false, code, message: msg }
}

// 调试日志全局开关：由设置页"启用调试日志"控制，避免每次输入/请求都刷日志。
let _debugLogEnabled = false
export function setDebugLogEnabled(v) {
  _debugLogEnabled = !!v
}
export function debugLogEnabled() {
  return _debugLogEnabled
}
export function debugLog(...args) {
  if (!_debugLogEnabled) return
  try { console.error('DSLOG | ' + args.join(' ')) } catch (e) { /* 忽略 */ }
}

let _g = null
function g() {
  if (!_g) _g = new globalModule.Global()
  return _g
}

export function getGlobal() {
  return g()
}

export function execShell(cmd) {
  try {
    return g().execShell(cmd)
  } catch (e) {
    return false
  }
}

// ---------- 运行环境检测（Bug 5：X6P 等异型设备兼容） ----------
// 只同步检测 execShell / Global 是否可用；不做任何 uname/文件等待——
// 部署成败由 healthCheck 判定，架构探测会在 deploy 命令里顺带记录到 stepLog 供诊断。
export function shellAvailable() {
  try {
    return !!g() && typeof g().execShell === 'function'
  } catch (e) {
    return false
  }
}

export async function detectEnvironment() {
  const info = { shell: shellAvailable(), global: shellAvailable(), ok: shellAvailable(), reason: '' }
  if (!info.shell) {
    info.reason = '该设备不支持执行 shell 命令（execShell 不可用），无法部署 ds-free-api 后端'
  }
  return info
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- 文件（import fs） ----------
export async function readFile(path) {
  try { return await fs.readFile(path) } catch (e) { return null }
}

export async function writeFile(path, content) {
  try { return await fs.writeFile(path, content) } catch (e) { return false }
}

export async function exists(path) {
  try { return await fs.exists(path) } catch (e) { return false }
}

export async function statSize(path) {
  try {
    const st = await fs.stat(path)
    return st && st.size ? st.size : 0
  } catch (e) { return 0 }
}

export async function readdir(path) {
  try { return await fs.readdir(path) } catch (e) { return null }
}

export async function mkdir(path) {
  try { return await fs.mkdir(path) } catch (e) { return false }
}

// 轮询读取某个文件，直到它出现非空内容或超时。execShell 是异步的，用它来等命令产物。
export async function waitForFile(path, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const c = await readFile(path)
    if (c !== null && c !== '') return c
    await sleep(150)
  }
  return null
}

// ---------- ds-free-api 账号配置 ----------
// 内置模式下，把 DeepSeek 官方账号写入本机 ds-free-api 的 config.toml（[[accounts]] 段），
// 并重启 ds-free-api 让账号生效。execShell 为 root，可写 /userdisk 下配置文件。
const DS_FREE_API_DIR = '/userdisk/ds-free-api'
const DS_CONFIG = DS_FREE_API_DIR + '/config.toml'
const DS_PORTS = [22217, 22218, 22219, 22220, 22221, 22222]

export function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// 停止一个后台流式 curl 任务（按唯一 token 精确匹配，避免误杀其它 curl）
export function stopStream(token) {
  try {
    execShell('pkill -f ' + shq(token) + ' || true')
  } catch (e) { /* 忽略 */ }
}

// 清洗账号/密码输入：去除引号、反斜杠、控制字符，避免破坏 TOML 或进入任何 shell 环节。
function sanitizeCred(s) {
  return String(s || '').replace(/["\\\r\n\t\0]/g, '').trim()
}

function uuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

// 在 JS 里改写 config.toml 的 [[accounts]] 段（纯字符串操作，不拼 shell），返回新内容；失败返回 null。
// 采用按行处理（split/map/join），避免 QuickJS 对 `^...$` 多行正则/RegExp.lastIndex 的兼容性问题。
function replaceAccount(raw, user, pass) {
  if (raw.indexOf('[[accounts]]') < 0) return null
  const isEmail = /@/.test(user || '')
  const lines = raw.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*=/)
    if (!kv) continue
    const key = kv[1]
    if (key === 'email') {
      lines[i] = 'email = ' + (isEmail ? '"' + user + '"' : '""')
      changed = true
    } else if (key === 'mobile') {
      lines[i] = 'mobile = ' + (isEmail ? '""' : '"' + user + '"')
      changed = true
    } else if (key === 'area_code') {
      if (!isEmail) { lines[i] = 'area_code = "+86"'; changed = true }
    } else if (key === 'password') {
      lines[i] = 'password = "' + pass + '"'
      changed = true
    }
  }
  if (!changed) return null
  return lines.join('\n')
}

// 替换或追加 [[api_keys]] 段，避免空 key 导致 401
function replaceApiKey(raw, apiKey) {
  const apiKeyBlock = '[[api_keys]]\nkey = "' + apiKey + '"\ndescription = "auto-generated"'
  const start = raw.indexOf('[[api_keys]]')
  if (start >= 0) {
    const end = raw.indexOf('\n[', start + 1)
    const before = raw.substring(0, start)
    const after = end >= 0 ? raw.substring(end) : ''
    return before + apiKeyBlock + after
  }
  return raw + (raw.endsWith('\n') ? '' : '\n') + apiKeyBlock
}

// 行级修复 [deepseek] 段的旧版指纹（Chrome/151 Edg UA、Android/35、2.0.4），
// 与 rquest Emulation::Chrome136 的 TLS 指纹对齐；只替换命中旧值的行，保留其它配置。
const NEW_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

function fixFingerprint(raw) {
  const lines = String(raw || '').split('\n')
  let inDeepseek = false
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inDeepseek = trimmed === '[deepseek]'
      continue
    }
    if (!inDeepseek) continue
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*=\s*"([^"]*)"\s*$/)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2]
    if (key === 'user_agent' && (val.indexOf('Chrome/151') >= 0 || val.indexOf('Edg/151') >= 0 || val.indexOf('Android/35') >= 0)) {
      lines[i] = 'user_agent = "' + NEW_USER_AGENT + '"'
      changed = true
    } else if (key === 'client_version' && (val === '2.0.4' || val === '2.0.3')) {
      lines[i] = 'client_version = "2.3.0"'
      changed = true
    } else if (key === 'client_platform' && val === 'android') {
      lines[i] = 'client_platform = "web"'
      changed = true
    }
  }
  return changed ? lines.join('\n') : null
}

/**
 * 更新本机 ds-free-api 的登录账号并重启服务。
 * 流程：读取 config.toml → JS 改写 [[accounts]] 段 → 写回（经临时文件 cp）→ 重启 → 轮询验证 /health。
 * 返回 { ok, message }。写入即视为成功（配置已落盘），health 探活失败也不回滚用户输入，
 * 只提示"配置已保存，服务可能仍在启动"。
 */
export async function updateDsFreeApiAccount(user, pass) {
  const cleanUser = sanitizeCred(user)
  const cleanPass = sanitizeCred(pass)
  if (!cleanUser || !cleanPass) return makeErr(10001, '账号和密码不能为空')
  try {
    const raw = await readFile(DS_CONFIG)
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件')
    const next = replaceAccount(raw, cleanUser, cleanPass)
    if (next === null) return makeErr(10203, 'config.toml 中未找到 [[accounts]] 段')

    // 生成随机 API Key（UUID v4 小写去中划线），并写入 config
    const apiKey = uuidV4().replace(/-/g, '')
    const withApiKey = replaceApiKey(next, apiKey)

    // 备份 + 原子写入，并等待异步 execShell 真正完成。
    const tmp = joinDataDir('dsconfig.tmp.toml')
    const resultFile = joinDataDir('dsconfig-result.txt')
    const writeOk = await writeFile(tmp, withApiKey)
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '')
    const configCommand =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile)
    if (!execShell(configCommand)) return makeErr(10403, '启动配置更新命令失败')
    const configResult = String(await waitForFile(resultFile, 10000) || '').trim()
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true')
    if (configResult !== 'ok') return makeErr(10403, '写入配置文件失败')

    // 重启后端服务
    const restartResult = await restartDsFreeApi()
    if (!restartResult.ok) return restartResult

    // 探活并等待账号就绪：healthCheck 只确认端口绑定，新进程登录 DeepSeek 需时间。
    // 若 health ok 但账号池为空（登录失败/未完成），对话仍会"未认证"。
    const ok = await healthCheckWithAccount(30000)
    appLog('[update] 保存账号后健康+账号 ok=' + ok + ' apiKeyLen=' + apiKey.length)
    if (ok) {
      // 返回新 key 给调用方，由设置页更新 form.apiKey（避免应用继续用旧 key 导致 401）
      return { ok: true, message: '账号已保存，DeepSeek 登录成功', apiKey }
    }
    // 配置已写入，不因探活失败回滚（避免抹掉用户刚填的账号）。
    // 账号池空通常意味着 DeepSeek 登录失败（账号/密码错误），提示用户检查。
    appLog('[update] 保存账号后账号池为空，可能登录失败')
    return makeErr(10503, '账号已保存，但 DeepSeek 登录未成功（请检查账号密码是否正确）')
  } catch (e) {
    return makeErr(10002, '更新失败：' + (e && e.message ? e.message : String(e)))
  }
}

async function restartDsFreeApi() {
  const binPath = DS_FREE_API_DIR + '/ds-free-api'
  appLog('[restart] start binExists=' + (await exists(binPath)) + ' dirExists=' + (await exists(DS_FREE_API_DIR)))
  if (!(await exists(binPath))) {
    return makeErr(10303, 'ds-free-api 二进制不存在，请先部署后端服务')
  }
  if (!(await exists(DS_FREE_API_DIR))) {
    return makeErr(10304, 'ds-free-api 工作目录不存在')
  }

  const resultFile = joinDataDir('ds-restart-result.txt')
  const logFile = DS_FREE_API_DIR + '/logs/runtime.log'
  const pidFile = joinDataDir('ds-pid.txt')
  await writeFile(resultFile, '')
  // 先读上次记录的 PID（若存在）逐个 kill -9，再 pkill -9 兜底，确保不会残留孤儿进程。
  // 之前只 pkill -9 可能因 execShell 异步时序没杀干净，导致新旧两个进程同时存在
  // （一个绑 22217 一个切 22218，应用连上旧进程 → "连接已断开"）。
  const oldPid = String(await readFile(pidFile) || '').trim()
  const killOld = oldPid && /^\d+$/.test(oldPid)
    ? 'kill -9 ' + shq(oldPid) + ' 2>/dev/null; '
    : ''
  const command =
    killOld +
    'pkill -9 -x ds-free-api 2>/dev/null; ' +
    'for i in 1 2 3 4 5 6 7 8 9 10; do ' +
    'if ! (ss -tln 2>/dev/null | grep -q ":22217 " || netstat -tln 2>/dev/null | grep -q ":22217 "); then break; fi; ' +
    'sleep 1; done; ' +
    'cd ' + shq(DS_FREE_API_DIR) + ' && ' +
    '(DS_DATA_DIR=' + shq(DS_FREE_API_DIR) + ' nohup ./ds-free-api >> ' + shq(logFile) + ' 2>&1 & echo $! > ' + shq(pidFile) + ') && ' +
    'printf started > ' + shq(resultFile)
  const execOk = execShell(command)
  appLog('[restart] execShell=' + execOk + ' oldPid=' + (oldPid || '无'))
  if (!execOk) return makeErr(10302, '启动 ds-free-api 重启命令失败')

  const result = String(await waitForFile(resultFile, 10000) || '').trim()
  appLog('[restart] result=' + (result || '(空)'))
  if (result !== 'started') return makeErr(10302, '启动 ds-free-api 进程失败（nohup）')

  // 读 PID 用于诊断 + 下次 kill。PID 文件保留不删（供下次 restart 精确杀旧进程）。
  const pid = String(await readFile(pidFile) || '').trim()
  if (pid && /^\d+$/.test(pid)) {
    debugLog('DS | ds-free-api 已启动 pid=' + pid)
    appLog('[restart] pid=' + pid)
  }
  execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
  return { ok: true }
}

async function healthCheck() {
  // 串行探测，优先 22217（主端口）。execShell 是异步无回显的，&&/wait 等后台组合在
  // 设备上不可靠，回退到逐端口 curl + 文件轮询（build 19 验证过的可靠方式）。
  // 每端口 curl -m 1 + 1.5s 等待；端口少（主端口优先），一轮最快 ~1.5s。
  const order = [DS_PORTS[0], ...DS_PORTS.slice(1)] // 22217 优先
  for (let i = 0; i < 3; i++) {
    for (const port of order) {
      const probe = joinDataDir('dshealth_' + Date.now() + '_' + i + '_' + port + '.txt')
      await writeFile(probe, '')
      execShell('curl -s -m 1 http://127.0.0.1:' + port + '/health > ' + shq(probe) + ' 2>&1')
      const out = await waitForFile(probe, 1500)
      execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true')
      if (out !== null && String(out).indexOf('"status":"ok"') >= 0) {
        appLog('[health] ok port=' + port + ' round=' + (i + 1))
        return true
      }
    }
    if (i < 2) await sleep(1000)
  }
  appLog('[health] FAIL 3 轮均未通过')
  return false
}

// 健康检查 + 等待账号就绪：/health 返回 ok 且 accounts.total > 0 才算成功。
// 用于"保存账号"后验证——仅端口绑定不代表 DeepSeek 登录成功，账号池空时对话会"未认证"。
async function healthCheckWithAccount(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000)
  while (Date.now() < deadline) {
    for (const port of DS_PORTS) {
      const probe = joinDataDir('dshealth_acc_' + Date.now() + '_' + port + '.txt')
      await writeFile(probe, '')
      execShell('curl -s -m 1 http://127.0.0.1:' + port + '/health > ' + shq(probe) + ' 2>&1')
      const out = await waitForFile(probe, 1500)
      execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true')
      if (out !== null && String(out).indexOf('"status":"ok"') >= 0) {
        // 端口通了，检查账号池
        const m = String(out).match(/"total"\s*:\s*(\d+)/)
        const total = m ? parseInt(m[1], 10) : 0
        if (total > 0) {
          appLog('[health] ok+账号 port=' + port + ' total=' + total)
          return true
        }
        appLog('[health] 端口通但账号池空 total=' + total + '（登录中或失败）')
      }
    }
    await sleep(1500)
  }
  appLog('[health] 等待账号就绪超时')
  return false
}

// ========== 后端部署（base64 内嵌二进制，运行时回写） ==========
// 后端二进制已打包成 base64 内嵌在 backend-blob.js 中，首次运行时自动写入 /userdisk/ds-free-api

import { BACKEND_B64, BACKEND_NAME, BACKEND_ARCH } from './backend-blob.js'

// 本二进制支持的 CPU 架构。BACKEND_ARCH 形如 "linux-aarch64-gnu"，取中段比较 uname -m。
// 当前仅用于日志/诊断展示，不参与部署阻断（部署成败由 healthCheck 判定）。
function supportedArch() {
  const m = String(BACKEND_ARCH || '').match(/-([a-z0-9_]+)-/)
  return m ? m[1] : ''
}

// 确保 ds-free-api 后端已部署到 /userdisk/ds-free-api
export async function deployBackend() {
  const targetDir = '/userdisk/ds-free-api'
  const targetBin = targetDir + '/ds-free-api'

  // 优化：目标二进制已存在且非空时，跳过 6MB base64 写盘 + 解码 + 比较（同一安装内
  // 每次启动都做这些很慢）。只需 chmod +x 保执行位，直接视为 unchanged。
  // 二进制更新由"卸载重装"保证（data 目录清空 → targetBin 不存在 → 走全量部署）。
  const targetBinExists = await exists(targetBin)
  if (targetBinExists) {
    const st = await statSize(targetBin)
    if (st > 0) {
      appLog('[deploy] 已存在且非空（size=' + st + '），跳过解码比较')
      const resultFile = joinDataDir('ds-deploy-result.txt')
      await writeFile(resultFile, '')
      execShell('mkdir -p ' + shq(targetDir + '/logs') + '; chmod +x ' + shq(targetBin) + '; printf unchanged > ' + shq(resultFile))
      const result = String(await waitForFile(resultFile, 5000) || '').trim()
      execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
      if (result === 'unchanged') {
        return { ok: true, updated: false, message: '后端已是最新版本' }
      }
      // chmod/写结果失败则继续走全量部署
      appLog('[deploy] 快速路径失败 result=' + (result || '(空)') + '，走全量')
    }
  }

  // 首次部署或二进制缺失：base64 -> 临时文件 -> 原子替换，避免启动过程中留下半写入二进制。
  // 命令结构与 build 19 验证过的版本一致（单条 if/else，短小可靠），
  // 仅增强：无论 cmp 结果如何都强制 chmod +x，避免权限丢失不自愈。
  const tmpB64 = joinDataDir('ds-free-api.b64')
  const tmpBin = joinDataDir('ds-free-api.tmp')
  const stagedBin = targetDir + '/ds-free-api.new'
  const resultFile = joinDataDir('ds-deploy-result.txt')
  appLog('[deploy] 全量部署 start dataDir=' + String($dataDir) + ' target=' + targetDir)
  try {
    const writeB64Ok = await writeFile(tmpB64, BACKEND_B64)
    appLog('[deploy] write b64=' + writeB64Ok + ' len=' + (BACKEND_B64 || '').length)
    if (!writeB64Ok) {
      return makeErr(10402, '写入临时 base64 文件失败（$dataDir=' + String($dataDir) + '）')
    }
    await writeFile(resultFile, '')
    const command =
      'mkdir -p ' + shq(targetDir) + ' ' + shq(targetDir + '/logs') + ' && ' +
      'base64 -d ' + shq(tmpB64) + ' > ' + shq(tmpBin) + ' && ' +
      'if [ -f ' + shq(targetBin) + ' ] && cmp -s ' + shq(tmpBin) + ' ' + shq(targetBin) + '; then ' +
      'chmod +x ' + shq(targetBin) + '; printf unchanged > ' + shq(resultFile) + '; else ' +
      'cp ' + shq(tmpBin) + ' ' + shq(stagedBin) + ' && ' +
      'chmod +x ' + shq(stagedBin) + ' && ' +
      'mv -f ' + shq(stagedBin) + ' ' + shq(targetBin) + ' && ' +
      'chmod +x ' + shq(targetBin) + ' && ' +
      'printf updated > ' + shq(resultFile) + '; fi || printf failed > ' + shq(resultFile)
    const execOk = execShell(command)
    appLog('[deploy] execShell=' + execOk + ' cmdLen=' + command.length)
    if (!execOk) return makeErr(10403, '启动后端更新命令失败')
    const result = String(await waitForFile(resultFile, 30000) || '').trim()
    appLog('[deploy] result=' + (result || '(空)'))
    if (result !== 'updated' && result !== 'unchanged') {
      // 带原始结果 + $dataDir 诊断，便于定位"logs 空目录"（mkdir 成功但后续步骤失败）
      const tmpExists = await exists(tmpBin)
      const targetExists = await exists(targetBin)
      appLog('[deploy] FAIL result=' + (result || '空') + ' tmpBin=' + tmpExists + ' targetBin=' + targetExists)
      return makeErr(10405, '更新后端二进制失败（result=' + (result || '空') + '，$dataDir=' + String($dataDir) + '，tmpBin=' + (tmpExists ? '存在' : '缺失') + '，targetBin=' + (targetExists ? '存在' : '缺失') + '）')
    }
    var backendUpdated = result === 'updated'
    appLog('[deploy] ok updated=' + backendUpdated)
  } catch (e) {
    appLog('[deploy] EXCEPTION ' + (e && e.message ? e.message : String(e)))
    return makeErr(10002, '部署后端失败：' + (e && e.message ? e.message : String(e)))
  } finally {
    execShell('rm -f ' + shq(tmpB64) + ' ' + shq(tmpBin) + ' ' + shq(stagedBin) + ' ' + shq(resultFile) + ' 2>/dev/null || true')
  }

  // 仅首次部署写入最小 config.toml，保留用户已有配置。
  // 存量配置指纹修复：旧版 config.toml 写的是 Chrome/151 + Edg/151（与 TLS Chrome136 指纹不匹配，
  // 禁言根因之一）。行级替换 [deepseek] 段的 UA/version/platform 为新指纹，保留用户其余配置。
  if (await exists(targetDir + '/config.toml')) {
    const legacy = String(await readFile(DS_CONFIG) || '')
    if (legacy && (legacy.indexOf('Chrome/151') >= 0 || legacy.indexOf('Edg/151') >= 0 || legacy.indexOf('Android/35') >= 0 || legacy.indexOf('2.0.4') >= 0)) {
      const fixed = fixFingerprint(legacy)
      if (fixed && fixed !== legacy) {
        const ok = await writeFile(DS_CONFIG, fixed)
        if (ok) debugLog('DS | 已修复 config.toml 旧版指纹（UA/version/platform 对齐 Chrome136）')
      }
    }
    return {
      ok: true,
      updated: !!backendUpdated,
      message: backendUpdated ? '后端已更新' : '后端已是最新版本'
    }
  }

  // 写入最小 config.toml（供后续 updateDsFreeApiAccount 改写 [[accounts]]）
  const minConfig = [
    '[server]',
    'port = 22217',
    'host = "127.0.0.1"',
    '',
    '[deepseek]',
    'api_base = "https://chat.deepseek.com/api/v0"',
    'wasm_url = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"',
    'user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"',
    'client_version = "2.3.0"',
    'client_platform = "web"',
    'client_locale = "zh-CN"',
    'model_types = ["default", "expert"]',
    'max_input_tokens = [4096, 4096]',
    'max_output_tokens = [8192, 8192]',
    '',
    '[[accounts]]',
    'email = ""',
    'mobile = ""',
    'area_code = "+86"',
    'password = ""',
    ''
  ].join('\n')
  const configOk = await writeFile(DS_CONFIG, minConfig)
  if (!configOk) return makeErr(ERR.CONFIG_WRITE_FAILED, '写入配置文件失败')

  return { ok: true, message: '后端部署成功，请填写账号密码' }
}

// 全局互斥：startup 页和 index 页可能同时调用 ensureBackendRunning，
// 并发执行 restart 会产生两个 ds-free-api 进程（孤儿进程）。这里 single-flight 共享同一个 Promise。
let _ensurePromise = null

export async function ensureBackendRunning() {
  if (_ensurePromise) return _ensurePromise
  _ensurePromise = doEnsureBackend().finally(() => { _ensurePromise = null })
  return _ensurePromise
}

async function doEnsureBackend() {
  appLog('[ensure] start')
  const deployResult = await deployBackend()
  appLog('[ensure] deploy ok=' + deployResult.ok + ' msg=' + (deployResult.message || '') + ' code=' + (deployResult.code || ''))
  // 部署失败不再直接阻断：若设备上已有旧二进制，仍尝试启动它，避免"后端完全不拉起"。
  // 部署错误信息保留，供启动页展示定位。
  if (!deployResult.ok) {
    const binExists = await exists(DS_FREE_API_DIR + '/ds-free-api')
    if (!binExists) {
      appLog('[ensure] deploy FAIL 且无旧二进制，放弃')
      return deployResult
    }
    appLog('[ensure] deploy FAIL 但存在旧二进制，尝试直接启动')
    debugLog('DS | 部署失败但存在旧二进制，尝试直接启动: ' + deployResult.message)
  }

  const needRestart = deployResult.updated || !(await healthCheck())
  appLog('[ensure] needRestart=' + needRestart)
  if (needRestart) {
    const restartResult = await restartDsFreeApi()
    appLog('[ensure] restart ok=' + restartResult.ok + ' msg=' + (restartResult.message || '') + ' code=' + (restartResult.code || ''))
    if (!restartResult.ok) return restartResult
  }

  const healthy = await healthCheck()
  appLog('[ensure] final healthy=' + healthy)
  if (!healthy) {
    // 可能是旧进程占着 22217 导致新进程切端口，或新进程没起来。
    // 再强杀一次并重启（PID 文件 + pkill -9 兜底），然后重试健康检查。
    appLog('[ensure] 首次健康检查失败，强杀重启重试')
    const retryRestart = await restartDsFreeApi()
    appLog('[ensure] 重试 restart ok=' + retryRestart.ok)
    if (retryRestart.ok) {
      const retryHealthy = await healthCheck()
      appLog('[ensure] 重试后 healthy=' + retryHealthy)
      if (retryHealthy) {
        appLog('[ensure] DONE (retry)')
        return { ok: true, message: deployResult.message }
      }
    }
    // 附带 runtime.log 尾部，便于定位"拉起后很快挂"的根因（如架构/权限/缺库）
    const logTail = String(await readFile(DS_FREE_API_DIR + '/logs/runtime.log') || '')
      .split('\n').filter(Boolean).slice(-5).join('；')
    appLog('[ensure] TIMEOUT logTail=' + (logTail || '(空)'))
    return makeErr(10502, 'ds-free-api 启动超时（' + (logTail || '无日志输出') + '）')
  }
  appLog('[ensure] DONE')
  return { ok: true, message: deployResult.message }
}

// 系统输入法编辑器统一走 @dictpen/core 封装，确保与 SDK 新版输入法/语音识别逻辑一致。
export { closeTextEditor, INPUT_TYPES }

export function isAsrEnabled() {
  try {
    return coreIsAsrEnabled()
  } catch (e) {
    return false
  }
}

export function openTextEditor(inputType, initialText) {
  // 透传预填充文本：修改消息/设置项时把当前值带回 IME（Bug 4）
  return coreOpenTextEditor(inputType, initialText)
}

// ---------- 持久化（$falcon.jsapi.storage） ----------
// 已探针验证：setStorage({key,data}) -> {key:data}；getStorage({key}) -> {data} 或 {error:3}；
// getStorageInfo({}) -> {keys:[], currentSize, limitSize}；removeStorage({key}) -> {key:"removed"}
export async function storageSet(key, data) {
  try {
    await $falcon.jsapi.storage.setStorage({ key, data: String(data) })
    return true
  } catch (e) {
    return false
  }
}

export async function storageGet(key) {
  try {
    const r = await $falcon.jsapi.storage.getStorage({ key })
    if (r && r.data !== undefined && r.data !== null) return String(r.data)
    return null
  } catch (e) {
    return null
  }
}

export async function storageRemove(key) {
  try {
    await $falcon.jsapi.storage.removeStorage({ key })
    return true
  } catch (e) {
    return false
  }
}

export async function storageKeys() {
  try {
    const r = await $falcon.jsapi.storage.getStorageInfo({})
    return (r && Array.isArray(r.keys)) ? r.keys : []
  } catch (e) {
    return []
  }
}
