import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/services/camera.js', import.meta.url), 'utf8')

assert.match(source, /modetest -w 75:zpos:2/, 'camera preview must explicitly raise the video plane')
assert.match(source, /modetest -w 54:zpos:1/, 'camera preview must lower the UI plane')
assert.match(source, /gst_pid=\$!/, 'layer correction must track the running preview process')
assert.match(source, /kill -0 \"\$gst_pid\"/, 'layer correction must retry while preview is alive')
assert.match(source, /wait \"\$gst_pid\"/, 'preview wrapper must reap the gst process')

console.log('PASS camera layer ordering contract')
