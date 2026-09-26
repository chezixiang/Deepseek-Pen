#!/usr/bin/env node
// ds-text.js 回归用例：URL 拼接、内部协议标签清洗（围栏感知折叠）、SSE 解析。
// parseSse 喂着每一条流式消息；stripInternalTags 的折叠规则曾毁掉代码缩进
// （并随消息持久化、回传模型），这里的用例锁住修复行为。
import { apiUrl, stripInternalTags, collapseOutsideFences, parseSse } from '../src/services/ds-text.js'

let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// ---------- apiUrl ----------
check('host 无 /v1 自动补', apiUrl('http://127.0.0.1:22217', 'chat/completions'), 'http://127.0.0.1:22217/v1/chat/completions')
check('host 带 /v1 不重复补', apiUrl('http://127.0.0.1:22217/v1', 'chat/completions'), 'http://127.0.0.1:22217/v1/chat/completions')
check('host 尾斜杠 + /v1', apiUrl('http://h:1/v1/', '/chat/completions'), 'http://h:1/v1/chat/completions')
check('path 带前导斜杠', apiUrl('http://h:1', '/chat/completions'), 'http://h:1/v1/chat/completions')
check('空 host 兜底', apiUrl('', 'chat/completions'), '/v1/chat/completions')

// ---------- stripInternalTags ----------
check('移除工具标签', stripInternalTags('a<|begin_of_function|>b'), 'ab')
check('移除 invoke 标签', stripInternalTags('<invoke>x</invoke>'), 'x')
check('移除通配协议标签', stripInternalTags('a<|anything_here|>b'), 'ab')
check('普通文本不变', stripInternalTags('你好 世界'), '你好 世界')
check('#14 回归：换行不折叠', stripInternalTags('一\n\n二'), '一\n\n二')
// 代码块内缩进必须保留（折叠曾毁掉缩进并持久化进历史）
check('代码块缩进保留', stripInternalTags('```python\ndef f():\n    return  1\n```'), '```python\ndef f():\n    return  1\n```')
check('围栏外仍折叠', stripInternalTags('a  b\n```\nc  d\n```\ne  f'), 'a b\n```\nc  d\n```\ne f')
check('~~~ 围栏同样豁免', collapseOutsideFences('~~~\nx    y\n~~~'), '~~~\nx    y\n~~~')
check('未配对围栏：其后全保留', collapseOutsideFences('```\na   b'), '```\na   b')
check('空值原样', stripInternalTags(''), '')

// ---------- parseSse ----------
{
  const { events, rest } = parseSse('data: {"a":1}\n\ndata: {"b":2}\n\n')
  check('两个完整事件', events.length, 2)
  check('事件内容', events[1], '{"b":2}')
  check('无残段', rest, '')
}
{
  // CRLF 行尾
  const { events } = parseSse('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')
  check('CRLF 切分', events.join('|'), '{"a":1}|{"b":2}')
}
{
  // 事件跨 chunk 撕裂：残段必须留在 rest 里下次拼接
  const first = parseSse('data: {"a"')
  check('撕裂事件不产出', first.events.length, 0)
  check('撕裂残段保留', first.rest, 'data: {"a"')
  const second = parseSse(first.rest + ':1}\n\n')
  check('拼接后产出', second.events.join(''), '{"a":1}')
}
{
  // 多行 data: 按行拼接（SSE 规范）
  const { events } = parseSse('data: line1\ndata: line2\n\n')
  check('多行 data 拼接', events[0], 'line1\nline2')
}
{
  // data: 后的单个空格按规范剥掉；没有空格也不出错
  const { events } = parseSse('data:nospace\n\ndata: keep\n\n')
  check('无空格 data', events[0], 'nospace')
  check('有空格 data', events[1], 'keep')
}
{
  // 非 data 行（event:/注释/空行内容）被忽略
  const { events } = parseSse('event: finish\ndata: {}\n\n: comment\n\n')
  check('event 行忽略', events.length, 1)
}
check('空输入', parseSse('').events.length, 0)
check('null 输入', parseSse(null).events.length, 0)

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
