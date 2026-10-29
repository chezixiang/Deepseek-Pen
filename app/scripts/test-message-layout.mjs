#!/usr/bin/env node
// 消息布局纯函数回归：定稿内容 key、表格/长消息判定、长回复分气泡。
import { layoutFingerprint, messageRenderKey, isTallMessage, chunkMarkdownBlocks, splitTableBlock, cellLineCount, estimateTextWidth } from '../src/services/message-layout.js'

let failures = 0
function check(name, got, expected) {
    const ok = got === expected
    if (!ok) failures++
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' => ' + JSON.stringify(got) + (ok ? '' : ' expected ' + JSON.stringify(expected)))
}

const base = { id: 'm1', role: 'assistant', pending: false, content: 'a'.repeat(400), reasoning: '', error: '' }
const sameLengthDifferentContent = Object.assign({}, base, { content: 'b'.repeat(400) })
const sameContentDifferentReasoning = Object.assign({}, base, { reasoning: 'reasoning' })
const sameContentWithError = Object.assign({}, base, { error: 'failed' })
check('指纹确定性', layoutFingerprint(base.content), layoutFingerprint(base.content))
check('同长度不同内容生成不同 key', messageRenderKey(base) !== messageRenderKey(sameLengthDifferentContent), true)
check('reasoning 变化生成不同 key', messageRenderKey(base) !== messageRenderKey(sameContentDifferentReasoning), true)
check('error 变化生成不同 key', messageRenderKey(base) !== messageRenderKey(sameContentWithError), true)
check('未定稿只依赖消息 epoch', messageRenderKey(Object.assign({}, base, { pending: true })) === messageRenderKey(Object.assign({}, base, { pending: true })), true)
check('短消息非长消息', isTallMessage({ role: 'assistant', content: '短消息' }), false)
check('超过阈值的文本为长消息', isTallMessage({ role: 'assistant', content: 'x'.repeat(301) }), true)
check('长思考过程为长消息', isTallMessage({ role: 'assistant', content: '短', reasoning: 'x'.repeat(301) }), true)
check('GFM 表格为长消息', isTallMessage({ role: 'assistant', content: '| A | B |\n| --- | --- |\n| x | y |' }), true)
check('多张工具卡片为长消息', isTallMessage({ role: 'assistant', content: 'x', toolCalls: [{}, {}] }), true)

// ---------- 长回复分气泡 ----------
function tableWithRows(n) {
    return { type: 'table', header: ['排名', '模型'], align: [], rows: Array.from({ length: n }, (_, i) => [String(i + 1), '模型' + i]) }
}
{
    const chunks = chunkMarkdownBlocks([])
    check('空块列表切出空组', chunks.length, 0)
}
{
    const chunks = chunkMarkdownBlocks([{ type: 'p', text: '短段落' }])
    check('单段落成一组', [chunks.length, chunks[0].length].join(','), '1,1')
}
{
    // 12 行表格：5 行一段 → 3 段（5+5+2），每段都带表头
    const pieces = splitTableBlock(tableWithRows(12))
    check('表格按行切段数', pieces.length, 3)
    check('续段重复表头', pieces.map((p) => p.header.length).join(','), '2,2,2')
    check('分段行数', pieces.map((p) => p.rows.length).join(','), '5,5,2')
    check('分段保留列对齐', JSON.stringify(pieces[0].align), '[]')
}
{
    // 5 行以内表格不切
    check('短表格不切分', splitTableBlock(tableWithRows(5)).length, 1)
}
{
    // 一条 5500 字长回复（约 40 个块、8 张表）切出的每组都不得超限太多，
    // 且总块数（含表格续段）与输入一致——不丢内容
    const blocks = []
    for (let t = 0; t < 8; t++) {
        blocks.push({ type: 'h2', text: '章节标题' + t })
        blocks.push({ type: 'p', text: '段落说明'.repeat(30) })
        blocks.push(tableWithRows(11))
    }
    const chunks = chunkMarkdownBlocks(blocks)
    const flatBlocks = chunks.reduce((n, c) => n + c.length, 0)
    check('切块后总块数守恒（表格展开为段）', flatBlocks, 8 * 2 + 8 * 3)
    check('长回复切出多组', chunks.length > 4, true)
}
{
    // 确定性：同一输入两次切块结果一致
    const blocks = [{ type: 'p', text: '甲' }, tableWithRows(11), { type: 'p', text: '乙' }]
    const a = JSON.stringify(chunkMarkdownBlocks(blocks))
    const b = JSON.stringify(chunkMarkdownBlocks(blocks))
    check('切块确定性', a === b, true)
}
{
    // 单元格行数：窄列长文本多于保底 3 行；短文本保持 3 行保底
    check('短单元格保底 3 行', cellLineCount('80.0', 7), 3)
    check('长单元格按列宽加行', cellLineCount('DeepSeek V4.1 Flash、GLM-5.3（开源最高）', 5) > 3, true)
    check('列数越少行数越少', cellLineCount('同一段文本内容', 2) <= cellLineCount('同一段文本内容', 5), true)
}
{
    // 估算宽度：CJK 全宽、ASCII 半宽
    check('CJK 估宽大于 ASCII', estimateTextWidth('模型模型') > estimateTextWidth('abcd'), true)
}

console.log(failures ? ('\n' + failures + ' 个用例失败') : '\n全部通过')
process.exit(failures ? 1 : 0)
