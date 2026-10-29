// AMR 构建产物解析：直接从上传的应用包里读出版本号和构建号。
//
// AMR 是标准 ZIP。manifest.json 里有 version/appid，但没有 BUILD_NUM；
// 构建号按下面顺序自动识别（先命中先用）：
//   1. 包内显式元数据 release.json / build-info.json / build.json
//      （根目录精确名优先，其次任意层级的同名文件，兼容重打包布局）；
//   2. 扫描打包后的 JS/字节码文本。三档逐级放开：先只认版本号锚定的融合
//      字面量 `<version> build N`（由 app/scripts/build-wrapper.js 写进
//      build-info.js，单个字符串字面量可穿过 minify 与 qjsc 字节码常量池），
//      再放开 BUILD_NUM 常量、最后才是宽松的 `build: N` 兜底——每档都跨全部
//      条目择先命中，避免排在 store 前面的无关文件里恰好有 `rebuild=1` 之类
//      抢跑给出错误构建号；
//   3. 文件名兜底：`8000000000182376.0_2_0.amr` 的版本段可以补 manifest
//      缺失的 version；`...build172.amr` / `...b-172.amr` 可以补构建号。
//
// 注意：运行时拼接出来的版本串（'0.2.0 build ' + BUILD_NUM）在 dev/未折叠
// 产物里不生成可扫描的完整字面量，是历史上「构建号识别失败」的根因。
// 客户端修复见 build-wrapper.js / src/services/build-info.js（融合字面量）。
//
// 不依赖第三方 unzip：生产服务器是裸 Node，少一个运行时依赖少一类部署故障。

import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_META_BYTES = 2 * 1024 * 1024
const MAX_SCAN_BYTES = 32 * 1024 * 1024

function text(buf) {
  return buf.toString('utf8').replace(/^\uFEFF/, '')
}

function decodeEntry(buffer, entry, maxBytes = MAX_META_BYTES) {
  if (!entry || entry.uncompressedSize > maxBytes) return null
  const off = entry.localOffset
  if (off + 30 > buffer.length || buffer.readUInt32LE(off) !== LOCAL_SIG) return null
  const nameLen = buffer.readUInt16LE(off + 26)
  const extraLen = buffer.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (start < 0 || end > buffer.length) return null
  const raw = buffer.subarray(start, end)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes })
    } catch (_) {
      return null
    }
  }
  return null
}

function centralEntries(buffer) {
  const min = Math.max(0, buffer.length - 65557)
  let eocd = -1
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 AMR/ZIP 文件（缺少中央目录）')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (!count || cdOffset >= buffer.length || cdOffset + cdSize > buffer.length) {
    throw new Error('AMR 中央目录损坏')
  }
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIG) break
    const flags = buffer.readUInt16LE(p + 8)
    const method = buffer.readUInt16LE(p + 10)
    const compressedSize = buffer.readUInt32LE(p + 20)
    const uncompressedSize = buffer.readUInt32LE(p + 24)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function safeJson(buf) {
  if (!buf) return null
  try { return JSON.parse(text(buf)) } catch (_) { return null }
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 版本号锚定的融合字面量：`0.2.0 build 172` / `0.2.0-build-172` / `0.2.0+172`。
// 依赖客户端 build-info.js 的 APP_VERSION 是构建期融合好的单个字面量，
// minify/qjsc 字节码里也能完整保留，是最可靠的构建号来源。
function anchoredBuildRes(version) {
  const v = escapeRe(version)
  return [
    new RegExp(v + '\\s+build\\s+(\\d{1,9})', 'i'),
    new RegExp(v + '[-_]build[-_](\\d{1,9})', 'i'),
    new RegExp(v + '\\+(\\d{1,9})', 'i')
  ]
}

// 构建号常量名（dev/未常量折叠产物里 BUILD_NUM = 177 的兜底）。
const BUILD_CONST_RES = [/(?:BUILD_NUM|buildNum)["']?\s*[:=]\s*(\d{1,9})/i]

// 最后手段：宽松的 `build: 177` / `build=177`。\b 避免误吃 rebuild=1 之类。
const BUILD_LOOSE_RES = [/\bbuild["']?\s*[:=]\s*(\d{1,9})/i]

/**
 * 从一段打包产物文本里提取构建号（按档位顺序，档内按模式顺序）。
 * @param {string} src 文本（JS 源码或字节码常量池）
 * @param {string} version manifest 里的版本号，用于锚定
 * @param {boolean} [strict] true=只用版本号锚定模式；false=三档全开
 */
function extractBuildFromText(src, version, strict = false) {
  if (!src) return 0
  const tiers = strict
    ? [anchoredBuildRes(version)]
    : [anchoredBuildRes(version), BUILD_CONST_RES, BUILD_LOOSE_RES]
  for (const patterns of tiers) {
    for (const re of patterns) {
      const m = String(src).match(re)
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n > 0) return Math.trunc(n)
      }
    }
  }
  return 0
}

/**
 * 解析 AMR 元数据。
 * @param {Buffer} buffer
 * @param {{name?: string}} [opts]
 * @returns {{isAmr:boolean, version:string, build:number, appId:string, appName:string, source:string, entries:number}}
 */
export function inspectAmr(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('更新包内容为空')
  const entries = centralEntries(buffer)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const manifest = safeJson(decodeEntry(buffer, byName.get('manifest.json')))
  if (!manifest || typeof manifest !== 'object') throw new Error('AMR 缺少可读的 manifest.json')

  const version = String(manifest.version || '').trim() ||
    // manifest 缺 version 时从官方流水线文件名兜底：
    // `8000000000182376.0_2_0.amr` / `app-0.2.0.amr` → 0.2.0
    (() => {
      const fm = String(opts.name || '').match(/\.(\d{1,3})([._-])(\d{1,3})\2(\d{1,3})(?:\.amr)?$/i)
      return fm ? fm[1] + '.' + fm[3] + '.' + fm[4] : ''
    })()
  const appId = String(manifest.appid || manifest.appId || '').trim()
  const appName = String(manifest.appName || manifest.name || '').trim()
  let build = 0
  let source = ''

  // 1) 新构建显式元数据（优先）：根目录精确名在前，其次任意层级的同名文件
  //    （兼容带 ./ 前缀或子目录重打包的 AMR）。
  for (const name of ['release.json', 'build-info.json', 'build.json']) {
    let entry = byName.get(name)
    if (!entry) {
      const suffix = '/' + name.toLowerCase()
      entry = entries.find((e) => e.name.toLowerCase().endsWith(suffix)) || null
    }
    const info = safeJson(decodeEntry(buffer, entry))
    if (!info || typeof info !== 'object') continue
    const n = Number(info.build != null ? info.build : info.buildNum)
    if (Number.isFinite(n) && n > 0) {
      build = Math.trunc(n)
      source = entry ? entry.name : name
      break
    }
  }

  // 2) 扫描打包后的 JS/字节码文本（.js / .js.bin / .bin / .json）。
  //    三档逐级放开，每档都跨全部条目择先命中，低档绝不抢在高档前面：
  //    ① 版本号锚定的融合字面量 `<version> build N`（最可靠，跨文件优先）；
  //    ② BUILD_NUM / buildNum 构建号常量（dev/未折叠产物兜底）；
  //    ③ 宽松的 `build: N`（最后手段）。
  //    这样排在 store 前面的无关文件里即使有 `build: 1`，也抢不过后面
  //    store 里的融合字面量或 BUILD_NUM 常量。
  if (!build) {
    const texts = []
    let scanned = 0
    for (const e of entries) {
      if (!/\.(?:js(?:\.bin)?|bin|json)$/i.test(e.name)) continue
      if (e.name === 'manifest.json' || e.uncompressedSize > 16 * 1024 * 1024) continue
      if (scanned + e.uncompressedSize > MAX_SCAN_BYTES) break
      const buf = decodeEntry(buffer, e, 16 * 1024 * 1024)
      if (!buf) continue
      scanned += buf.length
      texts.push([e.name, text(buf)])
    }
    const tiers = [anchoredBuildRes(version), BUILD_CONST_RES, BUILD_LOOSE_RES]
    outer: for (const patterns of tiers) {
      for (const [name, src] of texts) {
        for (const re of patterns) {
          const m = src.match(re)
          if (!m) continue
          const n = Number(m[1])
          if (Number.isFinite(n) && n > 0) {
            build = Math.trunc(n)
            source = name
            break outer
          }
        }
      }
    }
  }

  // 3) 文件名兜底：`8000000000182376.0_2_0.amr` 只含版本，不含构建号；
  // 某些自定义流水线会写成 `...build172.amr`。
  if (!build) {
    const m = String(opts.name || '').match(/(?:build|b)[-_ ]?(\d{1,9})(?:\D|$)/i)
    if (m) {
      build = Number(m[1]) || 0
      if (build) source = 'filename'
    }
  }

  return {
    isAmr: true,
    version,
    build,
    appId,
    appName,
    source,
    entries: entries.length
  }
}

export { centralEntries as _centralEntries, extractBuildFromText as _extractBuildFromText }
