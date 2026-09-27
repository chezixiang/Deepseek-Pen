import assert from 'node:assert/strict'
import fs from 'node:fs'

const camera = fs.readFileSync(new URL('../src/services/camera.js', import.meta.url), 'utf8')
const page = fs.readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8')

const previewStart = camera.slice(
  camera.indexOf('export async function startPreview'),
  camera.indexOf('export function stopPreview')
)
assert.doesNotMatch(
  previewStart,
  /KMS_LAUNCH_CMD/,
  'camera preview must not classify a black kmssink plane as a visible preview'
)
assert.match(
  previewStart,
  /startFramePreview\(onFrame\)/,
  'camera preview must start the image-backed fallback that is known to render'
)
assert.match(previewStart, /return 'frames'/, 'camera preview must expose the image-backed mode to the UI')
assert.match(camera, /const KMS_STOP_CMD = [^\n]*kmssink/, 'camera preview must clear stale hardware overlays before showing image frames')
assert.match(camera, /__FRAME_BASE___\$n\.jpg/, 'preview frame files must be session-scoped and uniquely numbered')
assert.match(camera, /CAMFEED_SH\.replace\(\/__FRAME_BASE__\/g, frameBase\)/, 'each preview session must replace the frame path marker with a fresh base path')
assert.doesNotMatch(camera, /ds_feed_\$i\.jpg/, 'preview frames must not reuse a two-slot filename ring')
assert.ok(camera.includes("onFrame(frameBase + '_' + n + '.jpg')"), 'preview callback must publish the session-scoped frame path')

const resetStart = page.indexOf('resetCropBox()')
const resetEnd = page.indexOf('// 裁剪框外的四块半透明遮罩', resetStart)
const resetBody = page.slice(resetStart, resetEnd)
assert.doesNotMatch(resetBody, /0\.92/, 'default crop box must reach the photo edges')
assert.match(resetBody, /x:\s*disp\.x[\s\S]*y:\s*disp\.y[\s\S]*w:\s*disp\.w[\s\S]*h:\s*disp\.h/)
const dispStart = page.indexOf('dispRect()')
const dispEnd = page.indexOf('cropBoxStyle()', dispStart)
const dispBody = page.slice(dispStart, dispEnd)
assert.match(dispBody, /x:\s*\(W\s*-\s*w\)\s*\/\s*2/, 'crop geometry must follow contain image horizontal centering')

console.log('PASS camera preview and crop-default regression contract')
