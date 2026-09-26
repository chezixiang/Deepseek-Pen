// LaTeX 显示层转换的回归用例
// 运行：cd app && node scripts/test-latex.mjs
import { latexToText, inlineSpans, markdownToBlocks } from '../src/services/markdown.js'

const cases = [
  // 定界符
  ['行内公式 \\(E = mc^2\\) 结束', '行内公式 E = mc² 结束'],
  ['$\\frac{a}{b}$ 分数', 'a/b 分数'],
  ['$$\\sqrt{x^2+y^2}$$', ' √(x²+y²) '],
  ['\\[\\sum_{i=1}^{n} i\\]', ' ∑ᵢ₌₁ⁿ i '],
  // 符号表
  ['\\alpha\\beta\\gamma \\le \\ge \\ne', 'αβγ ≤ ≥ ≠'],
  ['\\pi r^2 面积', 'π r² 面积'],
  ['积分 \\int_0^1 x\\,dx', '积分 ∫₀¹ x dx'],
  // 分式 / 根式
  ['\\frac{a+b}{c}', '(a+b)/c'],
  ['\\frac{\\text{距离}}{\\text{时间}}', '距离/时间'],
  ['\\text{速度} = \\frac{\\text{距离}}{\\text{时间}}', '速度 = 距离/时间'],
  ['\\left( \\frac{1}{2} \\right)', '( 1/2 )'],
  ['\\sqrt[3]{x}', '√[3](x)'],
  // 上下标边界
  ['x^2 + y^{10} + z_i', 'x² + y¹⁰ + zᵢ'],
  ['\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', 'lim_(x → 0) (sin x)/x = 1'],
  // 不该被改动的普通文本
  ['价格 $100 和 $200', '价格 $100 和 $200'],
  ['普通文本没有公式', '普通文本没有公式'],
  ['文件名 my_file.txt 不变', '文件名 my_file.txt 不变'],
  ['颜文字 ^_^ 不变', '颜文字 ^_^ 不变'],
  ['公式 m^2x 转换', '公式 m²ˣ 转换'],
  ['下标 snake_case_v2 保持', '下标 snake_case_v2 保持'],
  // 多行公式
  ['\\begin{cases} a \\\\ b \\end{cases}', ' a \n b ']
]

let fail = 0
for (const [input, want] of cases) {
  const got = latexToText(input)
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(input) + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// 行内代码里的反斜杠是代码，不能被转换
const spans = inlineSpans('use `\\frac{a}{b}` here')
const codeSpan = spans.find((s) => s.code)
const codeOk = !!codeSpan && codeSpan.text === '\\frac{a}{b}'
console.log((codeOk ? 'PASS' : 'FAIL') + '  行内代码保持原样 => ' + JSON.stringify(spans))
if (!codeOk) fail += 1

// 普通行内文本里的公式要被转换（inlineSpans 是渲染路径）
const spans2 = inlineSpans('结果是 $x^2$ 哦')
const inlineOk = spans2.map((s) => s.text).join('') === '结果是 x² 哦'
console.log((inlineOk ? 'PASS' : 'FAIL') + '  行进文本公式 => ' + JSON.stringify(spans2))
if (!inlineOk) fail += 1

// $$ 独占一行的公式块：渲染为块级公式（type='math'，内容为裸 LaTeX）
const blocks = markdownToBlocks('$$\nx^2\n$$')
const blockOk = blocks.length === 1 && blocks[0].type === 'math' && blocks[0].text === 'x^2'
console.log((blockOk ? 'PASS' : 'FAIL') + '  多行公式定界符 => ' + JSON.stringify(blocks))
if (!blockOk) fail += 1

// \[…\] 单行块级公式
const b2 = markdownToBlocks('\\[\\frac{a}{b}\\]')
const b2Ok = b2.length === 1 && b2[0].type === 'math' && b2[0].text === '\\frac{a}{b}'
console.log((b2Ok ? 'PASS' : 'FAIL') + '  单行 \\[\\] 块公式 => ' + JSON.stringify(b2))
if (!b2Ok) fail += 1

// ---------- 数学段切分（原生 <latex> 排版路径） ----------
import { splitMathSegments, canTypesetMath, bracesBalanced, MATH_TYPESET_MAX } from '../src/services/markdown.js'

function segsOf(s) {
  return splitMathSegments(s).map((x) => (x.math ? 'M:' + x.text : 'T:' + x.text))
}

const segCases = [
  // 行内公式被切成 math 段，定界符剥离
  ['勾股定理 $a^2+b^2=c^2$ 成立', ['T:勾股定理 ', 'M:a^2+b^2=c^2', 'T: 成立']],
  // 多个公式
  ['$x$ 与 $y$', ['M:x', 'T: 与 ', 'M:y']],
  // \(…\) 与 $$…$$ 也认
  ['值为 \\(x^2\\) 哦', ['T:值为 ', 'M:x^2', 'T: 哦']],
  ['$$x^2$$', ['M:x^2']],
  // 货币：内侧贴空白 / 以反斜杠结尾 → 不当公式（与 latexToText 判据一致）
  ['价格 $100 和 $200', ['T:价格 $100 和 $200']],
  // 没有定界符的普通文本
  ['普通文本', ['T:普通文本']],
  ['', []],
  ['未闭合 $x^2', ['T:未闭合 $x^2']]
]
for (const [input, want] of segCases) {
  const got = segsOf(input)
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  分段 ' + JSON.stringify(input) + ' => ' + JSON.stringify(got) + (ok ? '' : '  want ' + JSON.stringify(want)))
}

// 排版适用性：超长与括号不配平必须回退
const typeCases = [
  ['x^2', true],
  ['\\frac{a}{b}', true],
  ['\\frac{a}{', false],          // 流式中间态：残括号渲染为空
  ['a}b', false],                 // 多出来的右括号
  ['', false],
  ['', false],
  ['x'.repeat(MATH_TYPESET_MAX), true],
  ['x'.repeat(MATH_TYPESET_MAX + 1), false],   // 超长会被截断（不换行）
  ['\\sum_{i=1}^{n} i^2', true]
]
for (const [input, want] of typeCases) {
  const got = canTypesetMath(input)
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  可排版 ' + JSON.stringify(input.slice(0, 30)) + ' => ' + got + (ok ? '' : '  want ' + want))
}

// 括号配平判定：不配平的公式必须显示源码（原生排出空白 / Unicode 会拼出错字）
const balanceCases = [
  ['x^2', true],
  ['\\frac{a}{b}', true],
  ['\\frac{a}{', false],
  ['a}b', false],
  ['\\sum_{i=1}^{n}', true],
  ['{{}}', true],
  ['}', false],
  ['{', false]
]
for (const [input, want] of balanceCases) {
  const got = bracesBalanced(input)
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  括号配平 ' + JSON.stringify(input) + ' => ' + got + (ok ? '' : '  want ' + want))
}

// 消息原文不能被改动（只影响显示层）
const original = '$\\frac{1}{2}$'
latexToText(original)
splitMathSegments(original)
const mutOk = original === '$\\frac{1}{2}$'
console.log((mutOk ? 'PASS' : 'FAIL') + '  原文不被修改')
if (!mutOk) fail += 1

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
