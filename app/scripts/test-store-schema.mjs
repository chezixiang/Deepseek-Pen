#!/usr/bin/env node
// store-schema.js 回归用例：消息/会话归一化（Node 可直接导入的纯函数模块）。
// 核心回归：从磁盘读回时还挂着 pending=true 的助手消息必须降级为可重试的
// 错误态——旧版原样恢复，气泡永远卡在"正在思考…"、重试按钮永不出现。
import { normalizeMessages, normalizeConversation, stripImagePayloads, maskAccountId, uid } from '../src/services/store-schema.js'

let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// ---------- normalizeMessages：stale pending 降级 ----------
{
  const out = normalizeMessages([
    { id: 'a1', role: 'assistant', content: '半截回答', pending: true, createdAt: 1 }
  ])
  check('stale pending 降级为 false', out[0].pending, false)
  check('补出错误信息（可重试）', out[0].error, '生成中断，请重试')
  check('attempts 内也同步降级', out[0].attempts[0].pending, false)
  check('半截内容保留', out[0].content, '半截回答')
}
{
  // attempts 数组形态落盘的 stale pending
  const out = normalizeMessages([
    {
      id: 'a2', role: 'assistant', createdAt: 2, activeAttempt: 0,
      attempts: [{ id: 'x', content: '', reasoning: '', error: '', pending: true, createdAt: 2 }]
    }
  ])
  check('attempts 形态 stale pending 降级', out[0].pending, false)
  check('errorCode 缺省为空串', out[0].errorCode, '')
}
{
  // 正常完成的消息不受影响
  const out = normalizeMessages([
    {
      id: 'a3', role: 'assistant', createdAt: 3, activeAttempt: 0,
      attempts: [{ id: 'y', content: '完成', reasoning: '想了', error: '', pending: false, createdAt: 3 }]
    }
  ])
  check('正常消息 pending 保持 false', out[0].pending, false)
  check('正常消息无错误', out[0].error, '')
  check('内容不被改写', out[0].content, '完成')
}
{
  // 用户消息：补 revisions、钳制 activeRevision、内容取活跃版本
  const out = normalizeMessages([
    { id: 'u1', role: 'user', content: '第2版', activeRevision: 99, createdAt: 4,
      revisions: [{ content: '第1版', images: [], createdAt: 4 }, { content: '第2版', images: [], createdAt: 5 }] }
  ])
  check('越界 activeRevision 钳制到末位', out[0].activeRevision, 1)
  check('内容取活跃版本', out[0].content, '第2版')
}
{
  const out = normalizeMessages([
    { id: 'u2', role: 'user', content: '旧版消息无 revisions', createdAt: 6 }
  ])
  check('旧用户消息补 revisions', out[0].revisions.length, 1)
  check('activeRevision 补末位', out[0].activeRevision, 0)
}
check('非数组输入返回空', normalizeMessages('bad').length, 0)

// ---------- normalizeConversation ----------
check('旧会话补默认 mode', normalizeConversation({ id: 'c1' }).mode, 'fast')
check('已有字段不覆盖', normalizeConversation({ id: 'c2', thinking: false }).thinking, false)
check('null 兜底', normalizeConversation(null).search, false)

// ---------- stripImagePayloads ----------
{
  const out = stripImagePayloads([
    { id: 'm1', images: [{ name: 'a.jpg', path: '/p/a.jpg', dataUrl: 'data:image/png;base64,XXXX' }] },
    { id: 'm2', images: [] }
  ])
  check('dataUrl 被剥掉', out[0].images[0].dataUrl, null)
  check('path 保留', out[0].images[0].path, '/p/a.jpg')
  check('无图消息原样', out[1].images.length, 0)
  check('非数组原样返回', stripImagePayloads('x'), 'x')
}

// ---------- maskAccountId ----------
check('邮箱脱敏', maskAccountId('user@example.com'), 'us***@example.com')
check('手机号脱敏', maskAccountId('13800138000'), '138****8000')
check('短手机号原样', maskAccountId('12345'), '12345')
check('空值', maskAccountId(''), '')

// ---------- uid ----------
check('uid 前缀', uid('u').startsWith('u_'), true)
check('uid 唯一性', uid('x') !== uid('x'), true)

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
