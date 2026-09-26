#!/usr/bin/env node
// 验证 bug 1 在**应用侧**的行为：限流错误必须被识别为"停止重试"，
// 而不是普通的"服务繁忙，请稍后重试"（后者会诱导用户连点发送 → 账号被禁言）。
//
// 做法：直接调用 ds.js 里导出的分类函数（与运行时同一份实现），
// 覆盖后端可能给出的各种限流文案/错误码。
import { isRateLimitCode, isRateLimitText, isAccountSuspension, isRateLimitedError } from '../src/services/error-classify.js'

let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + got + (ok ? '' : '   want ' + want))
}

// 新后端的独立错误码
check('upstream_rate_limited 码', isRateLimitCode('upstream_rate_limited'), true)
check('UPSTREAM_RATE_LIMITED 大小写不敏感', isRateLimitCode('UPSTREAM_RATE_LIMITED'), true)
check('overloaded 不算上游限流', isRateLimitCode('overloaded'), false)
check('no_accounts_configured 不算限流', isRateLimitCode('no_accounts_configured'), false)

// 文案兜底（老后端 / 上游原始文案）
check('"上游限流" 文案', isRateLimitText('上游限流中，请 60 秒后再试'), true)
check('"rate limited" 文案', isRateLimitText('upstream rate limited: rate_limit_reached'), true)
check('"rate_limit_reached" 文案', isRateLimitText('上游触发限流（rate_limit_reached）'), true)
check('"所有账号均在限流" 文案', isRateLimitText('所有账号均在限流退避中，剩余最长 60s'), true)
// 关键区分：普通的服务繁忙不能被当成限流拦掉（否则用户永远发不出消息）
check('"服务繁忙" 不算限流', isRateLimitText('服务繁忙或触发限流，请稍后重试'), false)
check('空串不算限流', isRateLimitText(''), false)
check('undefined 不算限流', isRateLimitText(undefined), false)

// 限流不应被记成"账号被限制/禁言"取证（那是另一类问题）
check('限流文案不算账号封禁', isAccountSuspension('上游限流中，请稍后再试'), false)
check('禁言文案仍算账号封禁', isAccountSuspension('账号已被禁言至 2026-10-01'), true)

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
