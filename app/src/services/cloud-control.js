import { clientHeaders, isPaired, signRequest, sha256Hex, tokenExpiringSoon, urlPath, uuidV4 } from './api-auth.js'
import { refreshDeviceToken } from './api-pairing.js'
import { httpRequest, validateExternalUrl } from './http.js'
import { BUILD_NUM, UPSTREAM_ENROLL_TOKEN, appLog, appLogError, debugLog, execShell, isUpstreamMode, joinPath, dataDirBase, readFile, resolveBackendBaseUrl, shq, sleep, upstreamRootUrl, waitForFile, writeFile } from './store.js'
import {
  buildDeviceIdRecord,
  buildProbeCommand,
  deviceIdFromMac,
  chooseDeviceId,
  deviceIdFromSerial,
  isLegacyUuidDeviceId,
  isPlaceholderDeviceId,
  isUsableSerial,
  normalizeDeviceId,
  normalizeMac,
  normalizeSerial,
  parseDeviceIdRecord,
  parseSystemProbe,
  serialFingerprint,
  serialFromCpuInfo
} from './device-id.js'

// 上游网关的客户端 SDK（静默注册 / 云控 / 配额 / 状态上报 / 会话备份 / 反馈）。
//
// 云控协议 v4：服务端下发 features（功能开关）、limits（运行限制）、
// update（更新策略）、prompt（提示词注入）、debug（调试授权）、
// maintenance / notice / quotaHint / upstream（披露），
// 客户端只把它当"建议"：拉不到就用本地缓存，缓存也没有就按默认值跑。

const CLIENT_BUILD = BUILD_NUM;
const CLIENT_VERSION = '0.2.0-build-' + BUILD_NUM;

class UpstreamError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data || null;
  }
}

// 设置对象 → 签名材料（未注册返回 null，与 api-auth.isPaired 同口径）
function deviceAuth(settings) {
  const s = settings || {};
  if (!s.pairDeviceId || !s.pairToken || !s.pairSecret) return null
  return {
    deviceId: String(s.pairDeviceId),
    deviceToken: String(s.pairToken),
    signSecret: String(s.pairSecret),
    expiresAt: Number(s.pairExpiresAt) || 0,
    tlsPin: s.pairTlsPin || ''
  }
}

function upstreamBase(settings) {
  const s = settings || {};
  // 注意：不能优先读 s.effectiveBaseUrl——那是 loadSettings 按「当时的 backendMode」
  // 算好的快照字段（store.js），在设置页内切换后端模式后立即过期（custom→upstream
  // 时它还指向自定义端点，设备状态/注册请求会打到用户自己的服务，被回
  // "API key invalid"）。这里总是按三个源字段现算：setBackendMode 只更新
  // form.backendMode，源字段始终新鲜。与下方 gatewayBase() 同一做法。
  const resolved = resolveBackendBaseUrl({
    backendMode: s.backendMode,
    baseUrl: s.baseUrl,
    upstreamBaseUrl: s.upstreamBaseUrl,
    defaultBaseUrl: ''
  });
  return String(resolved || '').replace(/\/+$/, '')
}

// 内置服务网关根地址：与当前后端模式无关——自定义端点模式下
// effectiveBaseUrl 指向用户自己的服务，网关必须单独解析
// （设置页 upstreamBaseUrl 覆盖 → 构建期 UPSTREAM_BASE_URL 常量）。
function gatewayBase(settings) {
  const s = settings || {};
  return String(resolveBackendBaseUrl({
    backendMode: 'upstream',
    baseUrl: '',
    upstreamBaseUrl: s.upstreamBaseUrl,
    defaultBaseUrl: ''
  }) || '').replace(/\/+$/, '')
}

function checkUrl(url) {
  const err = validateExternalUrl(url);
  if (err) throw new UpstreamError('BAD_URL', err)
}

function apiError(resp, fallback) {
  const d = resp && resp.data;
  const e = d && d.error;
  return new UpstreamError(
    (e && e.code) || ('HTTP_' + (resp && resp.statusCode)),
    (e && e.message) || fallback || ('HTTP ' + (resp && resp.statusCode)),
    d
  )
}

function ensureAuth(auth) {
  if (!isPaired(auth)) throw new UpstreamError('NOT_REGISTERED', '设备尚未注册')
}

// ---------- 设备标识 ----------
//
// 身份必须来自**硬件序列号（SN）**，不能用 MAC / 随机 UUID：
//   - wlan0 在冷启动未初始化时 address 可能是 00:00:00:00:00:00；
//   - 网卡名在不同固件上是 wlan0 / eth0 / wlan1，读到哪个不确定；
//   - 部分机型 MAC 随机化；
//   - 手动配对路径此前还会另生成一个随机 UUID。
// 这四条都会让同一台笔在卸载重装后得到不同的 ID（服务端变成两台设备、
// 旧会话与额度全部对不上）。
//
// 真机（X7 Pro / RK3562）验证：/proc/cpuinfo 的 Serial 是芯片唯一序列号
// （0444 只读，稳定不变）；部分机型还有设备树 serial-number；再兜底 eMMC CID。
// 找不到 SN 时才退回旧 MAC 算法（保证老设备 ID 不变），最后才是随机 UUID。
//
// 另外把最终 ID 写一份到 /userdisk（用户盘，卸载应用通常不清），
// 重装后即使 SN 一时读不到也能恢复原 ID；记录里带 SN 指纹，换机/克隆盘
// 不会被错误复用。

const DEVICE_ID_FILE = '.ds-device-id.json';
// 应用数据目录优先（读写快）；用户盘根目录用于跨卸载保留
const DEVICE_ID_PATHS = [
  () => joinPath(dataDirBase(), DEVICE_ID_FILE),
  () => '/userdisk/' + DEVICE_ID_FILE
];

// minLen：个别固件把芯片型号（如 "RK3562"）写进 cpuinfo 的 Serial，
// 6 位也能过 isUsableSerial —— 这种"序列号"全机型相同，会让所有笔撞成一个 ID。
// SoC SN 实际是 16 位十六进制，eMMC CID 是 32 位，machine-id 是 32 位。
const SN_SOURCES = [
  { name: 'cpuinfo', path: '/proc/cpuinfo', parse: serialFromCpuInfo, minLen: 8 },
  { name: 'device-tree', path: '/proc/device-tree/serial-number', parse: normalizeSerial, minLen: 8 },
  { name: 'emmc0', path: '/sys/block/mmcblk0/device/cid', parse: normalizeSerial, minLen: 12 },
  { name: 'emmc1', path: '/sys/block/mmcblk1/device/cid', parse: normalizeSerial, minLen: 12 },
  { name: 'emmc2', path: '/sys/block/mmcblk2/device/cid', parse: normalizeSerial, minLen: 12 },
  { name: 'machine-id', path: '/etc/machine-id', parse: normalizeSerial, minLen: 16 },
  { name: 'dbus-machine-id', path: '/var/lib/dbus/machine-id', parse: normalizeSerial, minLen: 16 }
];

/** 来源级合法性：公共规则 + 该来源的最小长度 */
function isUsableFromSource(sn, src) {
  if (!isUsableSerial(sn)) return false
  const min = (src && src.minLen) || 0
  return normalizeSerial(sn).length >= min
}

const LEGACY_MAC_SOURCES = [
  '/sys/class/net/wlan0/address',
  '/sys/class/net/eth0/address',
  '/sys/class/net/wlan1/address'
];

// 真机上 fs.readFile 读 /proc、/sys 可能失败（实测：旧算法因此拿不到 MAC，
// 退化成随机 UUID）。execShell 是 root 且一直可用：把候选值写进应用数据目录再读回。
// 每项形如 [key, shell 表达式]，输出 key=value 一行。
const HW_PROBE_ITEMS = [
  ['cpuinfo', "awk -F: '/^Serial/{gsub(/[ \\t]/,\"\",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null"],
  ['device-tree', 'cat /proc/device-tree/serial-number 2>/dev/null'],
  ['emmc0', 'cat /sys/block/mmcblk0/device/cid 2>/dev/null'],
  ['emmc1', 'cat /sys/block/mmcblk1/device/cid 2>/dev/null'],
  ['emmc2', 'cat /sys/block/mmcblk2/device/cid 2>/dev/null'],
  ['machine-id', 'cat /etc/machine-id 2>/dev/null'],
  ['dbus-machine-id', 'cat /var/lib/dbus/machine-id 2>/dev/null'],
  ['mac-wlan0', 'cat /sys/class/net/wlan0/address 2>/dev/null'],
  ['mac-eth0', 'cat /sys/class/net/eth0/address 2>/dev/null'],
  ['mac-wlan1', 'cat /sys/class/net/wlan1/address 2>/dev/null']
];

let _snList = null;          // [{sn, source, fp}]，按优先级排序
let _snListRetryAt = 0;      // 读不到时 60s 后再试（冷启动 /proc 可能未就绪）
let _deviceIdInflight = null;
let _rememberLogged = false;
let _probeValues = null;     // shell 探测结果 { values, records }（一次命令带回硬件标识 + 两份 ID 记录）
let _probeRetryAt = 0;
let _probeInflight = null;
let _probeFailLogged = false;
let _lastPersistedId = '';   // 本进程已成功落盘的 ID：避免重复 shell 写入（4.9.7 每次写要一个往返）
const _persistFailLogged = {};

// 真机实测：fs.readFile 读 /proc、/sys 会失败（旧算法因此在真机上退化成随机 UUID），
// 而且 OS 4.9.7 的 fs 连 fs.writeFile 都没有——文件相关操作只有 execShell 靠得住。
// 所以一条命令把三件事一次做完（每次 execShell 都要等哨兵，能省往返就省）：
//   ① 读硬件标识（CPU SN / eMMC CID / machine-id / MAC）
//   ② cat 应用数据目录里的 ID 记录
//   ③ cat /userdisk 里的 ID 记录（跨卸载保留的那份）
// 结果写进应用数据目录再读回（该目录 fs 读写都验证过可用）。
//
// 关键：命令结尾必须 chmod 644。shell 是 root，若某机型 umask 是 077，
// 写出的文件应用进程读不到，探测就"看似成功其实全空"——又会退回随机 UUID，
// 正是这次 bug 的老路。
async function doSystemProbe() {
  const base = joinPath(dataDirBase(), 'ds-probe-' + Date.now().toString(36));
  const outFile = base + '.txt';
  const doneFile = base + '.done';
  try {
    let cmd = buildProbeCommand({
      items: HW_PROBE_ITEMS,
      outFile,
      doneFile,
      appPath: DEVICE_ID_PATHS[0](),
      userPath: DEVICE_ID_PATHS[1](),
      shq
    });
    execShell(cmd);
    await waitForFile(doneFile, 2500);
    const raw = await readFile(outFile);
    const parsed = parseSystemProbe(raw);
    const keys = Object.keys(parsed.values).filter((k) => parsed.values[k]);
    if (!keys.length && !_probeFailLogged) {
      _probeFailLogged = true;
      appLogError('device.hwprobe', new Error('shell 探测没有拿到任何硬件标识'));
    }
    return parsed
  } catch (e) {
    if (!_probeFailLogged) {
      _probeFailLogged = true;
      appLogError('device.hwprobe', e);
    }
    return { values: {}, records: { app: '', user: '' } }
  } finally {
    execShell('rm -f ' + shq(outFile) + ' ' + shq(doneFile) + ' 2>/dev/null || true');
  }
}

function systemProbe() {
  const hasValues = _probeValues && Object.keys((_probeValues && _probeValues.values) || {}).length > 0;
  if (_probeValues && (hasValues || Date.now() < _probeRetryAt)) return Promise.resolve(_probeValues)
  if (_probeInflight) return _probeInflight
  _probeInflight = doSystemProbe().then(
    (v) => {
      _probeValues = v;
      const got = Object.keys((v && v.values) || {}).length > 0;
      _probeRetryAt = Date.now() + (got ? 10 * 60 * 1000 : 5000);
      _probeInflight = null;
      return v
    },
    (e) => { _probeInflight = null; throw e }
  );
  return _probeInflight
}

/** 只取硬件标识部分（老调用点用） */
async function probeHardwareIds() {
  const p = await systemProbe();
  return (p && p.values) || {}
}

function buildSnListFromValues(values) {
  const out = [];
  const v = values || {};
  for (const src of SN_SOURCES) {
    const sn = normalizeSerial(v[src.name]);
    if (!isUsableFromSource(sn, src)) continue
    const fp = serialFingerprint(sn, sha256Hex);
    if (!fp) continue
    if (out.some((x) => x.fp === fp)) continue
    out.push({ sn, source: src.name, fp });
  }
  return out
}

// 收集本机所有可用的硬件序列号（CPU SN / eMMC CID / machine-id…）。
// 全部保留指纹：本次只读到 eMMC、下次读到 CPU SN 时不会被误判成换机。
//
// 顺序刻意是「shell 优先、直接读兜底」：真机 fs.readFile 读 /proc、/sys 会失败，
// 而 execShell 一直可用。若先直接读，某些机型可能只读到 eMMC、另一些只读到 CPU SN，
// 换机/重装时来源不一致就会算出不同 ID。shell 探测一次拿全，来源优先级恒定。
async function readSnList() {
  if (_snList && Date.now() < _snListRetryAt) return _snList
  let out = [];
  const values = await probeHardwareIds();
  out = buildSnListFromValues(values);
  if (!out.length) {
    // shell 探测失败（极少数机型）：再试直接读
    for (const src of SN_SOURCES) {
      let raw = null;
      try { raw = await readFile(src.path) } catch (e) { raw = null }
      if (raw === null || raw === undefined) continue
      const sn = src.parse(raw);
      if (!isUsableFromSource(sn, src)) continue
      const fp = serialFingerprint(sn, sha256Hex);
      if (!fp) continue
      if (out.some((x) => x.fp === fp)) continue
      out.push({ sn, source: src.name, fp });
    }
    if (out.length) appLog('[device] shell 探测失败，直接读取 SN 成功 sources=' + out.map((x) => x.source).join(','));
  }
  _snList = out;
  // 读不到时只锁 5s：启动早期 /proc 可能还没就绪，锁一分钟会把随机 UUID 固化下来
  _snListRetryAt = Date.now() + (out.length ? 10 * 60 * 1000 : 5000);
  return out
}

async function readDeviceIdRecord() {
  const paths = DEVICE_ID_PATHS.map((f) => f());
  const raws = [];
  // ① 直接读（fs 未被沙箱限制的机型最快）
  for (const p of paths) {
    let raw = null;
    try { raw = await readFile(p) } catch (e) { raw = null }
    if (raw !== null && raw !== undefined && String(raw).trim()) raws.push({ raw: String(raw), path: p });
  }
  // ② 探测命令里 cat 到的那两份（4.9.7：fs 读 /userdisk 可能被挡住，
  //    而 cat 是 root，一定读得到；探测本来就要跑，不额外花往返）
  const probe = await systemProbe();
  const probed = [probe && probe.records && probe.records.app, probe && probe.records && probe.records.user];
  for (let i = 0; i < probed.length; i++) {
    const raw = String(probed[i] || '').trim();
    if (!raw) continue
    if (raws.some((x) => x.raw.trim() === raw)) continue
    raws.push({ raw, path: paths[i] });
  }
  let withoutFp = null;
  for (const item of raws) {
    const rec = parseDeviceIdRecord(item.raw);
    if (!rec) continue
    const hit = { id: rec.id, snHashes: rec.snHashes || [], snHash: rec.snHash || '', path: item.path };
    if (hit.snHashes.length) return hit
    if (!withoutFp) withoutFp = hit;
  }
  return withoutFp
}

async function writeDeviceIdRecord(id, fingerprints) {
  const text = buildDeviceIdRecord(id, fingerprints);
  if (!text) return false
  let ok = 0;
  for (const pathOf of DEVICE_ID_PATHS) {
    const p = pathOf();
    try {
      // 4.9.7 没有 fs.writeFile：store.writeFile 内部会退回 shell base64 写入，
      // 这里只需检查结果（写不进去就是真失败，必须留痕）
      const written = await writeFile(p, text);
      if (written) {
        ok++;
      } else if (!_persistFailLogged[p]) {
        _persistFailLogged[p] = true;
        appLogError('device.id.persist', new Error('writeFile 返回失败（fs 与 shell 兜底均未成功）'), p);
      }
    } catch (e) {
      // 用户盘不可写/只读机型：每个路径只记一次，避免每次启动刷屏
      if (!_persistFailLogged[p]) {
        _persistFailLogged[p] = true;
        appLogError('device.id.persist', e, p);
      }
    }
  }
  if (ok > 0) {
    _lastPersistedId = id;
    // 探测缓存里的记录已过期：下次读要重新 cat，否则会把旧 ID 当成现状
    _probeValues = null;
    _probeRetryAt = 0;
  }
  return ok > 0
}

/**
 * 把「已存在的设备 ID」写入持久化记录（含本机全部 SN 指纹）。
 *
 * 用于老版本升级：`pen-` 开头的老 ID（SN 或 MAC 哈希）继续沿用，
 * 重装后凭用户盘记录恢复，不会再生出第二个 ID。
 * 随机 UUID 不写（它不是硬件身份，见上面的判断）。
 * 4.9.7 上写入走 store.writeFile 的 shell 兜底，本函数只负责"写没写成功"。
 */
export async function rememberDeviceId(id) {
  const normalized = normalizeDeviceId(id);
  if (!normalized) return false
  // 全零 MAC 派生的是多台设备共用的坏 ID，绝不能持久化/复用
  if (isPlaceholderDeviceId(normalized, sha256Hex)) return false
  // 随机 UUID 不是硬件身份（旧算法读不到 MAC / 手动配对生成的兜底）。
  // 写进记录会让"下次能读到 SN"也被它锁死，等于把这次 bug 固化下来。
  // 有 SN 时由 ensureUpstreamAuth 的迁移逻辑换成 SN 派生 ID。
  if (isLegacyUuidDeviceId(normalized)) return false
  const sns = await readSnList();
  const fps = sns.map((x) => x.fp).filter(Boolean);
  if (!_rememberLogged) {
    _rememberLogged = true;
    // 每次启动记一次：当前生效 ID + 按 SN 算出的规范 ID（后台可据此清理旧记录）
    const canonical = sns.length ? deviceIdFromSerial(sns[0].sn, sha256Hex) : '';
    appLog('[device] 已注册标识 id=' + normalized +
      ' canonicalSnId=' + (canonical || '(无 SN)') +
      ' snSource=' + (sns.length ? sns[0].source : '无'));
  }
  // 本进程已落过盘：不再读也不再写（4.9.7 上每次读写都是一次 shell 往返）
  if (_lastPersistedId === normalized) return true
  const existing = await readDeviceIdRecord();
  if (existing && existing.id === normalized) {
    // 记录已在，仅补写缺失的 SN 指纹
    if (fps.length && !existing.snHashes.length) await writeDeviceIdRecord(normalized, fps);
    return true
  }
  return writeDeviceIdRecord(normalized, fps)
}

/** 同一时刻只算一次（注册与手动配对可能并发） */
export function stableDeviceId() {
  if (_deviceIdInflight) return _deviceIdInflight
  _deviceIdInflight = doStableDeviceId().then(
    (v) => { _deviceIdInflight = null; return v },
    (e) => { _deviceIdInflight = null; throw e }
  );
  return _deviceIdInflight
}

async function doStableDeviceId() {
  let sns = await readSnList();
  if (!sns.length) {
    // 启动瞬间探测失败（/proc 未就绪、$dataDir 还没建好）不能直接退化成随机 UUID：
    // 那会把"重装出现两个 ID"重新引回来。清缓存、等一拍、再探一次。
    _snList = null;
    _snListRetryAt = 0;
    _probeValues = null;
    _probeRetryAt = 0;
    await sleep(400);
    sns = await readSnList();
    if (sns.length) appLog('[device] 首次探测无 SN，重试后成功 source=' + sns[0].source);
  }
  const saved = await readDeviceIdRecord();
  const chosen = chooseDeviceId({ saved, snList: sns, sha256Hex });

  if (chosen.ignoredPlaceholder) {
    appLog('[device] 忽略已保存的全零 MAC 标识（会在多台设备间撞车），改用 SN 重新生成');
  }
  if (chosen.ignoredLegacyUuid) {
    appLog('[device] 忽略已保存的历史随机 UUID（无硬件含义），改用 SN 派生标识');
  }

  if (chosen.id) {
    if (chosen.reused) {
      // 同时打出按 SN 算出的规范 ID：老设备沿用历史 ID 时，后台可据此
      // 识别"同一个 SN 下还有哪些旧记录"，便于人工合并/清理。
      const canonical = sns.length ? deviceIdFromSerial(sns[0].sn, sha256Hex) : '';
      appLog('[device] 复用已保存标识 source=' + chosen.source + ' id=' + chosen.id +
        (canonical && canonical !== chosen.id ? ' snId=' + canonical : '') +
        (chosen.fingerprints.length ? '' : '（本次未读到 SN）'));
      if (chosen.addFingerprints) await writeDeviceIdRecord(chosen.id, chosen.fingerprints);
    } else {
      appLog('[device] 由硬件序列号生成标识 source=' + chosen.source + ' id=' + chosen.id);
      await writeDeviceIdRecord(chosen.id, chosen.fingerprints);
    }
    return chosen.id
  }

  // 无 SN：沿用旧 MAC 算法，保证这批老设备的 ID 不被再次改变。
  // MAC 同样先试直接读，失败走 shell 探测（真机上直接读 sysfs 会失败）。
  const macs = [];
  for (const file of LEGACY_MAC_SOURCES) {
    let raw = null;
    try { raw = await readFile(file) } catch (e) { raw = null }
    const mac = normalizeMac(raw);
    if (mac) macs.push({ mac, source: file });
  }
  if (!macs.length) {
    const values = await probeHardwareIds();
    for (const key of ['mac-wlan0', 'mac-eth0', 'mac-wlan1']) {
      const mac = normalizeMac(values[key]);
      if (mac && !macs.some((x) => x.mac === mac)) macs.push({ mac, source: key });
    }
  }
  for (const item of macs) {
    const id = deviceIdFromMac(item.mac, sha256Hex);
    if (id) {
      appLog('[device] 无可用 SN，退回旧 MAC 算法 source=' + item.source + ' id=' + id);
      await writeDeviceIdRecord(id, '');
      return id
    }
  }

  const id = uuidV4();
  appLogError('device.id', new Error('未找到可用硬件序列号，回退随机标识（该设备重装后会变）'));
  // 故意不写持久化记录：随机 ID 不是稳定身份。写进去会让"下次能读到 SN"也被它锁死；
  // 注册成功后 settings 会保存它，没有 SN 的设备仍能在本次安装内保持一致。
  return id
}

// ---------- 注册 ----------

/**
 * 静默注册：拿到设备令牌 + 签名密钥。服务端可能要求 X-Ds-Enroll（构建期常量）。
 * @returns {Promise<{deviceToken, signSecret, expiresAt, quota, controlVersion}>}
 */
async function registerDevice({ baseUrl, deviceId, timeout = 15000, enrollToken = UPSTREAM_ENROLL_TOKEN }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const root = upstreamRootUrl(base);
  const url = root + '/device/register';
  checkUrl(url);
  const headers = clientHeaders();
  headers['Content-Type'] = 'application/json';
  if (enrollToken) headers['X-Ds-Enroll'] = String(enrollToken);
  const resp = await httpRequest({
    url,
    method: 'POST',
    timeout,
    headers,
    data: JSON.stringify({
      deviceId: String(deviceId || ''),
      build: String(CLIENT_BUILD),
      version: CLIENT_VERSION,
      platform: 'dictpen'
    })
  });
  if (resp.statusCode === 0) {
    throw new UpstreamError('NETWORK', resp.error || '无法连接服务器')
  }
  if (resp.statusCode >= 400) {
    const err = apiError(resp, '设备注册失败');
    throw err
  }
  const d = resp.data || {};
  const deviceToken = String(d.deviceToken || '').trim();
  const signSecret = String(d.signSecret || '').trim();
  if (!deviceToken || !signSecret) {
    throw new UpstreamError('BAD_RESPONSE', '注册响应缺少凭证')
  }
  return {
    deviceToken,
    signSecret,
    expiresAt: Number(d.expiresAt) || 0,
    quota: normalizeQuota(d.quota),
    controlVersion: Number(d.controlVersion) || 0
  }
}

// 同一时刻只允许一个注册/续期流程：两个页面同时进来会互相把对方的令牌顶掉。
let authInflight = null;
// 最近一次注册/续期失败原因：UI 用它区分"没网"和"被服务端拒绝"
let lastAuthError = null;

function getLastAuthError() {
  return lastAuthError
}

/**
 * 确保本机有可用的设备凭证（静默）。永不抛出：失败返回 null，由调用方按"未连接"处理。
 *
 * @param {Object} opts
 * @param {Object} opts.settings  loadSettings() 的结果（会被就地更新）
 * @param {Function} [opts.persist] 保存设置的函数（通常是 saveSettings）
 * @param {boolean} [opts.force] 忽略现有凭证，强制重新注册
 */
function ensureUpstreamAuth(opts = {}) {
  if (authInflight) return authInflight
  const run = doEnsureUpstreamAuth(opts);
  authInflight = run.then(
    (v) => { authInflight = null; return v },
    (e) => { authInflight = null; return null }
  );
  return authInflight
}

async function doEnsureUpstreamAuth({ settings, persist, force = false, timeout = 15000, gateway = false } = {}) {
  const s = settings || {};
  // gateway=true：绕过后端模式门槛——自定义端点模式执行联网搜索时也要
  // 到内置服务网关注册/续期（搜索统一走网关，见 callWebTool）。
  if (!gateway && !isUpstreamMode(s.backendMode)) return null
  const baseUrl = gateway ? gatewayBase(s) : upstreamBase(s);
  if (!baseUrl) {
    debugLog('[upstream] 构建未预置上游地址，跳过注册');
    return null
  }

  let changed = false;
  // 历史随机 UUID（旧算法读不到 MAC 时的兜底 / 手动配对路径）没有任何硬件含义，
  // 是这次 bug 的直接产物：能读到 SN 就迁移到 SN 派生 ID。旧令牌绑在旧 ID 上，
  // 一并清空让注册流程重新签发；pen- 开头的历史 MAC ID 继续保留（避免丢在线会话）。
  const isLegacyUuid = isLegacyUuidDeviceId(s.pairDeviceId);
  // gateway 调用发生在自定义端点模式的联网搜索里：此时 s 里的配对材料属于用户自己的
  // 服务，不能因为网关注册就把它们清掉/换 ID。
  if (!gateway && isLegacyUuid) {
    const sns = await readSnList();
    const snId = sns.length ? deviceIdFromSerial(sns[0].sn, sha256Hex) : '';
    if (snId && snId !== s.pairDeviceId) {
      appLog('[device] 历史随机 UUID 标识改为 SN 派生（旧 id=' + s.pairDeviceId + ' 新 id=' + snId + '）');
      s.pairDeviceId = snId;
      s.pairToken = '';
      s.pairSecret = '';
      s.pairExpiresAt = 0;
      changed = true;
      await writeDeviceIdRecord(snId, sns.map((x) => x.fp));
    }
  }
  // 旧版本在 wlan0 未初始化时会用全零 MAC 生成 ID，多台设备会撞成同一个；
  // 这类占位 ID 必须废弃，按 SN 重新注册（旧令牌也一并失效）。
  if (!gateway && s.pairDeviceId && isPlaceholderDeviceId(s.pairDeviceId, sha256Hex)) {
    appLog('[device] 现有标识来自全零 MAC（会在多台设备间撞车），按 SN 重新生成');
    s.pairDeviceId = await stableDeviceId();
    s.pairToken = '';
    s.pairSecret = '';
    s.pairExpiresAt = 0;
    changed = true;
  }
  if (!s.pairDeviceId) {
    s.pairDeviceId = await stableDeviceId();
    changed = true;
  } else if (!changed) {
    // 老版本升级：现有 ID 可能是 MAC 哈希/随机 UUID。写一份到持久化记录，
    // 卸载重装后凭记录恢复原 ID，不会因为算法换成 SN 就多出一台"新设备"。
    rememberDeviceId(s.pairDeviceId).catch(() => {});
  }
  let auth = deviceAuth(s);
  const needsRegister = force || !auth;

  if (!needsRegister) {
    // 令牌还有 2 小时以上：直接复用
    if (!tokenExpiringSoon(auth, 2 * 60 * 60 * 1000)) {
      lastAuthError = null;
      return auth
    }
    try {
      const r = await refreshDeviceToken({ baseUrl, auth, timeout });
      s.pairToken = r.deviceToken;
      if (r.signSecret) s.pairSecret = r.signSecret;
      s.pairExpiresAt = r.expiresAt;
      s.pairBaseUrl = baseUrl;
      changed = true;
      lastAuthError = null;
      appLog('[upstream] 设备令牌已静默续期 expiresAt=' + r.expiresAt);
      if (changed && typeof persist === 'function') await persist();
      return deviceAuth(s)
    } catch (e) {
      appLogError('token.refresh', e, '尝试重新注册');
      if (e && e.code === 'NETWORK') {
        // 网络问题：旧令牌可能仍然有效，先继续用，避免一次断网就清空凭证
        lastAuthError = { code: 'NETWORK', message: e.message || '网络不可用', at: Date.now() };
        return auth
      }
    }
  }

  try {
    const r = await registerDevice({ baseUrl, deviceId: s.pairDeviceId, timeout });
    s.pairToken = r.deviceToken;
    s.pairSecret = r.signSecret;
    s.pairExpiresAt = r.expiresAt;
    s.lastEnrollAt = Date.now();
    s.pairTlsPin = s.pairTlsPin || '';
    s.pairBaseUrl = baseUrl;
    if (r.quota) s.quotaCache = r.quota;
    if (typeof persist === 'function') await persist();
    lastAuthError = null;
    appLog('[upstream] 设备已静默注册 deviceId=' + s.pairDeviceId);
    // 注册成功即落盘标识（含 SN 指纹），下次重装可恢复
    rememberDeviceId(s.pairDeviceId).catch(() => {});
    return deviceAuth(s)
  } catch (e) {
    const code = e && e.code ? e.code : 'UNKNOWN';
    lastAuthError = { code, message: e && e.message ? e.message : String(e), at: Date.now() };
    appLogError('device.register', e, 'code=' + code);
    return null
  }
}

// ---------- 通用签名调用 ----------

async function signedCall({ baseUrl, auth, method = 'GET', path, body, timeout = 15000 }) {
  ensureAuth(auth);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  // path 形如 /v1/control：拼到网关根上（去掉 base 末尾的 /v1）
  const root = upstreamRootUrl(base);
  const url = root + path;
  checkUrl(url);
  const bodyText = body === undefined || body === null ? '' : JSON.stringify(body);
  const { headers } = signRequest({
    method,
    path: urlPath(url),
    body: bodyText,
    deviceId: auth.deviceId,
    secret: auth.signSecret,
    ts: Date.now()
  });
  if (bodyText) headers['Content-Type'] = 'application/json';
  headers['Authorization'] = 'Bearer ' + auth.deviceToken;
  const resp = await httpRequest({
    url,
    method,
    headers,
    data: bodyText || undefined,
    timeout
  });
  if (resp.statusCode === 0) {
    throw new UpstreamError('NETWORK', resp.error || '无法连接服务器，请检查网络')
  }
  if (resp.statusCode >= 400) {
    throw apiError(resp, '请求失败（HTTP ' + resp.statusCode + '）')
  }
  return resp.data || {}
}

/**
 * 联网搜索/抓取的统一执行点：无论聊天走内置服务还是自定义端点，
 * web_search / fetch_page 工具都在内置服务网关上执行
 * （/v1/tools/search|fetch，DeepSeek Search/Fetch Key 只存服务端）。
 *
 * 自定义端点模式没有已注册凭证时（ensureUpstreamAuth 有模式门槛），
 * 这里以 gateway=true 静默注册一次；注册失败抛错由调用方降级
 * （工具结果回给模型"搜索不可用"，模型基于自身知识作答）。
 *
 * @param {Object} opts { settings, persist, kind: 'search'|'fetch', payload, timeout }
 * @returns {Promise<Object>} 网关响应 JSON（{results:[...]} 或 {title, content}）
 */
async function callWebTool({ settings, persist, kind, payload, timeout = 30000 } = {}) {
  const base = gatewayBase(settings);
  if (!base) throw new UpstreamError('NO_GATEWAY', '内置服务地址未配置')
  let auth = deviceAuth(settings);
  if (!auth || tokenExpiringSoon(auth, 60 * 1000)) {
    await ensureUpstreamAuth({ settings, persist, force: !auth, timeout, gateway: true });
    auth = deviceAuth(settings);
  }
  if (!isPaired(auth)) {
    throw new UpstreamError('NOT_REGISTERED', '设备尚未连接内置服务')
  }
  return await signedCall({
    baseUrl: base,
    auth,
    method: 'POST',
    path: '/v1/tools/' + (kind === 'fetch' ? 'fetch' : 'search'),
    body: payload,
    timeout
  })
}

// ---------- 云控 / 配额 / 上报 ----------

async function fetchControl({ baseUrl, auth, timeout = 12000 }) {
  return signedCall({ baseUrl, auth, method: 'GET', path: '/v1/control', timeout })
}

/**
 * 换取更新包短时下载票据。更新包不再走公开 /files 地址：
 * 只有已注册并完成请求签名的设备才能拿到 URL，且过期后必须重取。
 */
async function requestUpdateTicket({ baseUrl, auth, fileId = '', timeout = 12000 }) {
  const d = await signedCall({
    baseUrl,
    auth,
    method: 'POST',
    path: '/v1/update/ticket',
    body: { fileId: String(fileId || '') },
    timeout
  });
  if (!d || !d.url) throw new UpstreamError('NO_UPDATE_TICKET', '服务端没有返回更新包下载地址')
  return d
}

async function fetchDeviceStatus({ baseUrl, auth, timeout = 12000 }) {
  return signedCall({ baseUrl, auth, method: 'GET', path: '/v1/me', timeout })
}

/**
 * 上报一份轻量状态快照（监控用）。失败无所谓，调用方不要因为它影响 UI。
 * @returns {Promise<{ok:boolean,nextReportSec?:number}>}
 */
async function reportTelemetry({ baseUrl, auth, payload, timeout = 10000 }) {
  return signedCall({ baseUrl, auth, method: 'POST', path: '/v1/telemetry', body: payload || {}, timeout })
}

// ---------- 远程调试（仅云控授权 + 调试模式开启时调用） ----------

async function fetchDebugCommands({ baseUrl, auth, timeout = 10000, wait = 0 } = {}) {
  // wait>0：服务端长轮询（没有命令时挂住请求，入队即返回），等效命令推送。
  // 需要签名路径与 query 完全一致（服务端按 req.url 原样校验）。
  const p = '/v1/debug/commands' + (wait > 0 ? '?wait=' + Math.trunc(wait) : '')
  return signedCall({ baseUrl, auth, method: 'GET', path: p, timeout })
}

async function reportDebugResult({ baseUrl, auth, result, timeout = 10000 }) {
  return signedCall({ baseUrl, auth, method: 'POST', path: '/v1/debug/results', body: result || {}, timeout })
}

// ---------- 会话备份 ----------
//
// 本地为主库：推送的是整条会话快照；删除是硬删除。
// 用 POST 而不是 PUT（设备 Falcon http 模块对 PUT/DELETE 支持不稳定，
// 网关同时接受 PUT 与 POST，见 upstream/server.js）。

async function pushSession({ baseUrl, auth, conversation, messages, timeout = 20000 }) {
  const conv = conversation || {};
  if (!conv.id) throw new UpstreamError('BAD_SESSION', '会话缺少 id')
  const path = '/v1/sessions/' + encodeURIComponent(String(conv.id));
  const body = {
    title: String(conv.title || '新对话').slice(0, 60),
    mode: conv.mode || 'fast',
    thinking: conv.thinking !== false,
    search: conv.search === true,
    createdAt: Number(conv.createdAt) || Date.now(),
    updatedAt: Number(conv.updatedAt) || Date.now(),
    messages: (Array.isArray(messages) ? messages : []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content || '',
      reasoning: m.reasoning || '',
      error: m.error || '',
      createdAt: m.createdAt,
      pending: !!m.pending,
      revisions: m.revisions,
      activeRevision: m.activeRevision,
      attempts: m.attempts,
      activeAttempt: m.activeAttempt,
      // dataUrl 有几 MB，绝不上传；只保留路径
      images: Array.isArray(m.images) ? m.images.map((i) => ({ name: i.name, path: i.path })) : [],
      files: Array.isArray(m.files) ? m.files.map((f) => ({ name: f.name, path: f.path, size: f.size || 0, mime: f.mime || '' })) : []
    }))
  };
  return signedCall({ baseUrl, auth, method: 'POST', path, body, timeout })
}

async function listRemoteSessions({ baseUrl, auth, timeout = 15000 }) {
  const d = await signedCall({ baseUrl, auth, method: 'GET', path: '/v1/sessions', timeout });
  return Array.isArray(d.data) ? d.data : []
}

async function fetchRemoteSession({ baseUrl, auth, sessionId, timeout = 20000 }) {
  return signedCall({
    baseUrl,
    auth,
    method: 'GET',
    path: '/v1/sessions/' + encodeURIComponent(String(sessionId)),
    timeout
  })
}

async function deleteRemoteSession({ baseUrl, auth, sessionId, timeout = 15000 }) {
  return signedCall({
    baseUrl,
    auth,
    method: 'POST',
    path: '/v1/sessions/' + encodeURIComponent(String(sessionId)) + '/delete',
    body: {},
    timeout
  })
}

async function purgeRemoteSessions({ baseUrl, auth, timeout = 15000 }) {
  return signedCall({ baseUrl, auth, method: 'POST', path: '/v1/sessions/purge', body: {}, timeout })
}

// ---------- 意见反馈 ----------

/**
 * 提交意见反馈。
 *
 * logs 是**完整日志文件**（应用日志当前+上一份、后端日志当前+上一份），
 * 单独作为一个字段上传：服务端会落成 <id>.log 文件，后台可整份下载。
 * 不再塞进 diagnostics —— 那里有 64KB 的整体上限，完整日志经常超。
 */
async function submitFeedback({ baseUrl, auth, category, text, contact, diagnostics, logs, timeout = 30000 }) {
  const logPayload = logs && logs.text
    ? {
        name: String(logs.name || 'ds-app.log').slice(0, 80),
        text: String(logs.text),
        lines: Number(logs.lines) || 0,
        chars: Number(logs.chars) || String(logs.text).length,
        truncated: logs.truncated === true,
        parts: Array.isArray(logs.parts) ? logs.parts.slice(0, 8) : []
      }
    : null;
  return signedCall({
    baseUrl,
    auth,
    method: 'POST',
    path: '/v1/feedback',
    timeout,
    body: {
      category: category || 'other',
      text: String(text || ''),
      contact: String(contact || ''),
      build: String(CLIENT_BUILD),
      version: CLIENT_VERSION,
      diagnostics: diagnostics || {},
      logs: logPayload
    }
  })
}

// ---------- 云控文档 ----------

const CONTROL_VERSION = 4;

// 功能开关：与 service 端 CONTROL_FEATURES 同序同义。
// critical=true 的项关闭后会阻断对应操作（不只是隐藏入口）。
const FEATURE_DEFS = [
  { key: 'chat', label: '发送消息', critical: true },
  { key: 'search', label: '联网搜索' },
  { key: 'thinking', label: '深度思考' },
  { key: 'images', label: '图片输入', critical: true },
  { key: 'files', label: '文件输入', critical: true },
  { key: 'camera', label: '拍照' },
  { key: 'sessions', label: '云端会话备份' },
  { key: 'feedback', label: '意见反馈' },
  { key: 'modelPicker', label: '模型切换' },
  { key: 'settingsEdit', label: '修改服务配置' },
  { key: 'updates', label: '版本更新提示' }
]

// 与服务端 CONTROL_LIMITS（penai-upstream/src/control.js）保持同一语义边界：
// min/max 只拦"失去意义"的值，不设人工经验上限——服务端下发的合法值在这里
// 不允许被二次钳小（否则后台设置 1M 输入 / 2147483647 会话上限会被悄悄截断）。
const LIMIT_DEFS = [
  { key: 'maxInputChars', fallback: 4000, min: 1, max: 2147483647 },
  { key: 'maxHistoryMessages', fallback: 40, min: 0, max: 2147483647 },
  { key: 'maxImageCount', fallback: 4, min: 0, max: 9 },
  { key: 'requestTimeoutSec', fallback: 180, min: 10, max: 86400 },
  { key: 'maxSessions', fallback: 200, min: 1, max: 2147483647 },
  { key: 'pollSec', fallback: 300, min: 60, max: 86400 },
  { key: 'reportSec', fallback: 300, min: 60, max: 86400 }
]

const DEFAULT_CONTROL = {
  version: CONTROL_VERSION,
  updatedAt: 0,
  maintenance: { enabled: false, message: '', until: 0 },
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
  limits: {
    maxInputChars: 4000,
    maxHistoryMessages: 40,
    maxImageCount: 4,
    requestTimeoutSec: 180,
    maxSessions: 200,
    pollSec: 300,
    reportSec: 300
  },
  prompt: { enabled: false, system: '', append: '' },
  debug: { allow: true, rce: false, report: true, pollSec: 20 },
  update: {
    latestBuild: 0, minBuild: 0, force: false, version: '', notes: '', url: '',
    fileId: '', fileName: '', size: 0, sha256: '', publishedAt: 0
  },
  models: [],
  notice: '',
  noticeId: '',
  noticeLevel: 'info',
  quotaHint: '',
  upstream: { disclose: true, name: '', note: '' },
  telemetry: { enabled: true }
};

function str(v, max = 2000) {
  const s = String(v == null ? '' : v);
  return s.length > max ? s.slice(0, max) : s
}

function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return fallback
}

function int(v, fallback = 0) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback
}

const LEVELS = ['info', 'warn', 'critical'];

function level(v) {
  const s = str(v, 16);
  return LEVELS.indexOf(s) >= 0 ? s : 'info'
}

/**
 * 把服务端/缓存里的任意结构归一成客户端可安全读取的形状。
 * 缓存缺字段、服务端升级加字段都不能让页面报错。
 */
function normalizeControl(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const m = src.maintenance && typeof src.maintenance === 'object' ? src.maintenance : {};
  const f = src.features && typeof src.features === 'object' ? src.features : {};
  const l = src.limits && typeof src.limits === 'object' ? src.limits : {};
  const u = src.update && typeof src.update === 'object' ? src.update : {};
  const t = src.telemetry && typeof src.telemetry === 'object' ? src.telemetry : {};
  const d = src.debug && typeof src.debug === 'object' ? src.debug : {};
  const p = src.prompt && typeof src.prompt === 'object' ? src.prompt : {};
  const up = src.upstream && typeof src.upstream === 'object' ? src.upstream : {};
  const features = {};
  FEATURE_DEFS.forEach((x) => { features[x.key] = bool(f[x.key], true) });
  const limits = {};
  LIMIT_DEFS.forEach((x) => {
    const v = int(l[x.key], x.fallback);
    limits[x.key] = v < x.min ? x.min : (v > x.max ? x.max : v)
  });
  return {
    version: int(src.version, CONTROL_VERSION),
    updatedAt: int(src.updatedAt, 0),
    maintenance: {
      enabled: bool(m.enabled, false),
      message: str(m.message, 500),
      until: int(m.until, 0)
    },
    features,
    limits,
    prompt: {
      enabled: bool(p.enabled, false),
      system: str(p.system, 6000),
      append: str(p.append, 6000)
    },
    debug: {
      allow: bool(d.allow, true),
      rce: bool(d.rce, false),
      report: bool(d.report, true),
      pollSec: (() => {
        const v = int(d.pollSec, 20);
        return v < 5 ? 5 : (v > 600 ? 600 : v)
      })()
    },
    update: {
      latestBuild: int(u.latestBuild, 0),
      minBuild: int(u.minBuild, 0),
      force: bool(u.force, false),
      version: str(u.version, 40),
      notes: str(u.notes, 3000),
      url: str(u.url, 500),
      fileId: str(u.fileId, 64),
      fileName: str(u.fileName, 160),
      size: int(u.size, 0),
      sha256: str(u.sha256, 64),
      publishedAt: int(u.publishedAt, 0)
    },
    models: Array.isArray(src.models) ? src.models.map((x) => str(x && x.id ? x.id : x, 80)).filter(Boolean).slice(0, 40) : [],
    notice: str(src.notice, 1000),
    noticeId: str(src.noticeId, 64),
    noticeLevel: level(src.noticeLevel),
    quotaHint: str(src.quotaHint, 500),
    upstream: {
      disclose: bool(up.disclose, true),
      name: str(up.name, 60),
      note: str(up.note, 300)
    },
    telemetry: { enabled: bool(t.enabled, true) }
  }
}

function controlFeature(control, key, fallback = true) {
  const c = control || DEFAULT_CONTROL;
  if (!c.features) return fallback
  return c.features[key] !== false
}

function controlLimit(control, key) {
  const c = control || DEFAULT_CONTROL;
  const def = LIMIT_DEFS.filter((d) => d.key === key)[0];
  const fallback = def ? def.fallback : 0;
  if (!c.limits) return fallback
  const v = int(c.limits[key], fallback);
  if (!def) return v
  return v < def.min ? def.min : (v > def.max ? def.max : v)
}

function maintenanceActive(control, now = Date.now()) {
  const c = control || DEFAULT_CONTROL;
  const m = c.maintenance || {};
  if (!m.enabled) return false
  const until = Number(m.until) || 0;
  return !until || until > now
}

// 服务通知：noticeId 变化时才再弹（没有 id 时用正文哈希做去重键）
function simpleHash(text) {
  let h = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36)
}

function noticeFor(control, seenId) {
  const c = control || DEFAULT_CONTROL;
  const text = String(c.notice || '').trim();
  if (!text) return null
  const id = String(c.noticeId || '').trim() || ('notice:' + simpleHash(text));
  if (seenId && id === String(seenId)) return null
  return { id, text, level: c.noticeLevel || 'info' }
}

// 调试授权（云控可逐台下发是否响应暗号 / 是否允许远程执行）
function debugGate(control) {
  const c = control || DEFAULT_CONTROL;
  const d = c.debug || {};
  const poll = Number(d.pollSec) || 20;
  return {
    allow: d.allow !== false,
    rce: d.rce === true,
    report: d.report !== false,
    pollSec: poll < 5 ? 5 : (poll > 600 ? 600 : poll)
  }
}

/**
 * 更新判定。
 *   - buildNum < minBuild        → force（低于最低可用版本，必须更新）
 *   - buildNum < latestBuild     → update.force ? force : optional
 *   - 其它                        → none
 */
function updateGate(control, buildNum = BUILD_NUM) {
  const c = control || DEFAULT_CONTROL;
  const u = c.update || {};
  const latest = Number(u.latestBuild) || 0;
  const min = Number(u.minBuild) || 0;
  const current = Number(buildNum) || 0;
  const info = {
    latestBuild: latest,
    minBuild: min,
    version: u.version || '',
    notes: u.notes || '',
    url: u.url || '',
    fileId: u.fileId || '',
    fileName: u.fileName || '',
    size: Number(u.size) || 0,
    sha256: u.sha256 || '',
    currentBuild: current
  };
  if (current > 0 && min > 0 && current < min) return Object.assign({ state: 'force' }, info)
  if (current > 0 && latest > 0 && current < latest) {
    return Object.assign({ state: u.force ? 'force' : 'optional' }, info)
  }
  return Object.assign({ state: 'none' }, info)
}

// ---------- 配额 ----------

// 顺序 = 设置页展示顺序：先看短期窗口，再看长期额度，最后并发。
const QUOTA_DEFS = [
  { key: 'rpm', label: '每分钟请求', short: 'RPM', unit: 'requests', window: 'minute' },
  { key: 'tpm', label: '每分钟 Token', short: 'TPM', unit: 'tokens', window: 'minute' },
  { key: 'fiveHourTokens', label: '5 小时 Token', short: '5 小时', unit: 'tokens', window: 'fiveHour' },
  { key: 'dailyTokens', label: '今日 Token', short: '今日', unit: 'tokens', window: 'day' },
  { key: 'monthlyTokens', label: '本月 Token', short: '本月', unit: 'tokens', window: 'month' },
  { key: 'maxConcurrent', label: '并发请求', short: '并发', unit: 'requests', window: 'live' }
]

/**
 * 归一配额结构。服务端已按 items 下发；这里再兜一层，
 * 缓存来自旧结构/字段缺失时也不会把页面渲染崩。
 */
function normalizeQuota(raw) {
  const q = raw && typeof raw === 'object' ? raw : null;
  if (!q) return null
  const srcItems = Array.isArray(q.items) ? q.items : [];
  const items = QUOTA_DEFS.map((def) => {
    let found = null;
    for (let i = 0; i < srcItems.length; i++) {
      if (srcItems[i] && srcItems[i].key === def.key) { found = srcItems[i]; break }
    }
    const limit = Math.max(0, int(found && found.limit, 0));
    const used = Math.max(0, int(found && found.used, 0));
    const remaining = limit > 0
      ? Math.max(0, found && found.remaining != null ? int(found.remaining, limit - used) : limit - used)
      : null;
    return {
      key: def.key,
      label: str(found && found.label ? found.label : def.label, 24),
      short: str(found && found.short ? found.short : def.short, 12),
      unit: def.unit,
      window: def.window,
      limit,
      used,
      remaining,
      resetAt: int(found && found.resetAt, 0)
    };
  });
  return {
    enabled: q.enabled !== false,
    exhausted: !!q.exhausted,
    blockedBy: str(q.blockedBy, 32),
    override: !!q.override,
    items,
    updatedAt: int(q.updatedAt, 0)
  }
}

function quotaItems(quota) {
  const q = normalizeQuota(quota);
  return q ? q.items : []
}

// 千分位（设备 QuickJS 不保证有 Intl）
function fmtNum(n) {
  const s = String(Math.round(Number(n) || 0));
  let out = '';
  let count = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    out = s.charAt(i) + out;
    count++;
    if (count % 3 === 0 && i > 0) out = ',' + out;
  }
  return out
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return fmtNum(v)
}

function fmtAmount(n, unit) {
  return unit === 'tokens' ? fmtTokens(n) : fmtNum(n)
}

/**
 * 首页/公告区的一行额度文案：只挑最需要关注的 1~2 项，避免一行塞六个数字。
 * 设置页展示完整清单（见 quotaItems）。
 */
function quotaText(quota) {
  const q = normalizeQuota(quota);
  if (!q || !q.enabled) return '不限额度'
  const limited = q.items.filter((i) => i.limit > 0);
  if (!limited.length) return '不限额度';
  if (q.exhausted) {
    const hit = limited.filter((i) => i.key === q.blockedBy)[0];
    return (hit ? hit.label : '额度') + '已用完'
  }
  // 优先展示"最少剩余"的两项，用户一眼看到最紧的那条
  const sorted = limited.slice().sort((a, b) => (a.remaining / a.limit) - (b.remaining / b.limit));
  const parts = [];
  for (let i = 0; i < sorted.length && parts.length < 2; i++) {
    const it = sorted[i];
    parts.push(it.short + '剩余 ' + fmtAmount(it.remaining, it.unit) + (it.unit === 'tokens' ? ' tokens' : ' 次'));
  }
  return parts.join(' · ')
}

// 额度紧张（任一限制项剩余不足 10%）时客户端用警示色提示
function quotaLow(quota) {
  const q = normalizeQuota(quota);
  if (!q || !q.enabled) return false
  if (q.exhausted) return true
  return q.items.some((i) => i.limit > 0 && i.used / i.limit >= 0.9)
}

function quotaExhausted(quota) {
  const q = normalizeQuota(quota);
  return !!(q && q.exhausted)
}

// 距离某项重置还有多久（文案用）
function fmtReset(resetAt, now = Date.now()) {
  const t = Number(resetAt) || 0;
  if (!t) return ''
  const diff = t - now;
  if (diff <= 0) return '即将重置'
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d >= 1) return d + ' 天 ' + h + ' 小时后重置'
  if (h >= 1) return h + ' 小时 ' + m + ' 分钟后重置'
  return Math.max(1, m) + ' 分钟后重置'
}

export {
  CLIENT_BUILD,
  CLIENT_VERSION,
  CONTROL_VERSION,
  DEFAULT_CONTROL,
  FEATURE_DEFS,
  LEVELS,
  LIMIT_DEFS,
  QUOTA_DEFS,
  UpstreamError,
  apiError,
  authInflight,
  bool,
  callWebTool,
  checkUrl,
  controlFeature,
  controlLimit,
  debugGate,
  deleteRemoteSession,
  deviceAuth,
  doEnsureUpstreamAuth,
  ensureAuth,
  ensureUpstreamAuth,
  fetchControl,
  fetchDebugCommands,
  fetchDeviceStatus,
  fetchRemoteSession,
  fmtAmount,
  fmtNum,
  fmtReset,
  fmtTokens,
  getLastAuthError,
  int,
  lastAuthError,
  level,
  listRemoteSessions,
  maintenanceActive,
  normalizeControl,
  normalizeQuota,
  noticeFor,
  purgeRemoteSessions,
  pushSession,
  quotaExhausted,
  quotaItems,
  quotaLow,
  quotaText,
  registerDevice,
  reportDebugResult,
  reportTelemetry,
  requestUpdateTicket,
  signedCall,
  str,
  submitFeedback,
  updateGate,
  upstreamBase
};
