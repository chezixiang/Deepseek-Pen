import fs from 'fs';
import globalModule from 'global';
import { BUILD_NUM } from './build-info.js';

// 系统输入法编辑器封装：调用设备系统级输入法（有道输入法 youdao-im）编辑文本。

/** 系统输入法键盘模式（反编译自 youdao-im 2.9.12 InputPage.vue） */
const INPUT_TYPES = {
  /** 中文首选（默认） */
  ZH_CN_PREFERRED: 'ZhCNPreferred',
  /** 仅中文 */
  ZH_CN_ONLY: 'ZhCNOnly',
  /** 英文首选 */
  EN_US_PREFERRED: 'EnUSPreferred',
  /** 仅英文 */
  EN_US_ONLY: 'EnUSOnly',
  /** 符号首选 */
  SYMBOLS_PREFERRED: 'SymbolsPreferred',
  /** 标点首选 */
  PUNCTUATION_PREFERRED: 'PunctuationPreferred',
  /**
   * 录音模式（y03 主题特有，与底部滑动手势关联）。
   * 注意：实测在 X7 Pro 上不触发语音按钮——语音按钮用默认 ZH_CN_PREFERRED 即可带出。
   */
  RECORD_PREFERRED: 'RecordPreferred'
};

let _g$1 = null;
function g$1() {
  if (!_g$1) _g$1 = new globalModule.Global();
  return _g$1
}

// 当前待处理的编辑会话（用于防泄漏：页面隐藏/关闭时把旧会话按取消结算，避免残留 handler 干扰下次编辑）
let activeSettle = null;
let activeCleanup = null;

// 把 textEditFinished 信号载荷归一化为文本。
// 实测：有道输入法通过 sendTextEditFinishedSignal(JSON.stringify(result)) 回传，
// result 对象形如 { uuid, contents, jsonData, editConfirmed, editCanceled }；
// 载荷也可能是纯文本，或（诊断钩子下）任务 uuid。
const TEXT_KEYS = ['contents', 'jsonData', 'text', 'inputText', 'currentText', 'content', 'data', 'result', 'value', 'textContent', 'editContent'];

function findText(j, depth) {
  if (depth > 3) return ''
  if (!j || typeof j !== 'object') return ''
  for (const k of TEXT_KEYS) {
    if (j[k] !== undefined && j[k] !== null) {
      if (typeof j[k] === 'string') return j[k]
      if (typeof j[k] === 'object') {
        const nested = findText(j[k], depth + 1);
        if (nested) return nested
      }
    }
  }
  return ''
}

function isCanceled(j) {
  return !!(j && typeof j === 'object' && (j.editCanceled || j.canceled || j.cancel))
}

// 从结果对象提取文本。found=false 表示这不是一次有效的编辑结果载荷
// （例如诊断钩子只回传任务 uuid），此时不应覆盖调用方的原值。
function extractResult(j) {
  if (!j || typeof j !== 'object') return { text: '', canceled: false, found: false }
  const canceled = isCanceled(j);
  const hasTextKey = TEXT_KEYS.some((k) => j[k] !== undefined && j[k] !== null);
  if (!hasTextKey) return { text: '', canceled, found: false }
  return { text: findText(j, 0), canceled, found: true }
}

function extractFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    let v = args[i];
    // 解包 FalconEvent 包装 {type,timestamp,data}
    if (v && typeof v === 'object' && 'data' in v) v = v.data;
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      // 纯 uuid（32 位 hex）不是文本，跳过
      if (/^[0-9a-fA-F]{32}$/.test(v)) continue
      try {
        const j = JSON.parse(v);
        if (j && typeof j === 'object') {
          const r = extractResult(j);
          if (r.found) return r
          continue
        }
      } catch (e) { /* 不是 JSON，当作纯文本 */ }
      // 裸字符串：确认后的纯文本结果
      return { text: v, canceled: false, found: true }
    }
    if (typeof v === 'object') {
      const r = extractResult(v);
      if (r.found) return r
    }
  }
  return { text: '', canceled: false, found: false }
}

/**
 * 打开系统原生文本编辑器（自带软键盘）。
 * 同时订阅 Global 信号与 $falcon 框架事件两条通道，避免漏接回传。
 *
 * 参数形态实测（对比计算器 v1.12.103 / tools_shell 字节码，offset 6858-6893）：
 *   - 裸字符串：startTextEdit('ZhCNPreferred') → 能拉起键盘，但只被当作 inputType，
 *     不显示语音/录音按钮；
 *   - 真对象：startTextEdit({...}) → Falcon JS→C++ 桥接层无法序列化，拉不起键盘；
 *   - JSON 字符串：startTextEdit(JSON.stringify({inputType, ...})) → 计算器实际形态
 *     （stringify 距 startTextEdit 仅 35 字节），系统输入法按 InputPage 配置处理，
 *     带语音/录音按钮。
 *
 * @param {string} [inputType] 键盘模式，见 INPUT_TYPES，默认 ZhCNPreferred
 * @param {string} [initialText] 预填充文本（IME 的 contents 字段）
 * @returns {Promise<?string>} 编辑结果文本；null 表示取消；空串表示确认清空
 */
function openTextEditor$1(inputType = INPUT_TYPES.ZH_CN_PREFERRED, initialText = '') {
  return new Promise((resolve) => {
    const gg = g$1();
    let settled = false;
    // 上一次编辑会话残留：先结算为「取消」，避免重复订阅导致事件错乱
    if (activeCleanup) {
      try { activeCleanup(); } catch (e) { /* 忽略 */ }
      const prevSettle = activeSettle;
      activeSettle = null;
      activeCleanup = null;
      if (prevSettle) prevSettle(null);
    }

    const cleanup = () => {
      try { gg.textEditFinished.off(handler); } catch (e) { /* 忽略 */ }
      try { $falcon.off('textEditFinished', falconHandler); } catch (e) { /* 忽略 */ }
    };

    const settle = (args) => {
      if (settled) return
      settled = true;
      cleanup();
      if (activeCleanup === cleanup) {
        activeSettle = null;
        activeCleanup = null;
      }
      const r = extractFromArgs(args);
      // found=false（诊断钩子等无有效结果载荷）时按取消处理，不覆盖调用方原值
      resolve(!r.found ? null : (r.canceled ? null : r.text));
    };

    const handler = function () {
      settle(Array.prototype.slice.call(arguments));
    };
    const falconHandler = function (e) {
      settle([e]);
    };

    gg.textEditFinished.on(handler);
    try { $falcon.on('textEditFinished', falconHandler); } catch (e) { /* 忽略 */ }
    activeSettle = settle;
    activeCleanup = cleanup;

    try {
      // InputPage 配置对象，字段集对齐计算器 v1.12.103 tools_shell 的反编译 JSON
      // （placeholder/autofocus/maxlength/showCursor/confirmButtonDisabledOnTextEmpty/
      //  inputType/multiLinesEditVisible/enterButtonText/contents），以 JSON 字符串传给原生代理。
      // 实测：裸字符串无语音按钮；真对象桥接失败拉不起键盘；JSON 字符串才触发完整
      // 输入法路径（含语音按钮）。multiLinesEditVisible=true 显示键盘工具栏收起按钮
      // （RetractButton，语音键左侧返回箭头，点击收起键盘但保留输入框）。
      // contents 为 IME 预填充文本（IME 通过 this.$page.loadOptions.contents 读取，
      // 见 .probe/ime_main.txt），修改消息/编辑已有设置项时把当前值带回键盘。
      const config = {
        inputType,
        placeholder: '',
        autofocus: true,
        maxlength: 2000,
        showCursor: true,
        confirmButtonDisabledOnTextEmpty: true,
        multiLinesEditVisible: true,
        enterButtonText: '完成',
        contents: initialText || ''
      };
      gg.startTextEdit(JSON.stringify(config));
    } catch (e) {
      settle([]);
    }
  })
}

// 应用侧文件日志：默认开启，写入 $dataDir/ds-app.log（追加模式）。

const LOG_FILE = () => String($dataDir || '/tmp/').replace(/\/+$/, '') + '/ds-app.log';
const MAX_LOG_LINES = 500;

let logQueue = Promise.resolve();

// 追加一行日志（带时间戳）。串行队列保证多行不互相覆盖。失败静默，不影响主流程。
function appLog(...args) {
  const line = new Date().toISOString() + ' | ' + args.map(String).join(' ');
  logQueue = logQueue.then(() => doAppend(line)).catch(() => {});
  return logQueue
}

async function doAppend(line) {
  try {
    let prev = '';
    try {
      const raw = await fs.readFile(LOG_FILE());
      if (raw) prev = String(raw);
    } catch (e) { /* 首次写入，无旧文件 */ }
    const next = (prev ? prev.replace(/^\[object Promise\]\n?/, '') + '\n' : '') + line;
    const lines = next.split('\n');
    let trimmed = next;
    if (lines.length > MAX_LOG_LINES) {
      // 轮转保留（bug 修复）：被挤出的较旧内容转入 .old（尾部 1000 行），
      // 不再直接丢弃——否则封号等事故发生前的日志无从查证
      const overflow = lines.slice(0, lines.length - MAX_LOG_LINES).join('\n');
      try {
        let prevOld = '';
        try {
          const oldRaw = await fs.readFile(LOG_FILE() + '.old');
          if (oldRaw) prevOld = String(oldRaw);
        } catch (e) { /* 无上一份 */ }
        const merged = (prevOld ? prevOld + '\n' : '') + overflow;
        const oldLines = merged.split('\n');
        await fs.writeFile(LOG_FILE() + '.old', oldLines.slice(-1000).join('\n'));
      } catch (e) { /* 忽略 */ }
      trimmed = lines.slice(-MAX_LOG_LINES).join('\n');
    }
    await fs.writeFile(LOG_FILE(), trimmed);
  } catch (e) { /* 忽略 */ }
}

// 读取日志：gen=0 当前文件，gen=1 上一份（轮转保留的 .old）
async function appLogTail(n = 10, gen = 0) {
  try {
    const path = LOG_FILE() + (gen === 1 ? '.old' : '');
    const raw = String(await fs.readFile(path) || '');
    return raw.split('\n').filter(Boolean).slice(-n).join('\n')
  } catch (e) {
    return ''
  }
}

// 清空应用日志（含上一份）
async function appLogClear() {
  try { await fs.writeFile(LOG_FILE(), ''); } catch (e) { /* 忽略 */ }
  try { await fs.writeFile(LOG_FILE() + '.old', ''); } catch (e) { /* 忽略 */ }
}

// ---------- 后端日志（ds-free-api runtime.log） ----------
// build 22 起 ds-free-api 部署在 $dataDir/ds-free-api，fs 可直接读。
// 直接用 fs 而不经 native.js，避免与 native.js → appLog 的循环依赖。
// gen=1 读 runtime.log.1（native.js 截断时保留的上一份，尾部 800 行）。
const BACKEND_LOG_FILE = (gen = 0) =>
  String($dataDir || '/tmp/').replace(/\/+$/, '') +
  '/ds-free-api/logs/runtime.log' + (gen === 1 ? '.1' : '');

async function backendLogTail(n = 100, gen = 0) {
  try {
    const raw = String(await fs.readFile(BACKEND_LOG_FILE(gen)) || '');
    return raw.split('\n').filter(Boolean).slice(-n).join('\n')
  } catch (e) {
    return ''
  }
}

async function backendLogClear() {
  try { await fs.writeFile(BACKEND_LOG_FILE(0), ''); } catch (e) { /* 忽略 */ }
  try { await fs.writeFile(BACKEND_LOG_FILE(1), ''); } catch (e) { /* 忽略 */ }
}

// ---------- 网络抓取（ds-free-api net-capture.jsonl） ----------
// 「启用调试日志」开关联动抓取的上游报文（后端 net_capture.rs 双向落盘，
// JSONL 每行一个事件，文件可达 20MB）。**读取走 native.js 的 readNetCaptureTail**
// （shell tail，避免整读进 QuickJS）；这里只提供清空（writeFile 空串即截断）。
const NET_CAPTURE_FILE = (gen = 0) =>
  String($dataDir || '/tmp/').replace(/\/+$/, '') +
  '/ds-free-api/logs/net-capture.jsonl' + (gen === 1 ? '.1' : gen === 2 ? '.2' : '');

async function netCaptureClear() {
  for (const gen of [0, 1, 2]) {
    try { await fs.writeFile(NET_CAPTURE_FILE(gen), ''); } catch (e) { /* 忽略 */ }
  }
}

// 设备原生能力封装（已通过真机探针验证）。

// ========== 错误码定义（10000 起） ==========
// 结构：模块编号(10) + 功能编号(10-70) + 位置编号(01-99)
const ERR = Object.freeze({
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
});

// $dataDir 的尾斜杠在不同机型上不一致（X7 带、部分机型不带），且各处拼接
// 又会自带前导 '/'，两者相遇就产生 `/data//ds-free-api` 这种非法路径。
// 统一规则：dataDirBase() 永远返回**不带**尾斜杠的目录，joinPath() 负责补一个。
function dataDirBase() {
  return String($dataDir || '/tmp').replace(/\/+$/, '')
}

// 任意段数拼接：去掉每段首尾多余斜杠后用单个 '/' 连接，保留 base 的前导 '/'
function joinPath(base, ...parts) {
  let out = String(base == null ? '' : base).replace(/\/+$/, '');
  for (const part of parts) {
    const seg = String(part == null ? '' : part).replace(/^\/+/, '').replace(/\/+$/, '');
    if (seg) out += '/' + seg;
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
let _debugLogEnabled = false;
function setDebugLogEnabled(v) {
  _debugLogEnabled = !!v;
}
function debugLog(...args) {
  if (!_debugLogEnabled) return
  try { console.error('DSLOG | ' + args.join(' ')); } catch (e) { /* 忽略 */ }
}

let _g = null;
function g() {
  if (!_g) _g = new globalModule.Global();
  return _g
}

function execShell(cmd) {
  try {
    return g().execShell(cmd)
  } catch (e) {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- 文件（import fs） ----------
async function readFile(path) {
  try { return await fs.readFile(path) } catch (e) { return null }
}

// fs.readFile 读不到（个别机型应用进程非 root，而 ds-free-api 以 root 运行，
// 写出的 config.toml 曾带 0600 权限 → "无法读取 ds-free-api 配置文件"10201）时，
// 用 execShell（root）cat 落到应用可读的临时文件再读。仅限小文件（配置）使用。
async function readFileWithShellFallback(path) {
  const raw = await readFile(path);
  if (raw !== null) return raw
  const out = joinDataDir('ds-cat-' + Date.now() + '.txt');
  await writeFile(out, '');
  execShell('cat ' + shq(path) + ' > ' + shq(out) + ' 2>/dev/null; chmod 644 ' + shq(path) + ' 2>/dev/null; true');
  const via = await waitForFile(out, 5000);
  execShell('rm -f ' + shq(out) + ' 2>/dev/null || true');
  if (via === null || String(via) === '') return null
  return String(via)
}

async function writeFile(path, content) {
  try { return await fs.writeFile(path, content) } catch (e) { return false }
}

async function exists(path) {
  try { return await fs.exists(path) } catch (e) { return false }
}

async function statSize(path) {
  try {
    const st = await fs.stat(path);
    return st && st.size ? st.size : 0
  } catch (e) { return 0 }
}

async function readdir(path) {
  try { return await fs.readdir(path) } catch (e) { return null }
}

async function mkdir(path) {
  try { return await fs.mkdir(path) } catch (e) { return false }
}

// 轮询读取某个文件，直到它出现非空内容或超时。execShell 是异步的，用它来等命令产物。
async function waitForFile(path, timeoutMs, shouldCancel) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldCancel && shouldCancel()) return null
    const c = await readFile(path);
    if (c !== null && c !== '') return c
    await sleep(150);
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
const DS_LEGACY_DIR = '/userdisk/ds-free-api';
const DS_PORTS = [22217, 22218, 22219, 22220, 22221, 22222];

function dsHomeDir() {
  return joinDataDir('ds-free-api')
}

function dsConfigPath() {
  return joinPath(dsHomeDir(), 'config.toml')
}

// ds-free-api 运行日志路径（后端用 DS_DATA_DIR + "/logs/runtime.log"）
function dsRuntimeLogPath() {
  return joinPath(dsHomeDir(), 'logs', 'runtime.log')
}

// 一次性迁移：老版本 /userdisk/ds-free-api 下的 config.toml 拷到新目录（幂等）。
// 二进制不拷贝——走 deployBackend 的 base64 全量部署，保证写入的是当前内嵌版本。
async function migrateLegacyDir() {
  const home = dsHomeDir();
  const cfg = dsConfigPath();
  const resultFile = joinDataDir('ds-migrate-result.txt');
  await writeFile(resultFile, '');
  const cmd =
    'mkdir -p ' + shq(joinPath(home, 'logs')) + '; ' +
    'if [ ! -f ' + shq(cfg) + ' ] && [ -f ' + shq(joinPath(DS_LEGACY_DIR, 'config.toml')) + ' ]; then ' +
    'cp ' + shq(joinPath(DS_LEGACY_DIR, 'config.toml')) + ' ' + shq(cfg) + '; fi; ' +
    'printf ok > ' + shq(resultFile);
  execShell(cmd);
  await waitForFile(resultFile, 15000);
  execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true');
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// 停止一个后台流式 curl 任务（按唯一 token 精确匹配，避免误杀其它 curl）
function stopStream(token) {
  try {
    execShell('pkill -f ' + shq(token) + ' || true');
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
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16)
  })
}

// 在 JS 里改写 config.toml 的 [[accounts]] 段（纯字符串操作，不拼 shell），返回新内容；失败返回 null。
// 采用按行处理（split/map/join），避免 QuickJS 对 `^...$` 多行正则/RegExp.lastIndex 的兼容性问题。
function replaceAccount(raw, user, pass) {
  const accStart = raw.indexOf('[[accounts]]');
  if (accStart < 0) return null
  const isEmail = /@/.test(user || '');
  const lines = raw.split('\n');
  // 需要写入的四个键；未在原文件出现的键必须补写，
  // 旧实现只改"已存在的行"，缺 mobile/area_code 的配置会保留旧值或空值导致登录失败。
  const want = {
    email: isEmail ? '"' + tomlEscape(user) + '"' : '""',
    mobile: isEmail ? '""' : '"' + tomlEscape(user) + '"',
    area_code: isEmail ? '""' : '"+86"',
    password: '"' + tomlEscape(pass) + '"'
  };
  const seen = { email: false, mobile: false, area_code: false, password: false };

  // 只在 [[accounts]] 段内改写：段边界 = 下一个以 '[' 开头的行
  let inAccounts = false;
  let lastAccountLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) {
      inAccounts = trimmed === '[[accounts]]';
      if (inAccounts) lastAccountLine = i;
      continue
    }
    if (!inAccounts) continue
    const kv = lines[i].match(/^\s*([a-zA-Z_]+)\s*=/);
    if (!kv) continue
    const key = kv[1];
    if (Object.prototype.hasOwnProperty.call(want, key)) {
      lines[i] = key + ' = ' + want[key];
      seen[key] = true;
      lastAccountLine = i;
    }
  }
  if (lastAccountLine < 0) return null

  // 补齐缺失的键，插到 [[accounts]] 段最后一行之后
  const missing = Object.keys(want)
    .filter((k) => !seen[k])
    .map((k) => k + ' = ' + want[k]);
  if (missing.length) {
    lines.splice(lastAccountLine + 1, 0, ...missing);
  }
  return lines.join('\n')
}

// 替换或追加 [[api_keys]] 段，避免空 key 导致 401
function replaceApiKey(raw, apiKey) {
  const apiKeyBlock = '[[api_keys]]\nkey = "' + apiKey + '"\ndescription = "auto-generated"';
  const start = raw.indexOf('[[api_keys]]');
  if (start >= 0) {
    const end = raw.indexOf('\n[', start + 1);
    const before = raw.substring(0, start);
    const after = end >= 0 ? raw.substring(end) : '';
    return before + apiKeyBlock + after
  }
  return raw + (raw.endsWith('\n') ? '' : '\n') + apiKeyBlock
}

// 行级修复 [deepseek] 段的旧版指纹（Chrome/151 Edg UA、Android/35、2.0.4，
// 以及更早的 Windows 桌面 Chrome 136），与 rquest Emulation::Chrome136 的
// TLS 指纹对齐，并把浏览器身份切到目标平台 Linux aarch64（词典笔原生平台，
// UA/平台与真实硬件一致；Windows UA 在 ARM64 Linux 设备上是可识别的错配）。
// 只替换命中旧值的行，保留其它配置。
const NEW_USER_AGENT = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

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
  const lines = String(raw || '').split('\n');
  let inDeepseek = false;
  let changed = false;
  let lastDeepseekLine = -1;
  const seen = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inDeepseek = trimmed === '[deepseek]';
      if (inDeepseek) lastDeepseekLine = i;
      continue
    }
    if (!inDeepseek) continue
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (!kv) continue
    const key = kv[1];
    const val = kv[2];
    seen[key] = true;
    lastDeepseekLine = i;
    if (key === 'user_agent' && isOutdatedUserAgent(val)) {
      lines[i] = 'user_agent = "' + NEW_USER_AGENT + '"';
      changed = true;
    } else if (key === 'client_version' && (val === '2.0.4' || val === '2.0.3' || val === '2.3.0' || val === '2.4.0')) {
      // new.jsonl（2026-09-12）实证线上 web 为 2.5.0（站点部署版本，与浏览器版本无关）
      lines[i] = 'client_version = "2.5.0"';
      changed = true;
    } else if (key === 'client_platform' && val === 'android') {
      lines[i] = 'client_platform = "web"';
      changed = true;
    } else if (key === 'client_locale' && val === 'zh-CN') {
      // full.har 实证 web 端 locale 为下划线格式
      lines[i] = 'client_locale = "zh_CN"';
      changed = true;
    }
  }
  // 补齐新增的 web 请求头字段（老配置没有；缺失会退回后端默认值，但显式写入便于用户核对）
  if (lastDeepseekLine >= 0) {
    const additions = [];
    if (!seen.client_bundle_id) additions.push('client_bundle_id = "com.deepseek.chat"');
    if (!seen.client_timezone_offset) additions.push('client_timezone_offset = 28800');
    if (additions.length) {
      lines.splice(lastDeepseekLine + 1, 0, ...additions);
      changed = true;
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
  const lines = String(raw || '').split('\n');
  let inDeepseek = false;
  let typesFixed = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) {
      inDeepseek = trimmed === '[deepseek]';
      continue
    }
    if (!inDeepseek) continue
    const kv = lines[i].match(/^\s*([a-zA-Z_]+)\s*=\s*\[(.*)\]\s*$/);
    if (!kv) continue
    const key = kv[1];
    const items = kv[2].trim();
    if (key === 'model_types') {
      const next = 'model_types = ["default"]';
      if (next !== lines[i]) {
        lines[i] = next;
        typesFixed = true;
      }
    } else if (key === 'max_input_tokens' || key === 'max_output_tokens') {
      const parts = items ? items.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (parts.length > 1) {
        lines[i] = key + ' = [' + parts[0] + ']';
        typesFixed = true;
      }
    } else if (key === 'model_aliases') {
      // 别名按 index 对齐 model_types，多余项会指向已下线模型
      const parts = items ? items.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (parts.length > 1) {
        lines[i] = 'model_aliases = [' + parts[0] + ']';
        typesFixed = true;
      }
    }
  }
  return typesFixed ? lines.join('\n') : null
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
  const DS_CONFIG = dsConfigPath();
  let raw = await readFileWithShellFallback(DS_CONFIG);
  if (raw !== null) return raw
  appLog('[config] config.toml 缺失或不可读，尝试自愈重建');
  const r = await ensureDsConfig();
  if (!r.ok) return null
  // 重建后必须重启后端，否则跑着的进程仍持旧 api_key
  await restartDsFreeApi();
  return await readFileWithShellFallback(DS_CONFIG)
}

/**
 * 更新本机 ds-free-api 的登录账号并重启服务。
 * 流程：读取 config.toml → JS 改写 [[accounts]] 段 → 写回（经临时文件 cp）→ 重启 → 轮询验证 /health。
 * 返回 { ok, message }。写入即视为成功（配置已落盘），health 探活失败也不回滚用户输入，
 * 只提示"配置已保存，服务可能仍在启动"。
 */
async function updateDsFreeApiAccount(user, pass) {
  const cleanUser = sanitizeCred(user);
  const cleanPass = sanitizeCred(pass);
  if (!cleanUser || !cleanPass) return makeErr(10001, '账号和密码不能为空')
  const DS_CONFIG = dsConfigPath();
  try {
    const raw = await readConfigOrRepair();
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceAccount(raw, cleanUser, cleanPass);
    if (next === null) return makeErr(10203, 'config.toml 中未找到 [[accounts]] 段')

    // 生成随机 API Key（UUID v4 小写去中划线），并写入 config
    const apiKey = uuidV4().replace(/-/g, '');
    const withApiKey = replaceApiKey(next, apiKey);

    // 备份 + 原子写入，并等待异步 execShell 真正完成。
    const tmp = joinDataDir('dsconfig.tmp.toml');
    const resultFile = joinDataDir('dsconfig-result.txt');
    const writeOk = await writeFile(tmp, withApiKey);
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '');
    const configCommand =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile);
    if (!execShell(configCommand)) return makeErr(10403, '启动配置更新命令失败')
    const configResult = String(await waitForFile(resultFile, 10000) || '').trim();
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true');
    if (configResult !== 'ok') return makeErr(10403, '写入配置文件失败')

    // 重启后端服务
    const restartResult = await restartDsFreeApi();
    if (!restartResult.ok) return restartResult

    // 探活并等待账号就绪：healthCheck 只确认端口绑定，新进程登录 DeepSeek 需时间。
    // 若 health ok 但账号池为空（登录失败/未完成），对话仍会"未认证"。
    //
    // 超时从 30s 提到 75s：后端最多重试 3 次登录（每次间隔 2s）并在首次尝试时跑一次
    // 完整 health_check completion（含 PoW），慢网设备 30s 内经常还没跑完，
    // 于是"登录成功"被误报成"账号密码错误"（部分设备无法账密登录的另一成因）。
    const ok = await healthCheckWithAccount(75000);
    appLog('[update] 保存账号后健康+账号 ok=' + ok + ' apiKeyLen=' + apiKey.length);
    if (ok) {
      // 返回新 key 给调用方，由设置页更新 form.apiKey（避免应用继续用旧 key 导致 401）
      return { ok: true, message: '账号已保存，DeepSeek 登录成功', apiKey }
    }
    // 配置已写入，不因探活失败回滚（避免抹掉用户刚填的账号）。
    // 账号池空可能是密码错误，也可能是验证码/网络/禁言 —— 从 runtime.log 取真实原因，
    // 不再一律甩"请检查账号密码是否正确"。
    appLog('[update] 保存账号后账号池为空，可能登录失败');
    const detail = await readLoginFailureReason();
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
async function clearDsFreeApiAccount() {
  const DS_CONFIG = dsConfigPath();
  try {
    const raw = await readConfigOrRepair();
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceAccount(raw, '', '');
    if (next === null) return makeErr(10203, 'config.toml 中未找到 [[accounts]] 段')

    // 备份 + 原子写入，等待异步 execShell 真正完成（与账号更新同款可靠模式）
    const tmp = joinDataDir('dsconfig.tmp.toml');
    const resultFile = joinDataDir('dsconfig-result.txt');
    const writeOk = await writeFile(tmp, next);
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '');
    const cmd =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile);
    if (!execShell(cmd)) return makeErr(10403, '启动配置更新命令失败')
    const result = String(await waitForFile(resultFile, 10000) || '').trim();
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true');
    if (result !== 'ok') return makeErr(10403, '写入配置文件失败')

    const restartResult = await restartDsFreeApi();
    if (!restartResult.ok) return restartResult

    const healthy = await healthCheck();
    appLog('[account] 已清空本机账号 health=' + healthy);
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
function validateProxyUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null // 空 = 清除代理，合法
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)$/);
  if (!m) return '格式不正确（形如 socks5://192.168.1.5:1080 或 http://192.168.1.5:7890）'
  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5' && scheme !== 'socks5h') {
    return '仅支持 http/https/socks5 代理'
  }
  let authority = m[2];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  const host = authority.replace(/:\d+$/, '');
  if (!host) return '缺少主机地址'
  return null
}

// 行级替换 [proxy] 段（纯字符串操作）；url 为空时整段移除，否则段尾追加/改写
function replaceProxySection(raw, url) {
  const lines = String(raw || '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[proxy]') {
      start = i;
      break
    }
  }
  let end = lines.length;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) {
        end = i;
        break
      }
    }
  }
  const before = lines.slice(0, start >= 0 ? start : lines.length);
  const after = lines.slice(end);
  if (!url) {
    return before.concat(after).join('\n')
  }
  const block = ['[proxy]', 'url = "' + tomlEscape(url) + '"'];
  return before.concat(block, after).join('\n')
}

// 读取当前 [proxy].url（未配置返回 ''）
async function readDsFreeApiProxy() {
  const raw = String((await readFile(dsConfigPath())) || '');
  let start = -1;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[proxy]') {
      start = i;
      break
    }
  }
  if (start < 0) return ''
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) break
    const kv = trimmed.match(/^url\s*=\s*"([^"]*)"/);
    if (kv) return kv[1]
  }
  return ''
}

/**
 * 更新本机 ds-free-api 的出站代理并重启服务（调试模式用）。
 * @param {string} url 代理地址（http/https/socks5/socks5h），空串 = 清除代理直连
 * 返回 { ok, message }。写入即生效（配置已落盘 + 后端已重启 + 探活）。
 */
async function updateDsFreeApiProxy(url) {
  const clean = String(url || '').trim();
  const invalid = validateProxyUrl(clean);
  if (invalid) return makeErr(10001, '代理地址' + invalid)
  const DS_CONFIG = dsConfigPath();
  try {
    const raw = await readConfigOrRepair();
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceProxySection(raw, clean);
    if (next === raw) return { ok: true, message: clean ? '代理未变化' : '本就未配置代理' }

    // 备份 + 原子写入，等待 execShell 完成（与账号更新同款可靠模式）
    const tmp = joinDataDir('dsproxy.tmp.toml');
    const resultFile = joinDataDir('dsproxy-result.txt');
    const writeOk = await writeFile(tmp, next);
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '');
    const cmd =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile);
    if (!execShell(cmd)) return makeErr(10403, '启动配置更新命令失败')
    const result = String(await waitForFile(resultFile, 10000) || '').trim();
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true');
    if (result !== 'ok') return makeErr(10403, '写入配置文件失败')

    // 重启后端使代理生效
    const restartResult = await restartDsFreeApi();
    if (!restartResult.ok) return restartResult

    const healthy = await healthCheck();
    appLog('[proxy] 已' + (clean ? '设置' : '清除') + '代理 health=' + healthy + ' url=' + (clean || '(直连)'));
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
  const lines = String(raw || '').split('\n');
  const want = 'net_capture = ' + (enabled ? 'true' : 'false');
  let inServer = false;
  let lastServerLine = -1;
  let seen = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) {
      if (inServer) break // 进入下一段，[server] 段结束
      inServer = trimmed === '[server]';
      if (inServer) lastServerLine = i;
      continue
    }
    if (!inServer) continue
    const kv = lines[i].match(/^\s*([a-zA-Z_]+)\s*=/);
    if (!kv) continue
    lastServerLine = i;
    if (kv[1] === 'net_capture') {
      if (lines[i].trim() === want) return null // 已是目标值，无需写盘重启
      lines[i] = want;
      seen = true;
    }
  }
  if (lastServerLine < 0) {
    return raw + (raw.endsWith('\n') ? '' : '\n') + '[server]\n' + want + '\n'
  }
  if (!seen) lines.splice(lastServerLine + 1, 0, want);
  return lines.join('\n')
}

/**
 * 更新本机 ds-free-api 的网络抓取开关并重启服务（「启用调试日志」联动）。
 * @param {boolean} enabled true=开启抓取，false=关闭
 * 返回 { ok, message }。写入即生效（配置已落盘 + 后端已重启 + 探活）。
 */
async function updateDsFreeApiNetCapture(enabled) {
  const DS_CONFIG = dsConfigPath();
  try {
    const raw = await readConfigOrRepair();
    if (raw === null) return makeErr(10201, '无法读取 ds-free-api 配置文件（路径：' + DS_CONFIG + '）')
    const next = replaceServerNetCapture(raw, !!enabled);
    if (next === null) return { ok: true, message: '抓取开关未变化' }

    // 备份 + 原子写入，等待 execShell 完成（与账号更新同款可靠模式）
    const tmp = joinDataDir('dscapture.tmp.toml');
    const resultFile = joinDataDir('dscapture-result.txt');
    const writeOk = await writeFile(tmp, next);
    if (!writeOk) return makeErr(10402, '写入临时配置文件失败')
    await writeFile(resultFile, '');
    const cmd =
      'cp ' + shq(DS_CONFIG) + ' ' + shq(DS_CONFIG + '.bak') + ' && ' +
      'cp ' + shq(tmp) + ' ' + shq(DS_CONFIG + '.new') + ' && ' +
      'mv -f ' + shq(DS_CONFIG + '.new') + ' ' + shq(DS_CONFIG) + ' && ' +
      'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile);
    if (!execShell(cmd)) return makeErr(10403, '启动配置更新命令失败')
    const result = String(await waitForFile(resultFile, 10000) || '').trim();
    execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' ' + shq(DS_CONFIG + '.new') + ' 2>/dev/null || true');
    if (result !== 'ok') return makeErr(10403, '写入配置文件失败')

    const restartResult = await restartDsFreeApi();
    if (!restartResult.ok) return restartResult

    const healthy = await healthCheck();
    appLog('[capture] net_capture=' + !!enabled + ' health=' + healthy);
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

/**
 * 读网络抓取文件尾部（「查看诊断日志 → 网络抓取」用）。
 * 用 shell tail 而非 fs.readFile：文件可达 20MB，整读进 QuickJS 会撑爆内存。
 * 每行展示层截断到 600 字符（完整内容以文件为准）。
 * @param {number} n 尾部行数
 * @param {number} gen 0=当前 1=.1 2=.2（后端轮转）
 */
async function readNetCaptureTail(n = 20, gen = 0) {
  const suffix = gen === 1 ? '.1' : gen === 2 ? '.2' : '';
  const p = joinPath(dsHomeDir(), 'logs', 'net-capture.jsonl' + suffix);
  const tmp = joinDataDir('ds-capture-tail.txt');
  try {
    await writeFile(tmp, '');
    // cut -c 在设备侧就截断每行：单个事件体可达 16MB，避免 tail 输出整行
    // 再整读进 QuickJS（busybox cut 支持 -c）
    execShell('tail -n ' + n + ' ' + shq(p) + ' | cut -c 1-600 > ' + shq(tmp) + ' 2>/dev/null; true');
    const out = await waitForFile(tmp, 3000);
    return String(out || '')
      .split('\n')
      .filter(Boolean)
      .map((l) => (l.length >= 600 ? l + '…' : l))
      .join('\n')
  } catch (e) {
    return ''
  } finally {
    execShell('rm -f ' + shq(tmp) + ' 2>/dev/null || true');
  }
}

async function restartDsFreeApi() {
  const DS_FREE_API_DIR = dsHomeDir();
  const binPath = joinPath(DS_FREE_API_DIR, 'ds-free-api');
  appLog('[restart] start binExists=' + (await exists(binPath)) + ' dirExists=' + (await exists(DS_FREE_API_DIR)));
  if (!(await exists(binPath))) {
    return makeErr(10303, 'ds-free-api 二进制不存在，请先部署后端服务')
  }
  if (!(await exists(DS_FREE_API_DIR))) {
    return makeErr(10304, 'ds-free-api 工作目录不存在')
  }

  const resultFile = joinDataDir('ds-restart-result.txt');
  const logFile = dsRuntimeLogPath();
  const pidFile = joinDataDir('ds-pid.txt');
  await writeFile(resultFile, '');

  // 清理旧后端进程。三条路子叠加，因为单靠任何一条都会漏（真机实测）：
  //  1) 记录的 PID（精确，但卸载重装后 PID 文件已随目录被清掉）；
  //  2) **fuser -k 按端口杀** —— 这是关键且唯一可靠的兜底：pkill 匹配的是进程名，
  //     实测 `pkill -9 -x ds-free-api` 在本机返回 1（v1.34.1 busybox 的 -x 与进程名
  //     匹配不上），进程根本杀不掉；而 fuser 直接问内核"谁占着这个端口"，无需名字匹配。
  //     僵尸后端的 cwd 已被删除、名字也可能变化，只有按端口才能找到它。
  //  3) pkill（不带 -x，宽匹配）兜底，覆盖还占着非标准端口的游离进程。
  const oldPid = String(await readFile(pidFile) || '').trim();
  // PID 会被系统复用而 pid 文件跨重启保留：重启后同号 PID 可能是任何进程。
  // 先核对 /proc/<pid>/cmdline 仍是 ds-free-api 才 kill -9，否则跳过
  // （还有 fuser/pkill 两条兜底路径）。
  const killOld = oldPid && /^\d+$/.test(oldPid)
    ? 'if grep -aq ds-free-api /proc/' + oldPid + '/cmdline 2>/dev/null; then kill -9 ' + oldPid + ' 2>/dev/null; fi; '
    : '';
  const killByPort = DS_PORTS
    .map((p) => 'fuser -k -9 ' + p + '/tcp 2>/dev/null; ')
    .join('');
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
    'printf started > ' + shq(resultFile);
  const execOk = execShell(command);
  appLog('[restart] execShell=' + execOk + ' oldPid=' + (oldPid || '无'));
  if (!execOk) return makeErr(10302, '启动 ds-free-api 重启命令失败')

  const result = String(await waitForFile(resultFile, 10000) || '').trim();
  appLog('[restart] result=' + (result || '(空)'));
  if (result !== 'started') return makeErr(10302, '启动 ds-free-api 进程失败（nohup）')

  // 读 PID 用于诊断 + 下次 kill。PID 文件保留不删（供下次 restart 精确杀旧进程）。
  const pid = String(await readFile(pidFile) || '').trim();
  if (pid && /^\d+$/.test(pid)) {
    debugLog('DS | ds-free-api 已启动 pid=' + pid);
    appLog('[restart] pid=' + pid);
  }
  execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true');
  return { ok: true }
}

async function healthCheck() {
  // 串行探测，优先 22217（主端口）。execShell 是异步无回显的，&&/wait 等后台组合在
  // 设备上不可靠，回退到逐端口 curl + 文件轮询（build 19 验证过的可靠方式）。
  // 每端口 curl -m 1 + 1.5s 等待；端口少（主端口优先），一轮最快 ~1.5s。
  // 新后端带 ready 字段（早绑定启动）：这里只验证服务可达，完整启动由
  // healthCheckWithAccount / checkBackendHealth(waitForReady) 等待。
  const order = [DS_PORTS[0], ...DS_PORTS.slice(1)]; // 22217 优先
  for (let i = 0; i < 3; i++) {
    for (const port of order) {
      const probe = joinDataDir('dshealth_' + Date.now() + '_' + i + '_' + port + '.txt');
      await writeFile(probe, '');
      execShell('curl -s -m 1 http://127.0.0.1:' + port + '/health > ' + shq(probe) + ' 2>&1');
      const out = await waitForFile(probe, 1500);
      execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true');
      if (out !== null && String(out).indexOf('"status":"ok"') >= 0) {
        appLog('[health] ok port=' + port + ' round=' + (i + 1));
        return true
      }
    }
    if (i < 2) await sleep(1000);
  }
  appLog('[health] FAIL 3 轮均未通过');
  return false
}

// 健康检查 + 等待账号就绪：/health 返回 ok 且 ready=true（账号登录完成）
// 且 accounts.total > 0 才算成功。用于"保存账号"与启动页"完全启动"等待——
// 早绑定模式下端口秒通但登录在后台进行，不能拿端口连通当就绪。
async function healthCheckWithAccount(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  let sawNotReady = false;
  while (Date.now() < deadline) {
    for (const port of DS_PORTS) {
      const probe = joinDataDir('dshealth_acc_' + Date.now() + '_' + port + '.txt');
      await writeFile(probe, '');
      execShell('curl -s -m 1 http://127.0.0.1:' + port + '/health > ' + shq(probe) + ' 2>&1');
      const out = await waitForFile(probe, 1500);
      execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true');
      if (out !== null && String(out).indexOf('"status":"ok"') >= 0) {
        const text = String(out);
        // 旧后端无 ready 字段 → 视为已就绪
        const ready = text.indexOf('"ready"') < 0 || /"ready"\s*:\s*true/.test(text);
        if (!ready) {
          sawNotReady = true;
          continue
        }
        // 端口通了，检查账号池
        const m = text.match(/"total"\s*:\s*(\d+)/);
        const total = m ? parseInt(m[1], 10) : 0;
        if (total > 0) {
          appLog('[health] ok+账号 port=' + port + ' total=' + total);
          return true
        }
        appLog('[health] 端口通但账号池空 total=' + total + '（登录中或失败）');
      }
    }
    await sleep(1500);
  }
  appLog('[health] 等待账号就绪超时' + (sawNotReady ? '（期间后端未完成初始化）' : ''));
  return false
}

// 从 runtime.log 尾部提取登录失败的真实原因，供"保存账号"失败时展示。
// 后端把具体原因写进日志（密码错误 / 人机验证 / 禁言 / 网络），但应用侧过去只显示
// "请检查账号密码是否正确"，用户无法区分。返回一句可读原因，取不到则返回 ''。
async function readLoginFailureReason() {
  try {
    const raw = String((await readFile(dsRuntimeLogPath())) || '');
    if (!raw) return ''
    const lines = raw.split('\n').filter((l) => l.trim());
    // 只看尾部 120 行（本次启动的日志），从后往前找第一条匹配的原因
    const tail = lines.slice(-120).reverse();
    const patterns = [
      { re: /RISK_DEVICE|设备风控|device_id/i, msg: '设备指纹被风控拒绝：请在 PC 浏览器登录一次 chat.deepseek.com，从 users/login 请求体抓取真实 device_id 填入账号配置' },
      { re: /人机验证|captcha/i, msg: '需要完成人机验证（请在设置里打开验证链接）' },
      { re: /禁言|user_is_muted/i, msg: '该账号已被禁言，到期前请更换账号' },
      { re: /密码错误|wrong password|invalid.*password|账号或密码/i, msg: '账号或密码错误' },
      { re: /WAF|Challenge/i, msg: '被上游风控拦截（换网络或稍后再试）' },
      { re: /dns|timed? ?out|超时|connect|网络/i, msg: '网络不通或连接超时' }
    ];
    for (const line of tail) {
      for (const p of patterns) {
        if (p.re.test(line)) return p.msg
      }
    }
    // 没命中已知模式时，回传最后一条 ERROR/WARN 原文（截断），至少让用户能反馈
    const err = tail.find((l) => /ERROR|WARN/i.test(l));
    if (err) return err.replace(/\s+/g, ' ').slice(0, 160)
    return ''
  } catch (e) {
    return ''
  }
}
const BACKEND_B64 = '';

// 判断设备上已部署的后端是否就是当前内嵌的这份
async function deployedBackendMatches() {
  return false
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
  const tmp = joinDataDir('dsconfig-root-' + Date.now() + '.toml');
  if (!(await writeFile(tmp, content))) return false
  const resultFile = joinDataDir('dsconfig-root-result.txt');
  await writeFile(resultFile, '');
  execShell('cp ' + shq(tmp) + ' ' + shq(path) + ' && chmod 644 ' + shq(path) + '; printf ok > ' + shq(resultFile));
  const out = String(await waitForFile(resultFile, 8000) || '').trim();
  execShell('rm -f ' + shq(tmp) + ' ' + shq(resultFile) + ' 2>/dev/null || true');
  return out === 'ok'
}

async function ensureDsConfig() {
  const DS_CONFIG = dsConfigPath();

  // 存在性判断必须能识别"fs 读不到但文件实际存在"的机型（非 root 应用进程
  // 遇到 root 写出的 0600 文件）：exists+readFile 都失败时再用 execShell cat 兜底，
  // 否则会误判为缺失并重建空配置，把已登录账号抹掉。
  let shellProbe = null;
  if (!(await exists(DS_CONFIG))) {
    shellProbe = await readFileWithShellFallback(DS_CONFIG);
    if (shellProbe === null) ; else {
      const repairedPerms = shellProbe;
      // 文件存在但 fs 读不到：立即放宽权限，之后按已有内容继续走修复逻辑
      execShell('chmod 644 ' + shq(DS_CONFIG) + ' 2>/dev/null; chown $(id -u):$(id -g) ' + shq(DS_CONFIG) + ' 2>/dev/null; true');
      const before = String(repairedPerms || '');
      let raw = before;
      const fixed = fixFingerprint(raw);
      if (fixed && fixed !== raw) {
        raw = fixed;
        debugLog('DS | 已修复 config.toml 指纹字段（UA/version/platform/bundle_id/timezone）');
      }
      const fixedTypes = fixModelTypes(raw);
      if (fixedTypes && fixedTypes !== raw) {
        raw = fixedTypes;
        debugLog('DS | 已把 config.toml model_types 收敛为合并后的 ["default"]');
      }
      if (raw !== before) {
        // fs.writeFile 可能同样写不进 root 属主文件——先夺回属主再写
        const w = await tryWriteConfig(DS_CONFIG, raw);
        appLog('[deploy] config.toml 已自动修复（shell 兜底路径）ok=' + w);
        return { ok: !!w, existed: true, changed: !!w }
      }
      return { ok: true, existed: true, changed: false }
    }
  } else {
    const before = String(await readFile(DS_CONFIG) || '');
    let raw = before;
    // 指纹修复无条件跑：除了替换旧值，还要补齐新增字段（旧的 indexOf 判断会漏掉这类配置）
    const fixed = fixFingerprint(raw);
    if (fixed && fixed !== raw) {
      raw = fixed;
      debugLog('DS | 已修复 config.toml 指纹字段（UA/version/platform/bundle_id/timezone）');
    }
    const fixedTypes = fixModelTypes(raw);
    if (fixedTypes && fixedTypes !== raw) {
      raw = fixedTypes;
      debugLog('DS | 已把 config.toml model_types 收敛为合并后的 ["default"]');
    }
    if (raw !== before) {
      await writeFile(DS_CONFIG, raw);
      appLog('[deploy] config.toml 已自动修复');
      return { ok: true, existed: true, changed: true }
    }
    return { ok: true, existed: true, changed: false }
  }

  // 缺失：先确保目录存在。SDK 的 fs.writeFile 不会自动建目录，
  // 而 migrateLegacyDir 的 mkdir 是异步 execShell，不保证已完成——目录真缺时
  // 直接 writeFile 会静默失败，配置依旧补不回来。
  const mkdirResult = joinDataDir('ds-mkdir-result.txt');
  await writeFile(mkdirResult, '');
  execShell('mkdir -p ' + shq(dsHomeDir()) + ' ' + shq(joinPath(dsHomeDir(), 'logs')) + '; printf ok > ' + shq(mkdirResult));
  const mkdirOut = String(await waitForFile(mkdirResult, 8000) || '').trim();
  execShell('rm -f ' + shq(mkdirResult) + ' 2>/dev/null || true');
  appLog('[deploy] config.toml 缺失，mkdir=' + (mkdirOut || '(未确认)'));

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
  ].join('\n');
  const configOk = await tryWriteConfig(DS_CONFIG, minConfig);
  appLog('[deploy] config.toml 缺失，已重建最小配置 ok=' + configOk);
  return { ok: !!configOk, existed: false, changed: !!configOk }
}

// 确保 ds-free-api 后端已部署到应用 data 目录（$dataDir/ds-free-api）
//
// single-flight：startup/index 走 ensureBackendRunning（内部会调 deploy），
// settings 页又直接调 deployBackend——两条并发路径写同一个 ds-free-api.b64
// 临时文件、跑同一条解码/替换命令，交错时会产生截断的 b64 和失败的部署。
// 与 ensureBackendRunning 一样共享同一个 Promise。
let _deployPromise = null;

function deployBackend() {
  // 账号登录模式已暂停：没有内嵌二进制可部署。保留函数签名与全部部署逻辑，
  // 恢复开关并重新内嵌后这里自然继续工作。
  if (!BACKEND_B64) {
    return Promise.resolve(makeErr(ERR.DEPLOY_VERIFY_FAILED, '账号登录模式已暂停：本版本不内嵌后端二进制'))
  }
  if (_deployPromise) return _deployPromise
  _deployPromise = doDeployBackend().finally(() => { _deployPromise = null; });
  return _deployPromise
}

async function doDeployBackend() {
  const targetDir = dsHomeDir();
  const targetBin = joinPath(targetDir, 'ds-free-api');
  const targetLogDir = joinPath(targetDir, 'logs');

  // 一次性迁移旧目录里的 config.toml（幂等，见 migrateLegacyDir 注释）
  await migrateLegacyDir();

  // config.toml 的保障必须放在**快速路径之前**：二进制与摘要匹配但配置丢失时，
  // 快速路径会直接 return，配置就永远补不回来（bug 报告 3 的成因）。
  const cfgResult = await ensureDsConfig();
  if (!cfgResult.ok) return makeErr(ERR.CONFIG_WRITE_FAILED, '写入配置文件失败')
  // 配置本次新建或被修正 → 必须让后端重启一次，否则跑着的进程仍持旧 api_key/账号
  const configNeedsRestart = cfgResult.changed;

  // 快速路径：设备上已有二进制，且其摘要与本次内嵌的一致时才能跳过
  // 6MB base64 写盘 + 解码（同一安装内每次启动都做这些很慢）。
  // 摘要用 ds-backend.sha 记录（全量部署成功后写入）。注意不能用
  // 「文件存在且非空」判断——那样覆盖安装（data 目录保留）时后端永远停在旧版本，
  // 后端修了 bug 用户也拿不到；摘要匹配才真正说明是这一份。
  const targetBinExists = await exists(targetBin);
  if (targetBinExists) {
    const st = await statSize(targetBin);
    if (st > 0 && (await deployedBackendMatches())) {
      appLog('[deploy] 已存在且摘要匹配（size=' + st + '），跳过解码比较');
      const resultFile = joinDataDir('ds-deploy-result.txt');
      await writeFile(resultFile, '');
      execShell('mkdir -p ' + shq(targetLogDir) + '; chmod +x ' + shq(targetBin) + '; printf unchanged > ' + shq(resultFile));
      const result = String(await waitForFile(resultFile, 5000) || '').trim();
      execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true');
      if (result === 'unchanged') {
        return {
          ok: true,
          updated: false,
          configRepaired: configNeedsRestart,
          message: configNeedsRestart ? '已重建后端配置' : '后端已是最新版本'
        }
      }
      // chmod/写结果失败则继续走全量部署
      appLog('[deploy] 快速路径失败 result=' + (result || '(空)') + '，走全量');
    } else if (st > 0) {
      appLog('[deploy] 已有二进制但摘要不匹配（内嵌 ' + ('无') + '），走全量部署更新后端');
    }
  }

  // 首次部署或二进制缺失：base64 -> 临时文件 -> 原子替换，避免启动过程中留下半写入二进制。
  // 命令结构与 build 19 验证过的版本一致（单条 if/else，短小可靠），
  // 仅增强：无论 cmp 结果如何都强制 chmod +x，避免权限丢失不自愈。
  const tmpB64 = joinDataDir('ds-free-api.b64');
  const tmpBin = joinDataDir('ds-free-api.tmp');
  const stagedBin = joinPath(targetDir, 'ds-free-api.new');
  const resultFile = joinDataDir('ds-deploy-result.txt');
  appLog('[deploy] 全量部署 start dataDir=' + String($dataDir) + ' target=' + targetDir);
  try {
    const writeB64Ok = await writeFile(tmpB64, BACKEND_B64);
    appLog('[deploy] write b64=' + writeB64Ok + ' len=' + ('').length);
    if (!writeB64Ok) {
      return makeErr(10402, '写入临时 base64 文件失败（$dataDir=' + String($dataDir) + '）')
    }
    await writeFile(resultFile, '');
    const command =
      'mkdir -p ' + shq(targetDir) + ' ' + shq(targetLogDir) + ' && ' +
      'base64 -d ' + shq(tmpB64) + ' > ' + shq(tmpBin) + ' && ' +
      'if [ -f ' + shq(targetBin) + ' ] && cmp -s ' + shq(tmpBin) + ' ' + shq(targetBin) + '; then ' +
      'chmod +x ' + shq(targetBin) + '; printf unchanged > ' + shq(resultFile) + '; else ' +
      'cp ' + shq(tmpBin) + ' ' + shq(stagedBin) + ' && ' +
      'chmod +x ' + shq(stagedBin) + ' && ' +
      'mv -f ' + shq(stagedBin) + ' ' + shq(targetBin) + ' && ' +
      'chmod +x ' + shq(targetBin) + ' && ' +
      'printf updated > ' + shq(resultFile) + '; fi || printf failed > ' + shq(resultFile);
    const execOk = execShell(command);
    appLog('[deploy] execShell=' + execOk + ' cmdLen=' + command.length);
    if (!execOk) return makeErr(10403, '启动后端更新命令失败')
    const result = String(await waitForFile(resultFile, 30000) || '').trim();
    appLog('[deploy] result=' + (result || '(空)'));
    if (result !== 'updated' && result !== 'unchanged') {
      // 带原始结果 + $dataDir 诊断，便于定位"logs 空目录"（mkdir 成功但后续步骤失败）
      const tmpExists = await exists(tmpBin);
      const targetExists = await exists(targetBin);
      appLog('[deploy] FAIL result=' + (result || '空') + ' tmpBin=' + tmpExists + ' targetBin=' + targetExists);
      return makeErr(10405, '更新后端二进制失败（result=' + (result || '空') + '，$dataDir=' + String($dataDir) + '，tmpBin=' + (tmpExists ? '存在' : '缺失') + '，targetBin=' + (targetExists ? '存在' : '缺失') + '）')
    }
    var backendUpdated = result === 'updated';
    appLog('[deploy] ok updated=' + backendUpdated + ' sha=' + ('无'));
  } catch (e) {
    appLog('[deploy] EXCEPTION ' + (e && e.message ? e.message : String(e)));
    return makeErr(10002, '部署后端失败：' + (e && e.message ? e.message : String(e)))
  } finally {
    execShell('rm -f ' + shq(tmpB64) + ' ' + shq(tmpBin) + ' ' + shq(stagedBin) + ' ' + shq(resultFile) + ' 2>/dev/null || true');
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

async function ensureBackendRunning() {
  // 账号登录模式已暂停：不部署、不探测端口、不拉起进程。
  // 自定义端点模式本来就不需要本机后端（startup/index 已按模式短路）。
  {
    return makeErr(ERR.DEPLOY_VERIFY_FAILED, '账号登录模式已暂停：不启动本机后端')
  }
}

// 上一次编辑会话：用于防泄漏（页面隐藏/关闭时按取消结算）
let _editSettle = null;
let _editCleanup = null;

function editGlobal() {
  try {
    return g()
  } catch (e) {
    return null
  }
}

// IME 回传结果里的文本字段名（不同版本/语音输入形态不同，逐个兜底）
const EDIT_TEXT_KEYS = ['contents', 'jsonData', 'text', 'inputText', 'currentText', 'content', 'data', 'result', 'value', 'textContent', 'editContent'];

function findEditText(j, depth) {
  if (depth > 3) return ''
  if (!j || typeof j !== 'object') return ''
  for (let i = 0; i < EDIT_TEXT_KEYS.length; i++) {
    const k = EDIT_TEXT_KEYS[i];
    if (j[k] === undefined || j[k] === null) continue
    if (typeof j[k] === 'string') return j[k]
    if (typeof j[k] === 'object') {
      const nested = findEditText(j[k], depth + 1);
      if (nested) return nested
    }
  }
  return ''
}

function extractEditResult(j) {
  if (!j || typeof j !== 'object') return { text: '', canceled: false, found: false }
  const canceled = !!(j.editCanceled || j.canceled || j.cancel);
  let hasKey = false;
  for (let i = 0; i < EDIT_TEXT_KEYS.length; i++) {
    if (j[EDIT_TEXT_KEYS[i]] !== undefined && j[EDIT_TEXT_KEYS[i]] !== null) {
      hasKey = true;
      break
    }
  }
  if (!hasKey) return { text: '', canceled, found: false }
  return { text: findEditText(j, 0), canceled, found: true }
}

function extractEditFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    let v = args[i];
    // FalconEvent 包装 {type,timestamp,data}
    if (v && typeof v === 'object' && 'data' in v) v = v.data;
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      if (/^[0-9a-fA-F]{32}$/.test(v)) continue // 纯 uuid 不是文本
      try {
        const j = JSON.parse(v);
        if (j && typeof j === 'object') {
          const r = extractEditResult(j);
          if (r.found) return r
          continue
        }
      } catch (e) { /* 非 JSON，按纯文本 */ }
      return { text: v, canceled: false, found: true }
    }
    if (typeof v === 'object') {
      const r = extractEditResult(v);
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
function openTextEditor(inputType = INPUT_TYPES.ZH_CN_PREFERRED, initialText = '') {
  return new Promise((resolve) => {
    const gg = editGlobal();
    if (!gg || typeof gg.startTextEdit !== 'function') {
      // 原生不可用：退回 SDK 封装（至少能把键盘拉起来）
      try {
        resolve(openTextEditor$1(inputType, initialText));
      } catch (e) {
        resolve(null);
      }
      return
    }

    let settled = false;
    // 上一次会话残留：先按取消结算，避免重复订阅
    if (_editCleanup) {
      try { _editCleanup(); } catch (e) { /* 忽略 */ }
      const prev = _editSettle;
      _editSettle = null;
      _editCleanup = null;
      if (prev) prev(null);
    }

    const cleanup = () => {
      try { gg.textEditFinished.off(handler); } catch (e) { /* 忽略 */ }
      try { $falcon.off('textEditFinished', falconHandler); } catch (e) { /* 忽略 */ }
    };

    const settle = (args) => {
      if (settled) return
      settled = true;
      cleanup();
      if (_editCleanup === cleanup) {
        _editSettle = null;
        _editCleanup = null;
      }
      const r = extractEditFromArgs(args);
      // found=false（诊断钩子等无有效载荷）按取消处理，不覆盖调用方原值
      resolve(!r.found ? null : (r.canceled ? null : r.text));
    };

    const handler = function () {
      settle(Array.prototype.slice.call(arguments));
    };
    const falconHandler = function (e) {
      settle([e]);
    };

    gg.textEditFinished.on(handler);
    try { $falcon.on('textEditFinished', falconHandler); } catch (e) { /* 忽略 */ }
    _editSettle = settle;
    _editCleanup = cleanup;

    try {
      const text = String(initialText === undefined || initialText === null ? '' : initialText);
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
      };
      gg.startTextEdit(JSON.stringify(config));
    } catch (e) {
      settle([]);
    }
  })
}

// ---------- 持久化（$falcon.jsapi.storage） ----------
// 已探针验证：setStorage({key,data}) -> {key:data}；getStorage({key}) -> {data} 或 {error:3}；
// getStorageInfo({}) -> {keys:[], currentSize, limitSize}；removeStorage({key}) -> {key:"removed"}
async function storageSet(key, data) {
  try {
    await $falcon.jsapi.storage.setStorage({ key, data: String(data) });
    return true
  } catch (e) {
    return false
  }
}

async function storageGet(key) {
  try {
    const r = await $falcon.jsapi.storage.getStorage({ key });
    if (r && r.data !== undefined && r.data !== null) return String(r.data)
    return null
  } catch (e) {
    return null
  }
}

async function storageRemove(key) {
  try {
    await $falcon.jsapi.storage.removeStorage({ key });
    return true
  } catch (e) {
    return false
  }
}

// ds-free-api config.toml 的最小读取器（应用侧只读，不写）。
//
// 为什么单独成模块：**账号真源是后端写的 config.toml**，而后端（toml crate）
// 会按值的内容选择不同的字符串字面量形态：
//   key = "value"      基本字符串（值里没有 " 和 \）
//   key = 'value'      字面量字符串 —— 值里有 " 或 \ 时 toml 自动改用这种
//   key = """…"""      多行基本字符串 —— 值里有换行时
//   key = '''…'''      多行字面量字符串
// 应用侧只用双引号正则去读，会把这类账号读成"未配置" → dsConfigured=false →
// 进账号页就被弹去登录页（bug 2）。这里统一处理全部形态，并有回归用例
// （scripts/test-config-parse.mjs）。

/// 取某个键的字符串值；读不到返回 ''。
/// 只在**该键所在行**取值，不会跨段误匹配到别的段（如把 api_keys 的 key 当成账号的）。
/// 重复键按 TOML 语义取最后一次出现（旧版 match 取第一次，与 TOML 规范相反）。
function tomlStringValue(raw, key) {
  const src = String(raw || '');
  const re = new RegExp(
    '(?:^|\\n)\\s*' + key + '\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*(?:[A-Za-z_]+\\s*=|\\[|$))',
    'g'
  );
  let m = null;
  let last = null;
  while ((m = re.exec(src)) !== null) {
    last = m;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (!last) return ''
  const v = String(last[1]).trim();
  if (v.indexOf('"""') === 0) {
    // 多行基本字符串：开定界符后紧跟的换行会被 TOML 丢掉，内容里仍做转义
    const body = v.slice(3).replace(/"""[\s\S]*$/, '').replace(/^\r?\n/, '');
    return unescapeTomlBasic(body)
  }
  if (v.indexOf("'''") === 0) {
    // 多行字面量字符串：同样丢掉紧跟开定界符的换行，内容不转义
    return v.slice(3).replace(/'''[\s\S]*$/, '').replace(/^\r?\n/, '')
  }
  // 单行值优先按「完整引号字符串」提取，忽略其后的行内注释 ——
  // 手工编辑的 config.toml 常有 password = "abc" # 备注 这类写法，
  // 旧版整体捕获后首尾引号配对失败，直接返回 ''（已登录被读成未登录）。
  let q = v.match(/^"((?:[^"\\]|\\.)*)"/);
  if (q) return unescapeTomlBasic(q[1])
  q = v.match(/^'([^']*)'/);
  if (q) return q[1]
  if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
    return unescapeTomlBasic(v.slice(1, -1))
  }
  if (v.length >= 2 && v.charAt(0) === "'" && v.charAt(v.length - 1) === "'") {
    return v.slice(1, -1) // 字面量字符串：内部不转义
  }
  return ''
}

// 基本字符串的反转义（与写入端 native.js 的 tomlEscape 相反）。
// 顺序要紧：先把 \\ 还原成占位符，再还原 \" \n \t 等，最后把占位符换回 \，
// 否则 "a\\\\\"b" 这类会被解错。
function unescapeTomlBasic(s) {
  const BACKSLASH = '\u0000BACKSLASH\u0000';
  return String(s)
    .replace(/\\\\/g, BACKSLASH)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\u0000BACKSLASH\u0000/g, '\\')
}

/// 去掉以 # 开头的注释行（避免把示例/注释误判为真实配置）。
/// 多行字符串（""" / '''）内部的 # 行是**值的一部分**，不能当注释删——
/// 旧版无脑过滤曾把多行密码里以 # 开头的行吃掉，解出来的值就错了。
function stripTomlComments(raw) {
  const lines = String(raw || '').split('\n');
  const out = [];
  let fence = null; // 当前所处的多行字符串定界符：null | '"""' | "'''"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      out.push(line);
      // 出现与开定界符相同的定界符 → 多行字符串结束
      if (line.indexOf(fence) >= 0) fence = null;
      continue
    }
    if (line.trim().indexOf('#') === 0) continue // 顶层注释行
    const m = line.match(/("""|''')/);
    if (m) {
      const first = line.indexOf(m[1]);
      const second = line.indexOf(m[1], first + 3);
      // 同一行内成对出现（value = """x"""）不算进入多行字符串
      if (second < 0) fence = m[1];
    }
    out.push(line);
  }
  return out.join('\n')
}

/// 取全部 [[accounts]] 段的正文
function accountSections(raw) {
  const src = String(raw || '');
  const out = [];
  const parts = src.split('[[accounts]]');
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const next = seg.search(/\n\s*\[/);
    out.push(next >= 0 ? seg.slice(0, next) : seg);
  }
  return out
}

/// 从 [[accounts]] 段取账号标识（邮箱优先，其次手机号）
function accountIdFromSection(section) {
  const email = tomlStringValue(section, 'email').trim();
  const mobile = tomlStringValue(section, 'mobile').trim();
  return { id: email || mobile, email, mobile }
}

// 构建信息：BUILD_NUM 由 scripts/build-wrapper.js 在每次构建时自动 +1（#17）。
// 手动编辑本文件即可校准版本号。提交到 git，保证不同克隆的构建序号连续。

// 构建期功能开关（纯常量，无设备依赖，可在 Node 里回归测试）。
//
// 2026-10：DeepSeek 账号登录模式（内置 ds-free-api 独立进程）暂停使用。
// 停用的是「运行形态」，不是代码：
//   - App 不再部署 / 启动 / 内嵌 Rust 后端（app/backend 二进制与 backend-blob.js 保留）；
//   - 认证方式固定为「自定义 OpenAI 兼容端点」；
//   - 账号登录页、config.toml 读写、后端部署/健康检查等代码全部保留，
//     把 BUILTIN_AUTH_ENABLED 改回 true 即可恢复（同时恢复 native.js 的
//     backend-blob 导入和 scripts/build-wrapper.js 的内嵌步骤，见 app/BUILTIN-MODE.md）。
//
// 传输侧没有 Rust 也没有原生库：HTTPS/TLS 由设备自带的 curl 承担
// （流式）与框架 http 模块承担（普通请求），业务全部在 JS。

const BUILTIN_AUTH_ENABLED = false;

const AUTH_MODE_BUILTIN = 'builtin';
const AUTH_MODE_OPENAI = 'openai';

const DEFAULT_AUTH_MODE = BUILTIN_AUTH_ENABLED ? AUTH_MODE_BUILTIN : AUTH_MODE_OPENAI;

// ---------- 两种后端（2026-10 起） ----------
//
// 1) custom   ：自定义 OpenAI 兼容端点。用户自己填地址 + API Key，行为与旧版一致；
//               设备配对是可选加固（防止 Key 被抠走搭反代）。
// 2) upstream ：接入「我的上游」网关（upstream/ 目录，本项目自带的服务端）。
//               地址由构建期常量预置，设备首次联网静默注册；不填 API Key、不做任何配置；
//               每个请求带 X-Ds-Client 与 HMAC 签名，服务端做防反代检测。
//
// 当前构建预置为 penai.aquavie.top；留空表示"这个构建还没有绑定上游"，
// 设置页会提示用户填写，或由发布者在打包前改这一行。仅上游模式使用；自定义模式不读它。
const BACKEND_MODE_CUSTOM = 'custom';
const BACKEND_MODE_UPSTREAM = 'upstream';

// 构建期锁定：true 时这个包就是"我的上游"专用客户端——
// 不显示后端类型选择，也不提供任何端点 / 配对 / 模型配置项。
// 上游模式下一切静默完成：地址取下面的常量、设备首次联网自动注册、模型由云控下发。
const LOCK_TO_UPSTREAM = true;

const UPSTREAM_BASE_URL = 'https://penai.aquavie.top/v1';

// 可选：与网关 auth.enroll.token 对应的注册令牌。留空表示服务端未开启注册令牌校验。
// 它编译进包里，只能提高"随手写脚本刷设备"的门槛，不是密码学意义上的秘密。
const UPSTREAM_ENROLL_TOKEN = '';

const DEFAULT_BACKEND_MODE = LOCK_TO_UPSTREAM ? BACKEND_MODE_UPSTREAM : BACKEND_MODE_CUSTOM;

function normalizeBackendMode(mode) {
  if (LOCK_TO_UPSTREAM) return BACKEND_MODE_UPSTREAM
  return mode === BACKEND_MODE_UPSTREAM ? BACKEND_MODE_UPSTREAM : BACKEND_MODE_CUSTOM
}

function isUpstreamMode(mode) {
  return normalizeBackendMode(mode) === BACKEND_MODE_UPSTREAM
}

/**
 * 解析当前应请求的根地址（含 /v1）。
 * - 上游模式：锁定构建只认常量（用户设置里的地址一律忽略，避免"配置漂移"）；
 *   非锁定构建仍允许设置页覆盖。
 * - 自定义模式：用户填的地址，空时回落到官方 API。
 */
function resolveBackendBaseUrl({ backendMode, baseUrl, upstreamBaseUrl, defaultBaseUrl } = {}) {
  if (isUpstreamMode(backendMode)) {
    return String(UPSTREAM_BASE_URL ).trim().replace(/\/+$/, '')
  }
  const custom = String(baseUrl || '').trim();
  if (custom) return custom.replace(/\/+$/, '')
  return String(defaultBaseUrl || '').trim().replace(/\/+$/, '')
}

/**
 * 网关根地址（去掉 OpenAI 兼容层的 `/v1`）。
 *
 * `effectiveBaseUrl` 是给聊天用的（形如 `https://host/v1`），而设备注册、云控、
 * 会话备份这些网关自有接口挂在根路径：直接拼会得到 `/v1/device/register` → 404。
 * 所有非 `/chat/completions` 的网关请求都必须先过这个函数。
 */
function upstreamRootUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/**
 * 把历史设置里的认证方式归一为当前可用的模式。
 *
 * 老用户升级后设置里仍是 'builtin'，在开关关闭时必须落到 'openai'，
 * 并且不能清掉 dsUser / dsPass 等字段——恢复开关后还要能继续用。
 *
 * @returns {{ mode: string, migratedFromBuiltin: boolean }}
 */
function normalizeAuthMode(mode) {
  if (mode === AUTH_MODE_BUILTIN && !BUILTIN_AUTH_ENABLED) {
    return { mode: AUTH_MODE_OPENAI, migratedFromBuiltin: true }
  }
  if (mode !== AUTH_MODE_OPENAI && mode !== AUTH_MODE_BUILTIN) {
    return { mode: DEFAULT_AUTH_MODE, migratedFromBuiltin: false }
  }
  return { mode, migratedFromBuiltin: false }
}

/**
 * 当前是否真的走内置后端。
 *
 * 注意与 `mode === 'builtin'` 的区别：后者在开关关闭时仍可能是历史设置值，
 * 任何会触发后端部署 / 健康检查 / config.toml 读写的分支都必须用本函数判断。
 */
function isBuiltinMode(mode) {
  return BUILTIN_AUTH_ENABLED 
}

// store.js 的纯函数部分（无 native 桥依赖），独立成模块以便在 Node 里做回归测试
// （scripts/test-store-schema.mjs）。store.js 引用并转发，保持对外 API 不变。
//
// 消息/会话的落盘结构约定见 store.js 顶部注释。

let seq = 0;
function uid$1(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

// 兼容旧会话：补全 mode / thinking / search 等字段，避免旧数据因字段缺失导致开关失效。
function normalizeConversation(c) {
  return Object.assign({
    mode: 'fast',
    thinking: true,
    search: false
  }, c || {})
}

// 落盘前剥掉图片的 base64（dataUrl）：它有几 MB 之巨（单图上限 900KB + base64 膨胀），
// 存进会话文件后每次发消息都要重新序列化整个历史、写文件、再由后端 JSON 解析一遍，
// 是弱内存设备上"发一条消息就卡死/重启"的主要压力来源。
// 只保留 path，真正要发的时候由 ds.buildMessages 按 path 重新压缩读取（compressImage
// 已按路径缓存，重复请求不会重复跑 ffmpeg）。
function stripImagePayloads(list) {
  if (!Array.isArray(list)) return list
  return list.map((m) => {
    if (!m || !Array.isArray(m.images) || m.images.length === 0) return m
    const copy = Object.assign({}, m);
    const clean = (imgs) => imgs.map((i) => ({ name: i.name, path: i.path, dataUrl: null }));
    copy.images = clean(copy.images);
    if (Array.isArray(copy.revisions)) {
      copy.revisions = copy.revisions.map((r) => (r && Array.isArray(r.images))
        ? Object.assign({}, r, { images: clean(r.images) })
        : r);
    }
    return copy
  })
}

// 兼容旧数据：给用户消息补 revisions，给助手消息补 attempts。
// 新版「重试 / 修改」不再覆盖旧内容，而是把每次结果作为版本保存在同一气泡里。
function normalizeMessages(list) {
  if (!Array.isArray(list)) return []
  const out = [];
  for (const m of list) {
    const msg = Object.assign({}, m);
    if (msg.role === 'user') {
      if (!Array.isArray(msg.revisions) || msg.revisions.length === 0) {
        msg.revisions = [{
          content: msg.content || '',
          images: msg.images || [],
          createdAt: msg.createdAt
        }];
      }
      if (typeof msg.activeRevision !== 'number' || !msg.revisions[msg.activeRevision]) {
        msg.activeRevision = msg.revisions.length - 1;
      }
      const rev = msg.revisions[msg.activeRevision];
      msg.content = rev.content || '';
      msg.images = rev.images || [];
    } else if (msg.role === 'assistant') {
      if (!Array.isArray(msg.attempts) || msg.attempts.length === 0) {
        msg.attempts = [{
          id: msg.id,
          content: msg.content || '',
          reasoning: msg.reasoning || '',
          error: msg.error || '',
          pending: !!msg.pending,
          createdAt: msg.createdAt
        }];
      }
      if (typeof msg.activeAttempt !== 'number' || !msg.attempts[msg.activeAttempt]) {
        msg.activeAttempt = msg.attempts.length - 1;
      }
      const att = msg.attempts[msg.activeAttempt];
      if (att) {
        msg.content = att.content || '';
        msg.reasoning = att.reasoning || '';
        msg.error = att.error || '';
        // errorCode 以当前版本为准：它决定「重试」是按下去还是被拦。
        // 重启后读回旧值时，本该拦住的限流重试会被放行，正好是要避免的动作（bug 1）
        msg.errorCode = att.errorCode || '';
        msg.pending = !!att.pending;
        // 兜底：从磁盘读回时还挂着 pending=true，说明上一次流式没有走到终态
        // （进程被杀、流中切换会话导致终态没落盘）。旧版原样恢复，表现为气泡
        // 永远卡在「正在思考…」、重试按钮永不出现、内容也被 buildMessages 跳过。
        // 流式进行中不受影响：index 页在 sending 时不会重载消息。
        if (msg.pending) {
          msg.pending = false;
          att.pending = false;
          if (!att.error && !msg.error) {
            att.error = msg.error = '生成中断，请重试';
          }
        }
      }
    }
    out.push(msg);
  }
  return out
}

// 账号显示名脱敏（登录页用）
function maskAccountId(id) {
  const v = String(id || '');
  const at = v.indexOf('@');
  if (at > 0) {
    const name = v.slice(0, at);
    return name.slice(0, 2) + '***' + v.slice(at)
  }
  if (v.length >= 7) return v.slice(0, 3) + '****' + v.slice(-4)
  return v
}

// 会话与消息的本地持久化，优先写入 $dataDir 下的 JSON 文件（重启不丢），

const uid = uid$1;

// 应用版本号：格式 "主.次.修订 build N"。build N 由 scripts/build-wrapper.js
// 在每次构建时对 build-info.js 的 BUILD_NUM 自动 +1（#17），便于用户确认是否更新。
const APP_VERSION = '0.1.5 build ' + BUILD_NUM;

const KEY_CONVERSATIONS = 'ds:conversations';
const KEY_SETTINGS = 'ds:settings';
const KEY_ACTIVE = 'ds:active';
const msgKey = (id) => `ds:msgs:${id}`;

// 不把 API Key 硬编码进源码：默认留空，运行期由用户填写。
const DEFAULT_SETTINGS = {
  // backendMode: 'custom'   自定义 OpenAI 兼容端点
  //              'upstream' 接入「我的上游」网关（客户端零配置：地址预置 + 静默注册）
  // 锁定构建（feature-flags.LOCK_TO_UPSTREAM）下恒为 upstream。
  backendMode: DEFAULT_BACKEND_MODE,
  // 上游网关地址（上游模式使用；构建期常量 UPSTREAM_BASE_URL 为空时在此填写）
  upstreamBaseUrl: '',
  // authMode: 'openai'  OpenAI 兼容端点（当前唯一可用）；
  //            'builtin' 内置 ds-free-api（已暂停，见 feature-flags.js）
  authMode: DEFAULT_AUTH_MODE,
  dsUser: '',
  dsPass: '',
  // OpenAI 兼容端点默认指向 DeepSeek 官方 API；内置模式（若恢复）运行期被 getActiveBackendBaseUrl 覆盖
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  // OpenAI 兼容端点的自定义模型 ID；留空由 ds.js resolveModel() 按端点决定
  // （官方 API → deepseek-chat，第三方 → deepseek-v4-flash）
  openaiModelId: '',
  // 设备配对（防搬运，见 api-auth.js 与 docs/api-auth-protocol.md）：
  // pairDeviceId  本机设备标识（首次配对时生成，之后不变）
  // pairToken     服务端签发的短期设备令牌（Bearer）
  // pairSecret    每设备签名密钥（HMAC-SHA256，服务端可轮换）
  // pairExpiresAt 令牌到期时间（ms 时间戳；0 表示服务端未返回过期时间）
  // pairTlsPin    证书公钥锁定（sha256//Base64(SPKI)，留空不启用）
  // 三者（deviceId/token/secret）齐全才算已配对；未配对时全部请求走旧行为。
  pairDeviceId: '',
  pairToken: '',
  pairSecret: '',
  pairExpiresAt: 0,
  pairTlsPin: '',
  // 静默注册完成时间（诊断用；凭证仍是上面四项）
  lastEnrollAt: 0,
  // 最近一次配额快照：断网时设置页显示上次结果，而不是一片空白
  quotaCache: null,
  // 自动更新：用户跳过的构建号、已读公告 id、上次检查时间
  skippedUpdateBuild: 0,
  seenAnnouncementId: '',
  lastUpdateCheckAt: 0,
  defaultMode: 'fast',
  defaultThinking: true,
  defaultSearch: false,
  defaultExpandThinking: true,
  // 流式输出（SSE）已固定开启，不再提供开关：非流式分支在设备上体验差
  // （整段等完才出字），且两条路径要各自维护错误处理。旧设置里的 sse 字段被忽略。
  systemPrompt: '',
  portrait: false,
  debugMode: false,
  debugLog: false,
  // Emoji 字体（实验）：联网下载 NotoColorEmoji 并注册，解决 emoji 白块
  emojiFont: false,
  // 深色模式：'light' | 'dark'（词典笔无系统深色，去掉 auto）
  theme: 'light'
};

// 本机 ds-free-api 的配置文件（用户在设备上自行配置的凭据，读取而非硬编码）。
// 已迁移到应用 data 目录（build 22），fs 可直接读取——旧 /userdisk 路径在部分设备读不到。

// 账号显示名缓存（ds:accounts）与当前活动账号（ds:activeAccount）。
// 声明在文件靠前位置：loadSettings 里的"配置读不到"兜底要用到 KEY_ACCOUNTS。
const KEY_ACCOUNTS = 'ds:accounts';
const KEY_ACTIVE_ACCOUNT = 'ds:activeAccount';

// 读取本机已配置的 DeepSeek 密码（仅用于设置页显示掩码，不写入应用设置存储）。
async function readLocalDsPass() {
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()));
    return readLocalDsPassRaw(raw)
  } catch (e) {
    return ''
  }
}

// 本机已配置的密码（原样，仅用于设置页掩码显示）。
// 走通用取值器以兼容后端可能写出的各种字符串形态（见 tomlStringValue）。
function readLocalDsPassRaw(raw) {
  if (!raw) return ''
  const secs = accountSections(raw);
  for (let i = 0; i < secs.length; i++) {
    const pass = tomlStringValue(secs[i], 'password');
    if (pass) return pass
  }
  return ''
}

function filePathFor(key) {
  // ds:conversations -> ds_conversations.json；ds:msgs:xxx -> ds_msgs_xxx.json
  // 必须走 joinPath：$dataDir 的尾斜杠在不同机型上不一致，直接相加会得到
  // `/data/…ds_conversations.json`（缺分隔符）或 `//`（重复分隔符）。
  const safe = String(key).replace(/[^a-zA-Z0-9_]/g, '_');
  return joinPath(dataDirBase(), safe + '.json')
}

async function getJSON(key, fallback) {
  // 优先读文件（持久化），再回退到框架 storage
  const fileRaw = await readFile(filePathFor(key));
  if (fileRaw !== null && fileRaw !== undefined && String(fileRaw).trim() !== '') {
    try {
      return JSON.parse(String(fileRaw))
    } catch (e) { /* 文件损坏则继续走 storage */ }
  }
  const raw = await storageGet(key);
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    return JSON.parse(raw)
  } catch (e) {
    return fallback
  }
}

async function setJSON(key, value) {
  const text = JSON.stringify(value);
  // 文件与 storage 双写，保证重启后仍在
  let okFile = false;
  try {
    okFile = await writeFile(filePathFor(key), text);
  } catch (e) {
    okFile = false;
  }
  if (!okFile) {
    // 文件写失败（磁盘满/权限）时清空旧文件：getJSON 是文件优先，
    // 留着旧内容会把刚写进 storage 的新值永久遮住（读到的是过期数据）
    try { await writeFile(filePathFor(key), ''); } catch (e) { /* 尽力而为 */ }
  }
  await storageSet(key, text);
  return true
}

async function removeJSON(key) {
  await writeFile(filePathFor(key), '');
  await storageRemove(key);
  return true
}

// 兼容旧会话的 normalizeConversation 已抽到 store-schema.js（文件顶部转发导出）

async function loadConversations() {
  const list = await getJSON(KEY_CONVERSATIONS, []);
  return (Array.isArray(list) ? list : []).map(normalizeConversation)
}

async function saveConversations(list) {
  return setJSON(KEY_CONVERSATIONS, list)
}

async function loadMessages(convId) {
  const list = await getJSON(msgKey(convId), []);
  return normalizeMessages(Array.isArray(list) ? list : [])
}

// 落盘前剥图片 payload 的 stripImagePayloads 已抽到 store-schema.js

async function saveMessages(convId, list) {
  return setJSON(msgKey(convId), stripImagePayloads(list))
}

// 兼容旧数据的 normalizeMessages 已抽到 store-schema.js（文件顶部转发导出）

async function deleteMessages(convId) {
  await removeJSON(msgKey(convId));
}

async function loadSettings() {
  const s = await getJSON(KEY_SETTINGS, {});
  const merged = Object.assign({}, DEFAULT_SETTINGS, s || {});
  // 旧版设置里可能有 theme:'auto'（已移除跟随系统），归一为 light 避免深色判断失效
  if (merged.theme === 'auto') {
    merged.theme = 'light';
    appLog('[store] 检测到旧设置 theme=auto，已迁移为 light');
  }

  // 认证方式归一：账号登录模式暂停期间，历史设置里的 builtin 一律落到 openai。
  // 只改内存值、不在这里写盘——写盘由 saveSettings 的使用方决定；
  // dsUser / dsPass 等账号字段原样保留，恢复开关后仍可继续使用。
  const auth = normalizeAuthMode(merged.authMode);
  merged.authMode = auth.mode;
  merged.builtinModeMigrated = auth.migratedFromBuiltin;
  merged.builtinAuthAvailable = BUILTIN_AUTH_ENABLED;
  if (auth.migratedFromBuiltin) {
    // 内置模式的 apiKey 由本机后端生成，对第三方端点毫无意义，且会泄露本机凭据。
    // 迁移时清空，让用户重新填写自定义端点的 Key（dsUser/dsPass 保留）。
    merged.apiKey = '';
    appLog('[store] 账号登录模式已暂停，authMode 由 builtin 归一为 openai（原账号信息保留，本机后端 Key 已清空）');
  }

  appLog('[store] loadSettings theme=' + merged.theme + ' authMode=' + merged.authMode + ' backendMode=' + merged.backendMode + ' baseUrl=' + merged.baseUrl + ' apiKey=' + (merged.apiKey ? '已设置' : '空') + ' openaiModelId=' + (merged.openaiModelId || '(空)') + ' paired=' + (merged.pairToken ? '是' : '否'));

  {
    // OpenAI 兼容端点下**不再**回填本机 key：本机 ds-free-api 的 key 对外部端点毫无意义，
    // 却会被当成 Bearer 发给第三方服务（既泄露本机凭据，又让"401 未授权"看起来像端点故障）。
    // 账号登录模式暂停期间也不再读 config.toml：后端不运行，读到的只会是过期状态。
    merged.dsConfigured = false;
    merged.dsConfigReadable = false;
  }

  // 后端类型：custom（自定义 OpenAI 兼容端点）/ upstream（我的上游网关）。
  // 上游模式的地址解析优先级：设置页 upstreamBaseUrl → 构建期 UPSTREAM_BASE_URL。
  // 只派生 effectiveBaseUrl，不改写 baseUrl（那是自定义模式的配置，切回时要保留）。
  merged.backendMode = normalizeBackendMode(merged.backendMode);
  merged.upstreamBaseUrl = String(merged.upstreamBaseUrl || '').trim().replace(/\/+$/, '');
  merged.effectiveBaseUrl = resolveBackendBaseUrl({
    backendMode: merged.backendMode,
    baseUrl: merged.baseUrl,
    upstreamBaseUrl: merged.upstreamBaseUrl,
    defaultBaseUrl: 'https://api.deepseek.com/v1'
  });
  merged.upstreamMode = isUpstreamMode(merged.backendMode);
  merged.upstreamConfigured = !merged.upstreamMode || !!merged.effectiveBaseUrl;
  const pairedNow = !!(String(merged.pairDeviceId || '').trim() && String(merged.pairToken || '').trim() && String(merged.pairSecret || '').trim());
  merged.paired = pairedNow;

  // 端点是否已配置：startup 用它决定是进主页还是先进设置页。
  // - 上游模式：地址已解析即可（设备凭证由静默注册自动取得，不需要用户做任何事）
  // - 自定义模式：API Key 或配对令牌二者其一
  // - 内置账号模式（若恢复）：由 config.toml 的账号状态决定
  if (merged.upstreamMode) {
    merged.endpointConfigured = !!merged.effectiveBaseUrl;
  } else {
    merged.endpointConfigured = !!String(merged.apiKey || '').trim() || pairedNow;
  }
  return merged
}

async function saveSettings(s) {
  // 落盘前清掉运行时派生字段：它们由 loadSettings 每次重算，
  // 写进存储只会留下过期状态（例如迁移标记、dsConfigured、明文密码）。
  const clean = Object.assign({}, s || {});
  delete clean.dsPass;
  delete clean.dsPassPreview;
  delete clean.dsConfigured;
  delete clean.dsConfigReadable;
  delete clean.endpointConfigured;
  delete clean.builtinModeMigrated;
  delete clean.builtinAuthAvailable;
  // 后端模式派生字段：每次 loadSettings 重算，不落盘（否则切模式后会留下过期状态）
  delete clean.effectiveBaseUrl;
  delete clean.upstreamMode;
  delete clean.upstreamConfigured;
  delete clean.paired;
  return setJSON(KEY_SETTINGS, clean)
}

async function loadActiveId() {
  return getJSON(KEY_ACTIVE, null)
}

async function saveActiveId(id) {
  return setJSON(KEY_ACTIVE, id)
}

// ---------- 账号异常取证 ----------
// 记录疑似封号/禁言/鉴权失败事件（首次检出时间回答"什么时候封的"）。
// 持久化在 ds:trouble，最多保留 20 条。
const KEY_TROUBLE = 'ds:trouble';

async function recordAccountTrouble(kind, message) {
  try {
    const list = await getJSON(KEY_TROUBLE, []);
    const arr = Array.isArray(list) ? list : [];
    arr.push({ t: Date.now(), kind: String(kind || ''), message: String(message || '').slice(0, 200) });
    await setJSON(KEY_TROUBLE, arr.slice(-20));
  } catch (e) { /* 忽略 */ }
}

async function loadAccountTrouble() {
  try {
    const list = await getJSON(KEY_TROUBLE, []);
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// ---------- 账号（专用登录页） ----------
// 账号真源是后端 config.toml 的 [[accounts]] 段（native.updateDsFreeApiAccount 写入）。
// 这里只把 config 与用户输入的显示名缓存合并成登录页要的视图。
//
// 多账号暂缓：ds-free-api 的 config.toml 支持多个 [[accounts]]，但应用侧写入函数
// （native.js updateDsFreeApiAccount / clearDsFreeApiAccount）只改写*第一个*段，
// 所以登录页按「单账号」呈现——列出 config 里已有的账号、标出当前使用的一个。
// 多账号完整增删需后端 /admin API 配合（后端已具备 add_account/remove_account 能力）。
// KEY_ACCOUNTS / KEY_ACTIVE_ACCOUNT 两个键常量声明在文件上方（loadSettings 的兜底逻辑要用）。

/// 解析 config.toml 中全部 [[accounts]] 段（只取标识字段，不读密码）
function parseAllAccounts(raw) {
  if (!raw) return []
  const out = [];
  const secs = accountSections(raw);
  for (let i = 0; i < secs.length; i++) {
    const a = accountIdFromSection(secs[i]);
    if (a.id) out.push({ id: a.id, email: a.email, mobile: a.mobile });
  }
  return out
}

// 账号显示名脱敏 maskAccountId 已抽到 store-schema.js（顶部以 _maskAccountId 引入）

/// 账号列表（登录页用）：config.toml 账号 + 活动标记
async function loadAccountList() {
  let fromConfig = [];
  try {
    const raw = stripTomlComments(await readFile(dsConfigPath()));
    if (!raw) {
      // 配置读不到时列表会静默为空、界面显示"未登录"，用户看不到原因。
      // 记一条日志便于定位（真正的重建由 native.ensureDsConfig 负责）。
      appLog('[store] 账号列表为空：config.toml 缺失或不可读（' + dsConfigPath() + '）');
    }
    fromConfig = parseAllAccounts(raw);
  } catch (e) { /* 忽略 */ }

  let cached = [];
  try {
    const v = await getJSON(KEY_ACCOUNTS, []);
    cached = Array.isArray(v) ? v : [];
  } catch (e) { /* 忽略 */ }

  const active = (await getJSON(KEY_ACTIVE_ACCOUNT, '')) || '';
  const merged = fromConfig.map((a) => {
    const hit = cached.find((c) => c.id === a.id);
    return {
      id: a.id,
      display: hit && hit.display ? hit.display : maskAccountId(a.id),
      active: a.id === active,
      state: ''
    }
  });
  if (merged.length && !merged.some((m) => m.active)) merged[0].active = true;
  return merged
}

/// 记住账号（应用侧缓存；真源仍是 config.toml）
async function upsertAccount(id) {
  try {
    const list = await getJSON(KEY_ACCOUNTS, []);
    const arr = Array.isArray(list) ? list : [];
    const key = String(id || '').trim();
    if (!key) return false
    if (!arr.some((a) => a.id === key)) {
      arr.push({ id: key, display: maskAccountId(key), addedAt: Date.now() });
      await setJSON(KEY_ACCOUNTS, arr.slice(-10));
    }
    return true
  } catch (e) {
    return false
  }
}

/// 从缓存移除指定 id 的账号（登录页「移除」用）。
/// 注意：账号真源是 config.toml，真正退出登录要调 native.clearDsFreeApiAccount()；
/// 这里只负责清掉显示名缓存，避免移除后还留着旧昵称。
async function removeAccountById(id) {
  try {
    const key = String(id || '').trim();
    if (!key) return false
    const list = await getJSON(KEY_ACCOUNTS, []);
    const arr = (Array.isArray(list) ? list : []).filter((a) => a && a.id !== key);
    await setJSON(KEY_ACCOUNTS, arr);
    return true
  } catch (e) {
    return false
  }
}

/// 设置当前活动账号（登录页切换用）
async function setActiveAccount(id) {
  try {
    await setJSON(KEY_ACTIVE_ACCOUNT, String(id || ''));
    return true
  } catch (e) {
    return false
  }
}

// ---------- 云控缓存 ----------
// 单独一个键：云控会被启动页/设置页/主页多处读取，塞进 ds:settings 会让
// 每次开关主题都顺带重写一遍策略文档。
const KEY_CONTROL = 'ds:control';

async function loadControlCache() {
  try {
    return await getJSON(KEY_CONTROL, null)
  } catch (e) {
    return null
  }
}

async function saveControlCache(control) {
  try {
    return await setJSON(KEY_CONTROL, control)
  } catch (e) {
    return false
  }
}

// ---------- 反馈草稿 ----------
// 提交失败（断网/服务异常）时把正文留在本地：用户在笔上手打一段话不容易，
// 不能因为一次网络抖动就让他重写。
const KEY_FEEDBACK_DRAFT = 'ds:feedbackDraft';

async function loadFeedbackDraft() {
  try {
    return (await getJSON(KEY_FEEDBACK_DRAFT, null)) || null
  } catch (e) {
    return null
  }
}

async function saveFeedbackDraft(draft) {
  try {
    return await setJSON(KEY_FEEDBACK_DRAFT, draft || {})
  } catch (e) {
    return false
  }
}

async function clearFeedbackDraft() {
  try {
    await removeJSON(KEY_FEEDBACK_DRAFT);
    return true
  } catch (e) {
    return false
  }
}

export { readDsFreeApiProxy, APP_VERSION, BUILTIN_AUTH_ENABLED, saveMessages, DEFAULT_SETTINGS, saveConversations, saveActiveId, loadMessages, uid, INPUT_TYPES, recordAccountTrouble, setDebugLogEnabled, loadConversations, loadActiveId, deleteMessages, stopStream, readdir, mkdir, exists, shq, isBuiltinMode, UPSTREAM_ENROLL_TOKEN, DEFAULT_AUTH_MODE, UPSTREAM_BASE_URL, uid$1, normalizeMessages, LOCK_TO_UPSTREAM, readLocalDsPass, saveSettings, deployBackend, appLogTail, readNetCaptureTail, backendLogTail, appLogClear, netCaptureClear, backendLogClear, validateProxyUrl, updateDsFreeApiProxy, updateDsFreeApiNetCapture, loadFeedbackDraft, clearFeedbackDraft, saveFeedbackDraft, BUILD_NUM, appLog, readFile, ensureBackendRunning, loadAccountTrouble, loadAccountList, upsertAccount, isUpstreamMode, updateDsFreeApiAccount, setActiveAccount, loadSettings, clearDsFreeApiAccount, removeAccountById, openTextEditor, execShell, sleep, resolveBackendBaseUrl, saveControlCache, joinPath, upstreamRootUrl, dataDirBase, writeFile, statSize, waitForFile, loadControlCache };
