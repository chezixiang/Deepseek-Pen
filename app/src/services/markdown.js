// 轻量 Markdown 渲染：把模型返回的 Markdown 文本解析成适合词典笔 Falcon UI 的块结构。
// 不引入第三方库，只覆盖常见语法：标题、段落、列表、代码块、引用、分隔线、粗体/斜体/行内代码。

// 解析块级 Markdown
export function markdownToBlocks(text) {
  // 兜底：清洗可能残留的内部协议标签，防止标签从 Markdown 渲染层泄漏。
  // 只折叠水平空白（[ \t]），保留换行——旧版 /\s{2,}/g 会吞掉空行导致段落黏连（#14）。
  text = String(text || '').replace(/<\|tool_calls_begin\|>/gi, '')
  text = text.replace(/<\|tool_calls_end\|>/gi, '')
  text = text.replace(/<invoke>/gi, '')
  text = text.replace(/<\/invoke>/gi, '')
  text = text.replace(/<parameter>/gi, '')
  text = text.replace(/<\/parameter>/gi, '')
  text = text.replace(/[ \t]{2,}/g, ' ')

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let listType = null
  let listItems = []

  const flushList = () => {
    if (listType) {
      blocks.push({ type: 'list', ordered: listType === 'ol', items: listItems.slice() })
      listType = null
      listItems = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      flushList()
      i++
      continue
    }

    // 围栏代码块 ``` / ~~~
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      flushList()
      const fence = trimmed.match(/^(`{3,}|~{3,})/)[1]
      const codeLines = []
      i++
      while (i < lines.length && lines[i].indexOf(fence) !== 0) {
        codeLines.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
      blocks.push({ type: 'code', text: codeLines.join('\n') })
      continue
    }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushList()
      blocks.push({ type: 'h' + h[1].length, text: h[2] })
      i++
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushList()
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // 引用
    if (trimmed.indexOf('>') === 0) {
      flushList()
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') })
      i++
      continue
    }

    // 无序/有序列表
    const ul = trimmed.match(/^[-*+]\s+(.*)$/)
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (listType !== kind) {
        flushList()
        listType = kind
      }
      listItems.push((ul ? ul[1] : ol[1]).trim())
      i++
      continue
    }

    flushList()
    blocks.push({ type: 'p', text: line })
    i++
  }
  flushList()
  return blocks
}

// 解析行内 Markdown：返回 [{ text, bold?, italic?, code? }]
export function inlineSpans(text) {
  const spans = []
  const src = String(text || '')
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let m = null

  while ((m = re.exec(src))) {
    if (m.index > last) {
      spans.push({ text: src.slice(last, m.index) })
    }
    const token = m[0]
    if (token.indexOf('**') === 0 && token.slice(-2) === '**') {
      spans.push({ text: token.slice(2, -2), bold: true })
    } else if (token.indexOf('`') === 0 && token.slice(-1) === '`') {
      spans.push({ text: token.slice(1, -1), code: true })
    } else {
      spans.push({ text: token.slice(1, -1), italic: true })
    }
    last = m.index + token.length
  }
  if (last < src.length) {
    spans.push({ text: src.slice(last) })
  }
  if (spans.length === 0) {
    spans.push({ text: src })
  }
  return spans
}

// ---------- Emoji 区段拆分（配合可选下载的 NotoColorEmoji 字体） ----------
// 设备缺 emoji 字形时显示白块；把 emoji 字符拆成独立 run 并指定 emoji 字体渲染。
const EMOJI_RANGES = [
  [0x2190, 0x21FF], // 箭头
  [0x2300, 0x23FF], // 杂项技术
  [0x25A0, 0x27BF], // 几何图形/杂项符号/印刷符号
  [0x2900, 0x297F], // 补充箭头
  [0x2B00, 0x2BFF], // 杂项符号和箭头
  [0x1F000, 0x1FAFF], // emoji 主区
  [0xFE00, 0xFE0F], // 变体选择符
  [0x200D, 0x200D] // 零宽连接符
]

function isEmojiCp(cp) {
  for (let i = 0; i < EMOJI_RANGES.length; i++) {
    if (cp >= EMOJI_RANGES[i][0] && cp <= EMOJI_RANGES[i][1]) return true
  }
  return false
}

/**
 * 把文本切成 [{ t: '片段', e: 是否emoji }]，供模板对 emoji 片段套用字体。
 * ZWJ/变体选择符在前一个字符是 emoji 时并入 emoji 段。
 */
export function splitEmojiRuns(text) {
  const src = String(text || '')
  if (!src) return [{ t: '', e: false }]
  const runs = []
  let buf = ''
  let bufEmoji = false
  let i = 0
  while (i < src.length) {
    const code = src.charCodeAt(i)
    let cp = code
    let advance = 1
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < src.length) {
      const lo = src.charCodeAt(i + 1)
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = (code - 0xD800) * 0x400 + (lo - 0xDC00) + 0x10000
        advance = 2
      }
    }
    const emoji = isEmojiCp(cp) || ((cp === 0x200D || cp === 0xFE0F) && bufEmoji)
    if (emoji === bufEmoji) {
      buf += src.substr(i, advance)
    } else {
      if (buf) runs.push({ t: buf, e: bufEmoji })
      buf = src.substr(i, advance)
      bufEmoji = emoji
    }
    i += advance
  }
  if (buf) runs.push({ t: buf, e: bufEmoji })
  return runs
}
