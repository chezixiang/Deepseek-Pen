// 聊天气泡布局的确定性辅助函数。
// Falcon 对原生文本节点和父气泡的高度有缓存；定稿内容替换后需用稳定 key 让旧节点失效，
// 表格/长回复也按同一规则判定为长消息，供滚动锚点选择使用。

export function layoutFingerprint(value) {
  const text = String(value == null ? '' : value)
  // 双 32-bit 哈希覆盖全文，保证同长度但内容不同的回复会得到不同的渲染 key。
  // Math.imul 是 ES6 标准整数乘法，适用于本项目 QuickJS runtime。
  let h1 = 2166136261
  let h2 = 5381
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0
    h2 = (Math.imul(h2, 33) ^ code) >>> 0
  }
  h1 = Math.imul(h1 ^ text.length, 16777619) >>> 0
  h2 = (Math.imul(h2, 33) ^ text.length) >>> 0
  return h1.toString(36) + h2.toString(36)
}

export function messageRenderKey(message) {
  if (!message) return 'msg-empty'
  const base = String(message.id || '') + ':' + (message.renderEpoch || 0)
  if (message.role === 'assistant' && !message.pending) {
    const content = String(message.content || '') + '\n' + String(message.reasoning || '') + '\n' + String(message.error || '')
    return base + ':f' + content.length + '-' + layoutFingerprint(content)
  }
  return base
}

export function isTallMessage(message) {
  if (!message) return false
  const content = String(message.content || '')
  const reasoning = String(message.reasoning || '')
  if (content.length > 300 || reasoning.length > 300) return true
  if (/\|\s*:?-{2,}/.test(content)) return true // GFM 表格分隔行
  if (Array.isArray(message.toolCalls) && message.toolCalls.length >= 2) return true
  return false
}

// ---------- 长回复分气泡（chunk） ----------
// 真机实证（build 196~198）：一条回复渲染成单棵超高 bubble 子树时，这台 Falcon
// 引擎量高/滚动范围会失效（尾部滚不到、行边界裁字）；而「很多个正常高度的消息」
// 是消息列表天天在跑的可靠形态。这里把 markdown 块按估算高度切成若干组，
// 每组渲染成独立气泡；超长表格按数据行切分、续段重复表头。
const CHUNK_MAX_HEIGHT = 700
const CHUNK_TABLE_ROWS = 5
// 气泡内容宽：936 × 80%（bubble max-width）− 28（左右 padding 14×2）≈ 720
const CHUNK_CONTENT_WIDTH = 720
// 单元格行高：lines 保底 3 行（build 198 真机确认的防裁形态）+ 上下 padding 12 + 边框
const CHUNK_CELL_ROW_HEIGHT = 3 * 28 + 12 + 1

// 估算文本渲染宽度（px）：CJK 按全宽 21、ASCII 按半宽 12——两个系数都刻意
// 偏大，保证估算宽度 ≥ 实际宽度，行数估算只会多不会少（多=留白，少=裁字）。
export function estimateTextWidth(text) {
  const s = String(text == null ? '' : text)
  let w = 0
  for (let i = 0; i < s.length; i++) {
    w += s.charCodeAt(i) > 0xff ? 21 : 12
  }
  return w
}

// 表格单元格文本的 lines 值：按等分列宽估算行数，保底 3（与 build 198 行为一致）。
// 列宽 = (内容宽 − 每列左右 padding 8×2 × 列数) / 列数。
export function cellLineCount(plainText, colCount) {
  const cols = Math.max(1, Number(colCount) || 1)
  const colWidth = Math.max(64, (CHUNK_CONTENT_WIDTH - cols * 16) / cols)
  return Math.max(3, Math.ceil(estimateTextWidth(plainText) / colWidth))
}

// 单个 markdown 块的估算高度（px）。粗略即可——只用于决定分组的切割点。
export function estimateBlockHeight(block) {
  if (!block || !block.type) return 34
  switch (block.type) {
    case 'p':
      return Math.max(1, Math.ceil(estimateTextWidth(block.text) / CHUNK_CONTENT_WIDTH)) * 28 + 12
    case 'code':
      return String(block.text || '').split('\n').length * 26 + 16 + 12
    case 'list':
      return (block.items || []).reduce((sum, item) =>
        sum + Math.max(1, Math.ceil(estimateTextWidth(item) / (CHUNK_CONTENT_WIDTH - 28))) * 28, 0) + 12
    case 'quote':
      return Math.max(1, Math.ceil(estimateTextWidth(block.text) / CHUNK_CONTENT_WIDTH)) * 28 + 8 + 12
    case 'math':
      return 52
    case 'hr':
      return 28 + 12
    case 'table':
      return ((block.rows || []).length + 1) * CHUNK_CELL_ROW_HEIGHT + 8
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return Math.max(1, Math.ceil(estimateTextWidth(block.text) / CHUNK_CONTENT_WIDTH)) * 30 + 10
    default:
      return 34
  }
}

// 超长表格按数据行切分；每个续段都带上表头（列对齐等字段原样保留）。
export function splitTableBlock(block) {
  const rows = Array.isArray(block.rows) ? block.rows : []
  if (rows.length <= CHUNK_TABLE_ROWS) return [block]
  const pieces = []
  for (let i = 0; i < rows.length; i += CHUNK_TABLE_ROWS) {
    pieces.push(Object.assign({}, block, { rows: rows.slice(i, i + CHUNK_TABLE_ROWS) }))
  }
  return pieces
}

// 把 markdown 块数组切成若干组，每组估算高度不超过 CHUNK_MAX_HEIGHT。
// 表格先按行拆成段，再当作普通块参与分组；单段超限（一行放不下）时独立成组。
export function chunkMarkdownBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const chunks = []
  let current = []
  let currentHeight = 0
  for (let i = 0; i < list.length; i++) {
    const pieces = list[i] && list[i].type === 'table' ? splitTableBlock(list[i]) : [list[i]]
    for (let p = 0; p < pieces.length; p++) {
      const height = estimateBlockHeight(pieces[p])
      if (current.length && currentHeight + height > CHUNK_MAX_HEIGHT) {
        chunks.push(current)
        current = []
        currentHeight = 0
      }
      current.push(pieces[p])
      currentHeight += height
    }
  }
  if (current.length) chunks.push(current)
  return chunks
}
