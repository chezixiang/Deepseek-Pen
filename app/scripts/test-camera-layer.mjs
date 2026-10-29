// 相机取景层级契约（build143 起的实现方式）。
//
// 旧版用 modetest 直接把 video plane 的 zpos 抬到 UI 之上；build143 改为
// 「清掉残留 kmssink → 用 image 帧循环取景」，不再操作 DRM plane。
// 本用例锁定当前策略，防止旧实现被无意间改回来：
//   1) 取景前必须清理残留的 kmssink；
//   2) 不允许再操作 DRM plane 的 zpos（黑屏根因）；
//   3) 帧文件必须按会话隔离，避免新旧会话互踩。
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/services/camera.js', import.meta.url), 'utf8')

assert.match(source, /const KMS_STOP_CMD = [^\n]*kmssink/, 'camera preview must clear stale kmssink before showing frames')
assert.doesNotMatch(source, /modetest -w \d+:zpos:\d+/, 'camera preview must not rely on DRM plane zpos overrides (black-screen root cause)')
assert.match(source, /__FRAME_BASE___\$n\.jpg/, 'preview frame files must be session-scoped and uniquely numbered')
assert.match(source, /CAMFEED_SH\.replace\(\/__FRAME_BASE__\/g, frameBase\)/, 'each preview session must replace the frame path marker')

console.log('PASS camera layer ordering contract')
