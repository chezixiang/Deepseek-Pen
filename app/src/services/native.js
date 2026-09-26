// 设备原生能力封装（已通过真机探针验证）。
// 本设备（X7 Pro）与 SDK 文档不同：langningchen 不存在；storage/fs 通过 import 可用；
// 但 import storage 的 setStorage 会失败，持久化改用 $falcon.jsapi.storage（对象参数）。
// execShell（global.Global）是无回显、异步的（返回 boolean），命令输出需重定向到文件后用 fs.readFile 读回。

import fs from 'fs'
import globalModule from 'global'
import { appLog } from './app-log.js'
import {
  openTextEditor as coreOpenTextEditor,
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

// $dataDir 的尾斜杠在不同机型上不一致（X7 带、部分机型不带），且各处拼接
// 又会自带前导 '/'，两者相遇就产生 `/data//ds-free-api` 这种非法路径。
// 统一规则：dataDirBase() 永远返回**不带**尾斜杠的目录，joinPath() 负责补一个。
export function dataDirBase() {
  return String($dataDir || '/tmp').replace(/\/+$/, '')
}

// 任意段数拼接：去掉每段首尾多余斜杠后用单个 '/' 连接，保留 base 的前导 '/'
export function joinPath(base, ...parts) {
  let out = String(base == null ? '' : base).replace(/\/+$/, '')
  for (const part of parts) {
    const seg = String(part == null ? '' : part).replace(/^\/+/, '').replace(/\/+$/, '')
    if (seg) out += '/' + seg
  }
  return out
}

function joinDataDir(name) {
  return joinPath(dataDirBase(), name)
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

// fs.readFile 读不到（个别机型应用进程非 root，而 ds-free-api 以 root 运行，
// 写出的 config.toml 曾带 0600 权限 → "无法读取 ds-free-api 配置文件"10201）时，
// 用 execShell（root）cat 落到应用可读的临时文件再读。仅限小文件（配置）使用。
export async function readFileWithShellFallback(path) {
  const raw = await readFile(path)
  if (raw !== null) return raw
  const out = joinDataDir('ds-cat-' + Date.now() + '.txt')
  await writeFile(out, '')
  execShell('cat ' + shq(path) + ' > ' + shq(out) + ' 2>/dev/null; chmod 644 ' + shq(path) + ' 2>/dev/null; true')
  const via = await waitForFile(out, 5000)
  execShell('rm -f ' + shq(out) + ' 2>/dev/null || true')
  if (via === null || String(via) === '') return null
  return String(via)
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
// 并重启 ds-free-api 让账号生效。execShell 为 root，可写应用 data 目录下的配置文件。
//
// 目录策略（build 22）：ds-free-api 统一放在应用 data 目录（$dataDir/ds-free-api）。
// 旧版放在 /userdisk/ds-free-api，部分设备的应用 fs 模块无法读该路径，导致
// "无法读取 ds-free-api 配置文件"（错误码 10201）；迁移后 fs 可直接读写全部文件。
// 副作用是卸载重装会清空 data 目录 → 自动触发全量重新部署（二进制/配置随版本更新）。
const DS_LEGACY_DIR = '/userdisk/ds-free-api'
const DS_PORTS = [22217, 22218, 22219, 22220, 22221, 22222]

export function dsHomeDir() {
  return joinDataDir('ds-free-api')
}

export function dsConfigPath() {
  return joinPath(dsHomeDir(), 'config.toml')
}

// ds-free-api 运行日志路径（后端用 DS_DATA_DIR + "/logs/runtime.log"）
export function dsRuntimeLogPath() {
  return joinPath(dsHomeDir(), 'logs', 'runtime.log')
}

// 一次性迁移：老版本 /userdisk/ds-free-api 下的 config.toml 拷到新目录（幂等）。
// 二进制不拷贝——走 deployBackend 的 base64 全量部署，保证写入的是当前内嵌版本。
async function migrateLegacyDir() {
  const home = dsHomeDir()
  const cfg = dsConfigPath()
  const resultFile = joinDataDir('ds-migrate-result.txt')
  await writeFile(resultFile, '')
  const cmd =
    'mkdir -p ' + shq(joinPath(home, 'logs')) + '; ' +
    'if [ ! -f ' + shq(cfg) + ' ] && [ -f ' + shq(joinPath(DS_LEGACY_DIR, 'config.toml')) + ' ]; then ' +
    'cp ' + shq(joinPath(DS_LEGACY_DIR, 'config.toml')) + ' ' + shq(cfg) + '; fi; ' +
    'printf ok > ' + shq(resultFile)
  execShell(cmd)
  await waitForFile(resultFile, 15000)
  execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
}

export function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// 停止一个后台流式 curl 任务（按唯一 token 精确匹配，避免误杀其它 curl）
export function stopStream(token) {
  try {
    execShell('pkill -f ' + shq(token) + ' || true')
  } catch (e) { /* 忽略 */ }
}

// 清洗账号/密码输入：只去掉会破坏 TOML 行结构的控制字符（换行/回车/制表/NUL），
// 并去掉首尾空白。**不再删除引号和反斜杠** —— 旧实现把 `"` 和 `\` 直接丢弃，
// 用户密码里含这两个字符时写进配置的就是错的密码，登录必然失败（部分设备/部分
// 用户"无法账密登录"的一个确定成因）。引号/反斜杠改由 tomlEscape 正确转义。
function sanitizeCred(s) {
  return String(s || '').replace(/[\r\n\t\0]/g, '').trim()
}

// TOML 基本字符串转义：反斜杠必须先转，否则会把后面转义出的反斜杠再转一次。
function tomlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
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
  const accStart = raw.indexOf('[[accounts]]')
  if (accStart < 0) return null
  const isEmail = /@/.test(user || '')
  const lines = raw.split('\n')
  // 需要写入的四个键；未在原文件出现的键必须补写，
  // 旧实现只改"已存在的行"，缺 mobile/area_code 的配置会保留旧值或空值导致登录失败。
  const want = {
    email: isEmail ? '"' + tomlEscape(user) + '"' : '""',
    mobile: isEmail ? '""' : '"' + tomlEscape(user) + '"',
    area_code: isEmail ? '""' : '"+86"',
    password: '"' + tomlEscape(pass) + '"'
  }
  const seen = { email: false, mobile: false, area_code: false, password: false }

  // 只在 [[accounts]] 段内改写：段边界 = 下一个以 '[' 开头的行
  let inAccounts = false
  let lastAccountLine = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[')) {
      inAccounts = trimmed === '[[accounts]]'
      if (inAccounts) lastAccountLine = i
      continue
    }
    if (!inAccounts) continue
    const kv = lines[i].match(/^\s*([a-zA-Z_]+)\s*=/)
    if (!kv) continue
    const key = kv[1]
    if (Object.prototype.hasOwnProperty.call(want, key)) {
      lines[i] = key + ' = ' + want[key]
      seen[key] = true
      lastAccountLine = i
    }
  }
  if (lastAccountLine < 0) return null

  // 补齐缺失的键，插到 [[accounts]] 段最后一行之后
  const missing = Object.keys(want)
    .filter((k) => !seen[k])
    .map((k) => k + ' = ' + want[k])
  if (missing.length) {
    lines.splice(lastAccountLine + 1, 0, ...missing)
  }
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

// 行级修复 [deepseek] 段的旧版指纹（Chrome/151 Edg UA、Android/35、2.0.4，
// 以及更早的 Windows 桌面 Chrome 136），与 rquest Emulation::Chrome136 的
// TLS 指纹对齐，并把浏览器身份切到目标平台 Linux aarch64（词典笔原生平台，
// UA/平台与真实硬件一致；Windows UA 在 ARM64 Linux 设备上是可识别的错配）。
// 只替换命中旧值的行，保留其它配置。
const NEW_USER_AGENT = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

// 需要改写为 Linux aarch64 UA 的历史值：旧版 Chrome/151 + Edg、Android 端 UA、
// Windows 桌面 UA、以及 x86_64 的 Linux UA（目标平台是 aarch64）
function isOutdatedUserAgent(val) {
  if (val.indexOf('X11; Linux aarch64') >= 0) return false
  return (
    val.indexOf('Chrome/') >= 0 ||
    val.indexOf('Edg/') >= 0 ||
    val.indexOf('Android/') >= 0 ||
    val.indexOf('Windows NT') >= 0 ||
    val.trim() === ''
  )
}

function fixFingerprint(raw) {
  const lines = String(raw || '').split('\n')
  let inDeepseek = false
  let changed = false
  let lastDeepseekLine = -1
  const seen = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inDeepseek = trimmed === '[deepseek]'
      if (inDeepseek) lastDeepseekLine = i
      continue
    }
    if (!inDeepseek) continue
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*=\s*"?([^"]*)"?\s*$/)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2]
    seen[key] = true
    lastDeepseekLine = i
    if (key === 'user_agent' && isOutdatedUserAgent(val)) {
      lines[i] = 'user_agent = "' + NEW_USER_AGENT + '"'
      changed = true
    } else if (key === 'client_version' && (val === '2.0.4' || val === '2.0.3' || val === '2.3.0' || val === '2.4.0')) {
      // new.jsonl（2026-09-12）实证线上 web 为 2.5.0（站点部署版本，与浏览器版本无关）
      lines[i] = 'client_version = "2.5.0"'
      changed = true
    } else if (key === 'client_platform' && val === 'android') {
      lines[i] = 'client_platform = "web"'
      changed = true
    } else if (key === 'client_locale' && val === 'zh-CN') {
      // full.har 实证 web 端 locale 为下划线格式
      lines[i] = 'client_locale = "zh_CN"'
      changed = true
    }
  }
  // 补齐新增的 web 请求头字段（老配置没有；缺失会退回后端默认值，但显式写入便于用户核对）
  if (lastDeepseekLine >= 0) {
    const additions = []
    if (!seen.client_bundle_id) additions.push('client_bundle_id = "com.deepseek.chat"')
    if (!seen.client_timezone_offset) additions.push('client_timezone_offset = 28800')
    if (additions.length) {
      lines.splice(lastDeepseekLine + 1, 0, ...additions)
      changed = true
    }
  }
  return changed ? lines.join('\n') : null
}

// 行级修复：把 model_types 收敛为官方合并后的唯一模型。
//
// 2026-09-12 官方合并"快速/专家/识图"三模式：client/settings?scope=model 实证
// expert 与 vision 都已 enabled:false，只剩 model_type="default"（自带图片理解）。
// 老配置里存的 ["default","expert","vision"]（或 build 22 误写的 "vl"）会让应用
// 继续注册/请求已下线的模型，识图/专家必失败。这里就地改写成 ["default"]。
// max_input/max_output_tokens 必须与 model_types 等长（后端启动会校验），一并裁到 1 项。
function fixModelTypes(raw) {
  const lines = String(raw || '').split('\n')
  let inDeepseek = false
  let typesFixed = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[')) {
      inDeepseek = trimmed === '[deepseek]'
      continue
    }
    if (!inDeepseek) continue
    const kv = lines[i].match(/^\s*([a-zA-Z_]+)\s*=\s*\[(.*)\]\s*$/)
    if (!kv) continue
    const key = kv[1]
    const items = kv[2].trim()
    if (key === 'model_types') {
      const next = 'model_types = ["default"]'
      if (next !== lines[i]) {
        lines[i] = next
        typesFixed = true
      }
    } else if (key === 'max_input_tokens' || key === 'max_output_tokens') {
      const parts = items ? items.split(',').map((s) => s.trim()).filter(Boolean) : []
      if (parts.length > 1) {
        lines[i] = key + ' = [' + parts[0] + ']'
        typesFixed = true
      }
    } else if (key === 'model_aliases') {
      // 别名按 index 对齐 model_types，多余项会指向已下线模型
      const parts = items ? items.split(',').map((s) => s.trim()).filter(Boolean) : []
      if (parts.length > 1) {
        lines[i] = 'model_aliases = [' + parts[0] + ']'
        typesFixed = true
      }
    }
  }
  return typesFixed ? lines.join('\n') : null
}

// runtime.log 滚动轮转：后端追加写不封顶，超过 256KB 时把旧内容尾部 800 行
// 留存到 runtime.log.1（bug 修复：不再直接截断丢弃，封号等事故日志可回查），
// 当前文件只保留最后 200 行。目录已在应用 data 目录下，fs 可直接 stat。
async function truncateRuntimeLog() {
  try {
    const logPath = dsRuntimeLogPath()
    const st = await statSize(logPath)
    if (st > 256 * 1024) {
      appLog('[log] runtime.log ' + st + ' 字节，轮转：旧内容尾部 800 行 → .1，当前保留 200 行')
      execShell(
        'tail -n 800 ' + shq(logPath) + ' > ' + shq(logPath + '.1') + '; ' +
        'tail -n 200 ' + shq(logPath) + ' > ' + shq(logPath + '.t') + ' && mv -f ' + shq(logPath + '.t') + ' ' + shq(logPath)
      )
    }
  } catch (e) { /* 忽略 */ }
}

/**
 * 更新本机 ds-free-api 的登录账号并重启服务。
 * 流程：读取 config.toml → JS 改写 [[accounts]] 段 → 写回（经临时文件 cp）→ 重启 → 轮询验证 /health。
 * 返回 { ok, message }。写入即视为成功（配置已落盘），health 探活失败也不回滚用户输入，
 * 只提示"配置已保存，服务可能仍在启动"。
 */
// 读取 config.toml；缺失时先尝试自愈重建，再读一次。
//
// 卸载重装 / 覆盖安装后 config.toml 可能不存在（旧版把重建逻辑放在 deployBackend 末尾，
// 而那之后有提前 return 的分支，配置就永远补不回来），用户会看到
// "无法读取 ds-free-api 配置文件（路径 …）"（bug 报告 3）。
// 这里在真正要用配置的三个入口统一兜一层，避免"配置没了 → 账号存不进去"的死局。
async function readConfigOrRepair() {
  const DS_CONFIG = dsConfigPath()
  let raw = await readFileWithShellFallback(DS_CONFIG)
  if (raw !== null) return raw
  appLog('[config] config.toml 缺失或不可读，尝试自愈重建')
  const r = await ensureDsConfig()
  if (!r.ok) return null
  // 重建后必须重启后端，否则跑着的进程仍持旧 api_key
  await restartDsFreeApi()
  return await readFileWithShellFallback(DS_CONFIG)
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
  const DS_CONFIG = dsConfigPath()
  try {
    const raw = await readConfigOrRepair()
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
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
    //
    // 超时从 30s 提到 75s：后端最多重试 3 次登录（每次间隔 2s）并在首次尝试时跑一次
    // 完整 health_check completion（含 PoW），慢网设备 30s 内经常还没跑完，
    // 于是"登录成功"被误报成"账号密码错误"（部分设备无法账密登录的另一成因）。
    const ok = await healthCheckWithAccount(75000)
    appLog('[update] 保存账号后健康+账号 ok=' + ok + ' apiKeyLen=' + apiKey.length)
    if (ok) {
      // 返回新 key 给调用方，由设置页更新 form.apiKey（避免应用继续用旧 key 导致 401）
      return { ok: true, message: '账号已保存，DeepSeek 登录成功', apiKey }
    }
    // 配置已写入，不因探活失败回滚（避免抹掉用户刚填的账号）。
    // 账号池空可能是密码错误，也可能是验证码/网络/禁言 —— 从 runtime.log 取真实原因，
    // 不再一律甩"请检查账号密码是否正确"。
    appLog('[update] 保存账号后账号池为空，可能登录失败')
    const detail = await readLoginFailureReason()
    return makeErr(
      10503,
      detail
        ? '账号已保存，但 DeepSeek 登录未成功：' + detail
        : '账号已保存，但 DeepSeek 登录未成功（可能是账号密码错误、需要验证码或网络不通；可在"查看日志"里看后端原因）'
    )
  } catch (e) {
    return makeErr(10002, '更新失败：' + (e && e.message ? e.message : String(e)))
  }
}

/**
 * 清空本机 ds-free-api 的登录账号（把 config.toml 的 [[accounts]] 段置空）并重启服务。
 *
 * 账号的真源是 config.toml：应用侧的 ds:accounts 只是显示名缓存，
 * 从缓存里删一条记录并不会真正退出登录（账号池仍会拿旧凭据登录）。
 * 登录页的「移除账号」必须走这里才名副其实。
 * 返回 { ok, message }；配置已落盘即视为成功，探活失败只提示不报错。
 */
export async function clearDsFreeApiAccount() {
  const DS_CONFIG = dsConfigPath()
  try {
    const raw = await readConfigOrRepair()
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceAccount(raw, '', '')
    if (next === null) return makeErr(10203, 'config.toml 中未找到 [[accounts]] 段')

    // 备份 + 原子写入，等待异步 execShell 真正完成（与账号更新同款可靠模式）
    const tmp = joinDataDir('dsconfig.tmp.toml')
    const resultFile = joinDataDir('dsconfig-result.txt')
    const writeOk = await writeFile(tmp, next)
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '')
    const cmd =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile)
    if (!execShell(cmd)) return makeErr(10403, '启动配置更新命令失败')
    const result = String(await waitForFile(resultFile, 10000) || '').trim()
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true')
    if (result !== 'ok') return makeErr(10403, '写入配置文件失败')

    const restartResult = await restartDsFreeApi()
    if (!restartResult.ok) return restartResult

    const healthy = await healthCheck()
    appLog('[account] 已清空本机账号 health=' + healthy)
    return {
      ok: true,
      message: healthy ? '已移除账号' : '账号已移除，后端仍在重启中'
    }
  } catch (e) {
    return makeErr(10002, '移除账号失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ---------- 调试模式代理（Socks5/HTTP） ----------
// 把出站代理写入本机 config.toml 的 [proxy] 段并重启后端。url 为空 = 清除代理直连。
// 支持 http://host:port 与 socks5://host:port（后端 wreq 原生支持两种协议）。
// 该代理作用于 ds-free-api → chat.deepseek.com 的全部出站请求（含 PoW wasm 下载），
// 用于调试模式下的抓包/内网穿透/绕过 WAF；应用自身访问 127.0.0.1 后端不走代理。

// 校验代理 URL：允许 http/https/socks5/socks5h，host 非空；返回错误文案或 null
export function validateProxyUrl(url) {
  const s = String(url || '').trim()
  if (!s) return null // 空 = 清除代理，合法
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)$/)
  if (!m) return '格式不正确（形如 socks5://192.168.1.5:1080 或 http://192.168.1.5:7890）'
  const scheme = m[1].toLowerCase()
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5' && scheme !== 'socks5h') {
    return '仅支持 http/https/socks5 代理'
  }
  let authority = m[2]
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  const host = authority.replace(/:\d+$/, '')
  if (!host) return '缺少主机地址'
  return null
}

// 行级替换 [proxy] 段（纯字符串操作）；url 为空时整段移除，否则段尾追加/改写
function replaceProxySection(raw, url) {
  const lines = String(raw || '').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[proxy]') {
      start = i
      break
    }
  }
  let end = lines.length
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) {
        end = i
        break
      }
    }
  }
  const before = lines.slice(0, start >= 0 ? start : lines.length)
  const after = lines.slice(end)
  if (!url) {
    return before.concat(after).join('\n')
  }
  const block = ['[proxy]', 'url = "' + tomlEscape(url) + '"']
  return before.concat(block, after).join('\n')
}

// 读取当前 [proxy].url（未配置返回 ''）
export async function readDsFreeApiProxy() {
  const raw = String((await readFile(dsConfigPath())) || '')
  let start = -1
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[proxy]') {
      start = i
      break
    }
  }
  if (start < 0) return ''
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[')) break
    const kv = trimmed.match(/^url\s*=\s*"([^"]*)"/)
    if (kv) return kv[1]
  }
  return ''
}

/**
 * 更新本机 ds-free-api 的出站代理并重启服务（调试模式用）。
 * @param {string} url 代理地址（http/https/socks5/socks5h），空串 = 清除代理直连
 * 返回 { ok, message }。写入即生效（配置已落盘 + 后端已重启 + 探活）。
 */
export async function updateDsFreeApiProxy(url) {
  const clean = String(url || '').trim()
  const invalid = validateProxyUrl(clean)
  if (invalid) return makeErr(10001, '代理地址' + invalid)
  const DS_CONFIG = dsConfigPath()
  try {
    const raw = await readConfigOrRepair()
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceProxySection(raw, clean)
    if (next === raw) return { ok: true, message: clean ? '代理未变化' : '本就未配置代理' }

    // 备份 + 原子写入，等待 execShell 完成（与账号更新同款可靠模式）
    const tmp = joinDataDir('dsproxy.tmp.toml')
    const resultFile = joinDataDir('dsproxy-result.txt')
    const writeOk = await writeFile(tmp, next)
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '')
    const cmd =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile)
    if (!execShell(cmd)) return makeErr(10403, '启动配置更新命令失败')
    const result = String(await waitForFile(resultFile, 10000) || '').trim()
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true')
    if (result !== 'ok') return makeErr(10403, '写入配置文件失败')

    // 重启后端使代理生效
    const restartResult = await restartDsFreeApi()
    if (!restartResult.ok) return restartResult

    const healthy = await healthCheck()
    appLog('[proxy] 已' + (clean ? '设置' : '清除') + '代理 health=' + healthy + ' url=' + (clean || '(直连)'))
    if (clean) {
      return {
        ok: true,
        message: healthy
          ? '代理已生效：' + clean
          : '代理已写入并重启后端，但探活未通过——请确认代理可用且地址正确'
      }
    }
    return { ok: true, message: healthy ? '已恢复直连' : '已恢复直连并重启后端，探活未通过' }
  } catch (e) {
    return makeErr(10002, '更新代理失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ---------- 调试网络抓取（JSONL） ----------
// 「启用调试日志」开关联动：把 [server] net_capture 写入本机 config.toml 并重启后端。
// 后端开启后把与 DeepSeek/数美的全部 HTTP 往返逐行落盘
// logs/net-capture.jsonl（JSONL，见 ds-free-api/src/server/net_capture.rs），
// 出现新的禁言/风控时无需挂代理抓包即可拿到第一手报文。

// 行级改写 [server] 段的 net_capture 键（纯字符串操作）。
// 与 [proxy] 整段替换不同：[server] 段还有 port/host 等键，只能改写单键——
// 键存在改值；段内缺失补在段尾；无 [server] 段则追加段。无变化返回 null。
function replaceServerNetCapture(raw, enabled) {
  const lines = String(raw || '').split('\n')
  const want = 'net_capture = ' + (enabled ? 'true' : 'false')
  let inServer = false
  let lastServerLine = -1
  let seen = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[')) {
      if (inServer) break // 进入下一段，[server] 段结束
      inServer = trimmed === '[server]'
      if (inServer) lastServerLine = i
      continue
    }
    if (!inServer) continue
    const kv = lines[i].match(/^\s*([a-zA-Z_]+)\s*=/)
    if (!kv) continue
    lastServerLine = i
    if (kv[1] === 'net_capture') {
      if (lines[i].trim() === want) return null // 已是目标值，无需写盘重启
      lines[i] = want
      seen = true
    }
  }
  if (lastServerLine < 0) {
    return raw + (raw.endsWith('\n') ? '' : '\n') + '[server]\n' + want + '\n'
  }
  if (!seen) lines.splice(lastServerLine + 1, 0, want)
  return lines.join('\n')
}

/**
 * 更新本机 ds-free-api 的网络抓取开关并重启服务（「启用调试日志」联动）。
 * @param {boolean} enabled true=开启抓取，false=关闭
 * 返回 { ok, message }。写入即生效（配置已落盘 + 后端已重启 + 探活）。
 */
export async function updateDsFreeApiNetCapture(enabled) {
  const DS_CONFIG = dsConfigPath()
  try {
    const raw = await readConfigOrRepair()
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceServerNetCapture(raw, !!enabled)
    if (next === null) return { ok: true, message: '抓取开关未变化' }

    // 备份 + 原子写入，等待 execShell 完成（与账号更新同款可靠模式）
    const tmp = joinDataDir('dscapture.tmp.toml')
    const resultFile = joinDataDir('dscapture-result.txt')
    const writeOk = await writeFile(tmp, next)
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '')
    const cmd =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile)
    if (!execShell(cmd)) return makeErr(10403, '启动配置更新命令失败')
    const result = String(await waitForFile(resultFile, 10000) || '').trim()
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true')
    if (result !== 'ok') return makeErr(10403, '写入配置文件失败')

    const restartResult = await restartDsFreeApi()
    if (!restartResult.ok) return restartResult

    const healthy = await healthCheck()
    appLog('[capture] net_capture=' + !!enabled + ' health=' + healthy)
    return {
      ok: true,
      message: healthy
        ? (enabled ? '网络抓取已开启' : '网络抓取已关闭')
        : (enabled ? '抓取已写入并重启后端，探活未通过（稍后自动恢复）' : '已写入关闭并重启后端，探活未通过')
    }
  } catch (e) {
    return makeErr(10002, '更新网络抓取开关失败：' + (e && e.message ? e.message : String(e)))
  }
}

async function restartDsFreeApi() {
  const DS_FREE_API_DIR = dsHomeDir()
  const binPath = joinPath(DS_FREE_API_DIR, 'ds-free-api')
  appLog('[restart] start binExists=' + (await exists(binPath)) + ' dirExists=' + (await exists(DS_FREE_API_DIR)))
  if (!(await exists(binPath))) {
    return makeErr(10303, 'ds-free-api 二进制不存在，请先部署后端服务')
  }
  if (!(await exists(DS_FREE_API_DIR))) {
    return makeErr(10304, 'ds-free-api 工作目录不存在')
  }

  const resultFile = joinDataDir('ds-restart-result.txt')
  const logFile = dsRuntimeLogPath()
  const pidFile = joinDataDir('ds-pid.txt')
  await writeFile(resultFile, '')

  // 清理旧后端进程。三条路子叠加，因为单靠任何一条都会漏（真机实测）：
  //  1) 记录的 PID（精确，但卸载重装后 PID 文件已随目录被清掉）；
  //  2) **fuser -k 按端口杀** —— 这是关键且唯一可靠的兜底：pkill 匹配的是进程名，
  //     实测 `pkill -9 -x ds-free-api` 在本机返回 1（v1.34.1 busybox 的 -x 与进程名
  //     匹配不上），进程根本杀不掉；而 fuser 直接问内核"谁占着这个端口"，无需名字匹配。
  //     僵尸后端的 cwd 已被删除、名字也可能变化，只有按端口才能找到它。
  //  3) pkill（不带 -x，宽匹配）兜底，覆盖还占着非标准端口的游离进程。
  const oldPid = String(await readFile(pidFile) || '').trim()
  // PID 会被系统复用而 pid 文件跨重启保留：重启后同号 PID 可能是任何进程。
  // 先核对 /proc/<pid>/cmdline 仍是 ds-free-api 才 kill -9，否则跳过
  // （还有 fuser/pkill 两条兜底路径）。
  const killOld = oldPid && /^\d+$/.test(oldPid)
    ? 'if grep -aq ds-free-api /proc/' + oldPid + '/cmdline 2>/dev/null; then kill -9 ' + oldPid + ' 2>/dev/null; fi; '
    : ''
  const killByPort = DS_PORTS
    .map((p) => 'fuser -k -9 ' + p + '/tcp 2>/dev/null; ')
    .join('')
  const command =
    killOld +
    'pkill -9 -x ds-free-api 2>/dev/null; ' +
    killByPort +
    'pkill -9 ds-free-api 2>/dev/null; ' +
    // 等端口真正释放：按端口 fuser 判定比 ss 可靠（本机无 ss，netstat 是 busybox 精简版
    // 且不支持 -p，只能列出状态不能定位进程）。最多等 10 秒。
    'for i in 1 2 3 4 5 6 7 8 9 10; do ' +
    'if ! (fuser ' + DS_PORTS[0] + '/tcp >/dev/null 2>&1); then break; fi; ' +
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
  // 新后端带 ready 字段（早绑定启动）：这里只验证服务可达，完整启动由
  // healthCheckWithAccount / checkBackendHealth(waitForReady) 等待。
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

// 健康检查 + 等待账号就绪：/health 返回 ok 且 ready=true（账号登录完成）
// 且 accounts.total > 0 才算成功。用于"保存账号"与启动页"完全启动"等待——
// 早绑定模式下端口秒通但登录在后台进行，不能拿端口连通当就绪。
async function healthCheckWithAccount(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000)
  let sawNotReady = false
  while (Date.now() < deadline) {
    for (const port of DS_PORTS) {
      const probe = joinDataDir('dshealth_acc_' + Date.now() + '_' + port + '.txt')
      await writeFile(probe, '')
      execShell('curl -s -m 1 http://127.0.0.1:' + port + '/health > ' + shq(probe) + ' 2>&1')
      const out = await waitForFile(probe, 1500)
      execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true')
      if (out !== null && String(out).indexOf('"status":"ok"') >= 0) {
        const text = String(out)
        // 旧后端无 ready 字段 → 视为已就绪
        const ready = text.indexOf('"ready"') < 0 || /"ready"\s*:\s*true/.test(text)
        if (!ready) {
          sawNotReady = true
          continue
        }
        // 端口通了，检查账号池
        const m = text.match(/"total"\s*:\s*(\d+)/)
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
  appLog('[health] 等待账号就绪超时' + (sawNotReady ? '（期间后端未完成初始化）' : ''))
  return false
}

// 从 runtime.log 尾部提取登录失败的真实原因，供"保存账号"失败时展示。
// 后端把具体原因写进日志（密码错误 / 人机验证 / 禁言 / 网络），但应用侧过去只显示
// "请检查账号密码是否正确"，用户无法区分。返回一句可读原因，取不到则返回 ''。
async function readLoginFailureReason() {
  try {
    const raw = String((await readFile(dsRuntimeLogPath())) || '')
    if (!raw) return ''
    const lines = raw.split('\n').filter((l) => l.trim())
    // 只看尾部 120 行（本次启动的日志），从后往前找第一条匹配的原因
    const tail = lines.slice(-120).reverse()
    const patterns = [
      { re: /RISK_DEVICE|设备风控|device_id/i, msg: '设备指纹被风控拒绝：请在 PC 浏览器登录一次 chat.deepseek.com，从 users/login 请求体抓取真实 device_id 填入账号配置' },
      { re: /人机验证|captcha/i, msg: '需要完成人机验证（请在设置里打开验证链接）' },
      { re: /禁言|user_is_muted/i, msg: '该账号已被禁言，到期前请更换账号' },
      { re: /密码错误|wrong password|invalid.*password|账号或密码/i, msg: '账号或密码错误' },
      { re: /WAF|Challenge/i, msg: '被上游风控拦截（换网络或稍后再试）' },
      { re: /dns|timed? ?out|超时|connect|网络/i, msg: '网络不通或连接超时' }
    ]
    for (const line of tail) {
      for (const p of patterns) {
        if (p.re.test(line)) return p.msg
      }
    }
    // 没命中已知模式时，回传最后一条 ERROR/WARN 原文（截断），至少让用户能反馈
    const err = tail.find((l) => /ERROR|WARN/i.test(l))
    if (err) return err.replace(/\s+/g, ' ').slice(0, 160)
    return ''
  } catch (e) {
    return ''
  }
}

// ========== 后端部署（base64 内嵌二进制，运行时回写） ==========
// 后端二进制已打包成 base64 内嵌在 backend-blob.js 中，首次运行时自动写入 /userdisk/ds-free-api

import { BACKEND_B64, BACKEND_NAME, BACKEND_ARCH, BACKEND_SHA } from './backend-blob.js'
import { httpRequest } from './http.js'

// 已部署后端的版本标记：记录上次落盘的二进制摘要（BACKEND_SHA）。
// 仅凭「文件存在且非空」跳过部署会让覆盖安装时后端永远停在旧版本
// —— 后端修了 bug（如登录响应解析）用户却拿不到。见 deployBackend 快速路径。
function backendMarkerPath() {
  return joinDataDir('ds-backend.sha')
}

// 判断设备上已部署的后端是否就是当前内嵌的这份
async function deployedBackendMatches() {
  if (!BACKEND_SHA) return false
  try {
    const cur = String(await readFile(backendMarkerPath()) || '').trim()
    return cur === BACKEND_SHA
  } catch (e) {
    return false
  }
}

// 确保 config.toml 存在并修正常见问题。
//
// 必须在 deployBackend 的"快速路径"提前返回**之前**调用：二进制与摘要都匹配、
// 但 config.toml 丢失时（覆盖安装、迁移异常、用户手删），旧实现直接 return，
// 配置文件永远不会重建 → 后续 updateDsFreeApiAccount / loadAccountList 报
// "无法读取 ds-free-api 配置文件（路径 …）"，账号也存不进去。
//
// 返回 { ok, existed, changed }：existed=false 表示本次新建；changed=true 表示写盘了
// （新建或被修正），调用方据此决定要不要重启后端让新配置生效。
//
// tryWriteConfig：fs.writeFile 失败（root 属主/只读属主）时经 execShell 以 root
// 写入。内容先落应用可写的 tmp，再由 root cp 到目标——execShell 参数转义用 shq。
async function tryWriteConfig(path, content) {
  if (await writeFile(path, content)) return true
  const tmp = joinDataDir('dsconfig-root-' + Date.now() + '.toml')
  if (!(await writeFile(tmp, content))) return false
  const resultFile = joinDataDir('dsconfig-root-result.txt')
  await writeFile(resultFile, '')
  execShell('cp ' + shq(tmp) + ' ' + shq(path) + ' && chmod 644 ' + shq(path) + '; printf ok > ' + shq(resultFile))
  const out = String(await waitForFile(resultFile, 8000) || '').trim()
  execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' 2>/dev/null || true')
  return out === 'ok'
}

async function ensureDsConfig() {
  const DS_CONFIG = dsConfigPath()

  // 存在性判断必须能识别"fs 读不到但文件实际存在"的机型（非 root 应用进程
  // 遇到 root 写出的 0600 文件）：exists+readFile 都失败时再用 execShell cat 兜底，
  // 否则会误判为缺失并重建空配置，把已登录账号抹掉。
  let shellProbe = null
  if (!(await exists(DS_CONFIG))) {
    shellProbe = await readFileWithShellFallback(DS_CONFIG)
    if (shellProbe === null) {
      // 真缺失：走重建
    } else {
      const repairedPerms = shellProbe
      // 文件存在但 fs 读不到：立即放宽权限，之后按已有内容继续走修复逻辑
      execShell('chmod 644 ' + shq(DS_CONFIG) + ' 2>/dev/null; chown $(id -u):$(id -g) ' + shq(DS_CONFIG) + ' 2>/dev/null; true')
      const before = String(repairedPerms || '')
      let raw = before
      const fixed = fixFingerprint(raw)
      if (fixed && fixed !== raw) {
        raw = fixed
        debugLog('DS | 已修复 config.toml 指纹字段（UA/version/platform/bundle_id/timezone）')
      }
      const fixedTypes = fixModelTypes(raw)
      if (fixedTypes && fixedTypes !== raw) {
        raw = fixedTypes
        debugLog('DS | 已把 config.toml model_types 收敛为合并后的 ["default"]')
      }
      if (raw !== before) {
        // fs.writeFile 可能同样写不进 root 属主文件——先夺回属主再写
        const w = await tryWriteConfig(DS_CONFIG, raw)
        appLog('[deploy] config.toml 已自动修复（shell 兜底路径）ok=' + w)
        return { ok: !!w, existed: true, changed: !!w }
      }
      return { ok: true, existed: true, changed: false }
    }
  } else {
    const before = String(await readFile(DS_CONFIG) || '')
    let raw = before
    // 指纹修复无条件跑：除了替换旧值，还要补齐新增字段（旧的 indexOf 判断会漏掉这类配置）
    const fixed = fixFingerprint(raw)
    if (fixed && fixed !== raw) {
      raw = fixed
      debugLog('DS | 已修复 config.toml 指纹字段（UA/version/platform/bundle_id/timezone）')
    }
    const fixedTypes = fixModelTypes(raw)
    if (fixedTypes && fixedTypes !== raw) {
      raw = fixedTypes
      debugLog('DS | 已把 config.toml model_types 收敛为合并后的 ["default"]')
    }
    if (raw !== before) {
      await writeFile(DS_CONFIG, raw)
      appLog('[deploy] config.toml 已自动修复')
      return { ok: true, existed: true, changed: true }
    }
    return { ok: true, existed: true, changed: false }
  }

  // 缺失：先确保目录存在。SDK 的 fs.writeFile 不会自动建目录，
  // 而 migrateLegacyDir 的 mkdir 是异步 execShell，不保证已完成——目录真缺时
  // 直接 writeFile 会静默失败，配置依旧补不回来。
  const mkdirResult = joinDataDir('ds-mkdir-result.txt')
  await writeFile(mkdirResult, '')
  execShell('mkdir -p ' + shq(dsHomeDir()) + ' ' + shq(joinPath(dsHomeDir(), 'logs')) + '; printf ok > ' + shq(mkdirResult))
  const mkdirOut = String(await waitForFile(mkdirResult, 8000) || '').trim()
  execShell('rm -f ' + shq(mkdirResult) + ' 2>/dev/null || true')
  appLog('[deploy] config.toml 缺失，mkdir=' + (mkdirOut || '(未确认)'))

  // 写入最小 config.toml（供后续 updateDsFreeApiAccount 改写 [[accounts]]）。
  // model_types 只有 "default"：官方 2026-09-12 合并了快速/专家/识图，
  // expert 与 vision 已 enabled:false，default 自带图片理解（file_feature.vision=true）。
  // 浏览器指纹统一 Linux aarch64 Chrome 136（与后端 Emulation::Chrome136 的
  // TLS 指纹同大版本，且与词典笔真实硬件平台一致）。
  const minConfig = [
    '[server]',
    'port = 22217',
    'host = "127.0.0.1"',
    '',
    '[deepseek]',
    'api_base = "https://chat.deepseek.com/api/v0"',
    'wasm_url = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"',
    'user_agent = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"',
    'client_version = "2.5.0"',
    'client_platform = "web"',
    'client_locale = "zh_CN"',
    'client_bundle_id = "com.deepseek.chat"',
    'client_timezone_offset = 28800',
    'model_types = ["default"]',
    // 实测 input_character_limit = 2621440；旧模板写 4096 会把长上下文提前截断
    'max_input_tokens = [1048576]',
    'max_output_tokens = [384000]',
    // 每账号每小时请求上限（上游实测 ~215 次/小时会触发禁言；0 = 不限制）
    'hourly_request_quota = 60',
    '',
    '[[accounts]]',
    'email = ""',
    'mobile = ""',
    'area_code = "+86"',
    'password = ""',
    ''
  ].join('\n')
  const configOk = await tryWriteConfig(DS_CONFIG, minConfig)
  appLog('[deploy] config.toml 缺失，已重建最小配置 ok=' + configOk)
  return { ok: !!configOk, existed: false, changed: !!configOk }
}

// 检测占着后端端口的"僵尸"后端：覆盖安装 / 卸载重装后，旧后端进程仍在运行，
// 但它的工作目录已被替换（readlink /proc/PID/cwd 含 "(deleted)"）。
//
// 后果很隐蔽：僵尸进程一直用着**旧配置里的旧 api_key** 占住 22217，新进程只能退到
// 22218；而应用健康检查按端口顺序优先命中 22217 → 拿新 key 请求旧进程 →
// 必然 401「未认证」。所以重启前必须把这类进程清掉。
// 返回形如 "1234:22217 5678:22218" 的描述串，空串表示没有僵尸。
async function detectStaleBackend() {
  const resultFile = joinDataDir('ds-stale-check.txt')
  await writeFile(resultFile, '')
  const cmd =
    'if command -v fuser >/dev/null 2>&1; then ' +
    'for p in ' + DS_PORTS.join(' ') + '; do ' +
    'for pid in $(fuser $p/tcp 2>/dev/null); do ' +
    'cwd=$(readlink /proc/$pid/cwd 2>/dev/null); ' +
    'case "$cwd" in *deleted*) printf "%s:%s " "$pid" "$p" >> ' + shq(resultFile) + ';; esac; ' +
    'done; done; fi; ' +
    'printf done >> ' + shq(resultFile)
  execShell(cmd)
  const out = String(await waitForFile(resultFile, 6000) || '')
  execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
  return out.replace(/done\s*$/, '').trim()
}

// 本二进制支持的 CPU 架构。BACKEND_ARCH 形如 "linux-aarch64-gnu"，取中段比较 uname -m。
// 当前仅用于日志/诊断展示，不参与部署阻断（部署成败由 healthCheck 判定）。
function supportedArch() {
  const m = String(BACKEND_ARCH || '').match(/-([a-z0-9_]+)-/)
  return m ? m[1] : ''
}

// 确保 ds-free-api 后端已部署到应用 data 目录（$dataDir/ds-free-api）
//
// single-flight：startup/index 走 ensureBackendRunning（内部会调 deploy），
// settings 页又直接调 deployBackend——两条并发路径写同一个 ds-free-api.b64
// 临时文件、跑同一条解码/替换命令，交错时会产生截断的 b64 和失败的部署。
// 与 ensureBackendRunning 一样共享同一个 Promise。
let _deployPromise = null

export function deployBackend() {
  if (_deployPromise) return _deployPromise
  _deployPromise = doDeployBackend().finally(() => { _deployPromise = null })
  return _deployPromise
}

async function doDeployBackend() {
  const targetDir = dsHomeDir()
  const targetBin = joinPath(targetDir, 'ds-free-api')
  const targetLogDir = joinPath(targetDir, 'logs')

  // 一次性迁移旧目录里的 config.toml（幂等，见 migrateLegacyDir 注释）
  await migrateLegacyDir()

  // config.toml 的保障必须放在**快速路径之前**：二进制与摘要匹配但配置丢失时，
  // 快速路径会直接 return，配置就永远补不回来（bug 报告 3 的成因）。
  const cfgResult = await ensureDsConfig()
  if (!cfgResult.ok) return makeErr(ERR.CONFIG_WRITE_FAILED, '写入配置文件失败')
  // 配置本次新建或被修正 → 必须让后端重启一次，否则跑着的进程仍持旧 api_key/账号
  const configNeedsRestart = cfgResult.changed

  // 快速路径：设备上已有二进制，且其摘要与本次内嵌的一致时才能跳过
  // 6MB base64 写盘 + 解码（同一安装内每次启动都做这些很慢）。
  // 摘要用 ds-backend.sha 记录（全量部署成功后写入）。注意不能用
  // 「文件存在且非空」判断——那样覆盖安装（data 目录保留）时后端永远停在旧版本，
  // 后端修了 bug 用户也拿不到；摘要匹配才真正说明是这一份。
  const targetBinExists = await exists(targetBin)
  if (targetBinExists) {
    const st = await statSize(targetBin)
    if (st > 0 && (await deployedBackendMatches())) {
      appLog('[deploy] 已存在且摘要匹配（size=' + st + '），跳过解码比较')
      const resultFile = joinDataDir('ds-deploy-result.txt')
      await writeFile(resultFile, '')
      execShell('mkdir -p ' + shq(targetLogDir) + '; chmod +x ' + shq(targetBin) + '; printf unchanged > ' + shq(resultFile))
      const result = String(await waitForFile(resultFile, 5000) || '').trim()
      execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
      if (result === 'unchanged') {
        return {
          ok: true,
          updated: false,
          configRepaired: configNeedsRestart,
          message: configNeedsRestart ? '已重建后端配置' : '后端已是最新版本'
        }
      }
      // chmod/写结果失败则继续走全量部署
      appLog('[deploy] 快速路径失败 result=' + (result || '(空)') + '，走全量')
    } else if (st > 0) {
      appLog('[deploy] 已有二进制但摘要不匹配（内嵌 ' + (BACKEND_SHA || '无') + '），走全量部署更新后端')
    }
  }

  // 首次部署或二进制缺失：base64 -> 临时文件 -> 原子替换，避免启动过程中留下半写入二进制。
  // 命令结构与 build 19 验证过的版本一致（单条 if/else，短小可靠），
  // 仅增强：无论 cmp 结果如何都强制 chmod +x，避免权限丢失不自愈。
  const tmpB64 = joinDataDir('ds-free-api.b64')
  const tmpBin = joinDataDir('ds-free-api.tmp')
  const stagedBin = joinPath(targetDir, 'ds-free-api.new')
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
      'mkdir -p ' + shq(targetDir) + ' ' + shq(targetLogDir) + ' && ' +
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
    // 落盘摘要标记：下次启动摘要一致即可走快速路径跳过 6MB 解码。
    // 解码成功（updated 或 unchanged）都写，失败路径不写、下次仍会重试。
    if (BACKEND_SHA) await writeFile(backendMarkerPath(), BACKEND_SHA)
    appLog('[deploy] ok updated=' + backendUpdated + ' sha=' + (BACKEND_SHA || '无'))
  } catch (e) {
    appLog('[deploy] EXCEPTION ' + (e && e.message ? e.message : String(e)))
    return makeErr(10002, '部署后端失败：' + (e && e.message ? e.message : String(e)))
  } finally {
    execShell('rm -f ' + shq(tmpB64) + ' ' + shq(tmpBin) + ' ' + shq(stagedBin) + ' ' + shq(resultFile) + ' 2>/dev/null || true')
  }

  // config.toml 已在本函数开头由 ensureDsConfig() 统一保障（新建 / 修正 / 指纹与模型收敛），
  // 这里只负责汇报结果。旧实现在这里才做配置处理，快速路径提前 return 时整段被跳过，
  // 导致配置丢失后永远补不回来。
  return {
    ok: true,
    updated: !!backendUpdated,
    configRepaired: configNeedsRestart,
    message: backendUpdated
      ? '后端已更新'
      : (configNeedsRestart ? '已重建后端配置' : '后端已是最新版本')
  }
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

  // 先识别"僵尸后端"：覆盖安装 / 卸载重装后旧进程仍占着端口，且用的是已删除目录里的
  // 旧 config（旧 api_key）。它会让 curl /health 照样返回 ok，于是后续
  // `!(await healthCheck())` 判定为 false → 以为后端正常、不重启 → 应用带着 config 里的
  // 新 key 去请求僵尸进程 → 401「未认证」。这正是 bug 报告 1 的成因。
  //
  // 这里只**检测**不立即重启：此刻新二进制可能还没部署（卸载重装后 data 目录是空的），
  // restartDsFreeApi 会因"二进制不存在"直接失败。真正的清理交给下面确定要重启时执行
  // （restartDsFreeApi 内部已按端口 fuser -k 强杀），这里用一个标记把"必须重启"钉死。
  const stale = await detectStaleBackend()
  const staleFound = !!stale
  if (staleFound) {
    appLog('[ensure] 发现僵尸后端（占端口且工作目录已删除）: ' + stale + '，将强制重启清理')
  }

  const deployResult = await deployBackend()
  appLog('[ensure] deploy ok=' + deployResult.ok + ' msg=' + (deployResult.message || '') + ' code=' + (deployResult.code || ''))
  truncateRuntimeLog()
  // 部署失败不再直接阻断：若设备上已有旧二进制，仍尝试启动它，避免"后端完全不拉起"。
  // 部署错误信息保留，供启动页展示定位。
  if (!deployResult.ok) {
    const binExists = await exists(joinPath(dsHomeDir(), 'ds-free-api'))
    if (!binExists) {
      appLog('[ensure] deploy FAIL 且无旧二进制，放弃')
      return deployResult
    }
    appLog('[ensure] deploy FAIL 但存在旧二进制，尝试直接启动')
    debugLog('DS | 部署失败但存在旧二进制，尝试直接启动: ' + deployResult.message)
  }

  // 三种情况都必须重启后端：
  //  - updated：二进制刚换新，得跑新版本；
  //  - configRepaired：配置刚重建/修正，跑着的进程仍持旧 api_key、旧账号；
  //  - staleFound：有僵尸占着端口，不杀它就会一直被健康检查"误判为正常"。
  // 注意 staleFound 必须在 healthCheck 之前参与判断（用 || 短路），
  // 否则僵尸的 /health 应答会让最后一条件为 false 而漏掉重启。
  const needRestart = staleFound || deployResult.updated || deployResult.configRepaired || !(await healthCheck())
  appLog('[ensure] needRestart=' + needRestart + ' stale=' + staleFound + ' updated=' + !!deployResult.updated + ' configRepaired=' + !!deployResult.configRepaired)
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
    const logTail = String(await readFile(dsRuntimeLogPath()) || '')
      .split('\n').filter(Boolean).slice(-5).join('；')
    appLog('[ensure] TIMEOUT logTail=' + (logTail || '(空)'))
    return makeErr(10502, 'ds-free-api 启动超时（' + (logTail || '无日志输出') + '）')
  }
  appLog('[ensure] DONE')
  return { ok: true, message: deployResult.message }
}

// 探测当前存活的后端端口（健康检查逐口探测，返回第一个 ok 的端口；全挂时回 22217）
export async function readDsFreeApiPort() {
  for (const port of DS_PORTS) {
    const probe = joinDataDir('dsport_' + Date.now() + '_' + port + '.txt')
    await writeFile(probe, '')
    execShell('curl -s -m 1 http://127.0.0.1:' + port + '/health > ' + shq(probe) + ' 2>&1')
    const out = await waitForFile(probe, 1500)
    execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true')
    if (out !== null && String(out).indexOf('"status":"ok"') >= 0) {
      return port
    }
  }
  return DS_PORTS[0]
}

// 设备凭据（device_id）现在由后端**完全自动**生成：ds-free-api 启动时检测到
// 账号缺凭据会直接走数美注册协议取得（用户无感），无需浏览器/扫码/任何操作。
// 详见 ds-free-api/docs/deepseek-verification-analysis.md §5f。
//
// 本函数仅保留为**可选的自检入口**（调试模式用）：查询后端凭据补齐情况。
export async function checkDeviceCredentials() {
  try {
    const port = await readDsFreeApiPort()
    const result = await httpRequest({
      url: 'http://127.0.0.1:' + port + '/health',
      method: 'GET',
      timeout: 8000,
    })
    if (result.statusCode !== 200 || !result.data) {
      return makeErr(10503, '后端未就绪（' + (result.error || 'HTTP ' + result.statusCode) + '）')
    }
    const total = (result.data.accounts && result.data.accounts.total) || 0
    if (total > 0) {
      return { ok: true, message: '设备凭据已就绪（' + total + ' 个账号可用）' }
    }
    return { ok: false, message: '账号尚未就绪：请确认账号密码正确；设备凭据由后端自动生成，无需手动操作' }
  } catch (e) {
    return makeErr(10503, '检查失败：' + (e && e.message ? e.message : String(e)))
  }
}

// 系统输入法编辑器：本模块直接调用原生 Global（不再走 @dictpen/core 的封装）。
// 原因（bug 4，真机取证）：预填充文本的字段名与 SDK 用的 `contents` 不同——
// 在本机 X7 Pro 的有道输入法 2.9.12 上按候选字段逐个打标记实测，只有 **text**
// 会被编辑器采用（contents / defaultText / inputText / value … 均被忽略，
// 编辑器一片空白）。这里把值放 text，并保留 contents 以兼容按该名字实现的固件。
export { INPUT_TYPES }

export function isAsrEnabled() {
  try {
    return coreIsAsrEnabled()
  } catch (e) {
    return false
  }
}

// 上一次编辑会话：用于防泄漏（页面隐藏/关闭时按取消结算）
let _editSettle = null
let _editCleanup = null

function editGlobal() {
  try {
    return g()
  } catch (e) {
    return null
  }
}

export function closeTextEditor() {
  const gg = editGlobal()
  try { if (gg) gg.closeTextEdit() } catch (e) { /* 忽略 */ }
  if (_editCleanup) {
    try { _editCleanup() } catch (e) { /* 忽略 */ }
    const settle = _editSettle
    _editSettle = null
    _editCleanup = null
    if (settle) settle(null)
  }
}

// IME 回传结果里的文本字段名（不同版本/语音输入形态不同，逐个兜底）
const EDIT_TEXT_KEYS = ['contents', 'jsonData', 'text', 'inputText', 'currentText', 'content', 'data', 'result', 'value', 'textContent', 'editContent']

function findEditText(j, depth) {
  if (depth > 3) return ''
  if (!j || typeof j !== 'object') return ''
  for (let i = 0; i < EDIT_TEXT_KEYS.length; i++) {
    const k = EDIT_TEXT_KEYS[i]
    if (j[k] === undefined || j[k] === null) continue
    if (typeof j[k] === 'string') return j[k]
    if (typeof j[k] === 'object') {
      const nested = findEditText(j[k], depth + 1)
      if (nested) return nested
    }
  }
  return ''
}

function extractEditResult(j) {
  if (!j || typeof j !== 'object') return { text: '', canceled: false, found: false }
  const canceled = !!(j.editCanceled || j.canceled || j.cancel)
  let hasKey = false
  for (let i = 0; i < EDIT_TEXT_KEYS.length; i++) {
    if (j[EDIT_TEXT_KEYS[i]] !== undefined && j[EDIT_TEXT_KEYS[i]] !== null) {
      hasKey = true
      break
    }
  }
  if (!hasKey) return { text: '', canceled, found: false }
  return { text: findEditText(j, 0), canceled, found: true }
}

function extractEditFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    let v = args[i]
    // FalconEvent 包装 {type,timestamp,data}
    if (v && typeof v === 'object' && 'data' in v) v = v.data
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      if (/^[0-9a-fA-F]{32}$/.test(v)) continue // 纯 uuid 不是文本
      try {
        const j = JSON.parse(v)
        if (j && typeof j === 'object') {
          const r = extractEditResult(j)
          if (r.found) return r
          continue
        }
      } catch (e) { /* 非 JSON，按纯文本 */ }
      return { text: v, canceled: false, found: true }
    }
    if (typeof v === 'object') {
      const r = extractEditResult(v)
      if (r.found) return r
    }
  }
  return { text: '', canceled: false, found: false }
}

/**
 * 打开系统原生输入法编辑当前文本。
 * @param {string} inputType 键盘模式（见 INPUT_TYPES）
 * @param {string} initialText 预填充文本（用户能直接看到并继续编辑）
 * @returns {Promise<?string>} 确认后的文本；null=取消；''=确认清空
 */
export function openTextEditor(inputType = INPUT_TYPES.ZH_CN_PREFERRED, initialText = '') {
  return new Promise((resolve) => {
    const gg = editGlobal()
    if (!gg || typeof gg.startTextEdit !== 'function') {
      // 原生不可用：退回 SDK 封装（至少能把键盘拉起来）
      try {
        resolve(coreOpenTextEditor(inputType, initialText))
      } catch (e) {
        resolve(null)
      }
      return
    }

    let settled = false
    // 上一次会话残留：先按取消结算，避免重复订阅
    if (_editCleanup) {
      try { _editCleanup() } catch (e) { /* 忽略 */ }
      const prev = _editSettle
      _editSettle = null
      _editCleanup = null
      if (prev) prev(null)
    }

    const cleanup = () => {
      try { gg.textEditFinished.off(handler) } catch (e) { /* 忽略 */ }
      try { $falcon.off('textEditFinished', falconHandler) } catch (e) { /* 忽略 */ }
    }

    const settle = (args) => {
      if (settled) return
      settled = true
      cleanup()
      if (_editCleanup === cleanup) {
        _editSettle = null
        _editCleanup = null
      }
      const r = extractEditFromArgs(args)
      // found=false（诊断钩子等无有效载荷）按取消处理，不覆盖调用方原值
      resolve(!r.found ? null : (r.canceled ? null : r.text))
    }

    const handler = function () {
      settle(Array.prototype.slice.call(arguments))
    }
    const falconHandler = function (e) {
      settle([e])
    }

    gg.textEditFinished.on(handler)
    try { $falcon.on('textEditFinished', falconHandler) } catch (e) { /* 忽略 */ }
    _editSettle = settle
    _editCleanup = cleanup

    try {
      const text = String(initialText === undefined || initialText === null ? '' : initialText)
      // text 是实测生效的预填充字段（见上方注释）；contents 一并带上做兼容。
      const config = {
        inputType,
        placeholder: '',
        autofocus: true,
        maxlength: 2000,
        showCursor: true,
        confirmButtonDisabledOnTextEmpty: true,
        multiLinesEditVisible: true,
        enterButtonText: '完成',
        text,
        contents: text
      }
      gg.startTextEdit(JSON.stringify(config))
    } catch (e) {
      settle([])
    }
  })
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
