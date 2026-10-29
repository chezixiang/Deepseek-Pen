// shell-write.js 回归测试：
//  1) utf8ToBase64 正确性（对照 Buffer、覆盖中文/emoji/代理对/空串）
//  2) splitB64Chunks 切块不变量
//  3) shellWriteFile 真集成：用宿主机 sh 执行生成的命令（与设备 busybox 同为 POSIX sh + base64）
//     —— 单块 / 多块 / 空内容 / 内容含引号换行 / Unicode
//  4) execShell 乱序容错：mock 一个并发执行的 execShell，靠哨兵同步仍保证内容正确
//  5) shellAppendLine / shellFileSize / shellTruncate
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  bytesToBase64,
  shellAppendLine,
  shellFileSize,
  shellTruncate,
  shellWriteFile,
  splitB64Chunks,
  utf8ToBase64
} from '../src/services/shell-write.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shell-write-'))
}

// 宿主机真 sh 桥：execShell 派生后台 sh -c（fire-and-forget，模拟设备语义）
function realShBridge(dir) {
  return {
    execShell(cmd) {
      const c = String(cmd)
      setImmediate(() => {
        try { execFileSync('sh', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: 15000 }) } catch (e) { /* 设备 execShell 也吞错误 */ }
      })
      return true
    },
    shq: (s) => "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'",
    async waitForFile(p, timeoutMs) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        try {
          const c = fs.readFileSync(p, 'utf8')
          if (c !== null && String(c) !== '') return String(c)
        } catch (e) { /* 未出现继续等 */ }
        await new Promise((r) => setTimeout(r, 50))
      }
      return null
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    dataDirBase: () => dir,
    joinPath: (b, ...p) => path.join(b, ...p)
  }
}

test('utf8ToBase64 与 Buffer 一致', () => {
  const samples = [
    '',
    'hello world',
    '中文内容测试',
    '混合 mix 内容 with "quotes" and \\backslash\\',
    'emoji 😀🎉 与代理对 𝐀𝐁',
    'line1\nline2\r\nline3\ttab',
    "single'quote'double\"quote",
    'x'.repeat(100000)
  ]
  for (const s of samples) {
    const expected = Buffer.from(s, 'utf8').toString('base64')
    assert.equal(utf8ToBase64(s), expected, '样本: ' + s.slice(0, 30))
  }
})

test('bytesToBase64 填充分支', () => {
  for (let n = 0; n <= 9; n++) {
    const bytes = Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)
    const expected = Buffer.from(bytes).toString('base64')
    assert.equal(bytesToBase64(bytes), expected, 'len=' + n)
  }
})

test('splitB64Chunks 覆盖全部且保序', () => {
  const b64 = utf8ToBase64('内容'.repeat(9000))
  const chunks = splitB64Chunks(b64, 8000)
  assert.equal(chunks.join(''), b64)
  for (const c of chunks) assert.ok(c.length <= 8000)
})

test('shellWriteFile 真集成：单块/多块/空串/特殊字符', async () => {
  const dir = tmpDir()
  const bridge = realShBridge(dir)
  const target = path.join(dir, 'out.json')

  // 单块
  assert.equal(await shellWriteFile(bridge, target, '{"a":"中文","n":1}'), true)
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":"中文","n":1}')

  // 多块（> 8000 b64 字符）
  const big = '中文ABC'.repeat(5000) // utf8 4.5 万字节 → b64 6 万字符 → 8 块
  assert.equal(await shellWriteFile(bridge, target, big), true)
  assert.equal(fs.readFileSync(target, 'utf8'), big)

  // 引号 / 换行 / 制表符（heredoc 场景容易碎的内容，base64 路径应原样保留）
  const tricky = 'A\r\nB"C\'D\tE\\F\nG'
  assert.equal(await shellWriteFile(bridge, target, tricky), true)
  assert.equal(fs.readFileSync(target, 'utf8'), tricky)

  // 空串 = 截断
  assert.equal(await shellWriteFile(bridge, target, ''), true)
  assert.equal(fs.readFileSync(target, 'utf8'), '')

  // 空文件重建为有内容
  assert.equal(await shellWriteFile(bridge, target, 'reborn'), true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'reborn')

  // 无临时残留
  const leftover = fs.readdirSync(dir).filter((f) => f.startsWith('wshell_'))
  assert.deepEqual(leftover, [])

  fs.rmSync(dir, { recursive: true, force: true })
})

test('shellWriteFile 对并发乱序 execShell 仍正确（哨兵同步）', async () => {
  const dir = tmpDir()
  const queue = []
  const bridge = Object.assign(realShBridge(dir), {
    // 故意延迟执行且不保证 FIFO：模拟设备 execShell 并发
    execShell(cmd) {
      queue.push(setImmediate(() => {
        try { execFileSync('sh', ['-c', String(cmd)], { cwd: dir, stdio: 'ignore', timeout: 15000 }) } catch (e) { /* 吞 */ }
      }))
      return true
    }
  })
  const target = path.join(dir, 'out2.txt')
  const content = '乱序测试'.repeat(4000)
  assert.equal(await shellWriteFile(bridge, target, content), true)
  assert.equal(fs.readFileSync(target, 'utf8'), content)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('shellAppendLine / shellFileSize / shellTruncate', async () => {
  const dir = tmpDir()
  const bridge = realShBridge(dir)
  const log = path.join(dir, 'ds-app.log')

  assert.equal(await shellAppendLine(bridge, log, '第一行 log'), true)
  assert.equal(await shellAppendLine(bridge, log, "第二行 with 'quote'"), true)
  assert.equal(
    fs.readFileSync(log, 'utf8'),
    '第一行 log\n' + "第二行 with 'quote'\n"
  )

  assert.equal(await shellFileSize(bridge, log), Buffer.byteLength('第一行 log\n' + "第二行 with 'quote'\n", 'utf8'))
  assert.equal(await shellFileSize(bridge, path.join(dir, 'nope.txt')), 0)

  assert.equal(await shellTruncate(bridge, log), true)
  assert.equal(fs.readFileSync(log, 'utf8'), '')

  // 不存在的文件写入（目录存在）
  assert.equal(await shellWriteFile(bridge, path.join(dir, 'new', '..', 'fresh.txt'), 'ok'), true)

  fs.rmSync(dir, { recursive: true, force: true })
})
