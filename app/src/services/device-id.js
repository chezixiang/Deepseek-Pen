// 设备标识派生（纯函数，可在宿主机单测）。
//
// 身份来源必须是**硬件序列号**：MAC 会因网卡未初始化读到全零、网卡名变化、
// MAC 随机化而改变；UUID 每次生成都不同。两者都不能作为跨卸载重装的设备身份。
//
// 真机（X7 Pro / RK3562）实测可用来源：
//   /proc/cpuinfo            Serial : 8c571a98d606d768   ← 首选（SoC SN，只读 0444）
//   /proc/device-tree/serial-number                       ← 部分机型有
//   /sys/block/mmcblk0/device/cid                         ← eMMC CID，硬件唯一
//
// 只把哈希上传服务端，原始 SN 不落盘、不上传。

export const DEVICE_ID_PREFIX = 'pen-'
// 域分隔：与旧 MAC 算法的 'deepseek-pen:' 前缀区分开，避免两种来源算出同一个 ID
export const SN_ID_DOMAIN = 'deepseek-pen:sn:'
export const SN_FP_DOMAIN = 'deepseek-pen:snfp:'

/** 去空白/NUL，只取第一行；保留原始大小写，比较时统一小写 */
export function normalizeSerial(raw) {
  if (raw === null || raw === undefined) return ''
  let s = String(raw).replace(/\uFEFF/g, '').replace(/\0/g, '')
  const nl = s.search(/[\r\n]/)
  if (nl >= 0) s = s.slice(0, nl)
  return s.trim()
}

/** /proc/cpuinfo 里的 Serial 行（ARM 平台在文件末尾，只有一行） */
export function serialFromCpuInfo(text) {
  const src = String(text || '')
  const re = /^\s*Serial\s*:\s*(\S+)\s*$/gim
  let m = null
  while ((m = re.exec(src)) !== null) {
    const s = normalizeSerial(m[1])
    if (isUsableSerial(s)) return s
  }
  return ''
}

/**
 * 判断一个序列号是否可用。
 * 拒绝空值、占位值（全 0/全 f/unknown）、过短值；允许字母数字与 . _ : -
 */
export function isUsableSerial(raw) {
  const s = normalizeSerial(raw)
  if (!s) return false
  if (s.length < 6 || s.length > 128) return false
  if (!/^[A-Za-z0-9._:-]+$/.test(s)) return false
  if (/^0+$/.test(s)) return false
  if (/^f+$/i.test(s)) return false
  if (/^(unknown|none|null|nil|n\/a|na|invalid|default)$/i.test(s)) return false
  return true
}

/** 从任意文本里提取第一个合法 MAC（旧算法的解析口径，保持兼容） */
export function normalizeMac(raw) {
  const m = String(raw == null ? '' : raw).match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/)
  if (!m) return ''
  const mac = m[0].toLowerCase()
  if (mac === '00:00:00:00:00:00') return ''
  // 组播/广播位：首字节最低位为 1，不可能是单播网卡地址
  if (parseInt(mac.slice(0, 2), 16) & 1) return ''
  return mac
}

/** 是否是历史随机 UUID（旧算法读不到 MAC / 手动配对生成的兜底标识） */
export function isLegacyUuidDeviceId(raw) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(raw == null ? '' : raw).trim())
}

/** 合法设备 ID：新格式 pen-<32hex>，或历史随机 UUID */
export function normalizeDeviceId(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (/^pen-[0-9a-f]{32}$/i.test(s)) return s.toLowerCase()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase()
  return ''
}

/**
 * SN → 设备 ID。同一个 SN 永远得到同一个 ID。
 * @param {string} serial
 * @param {(s:string)=>string} sha256Hex
 */
export function deviceIdFromSerial(serial, sha256Hex) {
  const s = normalizeSerial(serial)
  if (!isUsableSerial(s)) return ''
  return DEVICE_ID_PREFIX + sha256Hex(SN_ID_DOMAIN + s.toLowerCase()).slice(0, 32)
}

/**
 * 旧算法：MAC → 设备 ID。
 * 只在设备完全没有 SN 时作为兜底，保证这类老设备的 ID 不被再次改变。
 */
export function deviceIdFromMac(mac, sha256Hex) {
  const m = normalizeMac(mac)
  if (!m) return ''
  return DEVICE_ID_PREFIX + sha256Hex('deepseek-pen:' + m).slice(0, 32)
}

/**
 * 判断一个存量 ID 是否是旧算法用全零 MAC 生成的占位值。
 *
 * 旧代码的正则会匹配 `00:00:00:00:00:00`——冷启动 wlan0 未初始化时就是它。
 * 这个 ID 在所有"开机即注册"的设备上完全相同（多台笔撞成一个 deviceId），
 * 必须识别出来并用 SN 重新生成；不能当老身份保留。
 */
export function isPlaceholderDeviceId(id, sha256Hex) {
  const normalized = normalizeDeviceId(id)
  if (!normalized || normalized.indexOf(DEVICE_ID_PREFIX) !== 0) return false
  const zero = DEVICE_ID_PREFIX + sha256Hex('deepseek-pen:00:00:00:00:00:00').slice(0, 32)
  return normalized === zero
}

/** SN 指纹：持久化记录里用来判断"还是不是同一台机器"（不存原始 SN） */
export function serialFingerprint(serial, sha256Hex) {
  const s = normalizeSerial(serial)
  if (!isUsableSerial(s)) return ''
  return sha256Hex(SN_FP_DOMAIN + s.toLowerCase()).slice(0, 16)
}

// 一次 shell 探测同时带回硬件标识和两份 ID 记录，用分隔行切开。
// 分节而不是多个文件：4.9.7 上每个 execShell 往返都要等哨兵，能省则省。
export const PROBE_APP_MARK = '#ds-app-id#'
export const PROBE_USER_MARK = '#ds-user-id#'
export const PROBE_END_MARK = '#ds-end#'

/**
 * 解析 shell 探测结果：
 *
 *   cpuinfo=8c57…            ← 硬件标识（key=value）
 *   #ds-app-id#              ← 应用数据目录里的 ID 记录
 *   {"v":1,"id":"pen-…"}
 *   #ds-user-id#             ← /userdisk 里的 ID 记录（跨卸载保留）
 *   {"v":1,"id":"pen-…"}
 *   #ds-end#
 *
 * @returns {{values:Object<string,string>, records:{app:string,user:string}}}
 */
export function parseSystemProbe(text) {
  const values = {}
  const records = { app: '', user: '' }
  let section = 'hw'
  const lines = String(text == null ? '' : text).split('\n')
  for (const rawLine of lines) {
    // 记录可能是 shell 写出的 CRLF，也可能经 adb/串口被替换成多个 \r —— 一律剥掉
    const line = rawLine.replace(/\r+$/, '')
    if (line === PROBE_APP_MARK) { section = 'app'; continue }
    if (line === PROBE_USER_MARK) { section = 'user'; continue }
    if (line === PROBE_END_MARK) { section = 'end'; continue }
    if (section === 'hw') {
      const i = line.indexOf('=')
      if (i <= 0) continue
      const key = line.slice(0, i).trim()
      if (key) values[key] = normalizeSerial(line.slice(i + 1))
      continue
    }
    if (section === 'end') continue
    // 记录正文：cat 输出可能不带换行，调用方已补 echo，这里按行拼接
    const piece = line.trim()
    if (!piece) continue
    if (section === 'app') records.app = records.app ? records.app + '\n' + piece : piece
    else records.user = records.user ? records.user + '\n' + piece : piece
  }
  return { values, records }
}

/**
 * 只取硬件标识部分（`key=value` 每行一条）。
 * 真机上 `fs.readFile` 读 /proc、/sys 会失败（本机实测：旧算法因此拿不到 MAC，
 * 退化成随机 UUID），所以设备侧用 execShell 把候选值写进应用数据目录再读回。
 * @returns {Object<string,string>}
 */
export function parseSnProbe(text) {
  return parseSystemProbe(text).values
}

/**
 * 生成一次性探测命令：硬件标识 + 两份 ID 记录，全部写进 outFile。
 *
 * 只能靠 shell：OS 4.9.7 的 falcon fs 没有 fs.writeFile，fs.readFile 读
 * /proc、/sys（本机实测连 /sys/class/net/*\/address 都读不到）也不可靠，
 * 而 execShell 是 root 且一直可用。
 *
 * 结尾的 chmod 644 不是可选项：shell 以 root 写文件，若某机型 umask 是 077，
 * 应用进程读不回来，探测就等于全空 → 退回随机 UUID（本次 bug 的老路）。
 *
 * @param {Object} opts
 * @param {Array<[string,string]>} opts.items [key, shell 表达式]
 * @param {string} opts.outFile 探测输出（应用数据目录内）
 * @param {string} opts.doneFile 完成哨兵
 * @param {string} opts.appPath 应用数据目录里的 ID 记录
 * @param {string} opts.userPath 用户盘里的 ID 记录
 * @param {(s:string)=>string} opts.shq shell 单引号转义
 */
export function buildProbeCommand({ items, outFile, doneFile, appPath, userPath, shq }) {
  let cmd = '{ '
  for (const item of items || []) {
    cmd += 'echo "' + item[0] + '=$(' + item[1] + ')"; '
  }
  // cat 的内容没有结尾换行时后面的 echo 会拼到同一行 → 每段后补一个 echo
  cmd += 'echo ' + shq(PROBE_APP_MARK) + '; cat ' + shq(appPath) + ' 2>/dev/null; echo; '
  cmd += 'echo ' + shq(PROBE_USER_MARK) + '; cat ' + shq(userPath) + ' 2>/dev/null; echo; '
  cmd += 'echo ' + shq(PROBE_END_MARK) + '; } > ' + shq(outFile) + '; '
  cmd += 'echo done > ' + shq(doneFile) + '; '
  cmd += 'chmod 644 ' + shq(outFile) + ' ' + shq(doneFile) + ' 2>/dev/null; true'
  return cmd
}

/**
 * 解析持久化记录。格式：
 *   {"v":1,"id":"pen-…","sns":["…","…"],"snHash":"…"}
 * sns 记录写入时能读到的**全部**硬件指纹：只要有一个仍然匹配，就说明还是同一台
 * 机器（避免"这次只读到 eMMC、下次读到 CPU SN"被误判成换机）。
 * 兼容只有 snHash 的旧记录和纯 ID 文本。
 * @returns {{id:string, snHashes:string[], snHash:string, v:number}|null}
 */
export function parseDeviceIdRecord(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return null
  const plain = normalizeDeviceId(text)
  if (plain) return { id: plain, snHashes: [], snHash: '', v: 0 }
  try {
    const obj = JSON.parse(text)
    const id = normalizeDeviceId(obj && obj.id)
    if (!id) return null
    const list = []
    const push = (v) => {
      const s = typeof v === 'string' ? v.toLowerCase() : ''
      if (/^[0-9a-f]{8,64}$/.test(s) && list.indexOf(s) < 0) list.push(s)
    }
    if (Array.isArray(obj && obj.sns)) obj.sns.forEach(push)
    push(obj && obj.snHash)
    return { id, snHashes: list, snHash: list[0] || '', v: Number(obj && obj.v) || 0 }
  } catch (e) {
    return null
  }
}

/** 生成持久化记录文本（snHashes 可传数组或单个字符串） */
export function buildDeviceIdRecord(id, snHashes) {
  const normalized = normalizeDeviceId(id)
  if (!normalized) return ''
  const list = []
  const input = Array.isArray(snHashes) ? snHashes : [snHashes]
  for (const v of input) {
    const s = typeof v === 'string' ? v.toLowerCase() : ''
    if (/^[0-9a-f]{8,64}$/.test(s) && list.indexOf(s) < 0) list.push(s)
  }
  const out = { v: 1, id: normalized }
  if (list.length) {
    out.sns = list.slice(0, 8)
    out.snHash = list[0]
  }
  return JSON.stringify(out)
}

/**
 * 持久化记录是否属于当前这台机器。
 * 本次读不到任何 SN 时只能信任记录（否则偶发读取失败就会换 ID）；
 * 记录里没有任何指纹（老格式）时也信任（升级连续性优先）。
 */
export function recordMatchesFingerprints(record, fingerprints) {
  if (!record || !record.id) return false
  const saved = Array.isArray(record.snHashes) && record.snHashes.length
    ? record.snHashes
    : (record.snHash ? [record.snHash] : [])
  if (!saved.length) return true
  const now = Array.isArray(fingerprints) ? fingerprints.filter(Boolean) : []
  if (!now.length) return true
  for (const fp of now) {
    if (saved.indexOf(fp) >= 0) return true
  }
  return false
}

/**
 * 设备 ID 决策（纯函数，唯一入口；I/O 由调用方注入）。
 *
 * @param {Object} opts
 * @param {Object|null} opts.saved  持久化记录 { id, snHashes, path }
 * @param {Array} opts.snList       可用硬件序列号 [{ sn, source, fp }]，按优先级
 * @param {(s:string)=>string} opts.sha256Hex
 * @returns {{id:string, source:string, reused:boolean, addFingerprints:boolean,
 *            ignoredPlaceholder:boolean, fingerprints:string[]}}
 *   id 为空表示没有 SN 可用，调用方继续走 MAC / 随机兜底。
 */
export function chooseDeviceId({ saved = null, snList = [], sha256Hex } = {}) {
  const fps = (snList || []).map((x) => x && x.fp).filter(Boolean);
  let rec = saved;
  let ignoredPlaceholder = false;
  let ignoredLegacyUuid = false;

  if (rec && isPlaceholderDeviceId(rec.id, sha256Hex)) {
    rec = null;
    ignoredPlaceholder = true;
  }

  // 历史随机 UUID：它是旧算法读不到 MAC 时的兜底产物，没有任何硬件含义，
  // 正是"同一台笔出现两个 ID"的来源。只要能读到 SN，就必须收敛到 SN 派生 ID，
  // 不能因为磁盘上恰好留着这条记录就继续沿用。
  if (rec && isLegacyUuidDeviceId(rec.id) && fps.length) {
    rec = null;
    ignoredLegacyUuid = true;
  }

  if (rec && recordMatchesFingerprints(rec, fps)) {
    return {
      id: rec.id,
      source: 'record:' + (rec.path || ''),
      reused: true,
      addFingerprints: fps.length > 0 && (!rec.snHashes || !rec.snHashes.length),
      ignoredPlaceholder,
      ignoredLegacyUuid,
      fingerprints: fps
    }
  }

  if (snList && snList.length) {
    const primary = snList[0];
    const id = deviceIdFromSerial(primary.sn, sha256Hex);
    if (id) {
      return {
        id,
        source: 'sn:' + primary.source,
        reused: false,
        addFingerprints: false,
        ignoredPlaceholder,
        ignoredLegacyUuid,
        fingerprints: fps
      }
    }
  }

  return { id: '', source: '', reused: false, addFingerprints: false, ignoredPlaceholder, ignoredLegacyUuid, fingerprints: fps }
}
