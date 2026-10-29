// 文件内容解析器（零依赖，Node 内置 zlib）。
//
// 网关收到设备上传的 file_data（data URL）后，把常见文档格式解析成纯文本，
// 让模型真正读到内容，而不是把二进制原样塞给上游（官方 API 没有
// 文档上传通道，原样透传会被 400 拒绝）或简单丢弃。
//
// 覆盖范围与策略：
// - docx/pptx/xlsx：ZIP + XML 结构，手写 ZIP 读取（local header + central
//   directory + inflateRaw）+ 正则抽文本，覆盖绝大多数真实文件
// - epub：ZIP 内 xhtml/html 按文件名排序抽文本（不做 OPF spine 精确排序）
// - pdf：扫描全部 stream，FlateDecode 解压后按 Tj/TJ/'/" 文本算子提取，
//   ToUnicode CMap（bfchar/bfrange）做 CID→Unicode 映射（中文 PDF 关键路径）；
//   无文本层（扫描件）时返回 null，由上层给出明确提示
// - html/xml、rtf、纯文本/代码：标签剥离 / 控制字剥离 / 严格 UTF-8 嗅探
//
// 所有解析函数约定：成功返回 { text, truncated? }，格式不支持返回 null，
// 文件损坏抛 Error（由调用方捕获降级）。文本一律经过 cleanup() 规整，
// 调用方负责按 MAX_TEXT_CHARS 截断。

import zlib from 'node:zlib'

// ---------- 通用工具 ----------

// XML/HTML 命名实体（覆盖文档常见集合，其余原样保留）
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  middot: '·', laquo: '«', raquo: '»', deg: '°', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶'
}

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g) => {
    if (g[0] === '#') {
      let code
      if (g[1] === 'x' || g[1] === 'X') code = parseInt(g.slice(2), 16)
      else code = parseInt(g.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    const named = NAMED_ENTITIES[g.toLowerCase()]
    return named !== undefined ? named : m
  })
}

// 规整抽取结果：统一换行、压多余空行、去行尾空白
export function cleanup(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 严格 UTF-8 解码；含 NUL 或解码失败视为二进制，返回 null
export function decodeUtf8Strict(buf) {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    if (s.indexOf('\u0000') >= 0) return null
    return s
  } catch (e) {
    return null
  }
}

// ---------- ZIP 读取（docx/pptx/xlsx/epub 用） ----------

// 解析 ZIP central directory，返回 Map<entryName, Buffer>。
// 只支持 store/deflate；zip64、加密、分卷直接抛错（设备上传 ≤1.5MB，不会遇到）。
export function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('zip: 文件太小')
  let eocd = -1
  const scanFrom = Math.max(0, buf.length - 22 - 65536)
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (p + 46 > buf.length) throw new Error('zip: central directory 越界')
  const files = new Map()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const cmtLen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + cmtLen
    if (compSize === 0xffffffff || lho === 0xffffffff) throw new Error('zip: 不支持 zip64')
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip: local header 损坏')
    const lNameLen = buf.readUInt16LE(lho + 26)
    const lExtraLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error('zip: 数据越界')
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error('zip: 不支持的压缩方法 ' + method)
    files.set(name, data)
  }
  if (!files.size) throw new Error('zip: 无条目')
  return files
}

function entryNameNum(name) {
  const m = /(\d+)/.exec(name)
  return m ? parseInt(m[1], 10) : 0
}

// ---------- OOXML（docx/pptx/xlsx） ----------

// 抽取一段 XML 里某标签的文本序列（含属性形式 <t attr>xx</t>）
function xmlTexts(s, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g')
  const out = []
  let m
  while ((m = re.exec(s))) out.push(decodeEntities(m[1]))
  return out
}

// word/document.xml：段落 </w:p> 分行，w:t 文本 + w:tab/w:br
export function extractDocx(buf) {
  const files = unzip(buf)
  const xml = files.get('word/document.xml')
  if (!xml) return null
  const s = xml.toString('utf8')
  const paras = s.split(/<\/w:p>/)
  const lines = []
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g
  for (const para of paras) {
    let line = ''
    let m
    re.lastIndex = 0
    while ((m = re.exec(para))) {
      if (m[1] !== undefined) line += decodeEntities(m[1])
      else if (m[0].indexOf('<w:tab') === 0) line += '\t'
      else line += '\n'
    }
    lines.push(line)
  }
  const text = cleanup(lines.join('\n'))
  return text ? { text } : null
}

// ppt/slides/slideN.xml：按页序，<a:p> 分段，<a:t> 文本
export function extractPptx(buf) {
  const files = unzip(buf)
  const slides = Array.from(files.keys())
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => entryNameNum(a) - entryNameNum(b))
  if (!slides.length) return null
  const pages = []
  for (const name of slides) {
    const s = files.get(name).toString('utf8')
    const paras = s.split(/<\/a:p>/)
    const lines = []
    for (const para of paras) {
      const runs = xmlTexts(para, 'a:t')
      const line = runs.join('')
      if (line.trim()) lines.push(line.trim())
    }
    if (lines.length) pages.push(lines.join('\n'))
  }
  const text = cleanup(pages.join('\n\n'))
  return text ? { text } : null
}

// xl/sharedStrings.xml + worksheets/sheetN.xml：单元格制表符分列、行换行。
// 共享字符串/内联字符串/数值与布尔缓存值；公式取缓存结果。
export function extractXlsx(buf) {
  const files = unzip(buf)
  const sheets = Array.from(files.keys())
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => entryNameNum(a) - entryNameNum(b))
  if (!sheets.length) return null
  // 共享字符串表
  const shared = []
  const sstXml = files.get('xl/sharedStrings.xml')
  if (sstXml) {
    const s = sstXml.toString('utf8')
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
    let m
    while ((m = re.exec(s))) {
      const runs = xmlTexts(m[1], 't')
      shared.push(runs.join(''))
    }
  }
  const tables = []
  for (const name of sheets) {
    const s = files.get(name).toString('utf8')
    const rows = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rowRe.exec(s))) {
      const cells = []
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
      let cm
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || ''
        const body = cm[2] || ''
        const tm = /\bt="([^"]*)"/.exec(attrs)
        const type = tm ? tm[1] : 'n'
        if (type === 's') {
          const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
          const idx = vm ? parseInt(decodeEntities(vm[1]), 10) : -1
          cells.push(idx >= 0 && idx < shared.length ? shared[idx] : '')
        } else if (type === 'inlineStr') {
          cells.push(xmlTexts(body, 't').join(''))
        } else if (type === 'b') {
          const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
          cells.push(vm && vm[1].trim() === '1' ? 'TRUE' : 'FALSE')
        } else {
          const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
          if (vm) cells.push(decodeEntities(vm[1]).trim())
        }
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'))
    }
    if (rows.length) tables.push(rows.join('\n'))
  }
  const text = cleanup(tables.join('\n\n'))
  return text ? { text } : null
}

// epub：ZIP 内所有 xhtml/html 抽文本，按文件名排序拼接
export function extractEpub(buf) {
  const files = unzip(buf)
  const pages = Array.from(files.keys())
    .filter((n) => /\.(xhtml|html|htm)$/i.test(n))
    .sort()
  if (!pages.length) return null
  const parts = []
  for (const name of pages) parts.push(htmlToText(files.get(name).toString('utf8')))
  const text = cleanup(parts.join('\n\n'))
  return text ? { text } : null
}

// ---------- HTML / RTF ----------

export function htmlToText(s) {
  let out = String(s)
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  out = out.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  out = out.replace(/<br\b[^>]*\/?>/gi, '\n')
  out = out.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
  out = out.replace(/<[^>]+>/g, ' ')
  out = decodeEntities(out)
  out = out.replace(/[ \t]*\n[ \t]*/g, '\n')
  return cleanup(out)
}

// RTF：剥离控制字/分组，处理 \'hh 字节与 \uN Unicode 转义。\par/\line → 换行。
export function rtfToText(s) {
  const src = String(s)
  let out = ''
  // 跳过策略：{\*\...} 目标组与 fonttbl/colortbl 等元数据组整组丢弃
  const SKIP_GROUP = /^\{\s*\\\*|^\{\s*\\(fonttbl|colortbl|stylesheet|info|pict|object|themedata|datastore|listtable|listoverridetable|rsidtbl|generator)\b/
  let i = 0
  let depth = 0
  const skipAt = [] // 每层深度进入时是否在跳过组内
  let skipping = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      depth++
      skipAt[depth] = skipping
      if (SKIP_GROUP.test(src.slice(i, i + 64))) skipping = true
      i++
      continue
    }
    if (ch === '}') {
      skipping = depth > 0 ? !!skipAt[depth] : false
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (ch === '\\') {
      const n = src[i + 1]
      // 转义符号 \\ \{ \}
      if (n === '\\' || n === '{' || n === '}') {
        if (!skipping) out += n
        i += 2
        continue
      }
      // \'hh 单字节
      if (n === "'") {
        const byte = parseInt(src.slice(i + 2, i + 4), 16)
        if (Number.isFinite(byte) && !skipping) out += String.fromCharCode(byte)
        i += 4
        continue
      }
      // 控制字 \word[数字][空格]（\uN 亦属此形，N 为十进制码元）
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i))
      if (m) {
        const word = m[1]
        if (!skipping) {
          if (word === 'par' || word === 'line') out += '\n'
          else if (word === 'tab') out += '\t'
        }
        i += m[0].length
        if (word === 'u' && m[2] !== undefined) {
          let code = parseInt(m[2], 10)
          if (code < 0) code += 65536
          if (!skipping && code > 0 && code <= 0xffff) out += String.fromCharCode(code)
          // \uN 后紧跟一个替补字符（通常 ?），跳过
          if (src[i] && src[i] !== '\\' && src[i] !== '{' && src[i] !== '}') i++
        }
        continue
      }
      // 其余单字符控制符号（\* \~ \- 等）直接吞掉
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') { i++; continue }
    if (!skipping && ch !== '\0') out += ch
    i++
  }
  const text = cleanup(out)
  return text ? { text } : null
}

// ---------- PDF ----------

// ToUnicode CMap：bfchar / bfrange（<lo> <hi> <dst> 与数组两种形式）
function parseCMap(text) {
  const map = new Map()
  // 目标十六进制 → UTF-16BE 码元序列
  const hexToStr = (hex) => {
    const h = hex.replace(/[^0-9a-fA-F]/g, '')
    let s = ''
    for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
    return s
  }
  const setHex = (keyHex, valHex) => {
    const key = parseInt(keyHex, 16)
    if (!Number.isFinite(key)) return
    if (!map.has(key)) map.set(key, hexToStr(valHex))
  }
  let m
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  while ((m = bfchar.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let r
    while ((r = re.exec(m[1]))) setHex(r[1], r[2])
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = bfrange.exec(text))) {
    const reA = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let r
    while ((r = reA.exec(m[1]))) {
      const lo = parseInt(r[1], 16)
      const hi = parseInt(r[2], 16)
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue
      const base = parseInt(r[3], 16)
      for (let c = lo; c <= hi; c++) {
        if (!map.has(c)) map.set(c, String.fromCodePoint(base + (c - lo)))
      }
    }
    const reB = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g
    while ((r = reB.exec(m[1]))) {
      const lo = parseInt(r[1], 16)
      const hi = parseInt(r[2], 16)
      const dsts = r[3].match(/<[0-9a-fA-F]+>/g) || []
      for (let c = lo; c <= hi && c - lo < dsts.length; c++) {
        if (!map.has(c)) map.set(c, hexToStr(dsts[c - lo].slice(1, -1)))
      }
    }
  }
  return map
}

// 字面量字符串 (...)：转义 + 括号配平，返回 latin1 字节
function readLiteral(s, i) {
  let depth = 1
  const out = []
  let j = i + 1
  while (j < s.length && depth > 0) {
    const ch = s[j]
    if (ch === '\\') {
      const n = s[j + 1]
      if (n === 'n') { out.push('\n'); j += 2 }
      else if (n === 'r') { out.push('\r'); j += 2 }
      else if (n === 't') { out.push('\t'); j += 2 }
      else if (n === 'b' || n === 'f') { out.push(n === 'b' ? '\b' : '\f'); j += 2 }
      else if (n >= '0' && n <= '7') {
        let oct = ''
        let k = j + 1
        while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') { oct += s[k]; k++ }
        out.push(String.fromCharCode(parseInt(oct, 8) & 0xff))
        j = k
      } else if (n === '\r') { j += (s[j + 2] === '\n' ? 3 : 2) }
      else if (n === '\n') { j += 2 }
      else { out.push(n); j += 2 }
    } else if (ch === '(') { depth++; out.push(ch); j++ }
    else if (ch === ')') {
      depth--
      if (depth > 0) out.push(ch)
      j++
    } else { out.push(ch); j++ }
  }
  return { bytes: Buffer.from(out.join(''), 'latin1'), next: j }
}

function hexToBytes(hex) {
  const h = hex.replace(/[^0-9a-fA-F]/g, '')
  const padded = h.length % 2 ? h + '0' : h
  return Buffer.from(padded, 'hex')
}

// 用 ToUnicode 表解码字节串：先试 2 字节（CID 字体），命中率不足再试
// 1 字节（简单字体），仍不足回退 latin1 —— 同一文档常同时含 ASCII 字面量
// 与 CID 十六进制串，单一全局映射必须带覆盖率回退，否则一边会把另一边清空。
function decodeViaMap(bytes, map) {
  if (!map || !map.size) return bytes.toString('latin1')
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let out2 = ''
    let hits2 = 0
    for (let i = 0; i < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1]
      const s = map.get(code)
      if (s !== undefined) { out2 += s; hits2++ } else out2 += '\uFFFD'
    }
    if (hits2 / (bytes.length / 2) >= 0.5) return out2.replace(/\uFFFD/g, '')
  }
  let out1 = ''
  let hits1 = 0
  for (let i = 0; i < bytes.length; i++) {
    const s = map.get(bytes[i])
    if (s !== undefined) { out1 += s; hits1++ } else out1 += '\uFFFD'
  }
  if (hits1 / bytes.length >= 0.5) return out1.replace(/\uFFFD/g, '')
  return bytes.toString('latin1')
}

// 内容流文本算子扫描：字符串操作数原样收，TJ 数组内大位移补空格，
// ' " T* Td TD ET 视为换行；内联图片 BI...ID...EI 的二进制跳过。
function decodeContentStream(text, uni) {
  let out = ''
  let i = 0
  let inArray = false
  const len = text.length
  while (i < len) {
    const c = text[i]
    if (c === '(') {
      const lit = readLiteral(text, i)
      out += decodeViaMap(lit.bytes, uni)
      i = lit.next
      continue
    }
    if (c === '<') {
      if (text[i + 1] === '<') { i += 2; continue }
      const j = text.indexOf('>', i + 1)
      if (j < 0) break
      out += decodeViaMap(hexToBytes(text.slice(i + 1, j)), uni)
      i = j + 1
      continue
    }
    if (c === '[') { inArray = true; i++; continue }
    if (c === ']') { inArray = false; i++; continue }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '/' || c === '{' || c === '}') { i++; continue }
    // token
    const rest = text.slice(i, i + 64)
    const tm = /^(-?\d*\.?\d+|[A-Za-z'"*]+)/.exec(rest)
    if (!tm) { i++; continue }
    const tok = tm[1]
    i += tm[0].length
    if (/^-?\d*\.?\d+$/.test(tok)) {
      // TJ 数组里的字距调整：明显右移视为词间空格
      const v = parseFloat(tok)
      if (inArray && v >= 100) out += ' '
      continue
    }
    if (tok === "'" || tok === '"') out += '\n'
    else if (tok === 'T*' || tok === 'Td' || tok === 'TD' || tok === 'ET') out += '\n'
    else if (tok === 'BI') {
      // 内联图片：跳到 EI（尽力而为）
      const ei = text.indexOf('EI', i)
      i = ei < 0 ? len : ei + 2
    }
  }
  return out
}

// 主入口：返回 { text } 或 null（无文本层/损坏）。尽力而为，不追求完备。
export function extractPdfText(buf) {
  if (!buf || buf.length < 8) return null
  const head = buf.subarray(0, 1024).toString('latin1')
  if (head.indexOf('%PDF') < 0) return null
  const raw = buf.toString('latin1')
  const uni = new Map()
  const chunks = []
  // 逐个 "N G obj ... endobj" 扫描
  const objRe = /\d+\s+\d+\s+obj\b/g
  let m
  while ((m = objRe.exec(raw))) {
    const bodyStart = m.index + m[0].length
    const bodyEnd = raw.indexOf('endobj', bodyStart)
    if (bodyEnd < 0) break
    const body = raw.slice(bodyStart, bodyEnd)
    objRe.lastIndex = bodyEnd
    const streamKw = body.indexOf('stream')
    if (streamKw < 0) continue
    const dict = body.slice(0, streamKw)
    if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(dict)) continue
    let data = null
    let dataStart = streamKw + 'stream'.length
    if (body[dataStart] === '\r') dataStart++
    if (body[dataStart] === '\n') dataStart++
    const endKw = body.indexOf('endstream', dataStart)
    if (endKw < 0) continue
    const slice = Buffer.from(body.slice(dataStart, endKw), 'latin1')
    if (/\/FlateDecode\b/.test(dict)) {
      try { data = zlib.inflateSync(slice) } catch (e) {
        try { data = zlib.inflateRawSync(slice) } catch (e2) { data = null }
      }
    } else if (!/\/Filter\b/.test(dict)) {
      data = slice
    }
    if (!data) continue
    const text = data.toString('latin1')
    if (text.indexOf('beginbfchar') >= 0 || text.indexOf('beginbfrange') >= 0) {
      // ToUnicode CMap：合入全局映射（首个命中优先）
      for (const [k, v] of parseCMap(text)) if (!uni.has(k)) uni.set(k, v)
      continue
    }
    if (/\bBT\b/.test(text) && /\bT[jJ]\b/.test(text)) chunks.push(text)
  }
  if (!chunks.length) return null
  let out = ''
  for (const c of chunks) {
    out += decodeContentStream(c, uni)
    if (out.length > 4 * 1024 * 1024) break
  }
  const text = cleanup(out)
  // 提取结果过短视为失败（扫描件/纯图片 PDF）
  if (!text || text.replace(/\s/g, '').length < 2) return null
  return { text }
}

// ---------- 分发入口 ----------

const IMAGE_EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp'
}
const IMAGE_MIME = new Set(Object.values(IMAGE_EXT_MIME))

// 明确按纯文本解析的扩展名（其余交给 UTF-8 嗅探兜底）
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'html', 'htm',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'sql',
  'py', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'c', 'h', 'cpp', 'hpp', 'cc',
  'java', 'kt', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'bat', 'ps1',
  'css', 'scss', 'less', 'vue', 'swift', 'lua', 'pl', 'r', 'm', 'srt', 'vtt', 'lrc'
])

export function extOfName(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  return i >= 0 ? s.slice(i + 1).toLowerCase() : ''
}

export function imageMimeFor(name, mime) {
  const ext = extOfName(name)
  if (IMAGE_EXT_MIME[ext]) return IMAGE_EXT_MIME[ext]
  const m = String(mime || '').toLowerCase()
  return IMAGE_MIME.has(m) ? m : null
}

/**
 * 按扩展名/MIME 分发解析。返回：
 *   { kind: 'image', mime }           可走视觉通道
 *   { kind: 'text', text }            解析出的纯文本
 *   { kind: 'unsupported', reason }   无法解析（上层生成明确提示）
 * @param {string} name 文件名
 * @param {Buffer} buf  原始字节
 */
export function extractFileText(name, buf) {
  const ext = extOfName(name)
  if (imageMimeFor(name, '')) return { kind: 'image', mime: IMAGE_EXT_MIME[ext] }
  switch (ext) {
    case 'pdf': {
      const r = extractPdfText(buf)
      if (r && r.text) return { kind: 'text', text: r.text }
      return { kind: 'unsupported', reason: '未能从 PDF 中提取到文本（可能是扫描版/图片型或加密 PDF）' }
    }
    case 'docx': {
      const r = safe(() => extractDocx(buf))
      if (r && r.text) return { kind: 'text', text: r.text }
      return { kind: 'unsupported', reason: r === undefined ? 'DOCX 文件损坏' : '不是有效的 DOCX 文件或文档为空' }
    }
    case 'pptx': {
      const r = safe(() => extractPptx(buf))
      if (r && r.text) return { kind: 'text', text: r.text }
      return { kind: 'unsupported', reason: r === undefined ? 'PPTX 文件损坏' : '不是有效的 PPTX 文件或内容为空' }
    }
    case 'xlsx': {
      const r = safe(() => extractXlsx(buf))
      if (r && r.text) return { kind: 'text', text: r.text }
      return { kind: 'unsupported', reason: r === undefined ? 'XLSX 文件损坏' : '不是有效的 XLSX 文件或内容为空' }
    }
    case 'epub': {
      const r = safe(() => extractEpub(buf))
      if (r && r.text) return { kind: 'text', text: r.text }
      return { kind: 'unsupported', reason: r === undefined ? 'EPUB 文件损坏' : '不是有效的 EPUB 文件或内容为空' }
    }
    case 'rtf': {
      const r = safe(() => rtfToText(buf.toString('latin1')))
      if (r && r.text) return { kind: 'text', text: r.text }
      return { kind: 'unsupported', reason: 'RTF 文件损坏或内容为空' }
    }
    case 'doc':
    case 'xls':
    case 'ppt':
      return { kind: 'unsupported', reason: '旧版 Office 二进制格式暂不支持自动解析，请另存为 ' + ext.toUpperCase() + 'X 或 PDF 后重发' }
    default: {
      // 文本扩展名或未知格式：严格 UTF-8 嗅探（无 NUL），命中即文本
      const s = decodeUtf8Strict(buf)
      if (s !== null && (TEXT_EXT.has(ext) || looksTextLike(s))) {
        return { kind: 'text', text: s.replace(/^\uFEFF/, '') }
      }
      return { kind: 'unsupported', reason: '该文件格式（.' + (ext || '未知') + '）暂不支持自动解析' }
    }
  }
}

function safe(fn) {
  try { return fn() } catch (e) { return undefined }
}

// 嗅探：可打印字符占比足够高才当文本（控制字符仅放行 \t\n\f\v）
function looksTextLike(s) {
  if (!s) return false
  const sample = s.slice(0, 4096)
  let printable = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code === 9 || code === 10 || code === 13 || code === 12 || code === 11 ||
        (code >= 32 && code !== 127)) printable++
  }
  return printable / sample.length >= 0.9
}
