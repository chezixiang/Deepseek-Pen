// classifyUpstreamError：上游"内容审核误拦"类错误的识别与映射。
// 实证案例（2026-10-28）：设备提问"高考听障人士怎么听英语听力"，
// 被 rule91 镜像渠道以 sensitive_words_detected 连续 8 次误拦（500）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyUpstreamError } from '../src/provider.js'

test('镜像渠道 sensitive_words_detected 映射为 moderation_blocked + 友好文案', () => {
  const hit = classifyUpstreamError('sensitive_words_detected (request id: 202610281227587152785468268d9d65cevVTmY)')
  assert.ok(hit, '必须命中')
  assert.equal(hit.code, 'moderation_blocked')
  assert.ok(hit.message.includes('审核'), '文案要点明是审核拦截')
  assert.ok(hit.message.includes('误判'), '文案要点明多为误判')
  assert.ok(/管理员/.test(hit.message), '文案要给求助出口')
})

test('中文/英文变体同样命中', () => {
  assert.equal(classifyUpstreamError('命中敏感词，已拦截')?.code, 'moderation_blocked')
  assert.equal(classifyUpstreamError('content_filter: blocked by policy')?.code, 'moderation_blocked')
  assert.equal(classifyUpstreamError('Content Moderation rejected')?.code, 'moderation_blocked')
  assert.equal(classifyUpstreamError('sensitive words detected')?.code, 'moderation_blocked')
})

test('普通上游错误不得误判为审核拦截', () => {
  assert.equal(classifyUpstreamError('upstream timeout'), null)
  assert.equal(classifyUpstreamError('rate limited by upstream'), null)
  assert.equal(classifyUpstreamError('Invalid token (request id: x)'), null)
  assert.equal(classifyUpstreamError(''), null)
  assert.equal(classifyUpstreamError(null), null)
})
