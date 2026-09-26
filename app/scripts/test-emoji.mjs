#!/usr/bin/env node
// emoji-subst.js 回归用例：emoji → 文字标签的降级替换。
// 核心回归：
//  1. 快速路径正则与 isBmpEmoji 区段不同步，↗ ‼ ☀ 等已配标签的符号走不到替换；
//  2. ZWJ 后无条件吃 2 个码元，畸形序列 "👍‍ok" 会把正文 'o' 一起吞掉。
import { substituteEmoji } from '../src/services/emoji-subst.js'

let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// ---------- 基本替换 ----------
check('闹钟', substituteEmoji('⏰'), '[闹钟]')
check('VS16 变体形态', substituteEmoji('⏰️'), '[闹钟]')
check('高位面 👍', substituteEmoji('👍'), '[赞]')
check('中文夹带', substituteEmoji('早上好⏰啦'), '早上好[闹钟]啦')

// ---------- 区段同步回归（旧版快速路径漏检） ----------
check('↗ 右上（旧版漏检）', substituteEmoji('↗'), '[右上]')
check('‼ 双叹（旧版漏检）', substituteEmoji('‼'), '[双叹]')
check('⁉ 叹问', substituteEmoji('⁉'), '[叹问]')
check('☀ 太阳（旧版漏检）', substituteEmoji('☀'), '[太阳]')
check('☑ 已选（旧版漏检）', substituteEmoji('☑'), '[已选]')
check('纯文本不受影响', substituteEmoji('hello 你好'), 'hello 你好')

// ---------- 丢弃与保留规则 ----------
check('未命中高位面 emoji 丢弃', substituteEmoji('🫠'), '')
check('未命中 BMP 符号保留', substituteEmoji('【】'), '【】')
check('丢弃不影响前后文本', substituteEmoji('前🫠后'), '前后')

// ---------- ZWJ / 畸形序列回归 ----------
check('畸形 ZWJ 序列不吞正文', substituteEmoji('👍‍ok'), '[赞]‍ok')
check('正文完整性（ZWJ 场景）', substituteEmoji('好👍‍坏'), '好[赞]‍坏')
// ZWJ 组合：逐字符兜底命中 🚀 标签，未命中的 🧑 被丢弃，正文不吞
check('未配标签 ZWJ 序列后正文保留', substituteEmoji('🧑‍🚀ok'), '[火箭]ok')

// ---------- 幂等性（替换结果里不再有 emoji） ----------
check('幂等', substituteEmoji(substituteEmoji('⏰👍')), substituteEmoji('⏰👍'))
check('空串', substituteEmoji(''), '')
check('null', substituteEmoji(null), '')

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
