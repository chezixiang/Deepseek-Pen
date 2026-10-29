// 附件协议适配：ds-free-api 私有内容块 → DeepSeek 官方 OpenAI 兼容 API。
//
// 背景：客户端（词典笔 App）沿用了已废弃的 ds-free-api 私有协议，在 user
// 消息里发 { type: 'file', file: { filename, file_data } }。官方 API 没有
// 文档上传通道（Files API 仅收图片），该内容块原样透传会被上游网关以
// 400「请求内容不合法」拒绝（2026-10-28 生产 audit.log 实证）。
//
// 转换策略（在网关侧真正解析文件内容，而不是丢弃）：
// - 图片 png/jpeg/gif/webp → image_url 内容块（官方原生支持 base64 data
//   URL；设备端 mimeOf 对图片落 octet-stream，故按扩展名判定并纠正 MIME）
// - 纯文本/代码 → base64 解码内联为 text 内容块
// - pdf/docx/pptx/xlsx/epub/rtf → fileparse.js 解析出正文文本
// - 真正无法解析的格式 → 不塞进 user 内容，改为**一条 system 说明**（见下）
//
// 为什么"无法解析"必须走 system 而不是 user 内容块：
//   旧实现把「[系统提示：用户上传了附件 X，但服务端无法解析…请如实告知用户…]」
//   当成 user 的第二个 text 块发出去。模型（实测 gpt-6.1-sol）会把它当成
//   "用户贴过来的一段提示文本"，于是回答"这段提示的意思是…合适的回复可以是…"，
//   完全跑偏（2026-10-29 线上截图实证）。放到 system 里它才是真正的背景约束：
//   用户的问题保持不变，模型把"这个附件读不到"当成事实而不是任务。
//
// 约束：不改入参（返回新数组/新消息对象）；单文件内联文本超过
// MAX_INLINE_CHARS 截断并注明；转换过程任何异常都降级为提示，
// 保证聊天主链路永不因附件而 5xx。

import { extractFileText, imageMimeFor, extOfName } from './fileparse.js'

// 单文件内联文本上限（字符）：设备端单文件 ≤1.5MB，此处防的是
// 解压爆炸与上下文/费用失控，150K 字符对文档摘要类场景足够宽裕
export const MAX_INLINE_CHARS = 150000

// 附件状态说明的前缀：一眼能看出这是网关补的背景信息，不是用户的提问
const NOTE_PREFIX = '[附件状态] '

// 无法解析时，用户一个字都没打（只发了个文件）的兜底提问。
// 不能用"（附件已上传）"这种半句话——模型会接着复述它；给一句自然的请求，
// 配合 system 里的说明，答案才是"我读不了这个文件，你可以这样给我"。
const FALLBACK_ASK = '请看一下我上传的文件。'

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|csv|sql|rtf))/i

function labelOf(name) {
  return name ? '「' + name + '」' : '（未命名文件）'
}

// 单条"读不到"的原因文本，供汇总进 system
function noticeText(name, reason) {
  return labelOf(name) + ' 无法解析：' + reason
}

// 解析成功的正文包装。措辞刻意保持"陈述"而非"指令"：
// 旧版 "[以下是用户上传的附件…的解析内容]" 的方括号前缀在部分模型上
// 会被当成待解释的引用块。
function wrapFileText(name, content) {
  return { type: 'text', text: '（用户上传的附件' + (name ? '「' + name + '」' : '') + '内容如下）\n\n' + content }
}

// data URL → { mime, buf }；兼容裸 base64（无 data: 前缀，MIME 按扩展名判）
function parseFileData(dataUrl, name) {
  const s = String(dataUrl || '')
  const m = /^data:([^;,]*?)((?:;[^;,]*?)*),([\s\S]*)$/.exec(s)
  if (m) {
    const mime = (m[1] || '').toLowerCase()
    const b64 = m[3].replace(/\s+/g, '')
    return { mime, buf: Buffer.from(b64, 'base64') }
  }
  // 裸 base64 兜底（客户端不会发这种形态；含任何非 base64 字符一律拒绝，
  // 防止把畸形 data URL 当 base64 解出垃圾字节）
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) return null
  const b64 = s.replace(/\s+/g, '')
  if (!b64) return null
  return { mime: '', buf: Buffer.from(b64, 'base64') }
}

// 单个 file 内容块 → { parts: 官方可接受的内容块数组（可空）, notes: 需要进 system 的说明 }
function convertFilePart(part) {
  const file = (part && part.file) || {}
  const name = String(file.filename || file.name || '未命名文件')
  const dataUrl = file.file_data || file.data || ''
  if (!dataUrl) return { parts: [], notes: [noticeText(name, '缺少文件数据（file_data）')] }

  const parsed = parseFileData(dataUrl, name)
  if (!parsed || !parsed.buf || parsed.buf.length === 0) {
    return { parts: [], notes: [noticeText(name, '文件数据为空或 base64 无法解码')] }
  }
  // 单文件解码后上限（请求体整体另有 bodyLimitBytes 兜底）；客户端约定 1.5MB，
  // 这里防的是绕过客户端的直接调用
  if (parsed.buf.length > 4 * 1024 * 1024) {
    return { parts: [], notes: [noticeText(name, '文件过大（超过 4MB 上限），请压缩后重试')] }
  }

  // 1) 图片：扩展名优先（设备端 MIME 表不含图片，.png 会标成 octet-stream）
  const imgMime = imageMimeFor(name, parsed.mime)
  if (imgMime) {
    return {
      parts: [{ type: 'image_url', image_url: { url: 'data:' + imgMime + ';base64,' + parsed.buf.toString('base64') } }],
      notes: []
    }
  }

  // 2) 文档/文本：按扩展名分发解析
  let result
  try {
    result = extractFileText(name, parsed.buf)
  } catch (e) {
    result = { kind: 'unsupported', reason: '解析器异常（' + ((e && e.message) || 'unknown') + '）' }
  }
  if (result && result.kind === 'text') {
    const text = String(result.text || '')
    if (text.length > MAX_INLINE_CHARS) {
      return {
        parts: [wrapFileText(name, text.slice(0, MAX_INLINE_CHARS))],
        notes: [labelOf(name) + ' 内容过长，只保留前 ' + MAX_INLINE_CHARS + ' 字符，其余已截断']
      }
    }
    return { parts: [wrapFileText(name, text)], notes: [] }
  }
  if (result && result.kind === 'unsupported') {
    return { parts: [], notes: [noticeText(name, result.reason)] }
  }
  // 兜底：未知返回形态
  return { parts: [], notes: [noticeText(name, '无法识别的解析结果')] }
}

/**
 * 把「读不到附件」的说明合并进 system 消息（没有 system 就在最前面新建一条）。
 * 说明放在 system 末尾：既在模型注意力的有效区间，又不会被当成用户的问题。
 */
function withAttachmentNotes(messages, notes) {
  if (!notes.length) return messages
  const text = NOTE_PREFIX + notes.join('；') +
    '。若用户要求分析这些文件，请说明当前读不到其中的内容，并建议导出为 CSV / SQL / Excel 等可读格式后重发；不要猜测或编造文件内容。'
  const list = messages.slice()
  let sysIndex = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].role === 'system') { sysIndex = i; break }
  }
  if (sysIndex >= 0) {
    const cur = list[sysIndex]
    // system 内容也可能是内容块数组（OpenAI 允许）：追加一个 text 块，别覆盖
    if (Array.isArray(cur.content)) {
      list[sysIndex] = Object.assign({}, cur, { content: cur.content.concat([{ type: 'text', text }]) })
    } else {
      const prev = typeof cur.content === 'string' ? cur.content : ''
      list[sysIndex] = Object.assign({}, cur, { content: prev ? prev + '\n\n' + text : text })
    }
  } else {
    list.unshift({ role: 'system', content: text })
  }
  return list
}

/**
 * 把 messages 里的 ds-free-api 私有 file 内容块转换为上游可接受的形态。
 * 非数组 content、text/image_url 块原样保留；无 file 块的消息返回原对象。
 * 无法解析的附件不进 user 内容，改写成一条 system 说明（见文件头注释）。
 * @returns {Array} 新消息数组（不修改入参）
 */
export function normalizeMessageAttachments(messages) {
  if (!Array.isArray(messages)) return messages
  const out = new Array(messages.length)
  const notes = []
  let changed = false
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || !Array.isArray(msg.content) || !msg.content.some((p) => p && p.type === 'file')) {
      out[i] = msg
      continue
    }
    changed = true
    const parts = []
    for (const p of msg.content) {
      if (p && p.type === 'file') {
        try {
          const r = convertFilePart(p)
          for (const part of r.parts) parts.push(part)
          for (const note of r.notes) notes.push(note)
        } catch (e) {
          // 单块异常不拖垮整个请求
          notes.push(noticeText(String((p && p.file && (p.file.filename || p.file.name)) || ''), '处理附件时发生内部错误'))
        }
      } else {
        parts.push(p)
      }
    }
    // 只发了文件、正文为空：补一句自然的请求，别把空内容丢给上游
    if (!parts.length) parts.push({ type: 'text', text: FALLBACK_ASK })
    out[i] = Object.assign({}, msg, { content: parts })
  }
  return changed ? withAttachmentNotes(out, notes) : messages
}

// 供测试与运维观测：判定一个文件名按网关策略会走哪条通道
export function attachmentChannel(name, mime) {
  if (imageMimeFor(name, mime || '')) return 'image'
  const ext = extOfName(name)
  if (ext === 'pdf' || ext === 'docx' || ext === 'pptx' || ext === 'xlsx' ||
      ext === 'epub' || ext === 'rtf') return 'document'
  if (TEXT_MIME_RE.test(String(mime || ''))) return 'text'
  return 'sniff'
}
