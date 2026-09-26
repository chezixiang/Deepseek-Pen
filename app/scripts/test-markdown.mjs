#!/usr/bin/env node
// markdown.js 回归用例：块解析（代码块缩进保留）、行内强调、公式段、emoji 拆分。
// 核心回归：旧版在围栏解析前对全文做 [ \t]{2,} 折叠，代码块缩进被压掉，
// 且缩进丢失会随消息持久化、作为历史回传给模型（丢语义）。
import { markdownToBlocks, inlineSpans, splitEmojiRuns, splitMathSegments, bracesBalanced } from '../src/services/markdown.js'

let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// ---------- markdownToBlocks：代码块 ----------
{
  const blocks = markdownToBlocks('```python\ndef f():\n    return  1\n```')
  check('代码块数量', blocks.length, 1)
  check('代码块类型', blocks[0].type, 'code')
  check('P1 回归：代码缩进与内部空格完整保留', blocks[0].text, 'def f():\n    return  1')
}
{
  const blocks = markdownToBlocks('~~~\n  indent\n    more\n~~~')
  check('~~~ 围栏', [blocks[0].type, blocks[0].text], ['code', '  indent\n    more'])
}
{
  const blocks = markdownToBlocks('```js\nlet a = 1\n```\n之后的段落')
  check('围栏后段落', [blocks.length, blocks[1].type], [2, 'p'])
}
{
  const blocks = markdownToBlocks('```js\n未闭合的代码块')
  check('未闭合围栏', [blocks[0].type, blocks[0].text], ['code', '未闭合的代码块'])
}

// ---------- markdownToBlocks：常规块 ----------
{
  const blocks = markdownToBlocks('# 标题一\n## 标题二\n普通段落  两连空格\n- 甲\n- 乙\n1. 其一\n> 引用\n---')
  check('标题层级', [blocks[0].type, blocks[1].type], ['h1', 'h2'])
  check('段落折叠（围栏外生效）', blocks[2].text, '普通段落 两连空格')
  check('无序列表', [blocks[3].type, blocks[3].items], ['list', ['甲', '乙']])
  check('有序列表', [blocks[4].ordered, blocks[4].items], [true, ['其一']])
  check('引用', [blocks[5].type, blocks[5].text], ['quote', '引用'])
  check('分隔线', blocks[6].type, 'hr')
}
{
  // 列表项内折叠但内容不丢
  const blocks = markdownToBlocks('- 甲  乙')
  check('列表项折叠', blocks[0].items[0], '甲 乙')
}
{
  const blocks = markdownToBlocks('')
  check('空输入', blocks.length, 0)
}
{
  // 块级公式（display）
  const blocks = markdownToBlocks('$$\n\\frac{a}{b}\n$$')
  check('块级公式', [blocks[0].type, blocks[0].text], ['math', '\\frac{a}{b}'])
}

// ---------- markdownToBlocks：表格 ----------
{
  const md = '| 名称 | 数量 |\n| --- | ---: |\n| 苹果 | 3 |\n| 香蕉 | 12 |'
  const blocks = markdownToBlocks(md)
  check('表格类型', blocks[0].type, 'table')
  check('表头', blocks[0].header, ['名称', '数量'])
  check('列对齐（右对齐列）', blocks[0].align, ['left', 'right'])
  check('数据行', blocks[0].rows, [['苹果', '3'], ['香蕉', '12']])
}
{
  // 分隔行未到（流式中间态）：保持段落，不显示半截表
  const blocks = markdownToBlocks('| 名称 | 数量 |')
  check('流式中表格不成形', blocks[0].type, 'p')
}
{
  // 分隔行不合法（单元格不是 ---）也不算表格
  const blocks = markdownToBlocks('| 名称 | 数量 |\n| 甲 | 乙 |')
  check('无分隔行不成表', blocks[0].type, 'p')
}
{
  // 列数不齐：短行补空、长行截断，以表头为准
  const blocks = markdownToBlocks('| a | b | c |\n| --- | --- | --- |\n| 1 |')
  check('列数补齐', blocks[0].rows[0], ['1', '', ''])
}
{
  // 居中/居左对齐 + 表格后随段落正常分块
  const blocks = markdownToBlocks('| a | b |\n| :-: | --- |\n| 1 | 2 |\n后续段落')
  check('居中对齐', blocks[0].align, ['center', 'left'])
  check('表格后随段落', [blocks[1].type, blocks[1].text], ['p', '后续段落'])
}
{
  // 转义竖线不切列
  const blocks = markdownToBlocks('| a | b |\n| --- | --- |\n| x\\|y | 2 |')
  check('单元格转义竖线', blocks[0].rows[0], ['x|y', '2'])
}

// ---------- markdownToBlocks：任务列表 / 有序起始号 / 引用合并 ----------
{
  const blocks = markdownToBlocks('- [x] 已完成\n- [ ] 待办\n- 普通')
  check('任务状态三态', blocks[0].taskStates, ['done', 'open', null])
  check('任务项文本剥离勾选框', blocks[0].items, ['已完成', '待办', '普通'])
}
{
  const blocks = markdownToBlocks('- 甲\n- 乙')
  check('普通列表不背 taskStates', blocks[0].taskStates, undefined)
}
{
  const blocks = markdownToBlocks('段落\n\n3. 甲\n4. 乙')
  check('有序列表起始号', [blocks[1].ordered, blocks[1].start, blocks[1].items], [true, 3, ['甲', '乙']])
}
{
  const blocks = markdownToBlocks('1. 其一\n2. 其二')
  check('从 1 起不写 start', blocks[0].start, undefined)
}
{
  const blocks = markdownToBlocks('> 第一行\n> 第二行')
  check('连续引用行合并', [blocks.length, blocks[0].text], [1, '第一行\n第二行'])
}

// ---------- inlineSpans：删除线 / 链接 / 粗斜体 ----------
{
  const spans = inlineSpans('~~作废内容~~ 保留')
  check('删除线', [spans[0].text, !!spans[0].strike], ['作废内容', true])
  check('删除线后接普通文本', spans[1].text, ' 保留')
}
{
  const spans = inlineSpans('见 [百度](https://baidu.com) 主页')
  check('链接文字', spans[1].text, '百度')
  check('链接地址', spans[1].link, 'https://baidu.com')
}
{
  const spans = inlineSpans('***加粗斜体***')
  check('粗斜体', [spans[0].text, !!spans[0].bold, !!spans[0].italic], ['加粗斜体', true, true])
}
{
  // 链接与既有语法混排，互不干扰
  const spans = inlineSpans('**粗** 与 `code` 与 ~~删~~')
  check('混排不被新规则破坏', spans.map((s) => s.text).join(''), '粗 与 code 与 删')
  check('混排标记保留', [!!spans[0].bold, !!spans[2].code, !!spans[4].strike], [true, true, true])
}

// ---------- inlineSpans ----------
{
  const spans = inlineSpans('3 * 4 * 5')
  check('P1 回归：乘号星号不被当斜体', spans.map((s) => s.text).join(''), '3 * 4 * 5')
  check('无斜体标记产生', spans.some((s) => s.italic), false)
}
{
  const spans = inlineSpans('**加粗** 与 *斜体* 与 `代码`')
  check('加粗', [spans[0].text, !!spans[0].bold], ['加粗', true])
  check('斜体', [spans[2].text, !!spans[2].italic], ['斜体', true])
  check('行内代码', [spans[4].text, !!spans[4].code], ['代码', true])
}
{
  const spans = inlineSpans('**bold *nested***')
  // 嵌套场景：外层 ** 不构成加粗（内含 *），保持字面量；*nested* 正常斜体；
  // 任何非定界符字符都不能被吞掉
  check('嵌套强调不丢字符', spans.map((s) => s.text).join(''), '**bold nested**')
}
{
  const spans = inlineSpans('$x^2$ 公式')
  check('公式转 Unicode', spans[0].text, 'x² 公式')
}
{
  const spans = inlineSpans('`\\frac{a}{b}` 不转公式')
  check('行内代码内不动 LaTeX', spans[0].text, '\\frac{a}{b}')
}

// ---------- splitMathSegments / bracesBalanced ----------
{
  const segs = splitMathSegments('前后 $a+b$ 后')
  check('公式段切分', [segs.length, segs[1].math], [3, true])
  check('公式段是裸 LaTeX', segs[1].text, 'a+b')
  check('货币 $ 不当公式', splitMathSegments('价格 $ 5 元').every((s) => !s.math), true)
}
check('括号配平', bracesBalanced('\\frac{a}{b}'), true)
check('括号不配平', bracesBalanced('\\frac{a}{'), false)

// ---------- splitEmojiRuns ----------
{
  const runs = splitEmojiRuns('a😀b')
  check('emoji 拆分段数', runs.length, 3)
  check('emoji 段标记', [runs[0].e, runs[1].e, runs[2].e], [false, true, false])
}
{
  const runs = splitEmojiRuns('纯文本')
  check('纯文本单段', [runs.length, runs[0].e], [1, false])
}

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
