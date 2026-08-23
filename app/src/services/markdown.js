// 轻量 Markdown 渲染：把模型返回的 Markdown 文本解析成适合词典笔 Falcon UI 的块结构。
// 不引入第三方库，只覆盖常见语法：标题、段落、列表、代码块、引用、分隔线、粗体/斜体/行内代码。

// 解析块级 Markdown
export function markdownToBlocks(text) {
  // 兜底：清洗可能残留的内部协议标签，防止标签从 Markdown 渲染层泄漏
  text = String(text || '').replace(/<\|tool_calls_begin\|>/gi, ' ')
  text = text.replace(/<\|tool_calls_end\|>/gi, ' ')
  text = text.replace(/<invoke>/gi, ' ')
  text = text.replace(/<\/invoke>/gi, ' ')
  text = text.replace(/<parameter>/gi, ' ')
  text = text.replace(/<\/parameter>/gi, ' ')
  text = text.replace(/\s{2,}/g, ' ')

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
