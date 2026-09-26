// 轻量 Markdown 渲染：把模型返回的 Markdown 文本解析成适合词典笔 Falcon UI 的块结构。
// 不引入第三方库，只覆盖常见语法：标题、段落、列表（含 GFM 任务项）、表格、
// 代码块、引用、分隔线，以及行内粗体/斜体/粗斜体/删除线/链接/行内代码。
//
// 数学公式：设备上没有 KaTeX/MathJax 可用的运行时（Falcon 只有 <text> 节点，无 web 视图），
// 因此 LaTeX 在**显示层**转成 Unicode 纯文本（见 latexToText），不再整段照抄源码。

// ---------- LaTeX → Unicode 纯文本 ----------
// 只做显示转换：消息原文保持不变（发送给模型的历史仍是用户/模型原本的 LaTeX）。
const TEX_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆', circ: '∘',
  bullet: '•', oplus: '⊕', otimes: '⊗', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', equiv: '≡', approx: '≈', sim: '∼', simeq: '≃', propto: '∝',
  ll: '≪', gg: '≫', llbracket: '⟦', rrlbracket: '⟧',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄',
  emptyset: '∅', varnothing: '∅', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', implies: '⟹',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', oint: '∮',
  angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  quad: ' ', qquad: '  ', ':': ' ', ';': ' ', '!': '', ',': ' ', '%': '%',
  '{': '{', '}': '}', '_': '_', '&': '&', '#': '#', '$': '$',
  degree: '°', celsius: '°C', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ'
}

// 上下标字符表：只有能映射成真实 Unicode 的字符才升/降位，其余回退成 ^( ) 形式
const TEX_SUP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷',
  '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  n: 'ⁿ', i: 'ⁱ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ',
  j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ',
  v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', ' ': ' '
}
const TEX_SUB = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇',
  '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ',
  o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', ' ': ' '
}

function mapScript(chars, table) {
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (table[c] === undefined) return null
    out += table[c]
  }
  return out
}

// 解析 {…}（含嵌套一层）或单个字符，返回 [内容, 消耗长度]
function readGroup(src, start) {
  if (src[start] !== '{') {
    return [src[start] === undefined ? '' : src[start], 1]
  }
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return [src.slice(start + 1, i), i - start + 1]
    }
  }
  return [src.slice(start + 1), src.length - start] // 未闭合：吃到结尾
}

// 分数：\frac{a}{b} → a/b；含空格/运算符的分子分母加括号
function renderFrac(num, den) {
  const wrap = (s) => (/^[\w\u4e00-\u9fffα-ωΑ-Ω]+$/.test(s) ? s : '(' + s + ')')
  return wrap(num) + '/' + wrap(den)
}

/**
 * 把 LaTeX 源转成可读的 Unicode 纯文本（显示层用）。
 * 覆盖：$…$ / $$…$$ / \(…\) / \[…\] 定界、常用符号命令、\frac、\sqrt、
 * 上下标、\text 系列包壳；未识别的命令去掉反斜杠保留名字，不吞内容。
 */
export function latexToText(text) {
  let s = String(text === undefined || text === null ? '' : text)
  if (!s) return s
  // 快路：既没有 LaTeX 记号也没有上下标时原样返回（绝大多数消息走这条）
  if (s.indexOf('\\') < 0 && s.indexOf('$') < 0 && s.indexOf('^') < 0 && s.indexOf('_') < 0) {
    return s
  }

  s = s.replace(/\$\$([\s\S]+?)\$\$/g, ' $1 ')
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, ' $1 ')
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, ' $1 ')
  // 行内 $…$：内侧紧贴空白的、或以反斜杠结尾的（多半是货币/转义美元）保持原样。
  // 不用后行断言（lookbehind）——设备端 QuickJS 版本较旧，不保证支持。
  s = s.replace(/\$([^$\n]+)\$/g, (m, inner) => {
    if (/^\s|\s$/.test(inner) || /\\$/.test(inner)) return m
    return inner
  })

  // 环境与参数类命令：\begin{…}/\end{…} 只去壳保留内容
  s = s.replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, ' ')
  // 文本包壳先去壳：\frac{\text{距离}}{\text{时间}} 必须先变成 \frac{距离}{时间}，
  // 否则嵌套花括号让 frac 的正则匹配不上，\frac 会被当成未知命令原样留下。
  s = s.replace(/\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mathsf|mathtt|operatorname|textnormal|mbox)\s*\{([^{}]*)\}/g, '$1')
  s = s.replace(/\\(?:d|t)?frac\s*\{/g, '\\frac{')
  let prev = null
  while (prev !== s) {
    prev = s
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) => renderFrac(a, b))
    s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (m, n, x) => '√[' + n + '](' + x + ')')
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, x) => '√(' + x + ')')
  }
  // \left \right 这类尺寸修饰直接去掉（定界符本身保留）
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|textstyle|limits|nolimits)\b/g, '')

  // 换行与符号命令**先**做：这样上下标的内容已经是最终字符（\to → →），
  // 下面是单遍处理，不会把回退形式 _(...) 再当成下标啃一遍。
  s = s.replace(/\\\\/g, '\n')
  s = s.replace(/\\([A-Za-z]+)/g, (m, name) => (TEX_SYMBOLS[name] !== undefined ? TEX_SYMBOLS[name] : name))
  s = s.replace(/\\([^A-Za-z\s])/g, (m, ch) => (TEX_SYMBOLS[ch] !== undefined ? TEX_SYMBOLS[ch] : ch))

  // 上标/下标：
  //  - 花括号形式（^{…} / _{…}）是明确的 LaTeX，直接转换；
  //  - 裸上标 ^2 风险低（普通文本里 ^ 几乎只出现在公式里），照常转换，
  //    于是 E=mc^2、m^2x 都能正常显示；
  //  - 裸下标 _i 风险高（snake_case、my_file.txt 这类标识符很常见），
  //    因此只在"底数前是分隔符、且下标是单个字符"时才转换：x_i、∫_0 会转，
  //    my_file、snake_case_v2 原样保留。
  s = s.replace(/\^\{([^{}]*)\}/g, (m, body) => {
    const mapped = mapScript(body, TEX_SUP)
    return mapped === null ? '^(' + body + ')' : mapped
  })
  s = s.replace(/([^\s])\^([A-Za-z0-9]+)(?![A-Za-z0-9])/g, (m, base, body) => {
    const mapped = mapScript(body, TEX_SUP)
    return base + (mapped === null ? '^(' + body + ')' : mapped)
  })
  s = s.replace(/_\{([^{}]*)\}/g, (m, body) => {
    const mapped = mapScript(body, TEX_SUB)
    return mapped === null ? '_(' + body + ')' : mapped
  })
  s = s.replace(/(^|[^A-Za-z0-9_])([\w\u0370-\u03ff\u2200-\u22ff])_([A-Za-z0-9])(?![A-Za-z0-9])/g,
    (m, pre, base, body) => {
      const mapped = mapScript(body, TEX_SUB)
      return pre + base + (mapped === null ? '_(' + body + ')' : mapped)
    })

  // 去掉残余的分组花括号（保留内容），并压掉公式两侧多余空格
  s = s.replace(/[{}]/g, '')
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s
}

// ---------- 数学段切分（交给设备原生 <latex> 真排版） ----------
// 词典笔固件自带 clatexmath 排版引擎，Falcon 的 <richtext> 里可以用 <latex value="…">
// 渲染真正的数学排版（分式、求和号、根式都是排出来的，不是 Unicode 近似）。
//
// 这里把文本切成 [{ text, math }]：math 段是**裸 LaTeX**（定界符已剥离），其余是普通
// 文本。定界符识别与「货币不当公式」的判据必须与 latexToText 保持一致——两边不一致
// 会出现「预览是美元、发出去变公式」这类前后不一致的显示。
export function splitMathSegments(text) {
  const src = String(text === undefined || text === null ? '' : text)
  if (!src) return []
  // 快路：没有任何定界符时整段都是普通文本（绝大多数消息走这条）
  if (src.indexOf('$') < 0 && src.indexOf('\\(') < 0 && src.indexOf('\\[') < 0) {
    return [{ text: src, math: false }]
  }

  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+)\$/g
  const segs = []
  let last = 0
  let m = null
  while ((m = re.exec(src))) {
    // $…$ 内侧紧贴空白的、或以反斜杠结尾的：多半是货币/转义美元，留给文本管线
    if (m[4] !== undefined && (/^\s/.test(m[4]) || /\s$/.test(m[4]) || /\\$/.test(m[4]))) {
      continue
    }
    const body = m[1] !== undefined ? m[1]
      : m[2] !== undefined ? m[2]
        : m[3] !== undefined ? m[3] : m[4]
    if (m.index > last) segs.push({ text: src.slice(last, m.index), math: false })
    segs.push({ text: String(body).trim(), math: true })
    last = m.index + m[0].length
  }
  if (last < src.length) segs.push({ text: src.slice(last), math: false })
  if (segs.length === 0) segs.push({ text: src, math: false })
  return segs
}

/**
 * 公式是否适合交给原生 <latex> 排版。
 *
 * 两个限制来自真机实测（X7 Pro，宽 896px，字号 30 / 信息字号 20）：
 *  1. **超长会截断而不是换行**——实测约 50 字符在 896px 内刚好排满，再长右侧被裁掉。
 *     宁可退回 Unicode（会换行、内容完整）也不要显示半截公式。
 *  2. **残括号不渲染**——`\frac{a}{` 这类中间态输出空（0×0）。所以只在定稿后排版，
 *     流式过程中仍走 Unicode，避免边打字边闪没。
 * 花括号必须配平、不能为空，否则同上会渲染成空白。
 */
export const MATH_TYPESET_MAX = 48

export function canTypesetMath(latex) {
  const s = String(latex === undefined || latex === null ? '' : latex).trim()
  if (!s || s.length > MATH_TYPESET_MAX) return false
  return bracesBalanced(s)
}

/**
 * 花括号是否配平。不配平的 LaTeX（流式中间态 `\frac{a}{`、或模型笔误）交给原生排版
 * 会渲染成**空白**，交给 latexToText 又会把 `\frac` 啃成 `frac` 拼出 `fraca` 这种
 * 误导性文本。调用方据此**原样展示源码**——短暂、诚实，也不会静默丢内容。
 */
export function bracesBalanced(latex) {
  const s = String(latex === undefined || latex === null ? '' : latex)
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

// 解析块级 Markdown
// 水平空白折叠（[ \t]{2,} → ' '）只对非代码块的文本做：旧版在解析前对全文
// 折叠，把代码块的缩进全部压掉——不仅显示错，缩进还会随消息持久化、作为
// 历史回传给模型（丢语义）。代码块内保留原文。
function collapseHorizontal(s) {
  return String(s).replace(/[ \t]{2,}/g, ' ')
}

// ---------- 表格（GFM 管道表格） ----------
// 结构：表头行 + 分隔行（| --- | :---: |）+ 任意数据行。
// 分隔行是表格的"确认信号"：流式输出中表头先到、分隔行未到时保持原样段落，
// 分隔行一到整体升级为表格——宁可持续几秒显示带竖线的原文，不显示半截表。

// 拆一行表格为单元格：去首尾围栏竖线后按 | 切分，\| 转义还原成字面竖线。
// 允许不写首尾竖线（GFM 宽松写法 `a | b`），所以"含竖线"即可尝试。
function splitTableRow(line) {
  let s = String(line).trim()
  if (s.charAt(0) === '|') s = s.slice(1)
  if (s.charAt(s.length - 1) === '|' && s.length > 0) s = s.slice(0, -1)
  const cells = []
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '\\' && s.charAt(i + 1) === '|') {
      buf += '|'
      i++
    } else if (c === '|') {
      cells.push(buf.trim())
      buf = ''
    } else {
      buf += c
    }
  }
  cells.push(buf.trim())
  return cells
}

// 分隔行：每个单元格形如 ---、:---、---:、:---:（至少一个短横）
function isTableDivider(line) {
  const cells = splitTableRow(line)
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-{1,}:?$/.test(c))
}

// 从分隔行读列对齐方式（缺省 left），与表头一一对应
function parseAlignments(line) {
  return splitTableRow(line).map((c) => {
    const left = c.charAt(0) === ':'
    const right = c.charAt(c.length - 1) === ':'
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

export function markdownToBlocks(text) {
  // 兜底：清洗可能残留的内部协议标签，防止标签从 Markdown 渲染层泄漏。
  // 只清洗标签、不折叠空白——折叠交给下方逐块处理（代码块豁免，见 collapseHorizontal）。
  text = String(text || '').replace(/<\|tool_calls_begin\|>/gi, '')
  text = text.replace(/<\|tool_calls_end\|>/gi, '')
  text = text.replace(/<invoke>/gi, '')
  text = text.replace(/<\/invoke>/gi, '')
  text = text.replace(/<parameter>/gi, '')
  text = text.replace(/<\/parameter>/gi, '')

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let listType = null
  let listItems = []
  let listStart = 1
  // 任务列表状态（'done'/'open'/null=普通项），与 listItems 一一对应。
  // 只有列表里真的出现任务项才随块携带，普通列表不背多余字段。
  let listTasks = []

  const flushList = () => {
    if (listType) {
      const block = { type: 'list', ordered: listType === 'ol', items: listItems.slice() }
      if (listType === 'ol' && listStart !== 1) block.start = listStart
      if (listTasks.some((t) => t)) block.taskStates = listTasks.slice()
      blocks.push(block)
      listType = null
      listItems = []
      listStart = 1
      listTasks = []
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

    // 独立成块的公式（display）：$$…$$ 与 \[…\]，支持跨行与单行两种写法。
    // 渲染成居中的块级公式；过长或括号不配平时由渲染层退回 Unicode 段落。
    if (/^(\$\$|\\\[)$/.test(trimmed)) {
      flushList()
      const body = []
      i++
      while (i < lines.length && !/^(\$\$|\\\])$/.test(lines[i].trim())) {
        body.push(lines[i])
        i++
      }
      i++ // 跳过结束定界符
      const tex = body.join('\n').trim()
      if (tex) blocks.push({ type: 'math', text: tex })
      continue
    }
    const single = trimmed.match(/^(\$\$|\\\[)([\s\S]+?)(\$\$|\\\])$/)
    if (single) {
      flushList()
      blocks.push({ type: 'math', text: single[2].trim() })
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
      blocks.push({ type: 'h' + h[1].length, text: collapseHorizontal(h[2]) })
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

    // 引用：连续 > 行合并为一块（内部换行保留），旧版逐行成块会在视觉上断成多段
    if (trimmed.indexOf('>') === 0) {
      flushList()
      const quoteLines = [trimmed.replace(/^>\s?/, '')]
      i++
      while (i < lines.length && lines[i].trim().indexOf('>') === 0) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: collapseHorizontal(quoteLines.join('\n')) })
      continue
    }

    // 表格：当前行含竖线、且下一行是分隔行（分隔行齐了才算表格，见上方说明）
    if (trimmed.indexOf('|') >= 0 && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushList()
      const header = splitTableRow(trimmed)
      const align = parseAlignments(lines[i + 1])
      const rows = []
      i += 2
      while (i < lines.length) {
        const row = lines[i].trim()
        // 空行 / 不含竖线 / 开新围栏：表格结束（围栏优先，防止吃进后面的代码块）
        if (!row || row.indexOf('|') < 0 || /^(`{3,}|~{3,})/.test(row)) break
        rows.push(splitTableRow(row))
        i++
      }
      // 列数以表头为准：短行补空、长行截断，保证每行列数一致（渲染层按列等分）
      const width = header.length
      blocks.push({
        type: 'table',
        align,
        header,
        rows: rows.map((r) => {
          const cells = r.slice(0, width)
          while (cells.length < width) cells.push('')
          return cells
        })
      })
      continue
    }

    // 无序/有序列表；无序列表支持 GFM 任务项 `- [ ]` / `- [x]`
    const ul = trimmed.match(/^[-*+]\s+(.*)$/)
    const ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/)
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      let item = (ul ? ul[1] : ol[2]).trim()
      let taskState = null
      if (ul) {
        const task = item.match(/^\[([ xX])\]\s*(.*)$/)
        if (task) {
          taskState = task[1] === ' ' ? 'open' : 'done'
          item = task[2]
        }
      }
      if (listType !== kind) {
        flushList()
        listType = kind
        // 有序列表记录首项序号：模型写 "3. 4." 就从 3 数起，不重置成 1
        listStart = ol ? (parseInt(ol[1], 10) || 1) : 1
      }
      listItems.push(collapseHorizontal(item))
      listTasks.push(taskState)
      i++
      continue
    }

    flushList()
    blocks.push({ type: 'p', text: collapseHorizontal(line) })
    i++
  }
  flushList()
  return blocks
}

// 解析行内 Markdown：返回 [{ text, bold?, italic?, strike?, code?, link? }]
// LaTeX 在**非行内代码**的片段上转成 Unicode（行内代码里的反斜杠是代码，不能动）。
//
// 强调定界符要求内侧非空、且紧贴非空白（CommonMark 规则）：旧版 \*[^*]+\*
// 会把 "3 * 4 * 5" 里的 "* 4 *" 当斜体吞掉星号；只要求非空又会把 "**" 当
// 空斜体。只用先行断言 (?!\s)，不用后行断言——设备端 QuickJS 不保证支持 lookbehind。
//
// 分支顺序即正则顺序：*** 必须先于 ** 尝试，否则 "***x***" 会被双星规则
// 从第 2 个字符起啃成 "斜体+尾巴"；链接 [..](..) 的括号内不含空白，
// 带 title 的写法解析不了就整段保持字面（不吞字）。
export function inlineSpans(text) {
  const spans = []
  const src = String(text || '')
  const re = /(\*\*\*(?!\s)[^*]*[^*\s]\*\*\*|\*\*(?!\s)[^*]*[^*\s]\*\*|\*(?!\s)[^*]*[^*\s]\*|~~(?!\s)[^~]*[^~\s]~~|`[^`]+`|\[[^\]\n]+\]\([^)\s]*\))/g
  let last = 0
  let m = null

  while ((m = re.exec(src))) {
    if (m.index > last) {
      spans.push({ text: latexToText(src.slice(last, m.index)) })
    }
    const token = m[0]
    if (token.indexOf('***') === 0) {
      spans.push({ text: latexToText(token.slice(3, -3)), bold: true, italic: true })
    } else if (token.indexOf('**') === 0 && token.slice(-2) === '**') {
      spans.push({ text: latexToText(token.slice(2, -2)), bold: true })
    } else if (token.indexOf('~~') === 0 && token.slice(-2) === '~~') {
      spans.push({ text: latexToText(token.slice(2, -2)), strike: true })
    } else if (token.indexOf('`') === 0 && token.slice(-1) === '`') {
      spans.push({ text: token.slice(1, -1), code: true })
    } else if (token.charAt(0) === '[') {
      const link = token.match(/^\[([^\]]+)\]\(([^)]*)\)$/)
      if (link) {
        // 链接只显示文字（设备无浏览器，URL 上屏又长又乱）；原文不动
        spans.push({ text: latexToText(link[1]), link: link[2] })
      } else {
        spans.push({ text: latexToText(token) })
      }
    } else {
      spans.push({ text: latexToText(token.slice(1, -1)), italic: true })
    }
    last = m.index + token.length
  }
  if (last < src.length) {
    spans.push({ text: latexToText(src.slice(last)) })
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
