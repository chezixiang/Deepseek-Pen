// 附件协议适配 + 文件解析器 单元测试（node --test test/）。
//
// 覆盖：unzip / docx / pptx / xlsx / epub / rtf / html / pdf（含 ToUnicode
// 中文映射）的解析，normalizeMessageAttachments 的通道转换、截断、降级提示
// 与入参不可变性。
//
// 说明：ZIP fixture 用 store（不压缩）方式手工构造，足以覆盖网关侧
// unzip 的 central directory 解析路径；PDF fixture 用 deflate 压缩内容流，
// 覆盖 FlateDecode + Tj/TJ + ToUnicode CMap 主链路。

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import {
  unzip,
  extractDocx,
  extractPptx,
  extractXlsx,
  extractEpub,
  extractPdfText,
  rtfToText,
  htmlToText,
  extractFileText,
  decodeUtf8Strict
} from '../src/fileparse.js'
import {
  normalizeMessageAttachments,
  attachmentChannel,
  MAX_INLINE_CHARS
} from '../src/attachments.js'

// ---------- 测试辅助 ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 0)) >>> 0 : (c >>> 1) >>> 0
  return c >>> 0
})

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// 构造最小合法 ZIP（store 方式）
function makeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8) // method = store
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 10) // method = store
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cen, nameBuf]))
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cd, eocd])
}

// 构造最小 PDF：内容流（FlateDecode）+ ToUnicode CMap 流
function makePdf({ contentOps, bfchar }) {
  const content = zlib.deflateSync(Buffer.from(contentOps, 'latin1'))
  const obj1 = '1 0 obj\n<< /Length ' + content.length + ' /Filter /FlateDecode >>\nstream\n' +
    content.toString('latin1') + '\nendstream\nendobj\n'
  const cmapBody = '/CIDInit /ProcSet findresource begin\nbegincmap\n' +
    (bfchar || '') + '\nendcmap\nend'
  const obj2 = '2 0 obj\n<< /Length ' + cmapBody.length + ' >>\nstream\n' +
    cmapBody + '\nendstream\nendobj\n'
  return Buffer.from('%PDF-1.7\n' + obj1 + obj2 + 'trailer\n<< /Size 3 >>\n%%EOF\n', 'latin1')
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64')
}

function dataUrl(mime, s) {
  return 'data:' + mime + ';base64,' + b64(s)
}

// ---------- unzip / OOXML ----------

test('unzip 能解析 store 方式的 ZIP', () => {
  const zip = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/b.txt', data: 'world' }
  ])
  const files = unzip(zip)
  assert.equal(files.get('a.txt').toString(), 'hello')
  assert.equal(files.get('dir/b.txt').toString(), 'world')
})

test('extractDocx：段落分行、tab 分列、实体解码', () => {
  const docx = makeZip([{
    name: 'word/document.xml',
    data: '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>第一段 &amp; 更多</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>列一</w:t><w:tab/><w:t>列二</w:t></w:r></w:p>' +
      '</w:body></w:document>'
  }])
  const r = extractDocx(docx)
  assert.ok(r && r.text)
  assert.equal(r.text, '第一段 & 更多\n列一\t列二')
})

test('extractPptx：按页序拼接', () => {
  const pptx = makeZip([
    { name: 'ppt/slides/slide2.xml', data: '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:sld>' },
    { name: 'ppt/theme/theme1.xml', data: '<a:theme>不该出现</a:theme>' }
  ])
  const r = extractPptx(pptx)
  assert.ok(r && r.text)
  assert.equal(r.text, '第一页\n\n第二页')
})

test('extractXlsx：共享字符串 + 数值 + 内联字符串', () => {
  const xlsx = makeZip([
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>名称</t></si><si><t>数量</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>' +
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row><c r="A2" t="inlineStr"><is><t>苹果</t></is></c><c r="B2"><v>3</v></c></row>' +
      '</sheetData></worksheet>' }
  ])
  const r = extractXlsx(xlsx)
  assert.ok(r && r.text)
  assert.equal(r.text, '名称\t数量\n苹果\t3')
})

test('extractEpub：按文件名排序抽 HTML 文本', () => {
  const epub = makeZip([
    { name: 'OEBPS/ch2.xhtml', data: '<html><body><p>第二章</p></body></html>' },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><p>第一章</p></body></html>' },
    { name: 'mimetype', data: 'application/epub+zip' }
  ])
  const r = extractEpub(epub)
  assert.ok(r && r.text)
  assert.equal(r.text, '第一章\n\n第二章')
})

test('损坏的 ZIP 抛错，extractFileText 降级为 unsupported', () => {
  const garbage = Buffer.from('this is not a zip file at all......')
  assert.throws(() => unzip(garbage))
  const r = extractFileText('broken.docx', garbage)
  assert.equal(r.kind, 'unsupported')
  assert.ok(r.reason)
})

// ---------- RTF / HTML ----------

test('rtfToText：\\uN 十进制转义 + \\par 换行 + 控制字剥离', () => {
  // 你=20320(0x4F60) 好=22909(0x597D)，负数转义 -44501 → 65536-44501=21035(0x522B 别)
  const rtf = '{\\rtf1\\ansi\\deff0 Hello \\u20320?\\u22909?\\par World \\u-44501?}'
  const r = rtfToText(rtf)
  assert.ok(r && r.text)
  assert.equal(r.text, 'Hello 你好\nWorld 别')
})

test('rtfToText：跳过 fonttbl 等元数据组', () => {
  const rtf = '{\\rtf1{\\fonttbl{\\f0 SimSun;}}正文{\\*\\generator WorkBuddy}}'
  const r = rtfToText(rtf)
  assert.ok(r && r.text)
  assert.equal(r.text, '正文')
})

test('htmlToText：块级标签换行、实体、script 剔除', () => {
  const text = htmlToText('<div>标题</div><p>正文 &amp; 内容</p><script>var x=1;</script><p>末行</p>')
  assert.equal(text, '标题\n正文 & 内容\n末行')
})

// ---------- PDF ----------

test('extractPdfText：FlateDecode + 字面量 + ToUnicode 中文映射', () => {
  // <0041>→中(4E2D)、<0042>→文(6587)：内容流混排字面量与 CID 十六进制串
  const pdf = makePdf({
    contentOps: 'BT /F1 12 Tf (Hello ) Tj <00410042> Tj ( World) Tj ET',
    bfchar: '2 beginbfchar\n<0041> <4E2D>\n<0042> <6587>\nendbfchar'
  })
  const r = extractPdfText(pdf)
  assert.ok(r && r.text, '应能提取文本')
  assert.ok(r.text.indexOf('Hello 中文 World') >= 0, '实际：' + r.text)
})

test('extractPdfText：TJ 数组与大字距补空格', () => {
  const pdf = makePdf({
    contentOps: 'BT [(ab) 300 (cd)] TJ ET',
    bfchar: ''
  })
  const r = extractPdfText(pdf)
  assert.ok(r && r.text)
  assert.equal(r.text, 'ab cd')
})

test('extractPdfText：无文本层（扫描件）返回 null', () => {
  const pdf = makePdf({ contentOps: 'q 1 0 cm Q', bfchar: '' })
  assert.equal(extractPdfText(pdf), null)
})

test('extractPdfText：非 PDF 返回 null', () => {
  assert.equal(extractPdfText(Buffer.from('plain text, not a pdf')), null)
})

// ---------- decodeUtf8Strict ----------

test('decodeUtf8Strict：合法 UTF-8 通过，NUL/坏字节拒绝', () => {
  assert.equal(decodeUtf8Strict(Buffer.from('中文abc')), '中文abc')
  assert.equal(decodeUtf8Strict(Buffer.from([0x48, 0x00, 0x69])), null)
  assert.equal(decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0xfd])), null)
})

// ---------- extractFileText 分发 ----------

test('extractFileText：纯文本与代码文件（含 octet-stream MIME）', () => {
  const txt = extractFileText('note.txt', Buffer.from('笔记内容'))
  assert.equal(txt.kind, 'text')
  assert.equal(txt.text, '笔记内容')

  // 设备端 mimeOf 对未知扩展名落 application/octet-stream，靠 UTF-8 嗅探兜底
  const py = extractFileText('script.py', Buffer.from('print("hi")\n'))
  assert.equal(py.kind, 'text')
  assert.ok(py.text.indexOf('print') >= 0)
})

test('extractFileText：图片返回 image 通道', () => {
  const r = extractFileText('photo.png', Buffer.from([0x89, 0x50]))
  assert.equal(r.kind, 'image')
  assert.equal(r.mime, 'image/png')
})

test('extractFileText：旧版 Office 格式给出另存为提示', () => {
  const r = extractFileText('legacy.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
  assert.equal(r.kind, 'unsupported')
  assert.ok(r.reason.indexOf('DOCX') >= 0)
})

test('extractFileText：未知二进制格式 unsupported', () => {
  const r = extractFileText('data.bin', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x01]))
  assert.equal(r.kind, 'unsupported')
})

// ---------- normalizeMessageAttachments ----------

test('file 块（.png + octet-stream MIME）转 image_url 并纠正 MIME', () => {
  const msgs = [{
    role: 'user',
    content: [
      { type: 'text', text: '看看这张图' },
      { type: 'file', file: { filename: 'photo.png', file_data: dataUrl('application/octet-stream', 'pngdata') } }
    ]
  }]
  const out = normalizeMessageAttachments(msgs)
  assert.notEqual(out, msgs)
  assert.equal(out[0].content.length, 2)
  assert.deepEqual(out[0].content[0], { type: 'text', text: '看看这张图' })
  const img = out[0].content[1]
  assert.equal(img.type, 'image_url')
  assert.equal(img.image_url.url, 'data:image/png;base64,' + b64('pngdata'))
})

test('file 块（.txt）解码内联为 text，docx 走解析器', () => {
  const docx = makeZip([{
    name: 'word/document.xml',
    data: '<w:document><w:body><w:p><w:r><w:t>合同正文</w:t></w:r></w:p></w:body></w:document>'
  }])
  const msgs = [{
    role: 'user',
    content: [
      { type: 'file', file: { filename: '笔记.txt', file_data: dataUrl('text/plain', '纯文本内容') } },
      { type: 'file', file: { filename: '合同.docx', file_data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + docx.toString('base64') } }
    ]
  }]
  const out = normalizeMessageAttachments(msgs)
  const [t1, t2] = out[0].content
  assert.equal(t1.type, 'text')
  assert.ok(t1.text.indexOf('笔记.txt') >= 0)
  assert.ok(t1.text.indexOf('纯文本内容') >= 0)
  assert.equal(t2.type, 'text')
  assert.ok(t2.text.indexOf('合同.docx') >= 0)
  assert.ok(t2.text.indexOf('合同正文') >= 0)
})

test('file 块（.py + octet-stream）嗅探为文本', () => {
  const msgs = [{
    role: 'user',
    content: [{ type: 'file', file: { filename: 'main.py', file_data: dataUrl('application/octet-stream', 'def main():\n    pass\n') } }]
  }]
  const out = normalizeMessageAttachments(msgs)
  assert.equal(out[0].content[0].type, 'text')
  assert.ok(out[0].content[0].text.indexOf('def main()') >= 0)
})

test('无法解析的文件（扫描版 PDF）：说明进 system，用户问题保持干净', () => {
  const pdf = Buffer.from('%PDF-1.7\ntrailer\n<< /Size 1 >>\n%%EOF\n', 'latin1')
  const msgs = [{
    role: 'user',
    content: [
      { type: 'text', text: '分析' },
      { type: 'file', file: { filename: '扫描件.pdf', file_data: 'data:application/pdf;base64,' + pdf.toString('base64') } }
    ]
  }]
  const out = normalizeMessageAttachments(msgs)
  // 首条是 system 说明，而不是把「系统提示」塞进 user 内容
  assert.equal(out[0].role, 'system')
  assert.ok(out[0].content.indexOf('[附件状态]') === 0)
  assert.ok(out[0].content.indexOf('扫描件.pdf') >= 0)
  assert.ok(out[0].content.indexOf('扫描') >= 0)
  assert.ok(out[0].content.indexOf('不要猜测或编造') >= 0)
  // user 只剩原本那句「分析」：模型不会把提示文本当成问题来解读
  assert.deepEqual(out[1].content, [{ type: 'text', text: '分析' }])
})

test('只发文件不打字：补一句自然提问，不把空内容丢给上游', () => {
  const pdf = Buffer.from('%PDF-1.7\ntrailer\n<< /Size 1 >>\n%%EOF\n', 'latin1')
  const msgs = [{
    role: 'user',
    content: [{ type: 'file', file: { filename: '扫描件.pdf', file_data: 'data:application/pdf;base64,' + pdf.toString('base64') } }]
  }]
  const out = normalizeMessageAttachments(msgs)
  assert.equal(out[0].role, 'system')
  assert.equal(out[1].content.length, 1)
  assert.equal(out[1].content[0].type, 'text')
  assert.ok(out[1].content[0].text.indexOf('上传的文件') >= 0)
  assert.equal(out[1].content[0].text.indexOf('系统提示'), -1)
})

test('已有 system 时说明合并进同一条 system，不新增第二条', () => {
  const pdf = Buffer.from('%PDF-1.7\ntrailer\n<< /Size 1 >>\n%%EOF\n', 'latin1')
  const msgs = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,' + pdf.toString('base64') } }] }
  ]
  const out = normalizeMessageAttachments(msgs)
  assert.equal(out.filter((m) => m.role === 'system').length, 1)
  assert.ok(out[0].content.indexOf('你是助手') === 0)
  assert.ok(out[0].content.indexOf('[附件状态]') > 0)
})

test('超长文本截断：正文留在 user，截断说明进 system', () => {
  const big = 'a'.repeat(MAX_INLINE_CHARS + 5000)
  const msgs = [{
    role: 'user',
    content: [{ type: 'file', file: { filename: 'big.txt', file_data: dataUrl('text/plain', big) } }]
  }]
  const out = normalizeMessageAttachments(msgs)
  const p = out[1].content[0]
  assert.equal(p.type, 'text')
  assert.ok(p.text.indexOf('big.txt') >= 0)
  assert.ok(p.text.length < MAX_INLINE_CHARS + 500)
  assert.ok(out[0].content.indexOf('已截断') >= 0)
})

test('缺 file_data / 畸形 data URL 降级为 system 说明', () => {
  const msgs = [{
    role: 'user',
    content: [
      { type: 'text', text: '看看' },
      { type: 'file', file: { filename: '空的.txt', file_data: '' } },
      { type: 'file', file: { filename: '畸形.png', file_data: 'data:image/png' } },
      { type: 'file', file: { filename: '只有id.pdf', file_id: 'file-xyz' } }
    ]
  }]
  const out = normalizeMessageAttachments(msgs)
  assert.equal(out[0].role, 'system')
  for (const name of ['空的.txt', '畸形.png', '只有id.pdf']) {
    assert.ok(out[0].content.indexOf(name) >= 0, name)
  }
  assert.deepEqual(out[1].content, [{ type: 'text', text: '看看' }])
})

test('入参不被修改；无 file 块时返回原数组', () => {
  const before = JSON.stringify(msgsFixture())
  const msgs = JSON.parse(before)
  normalizeMessageAttachments(msgs)
  assert.equal(JSON.stringify(msgs), before)

  const plain = [{ role: 'user', content: '你好' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]
  assert.equal(normalizeMessageAttachments(plain), plain)
})

test('单块转换异常不拖垮整个请求', () => {
  const msgs = [{
    role: 'user',
    content: [
      { type: 'file', file: { filename: '合同.docx', file_data: dataUrl('application/octet-stream', 'not a zip') } },
      { type: 'text', text: '继续聊' }
    ]
  }]
  const out = normalizeMessageAttachments(msgs)
  assert.equal(out[0].role, 'system')
  assert.ok(out[0].content.indexOf('合同.docx') >= 0)
  assert.deepEqual(out[1].content, [{ type: 'text', text: '继续聊' }])
})

test('attachmentChannel 通道判定', () => {
  assert.equal(attachmentChannel('a.png', 'application/octet-stream'), 'image')
  assert.equal(attachmentChannel('a.jpg', ''), 'image')
  assert.equal(attachmentChannel('a.pdf', ''), 'document')
  assert.equal(attachmentChannel('a.xlsx', 'application/octet-stream'), 'document')
  assert.equal(attachmentChannel('a.txt', 'text/plain'), 'text')
  assert.equal(attachmentChannel('a.weird', 'application/octet-stream'), 'sniff')
})

function msgsFixture() {
  // 仅供 immutability 测试的模板源（会被 JSON 序列化两份）
  return [{
    role: 'user',
    content: [
      { type: 'text', text: '带附件' },
      { type: 'file', file: { filename: 'a.txt', file_data: dataUrl('text/plain', '内容') } }
    ]
  }]
}
