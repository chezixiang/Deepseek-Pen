// 网关冒烟测试：注册 → 签名接口 → 云控 → 单设备控制 → 遥测 → 后台 API。
//
// 运行：node --test test/
// 不依赖网络：provider 指向一个必然连不上的地址，聊天以外的主链路全部本地完成。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import zlib from 'node:zlib'

import { loadConfig } from '../src/config.js'
import { createServer, VERSION } from '../server.js'
import { hmacHex, sha256Hex, signatureBase } from '../src/auth.js'
import { inspectAmr } from '../src/amr.js'

const CLIENT = 'deepseek-pen/0.2.0'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'penai-test-'))
}

// 生成一个最小合法 AMR/ZIP：manifest + 一段带 `version build N` 的 JS 文本。
// 使用 deflate + 正确的 local/central directory，足以覆盖 amr.js 的解析路径。
// entries 可替换默认的 store 条目（用于覆盖构建号识别的各类产物形态）。
function createTestAmr({ version = '0.3.0', build = 300, entries = null } = {}) {
  const chunks = []
  const central = []
  let offset = 0

  const add = (name, data, method = 8) => {
    const nameBuf = Buffer.from(name, 'utf8')
    const crcTable = Array.from({ length: 256 }, (_, i) => {
      let c = i
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      return c >>> 0
    })
    let crc = 0xffffffff
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const payload = method === 8 ? zlib.deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cen, nameBuf]))
    offset += local.length + nameBuf.length + payload.length
  }

  add('manifest.json', Buffer.from(JSON.stringify({ appName: 'Test', version, appid: '8000000000test' })))
  const payloadEntries = entries || [['store-test.js.bin', `const APP_VERSION='${version} build ${build}';`]]
  for (const [name, data] of payloadEntries) {
    add(name, Buffer.from(data))
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  // 条目数 = manifest + 自定义条目数（写死 2 会让多条目包的解析丢尾部条目）
  eocd.writeUInt16LE(payloadEntries.length + 1, 8)
  eocd.writeUInt16LE(payloadEntries.length + 1, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, cd, eocd])
}

async function boot() {
  const dir = tempDir()
  const { config } = loadConfig({ configPath: path.join(dir, 'config.json'), env: {} })
  config.dataDir = path.join(dir, 'data')
  config.server.host = '127.0.0.1'
  config.server.port = 0
  config.provider.baseUrl = 'http://127.0.0.1:1/v1'
  config.provider.apiKey = 'test-key'
  const { server, app } = createServer({ config })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const session = app.ctx.adminAuth.setup('test-password-123', {
    ip: '127.0.0.1',
    req: { socket: { remoteAddress: '127.0.0.1' } }
  })
  return { dir, server, app, base, cookie: 'penai_admin_session=' + session.token }
}

async function json(resp) {
  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch (_) {
    return { raw: text }
  }
}

function signer(auth) {
  return function signedFetch(base, urlPath, { method = 'GET', body = null, headers = {} } = {}) {
    const bodyText = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
    const ts = Date.now()
    const nonce = crypto.randomBytes(16).toString('hex')
    const bodyHash = sha256Hex(Buffer.from(bodyText, 'utf8'))
    const signature = hmacHex(auth.signSecret, signatureBase({
      method,
      path: urlPath,
      bodyHash,
      ts,
      nonce,
      deviceId: auth.deviceId
    }))
    return fetch(base + urlPath, {
      method,
      headers: Object.assign({
        'X-Ds-Client': CLIENT,
        'X-Ds-Device-Id': auth.deviceId,
        'X-Ds-Timestamp': String(ts),
        'X-Ds-Nonce': nonce,
        'X-Ds-Signature': signature,
        'Authorization': 'Bearer ' + auth.deviceToken,
        'Content-Type': 'application/json'
      }, headers),
      body: bodyText || undefined
    })
  }
}

test('网关主链路：云控 v4 / 额度 / 单设备控制 / 遥测 / 后台', async (t) => {
  const ctx = await boot()
  t.after(() => {
    ctx.server.close()
    try { fs.rmSync(ctx.dir, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
  })

  await t.test('健康检查带云控协议版本', async () => {
    const h = await json(await fetch(ctx.base + '/health'))
    assert.equal(h.ok, true)
    // 跟随 server.js 的 VERSION 常量，避免每次升版本号都要改测试
    assert.equal(h.version, VERSION)
    assert.equal(h.control.version, 4)
    assert.equal(h.telemetry.enabled, true)
  })

  let auth = null
  await t.test('设备静默注册', async () => {
    const resp = await fetch(ctx.base + '/device/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ds-Client': CLIENT },
      body: JSON.stringify({ deviceId: 'pen-test-00000001', build: '200', version: '0.2.0', platform: 'dictpen' })
    })
    const d = await json(resp)
    assert.equal(resp.status, 200, JSON.stringify(d))
    assert.ok(d.deviceToken)
    assert.ok(d.signSecret)
    assert.equal(Array.isArray(d.quota.items), true)
    auth = { deviceId: 'pen-test-00000001', deviceToken: d.deviceToken, signSecret: d.signSecret }
  })

  const call = signer(auth)

  await t.test('/v1/me 返回全部额度项', async () => {
    const d = await json(await call(ctx.base, '/v1/me'))
    assert.equal(d.state, 'active')
    const keys = d.quota.items.map((i) => i.key)
    assert.deepEqual(keys, ['rpm', 'tpm', 'fiveHourTokens', 'dailyTokens', 'monthlyTokens', 'maxConcurrent'])
    const rpm = d.quota.items.find((i) => i.key === 'rpm')
    assert.equal(rpm.label, '每分钟请求')
    assert.equal(rpm.remaining, rpm.limit - rpm.used)
    // 旧字段（requests/tokens/daily）不再下发
    assert.equal(d.quota.requests, undefined)
    assert.equal(d.limits, undefined)
  })

  await t.test('/v1/control 下发 v4 文档', async () => {
    const d = await json(await call(ctx.base, '/v1/control'))
    assert.equal(d.version, 4)
    assert.equal(d.features.chat, true)
    assert.equal(typeof d.limits.maxInputChars, 'number')
    assert.equal(d.device.deviceId, 'pen-test-00000001')
    assert.ok(d.quota.items.length >= 5)
    assert.equal(typeof d.prompt.enabled, 'boolean')
    assert.equal(typeof d.debug.allow, 'boolean')
    assert.equal(d.update.latestBuild, 0)
  })

  await t.test('遥测上报进入后台设备列表', async () => {
    const r = await call(ctx.base, '/v1/telemetry', {
      method: 'POST',
      body: {
        version: '0.2.0',
        build: '200',
        model: 'deepseek-flash',
        page: 'settings',
        backendMode: 'upstream',
        stats: { conversations: 3, messages: 12 },
        lastError: { code: 'NETWORK', message: '断网', at: Date.now() },
        events: [{ t: Date.now(), type: 'error', code: 'NETWORK', message: '一次断网' }]
      }
    })
    const d = await json(r)
    assert.equal(d.ok, true)
    assert.equal(d.nextReportSec, 300)

    const devices = await json(await fetch(ctx.base + '/admin/api/devices', { headers: { Cookie: ctx.cookie } }))
    const dev = devices.devices.find((x) => x.deviceId === auth.deviceId)
    assert.ok(dev)
    assert.equal(dev.online, true)
    assert.equal(dev.telemetry.version, '0.2.0')
    assert.equal(dev.telemetry.model, 'deepseek-flash')

    const monitor = await json(await fetch(ctx.base + '/admin/api/monitor', { headers: { Cookie: ctx.cookie } }))
    assert.equal(monitor.counts.reported, 1)
    assert.equal(monitor.counts.online, 1)
    assert.ok(monitor.events.length >= 1)
  })

  await t.test('云控全局开关立即生效', async () => {
    const put = await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ features: { chat: false }, limits: { maxInputChars: 1200 } })
    })
    assert.equal(put.status, 200, JSON.stringify(await json(put)))
    const d = await json(await call(ctx.base, '/v1/control'))
    assert.equal(d.features.chat, false)
    assert.equal(d.limits.maxInputChars, 1200)

    // 恢复
    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ features: { chat: true }, limits: { maxInputChars: 4000 } })
    })
  })

  await t.test('单设备控制：停用后聊天 403，云控仍可读', async () => {
    const put = await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ disabled: true, notice: '测试停止服务', quota: { rpm: 1 } })
    })
    assert.equal(put.status, 200, JSON.stringify(await json(put)))

    const chat = await call(ctx.base, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }
    })
    assert.equal(chat.status, 403)
    const err = await json(chat)
    assert.equal(err.error.code, 'device_disabled')

    const ctl = await json(await call(ctx.base, '/v1/control'))
    assert.equal(ctl.device.disabled, true)
    assert.equal(ctl.notice, '测试停止服务')

    const detail = await json(await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId, {
      headers: { Cookie: ctx.cookie }
    }))
    assert.equal(detail.control.summary.disabled, true)
    assert.equal(detail.quota.rpm.limit, 1)

    const del = await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
      method: 'DELETE',
      headers: { Cookie: ctx.cookie }
    })
    assert.equal(del.status, 200)
    const ctl2 = await json(await call(ctx.base, '/v1/control'))
    assert.equal(ctl2.device.disabled, false)
  })

  await t.test('额度保存不接收旧字段', async () => {
    const put = await fetch(ctx.base + '/admin/api/quota', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ rpm: 7, dailyRequests: 999 })
    })
    const d = await json(put)
    assert.equal(d.ok, true)
    assert.equal(d.quota.rpm, 7)
    assert.equal(Object.prototype.hasOwnProperty.call(d.quota, 'dailyRequests'), false)

    const me = await json(await call(ctx.base, '/v1/me'))
    assert.equal(me.quota.rpm.limit, 7)
  })

  await t.test('维护窗口 + 白名单', async () => {
    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ maintenance: { enabled: true, message: '维护中', until: 0 } })
    })
    const blocked = await call(ctx.base, '/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] }
    })
    assert.equal(blocked.status, 503)

    await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ maintenanceBypass: true })
    })
    const bypass = await call(ctx.base, '/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] }
    })
    // 绕过维护后继续往下走：provider 不可达 → 502/503，但不再是 maintenance
    const body = await json(bypass)
    assert.notEqual(body.error && body.error.code, 'maintenance')

    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ maintenance: { enabled: false } })
    })
    await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
      method: 'DELETE',
      headers: { Cookie: ctx.cookie }
    })
  })

  await t.test('提示词注入：服务端拼进 system，单设备可覆盖', async () => {
    const captured = []
    const stub = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }))
      })
    })
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const original = ctx.app.ctx.config.provider.baseUrl
    ctx.app.ctx.config.provider.baseUrl = 'http://127.0.0.1:' + stub.address().port + '/v1'
    try {
      await fetch(ctx.base + '/admin/api/control', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
        body: JSON.stringify({ prompt: { enabled: true, system: 'SYS-RULE', append: 'APPEND-RULE' } })
      })
      const r = await call(ctx.base, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'CLIENT-SYS' },
            { role: 'user', content: 'hi' }
          ]
        }
      })
      assert.equal(r.status, 200, await r.clone().text())
      const sent = JSON.parse(captured[captured.length - 1])
      assert.equal(sent.messages[0].role, 'system')
      assert.ok(sent.messages[0].content.indexOf('SYS-RULE') === 0)
      assert.ok(sent.messages[0].content.indexOf('CLIENT-SYS') > 0)
      assert.ok(sent.messages[0].content.indexOf('APPEND-RULE') > 0)
      // 只注入一条 system，不新增第二条
      assert.equal(sent.messages.filter((m) => m.role === 'system').length, 1)

      // 单设备覆盖：只对这台设备换一套提示词
      await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
        body: JSON.stringify({ prompt: { enabled: true, system: 'DEVICE-RULE', append: '' } })
      })
      const r2 = await call(ctx.base, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }
      })
      assert.equal(r2.status, 200)
      const sent2 = JSON.parse(captured[captured.length - 1])
      assert.equal(sent2.messages[0].content, 'DEVICE-RULE')
      await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
        method: 'DELETE',
        headers: { Cookie: ctx.cookie }
      })
    } finally {
      ctx.app.ctx.config.provider.baseUrl = original
      await new Promise((resolve) => stub.close(resolve))
      await fetch(ctx.base + '/admin/api/control', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
        body: JSON.stringify({ prompt: { enabled: false } })
      })
    }
  })

  await t.test('联网工具说明 + 附件提示：都进 system，用户内容保持干净', async () => {
    const captured = []
    const stub = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }))
      })
    })
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const original = ctx.app.ctx.config.provider.baseUrl
    ctx.app.ctx.config.provider.baseUrl = 'http://127.0.0.1:' + stub.address().port + '/v1'
    try {
      // 带 web_search 工具：system 末尾补能力说明，只保留一条 system
      const withTools = await call(ctx.base, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'CLIENT-SYS' },
            { role: 'user', content: '今天有什么新闻' }
          ],
          tools: [{
            type: 'function',
            function: { name: 'web_search', parameters: { type: 'object', properties: {} } }
          }]
        }
      })
      assert.equal(withTools.status, 200, await withTools.clone().text())
      const sent = JSON.parse(captured[captured.length - 1])
      const sys = sent.messages.filter((m) => m.role === 'system')
      assert.equal(sys.length, 1)
      assert.ok(sys[0].content.indexOf('CLIENT-SYS') === 0)
      assert.ok(sys[0].content.indexOf('【联网能力】') > 0)
      assert.ok(sys[0].content.indexOf('web_search') > 0)

      // 不带工具：不注入能力说明（否则模型会"说要搜"却没工具可用）
      const noTools = await call(ctx.base, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }
      })
      assert.equal(noTools.status, 200)
      const sent2 = JSON.parse(captured[captured.length - 1])
      assert.equal(sent2.messages.some((m) => String(m.content || '').indexOf('【联网能力】') >= 0), false)

      // 客户端自己带过同一段说明：不重复注入
      const dup = await call(ctx.base, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: '【联网能力】客户端已声明' },
            { role: 'user', content: 'hi' }
          ],
          tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } }]
        }
      })
      assert.equal(dup.status, 200)
      const sentDup = JSON.parse(captured[captured.length - 1])
      assert.equal(sentDup.messages[0].content, '【联网能力】客户端已声明')

      // 不支持的附件：说明进 system，user 只剩用户原话
      const db = Buffer.from('SQLite format 3\u0000 binary', 'latin1')
      const withFile = await call(ctx.base, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'deepseek-chat',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '分析' },
              { type: 'file', file: { filename: 'course_app.db', file_data: 'data:application/octet-stream;base64,' + db.toString('base64') } }
            ]
          }]
        }
      })
      assert.equal(withFile.status, 200, await withFile.clone().text())
      const sent3 = JSON.parse(captured[captured.length - 1])
      assert.equal(sent3.messages.length, 2)
      assert.equal(sent3.messages[0].role, 'system')
      assert.ok(sent3.messages[0].content.indexOf('[附件状态]') === 0)
      assert.ok(sent3.messages[0].content.indexOf('course_app.db') > 0)
      const userParts = sent3.messages[1].content
      assert.equal(Array.isArray(userParts), true)
      assert.equal(userParts.length, 1)
      assert.deepEqual(userParts[0], { type: 'text', text: '分析' })
      assert.equal(JSON.stringify(sent3.messages).indexOf('系统提示'), -1)
    } finally {
      ctx.app.ctx.config.provider.baseUrl = original
      await new Promise((resolve) => stub.close(resolve))
    }
  })

  await t.test('文件上传 + AMR 自动识别 + 发布历史 + 受保护下载/断点续传', async () => {
    const bytes = createTestAmr({ version: '0.3.0', build: 300 })
    const up = await fetch(ctx.base + '/admin/api/files', {
      method: 'POST',
      headers: {
        Cookie: ctx.cookie,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('demo-0.3.0.amr'),
        'X-File-Kind': 'update'
      },
      body: bytes
    })
    const uploaded = await json(up)
    assert.equal(up.status, 200, JSON.stringify(uploaded))
    assert.equal(uploaded.file.size, bytes.length)
    assert.ok(uploaded.file.sha256)
    assert.equal(uploaded.file.version, '0.3.0')
    assert.equal(uploaded.file.build, 300)

    const pub = await fetch(ctx.base + '/admin/api/update/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ fileId: uploaded.file.id, minBuild: 0, notes: '测试包', force: true })
    })
    const published = await json(pub)
    assert.equal(pub.status, 200, JSON.stringify(published))
    assert.equal(published.update.latestBuild, 300)
    assert.equal(published.update.version, '0.3.0')
    assert.equal(published.update.url, '')
    assert.ok(published.downloadUrl.indexOf('/admin/api/files/') === 0)

    const ctl = await json(await call(ctx.base, '/v1/control'))
    assert.equal(ctl.update.latestBuild, 300)
    assert.equal(ctl.update.force, true)
    assert.equal(ctl.update.fileName, 'demo-0.3.0.amr')
    assert.equal(ctl.update.size, bytes.length)
    assert.equal(ctl.update.minBuild, 0)
    assert.ok(ctl.update.url.indexOf('/files/' + uploaded.file.id + '/') > 0)
    assert.ok(ctl.update.url.indexOf('ticket=') > 0)

    // 更新包无票据直接访问必须拒绝
    const denied = await fetch(ctx.base + '/files/' + uploaded.file.id + '/demo-0.3.0.amr')
    assert.equal(denied.status, 403)

    // 设备签名换取短时票据后可下载
    const ticketResp = await call(ctx.base, '/v1/update/ticket', {
      method: 'POST',
      body: { fileId: uploaded.file.id }
    })
    const ticket = await json(ticketResp)
    assert.equal(ticketResp.status, 200, JSON.stringify(ticket))
    assert.ok(ticket.url.startsWith(ctx.base + '/files/' + uploaded.file.id + '/'))
    assert.ok(ticket.url.indexOf('ticket=') > 0)
    assert.equal(ticket.sha256, uploaded.file.sha256)

    const dl = await fetch(ticket.url)
    assert.equal(dl.status, 200)
    assert.equal(Buffer.compare(Buffer.from(await dl.arrayBuffer()), bytes), 0)
    const part = await fetch(ticket.url, { headers: { Range: 'bytes=0-2' } })
    assert.equal(part.status, 206)
    assert.equal((await part.text()).slice(0, 2), 'PK')

    // 后台下载走 Cookie；发布历史能看见当前版本
    const adminDl = await fetch(ctx.base + '/admin/api/files/' + uploaded.file.id + '/download', {
      headers: { Cookie: ctx.cookie }
    })
    assert.equal(adminDl.status, 200)
    const rel = await json(await fetch(ctx.base + '/admin/api/releases', { headers: { Cookie: ctx.cookie } }))
    assert.ok(rel.releases.some((r) => r.id === published.release.id && r.current && r.build === 300))

    // 清理：删文件 + 复位更新策略
    await fetch(ctx.base + '/admin/api/files/' + uploaded.file.id, { method: 'DELETE', headers: { Cookie: ctx.cookie } })
    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ update: { latestBuild: 0, minBuild: 0, force: false, version: '', notes: '', url: '', fileId: '', fileName: '', size: 0, sha256: '' } })
    })
  })

  await t.test('反馈：完整日志落盘 / 下载 / 删除清理 + 筛选 / 备注 / 状态 / 导出', async () => {
    const logText = '===== ds-app.log（当前）=====\n2026-01-01T00:00:00Z | [error] chat: boom\n2026-01-01T00:00:01Z | [settings] theme: light -> dark\n'
    const submit = await call(ctx.base, '/v1/feedback', {
      method: 'POST',
      body: {
        category: 'bug',
        text: '设置页闪退',
        contact: 'a@b.c',
        build: '200',
        version: '0.2.0',
        diagnostics: { page: 'settings' },
        logs: { name: 'ds-app.log', text: logText, lines: 3, chars: logText.length, parts: [{ name: 'ds-app.log（当前）', lines: 3, chars: logText.length }] }
      }
    })
    const got = await json(submit)
    assert.equal(got.ok, true)
    const id = got.id

    const logPath = path.join(ctx.dir, 'data', 'feedback-logs', id + '.log')
    assert.equal(fs.existsSync(logPath), true, '完整日志应落盘为独立文件')
    assert.equal(fs.readFileSync(logPath, 'utf8'), logText)

    const q = await json(await fetch(ctx.base + '/admin/api/feedback?q=闪退&category=bug&limit=10', { headers: { Cookie: ctx.cookie } }))
    assert.equal(q.total, 1)
    assert.equal(q.feedback[0].id, id)
    assert.equal(q.stats.total, 1)
    // 列表不带日志正文，只带元信息
    assert.equal(q.feedback[0].log.lines, 3)
    assert.equal(q.feedback[0].log.text, undefined)

    const detail = await json(await fetch(ctx.base + '/admin/api/feedback/' + id, { headers: { Cookie: ctx.cookie } }))
    assert.equal(detail.entry.text, '设置页闪退')
    assert.equal(detail.logText, logText)
    assert.equal(detail.logMeta.lines, 3)

    const dl = await fetch(ctx.base + '/admin/api/feedback/' + id + '/log', { headers: { Cookie: ctx.cookie } })
    assert.equal(dl.status, 200)
    assert.equal(await dl.text(), logText)

    const note = await json(await fetch(ctx.base + '/admin/api/feedback/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ note: '已定位' })
    }))
    assert.equal(note.entry.note, '已定位')

    const handled = await json(await fetch(ctx.base + '/admin/api/feedback/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ status: 'handled', note: '已修' })
    }))
    assert.equal(handled.entry.status, 'handled')

    const csv = await fetch(ctx.base + '/admin/api/feedback/export.csv', { headers: { Cookie: ctx.cookie } })
    assert.equal(csv.status, 200)
    const text = await csv.text()
    assert.ok(text.indexOf('设置页闪退') > 0)

    const del = await fetch(ctx.base + '/admin/api/feedback/' + id, { method: 'DELETE', headers: { Cookie: ctx.cookie } })
    assert.equal(del.status, 200)
    assert.equal(fs.existsSync(logPath), false, '删除反馈应同时删除日志文件')
  })

  await t.test('调试模式：命令队列 + 云控授权 + 远程执行结果', async () => {
    // 未授权时拒绝
    const denied = await call(ctx.base, '/v1/debug/commands')
    const deniedText = await denied.clone().text()
    assert.equal(denied.status, 200, deniedText)
    const deniedBody = await json(denied)
    assert.equal(deniedBody.rce, false)
    assert.equal(deniedBody.commands.length, 0)

    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ debug: { allow: true, rce: true, report: true, pollSec: 5 } })
    })
    const queued = await json(await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/debug/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ type: 'eval', code: '1+1' })
    }))
    assert.equal(queued.ok, true)
    assert.ok(queued.command.id)

    const poll = await json(await call(ctx.base, '/v1/debug/commands'))
    assert.equal(poll.rce, true)
    assert.equal(poll.commands.length, 1)
    assert.equal(poll.commands[0].code, '1+1')

    const post = await call(ctx.base, '/v1/debug/results', {
      method: 'POST',
      body: { id: poll.commands[0].id, ok: true, output: '2', durationMs: 3 }
    })
    assert.equal((await json(post)).ok, true)

    const view = await json(await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/debug', {
      headers: { Cookie: ctx.cookie }
    }))
    assert.equal(view.queue.results[0].output, '2')

    // 长轮询：命令入队即时唤醒挂住的请求（等效推送），waited=true
    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ debug: { allow: true, rce: true, report: true, pollSec: 20 } })
    })
    const waitQuery = '/v1/debug/commands?wait=3'
    const started = Date.now()
    const lpPromise = call(ctx.base, waitQuery).then((r) => json(r))
    await new Promise((resolve) => setTimeout(resolve, 400))
    const lpQueue = await json(await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/debug/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ type: 'eval', code: '2+2' })
    }))
    assert.equal(lpQueue.ok, true)
    const lp = await lpPromise
    const elapsed = Date.now() - started
    assert.equal(lp.waited, true)
    assert.equal(lp.commands.length, 1)
    assert.equal(lp.commands[0].code, '2+2')
    assert.ok(elapsed < 2500, '长轮询应在入队后立即返回（实际 ' + elapsed + 'ms）')

    // 空队列长轮询超时：等满 wait 秒返回空数组（waited=true）
    const t0 = Date.now()
    const emptyLp = await json(await call(ctx.base, '/v1/debug/commands?wait=1'))
    assert.equal(emptyLp.commands.length, 0)
    assert.equal(emptyLp.waited, true)
    assert.ok(Date.now() - t0 >= 900, '空队列应等满 wait 秒再返回')

    // 单设备关闭调试授权 → 403
    await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ debug: { allow: false } })
    })
    const blocked = await call(ctx.base, '/v1/debug/commands')
    assert.equal(blocked.status, 403)
    await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId + '/control', {
      method: 'DELETE',
      headers: { Cookie: ctx.cookie }
    })
    await fetch(ctx.base + '/admin/api/control', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ debug: { allow: true, rce: false } })
    })
  })

  await t.test('后台概览与设备详情可读', async () => {
    const ov = await json(await fetch(ctx.base + '/admin/api/overview', { headers: { Cookie: ctx.cookie } }))
    assert.equal(ov.ok, true)
    assert.equal(ov.counts.devices, 1)
    assert.equal(ov.control.overrides, 0)
    assert.ok(ov.monitor)

    const detail = await json(await fetch(ctx.base + '/admin/api/devices/' + auth.deviceId, {
      headers: { Cookie: ctx.cookie }
    }))
    assert.equal(detail.ok, true)
    assert.equal(detail.device.deviceId, auth.deviceId)
    assert.ok(detail.quota.items.length)
    assert.ok(Array.isArray(detail.audit))
    assert.ok(detail.sessions)
  })

  await t.test('会话详情：后台可读完整消息内容', async () => {
    const sessionCall = signer(auth)
    const push = await json(await sessionCall(ctx.base, '/v1/sessions/c_testdetail_1', {
      method: 'POST',
      body: {
        title: '详情测试会话',
        mode: 'fast',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          { id: 'm1', role: 'user', content: '帮我看下这个问题', createdAt: Date.now() },
          { id: 'm2', role: 'assistant', content: '这是完整回复内容', reasoning: '思考过程……', createdAt: Date.now() }
        ]
      }
    }))
    assert.equal(push.ok, true, JSON.stringify(push))

    // 设备侧列表只有元信息
    const list = await json(await fetch(ctx.base + '/admin/api/sessions?deviceId=' + encodeURIComponent(auth.deviceId), { headers: { Cookie: ctx.cookie } }))
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].messageCount, 2)

    // 详情返回完整消息（标题之外的内容）
    const detail = await json(await fetch(ctx.base + '/admin/api/sessions/' + encodeURIComponent(auth.deviceId) + '/c_testdetail_1', { headers: { Cookie: ctx.cookie } }))
    assert.equal(detail.ok, true)
    assert.equal(detail.session.title, '详情测试会话')
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages[0].content, '帮我看下这个问题')
    assert.equal(detail.messages[1].content, '这是完整回复内容')
    assert.equal(detail.messages[1].reasoning, '思考过程……')

    // 不存在的会话 → 404
    const missing = await fetch(ctx.base + '/admin/api/sessions/' + encodeURIComponent(auth.deviceId) + '/c_nope', { headers: { Cookie: ctx.cookie } })
    assert.equal(missing.status, 404)

    // 清理
    await json(await sessionCall(ctx.base, '/v1/sessions/c_testdetail_1/delete', { method: 'POST', body: {} }))
  })

  await t.test('反馈诊断：日志字段放宽上限', async () => {
    const bigLog = Array.from({ length: 300 }, (_, i) => '2026-10-28T0' + (i % 10) + ':00:00Z | [chat] line ' + i).join('\n')
    const fb = await json(await call(ctx.base, '/v1/feedback', {
      method: 'POST',
      body: { category: 'bug', text: '带大日志的反馈测试', diagnostics: { mode: 'upstream', log: bigLog } }
    }))
    assert.equal(fb.ok, true, JSON.stringify(fb).slice(0, 200))
    const got = await json(await fetch(ctx.base + '/admin/api/feedback/' + fb.id, { headers: { Cookie: ctx.cookie } }))
    assert.equal(got.entry.diagnostics.log.split('\n').length, 300, '日志尾部不应被截成 2000 字符')
    assert.ok(got.entry.diagnostics.log.indexOf('[chat] line 299') >= 0)
    await fetch(ctx.base + '/admin/api/feedback/' + fb.id, { method: 'DELETE', headers: { Cookie: ctx.cookie } })
  })

  await t.test('tools 管理 API：查询 / 保存（key 掩码）/ 复位', async () => {
    const got = await json(await fetch(ctx.base + '/admin/api/tools', { headers: { Cookie: ctx.cookie } }))
    assert.equal(got.ok, true)
    assert.equal(got.tools.enabled, true)

    const put = await fetch(ctx.base + '/admin/api/tools', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ apiKey: 'sk-tools-test-0001', perDayPerDevice: 33, maxCount: 8 })
    })
    const saved = await json(put)
    assert.equal(put.status, 200, JSON.stringify(saved))
    assert.equal(saved.tools.apiKeySet, true)
    assert.ok(saved.tools.apiKeyMasked.indexOf('****') > 0)
    assert.equal(saved.tools.apiKey, undefined, '明文 key 绝不回传')
    assert.equal(saved.tools.perDayPerDevice, 33)
    assert.equal(saved.tools.maxCount, 8)
    assert.equal(saved.source, 'admin')

    // 非法值被拒
    const bad = await fetch(ctx.base + '/admin/api/tools', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
      body: JSON.stringify({ maxCount: 999 })
    })
    assert.equal(bad.status, 400)

    // 复位后回到 config.json 值（perDayPerDevice 默认 100）
    const del = await fetch(ctx.base + '/admin/api/tools', { method: 'DELETE', headers: { Cookie: ctx.cookie } })
    const reset = await json(del)
    assert.equal(del.status, 200)
    assert.equal(reset.source, 'config')
    assert.equal(reset.tools.perDayPerDevice, 100)
    assert.equal(reset.tools.apiKeySet, false)
  })
})

// ---------- 网页搜索/抓取代理（/v1/tools/search|fetch） ----------
//
// fetchImpl 打桩：不请求真实 DeepSeek，验证鉴权 / 转发参数 / 钳制 / 限额 / 错误映射。

test('tools 代理：未配置 503、成功转发、url 校验、按天限额', async (t) => {
  const dir = tempDir()
  const { config } = loadConfig({ configPath: path.join(dir, 'config.json'), env: {} })
  config.dataDir = path.join(dir, 'data')
  config.server.host = '127.0.0.1'
  config.server.port = 0
  config.provider.baseUrl = 'http://127.0.0.1:1/v1'
  config.provider.apiKey = 'test-key'
  config.tools.enabled = true
  config.tools.apiKey = ''
  config.tools.perDayPerDevice = 2
  config.tools.fetchMaxChars = 120
  config.tools.maxCount = 3

  const calls = []
  const stubFetch = async (url, opts) => {
    calls.push({ url, body: String((opts && opts.body) || '') })
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (path === '/v1/tools/search') {
      return new Response(JSON.stringify({
        results: [
          { rerank_score: 2.4, title: 'T1', url: 'https://a.example/1', snippet: 'S1', summary: 'U1'.repeat(3000), content: 'C1', site_name: 'A', site_icon: null, date: null, authority: 3 },
          { rerank_score: 1.0, title: 'T2', url: 'https://b.example/2', snippet: 'S2', summary: 'U2', content: '', site_name: null, date: null, authority: 1 }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path === '/v1/tools/fetch') {
      return new Response(JSON.stringify({ title: 'P', content: 'X'.repeat(500) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path === '/v1/tools/search-balance') {
      return new Response(JSON.stringify({ error: { message: '余额不足', type: 'invalid_request_error' } }), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }

  // 未配置 apiKey：先起一个实例验证 503
  const { server: server1, app: app1 } = createServer({ config: JSON.parse(JSON.stringify(config)) })
  await new Promise((resolve) => server1.listen(0, '127.0.0.1', resolve))
  const base1 = 'http://127.0.0.1:' + server1.address().port

  const reg1 = await json(await fetch(base1 + '/device/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ds-Client': CLIENT },
    body: JSON.stringify({ deviceId: 'pen-tools-00000001' })
  }))
  // /device/register 响应不含 deviceId 回显，调用方必须自带
  const call1 = signer({ deviceId: 'pen-tools-00000001', deviceToken: reg1.deviceToken, signSecret: reg1.signSecret })

  await t.test('未配置 tools.apiKey → 503 tools_not_configured', async () => {
    const r = await call1(base1, '/v1/tools/search', { method: 'POST', body: { query: 'hi' } })
    assert.equal(r.status, 503)
    const d = await json(r)
    assert.equal(d.error.code, 'tools_not_configured')
  })

  await new Promise((resolve) => server1.close(() => resolve()))
  try { fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }) } catch (_) { /* 忽略 */ }

  // 配置 apiKey + 打桩 fetch：主流程
  config.tools.apiKey = 'test-dsk'
  const { server, app } = createServer({ config, fetchImpl: stubFetch })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.after(() => {
    server.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
  })

  const reg = await json(await fetch(base + '/device/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ds-Client': CLIENT },
    body: JSON.stringify({ deviceId: 'pen-tools-00000002' })
  }))
  assert.equal(reg.enrolled, true)
  const auth = { deviceId: 'pen-tools-00000002', deviceToken: reg.deviceToken, signSecret: reg.signSecret }
  const call = signer(auth)

  await t.test('/health 暴露 tools 状态', async () => {
    const h = await json(await fetch(base + '/health'))
    assert.equal(h.tools.enabled, true)
    assert.equal(h.tools.configured, true)
  })

  await t.test('search：转发官方参数并钳制结果', async () => {
    const r = await call(base, '/v1/tools/search', {
      method: 'POST',
      body: { query: 'DeepSeek V4 发布', count: 99, ori_question: '最新模型是什么', need_content: false }
    })
    assert.equal(r.status, 200, await r.clone().text())
    const d = await json(r)
    assert.equal(d.results.length, 2)
    assert.equal(d.results[0].title, 'T1')
    // summary 被钳到 resultMaxChars（默认 2000）
    assert.ok(d.results[0].summary.length <= 2000)
    // 转发参数：count 被钳到 maxCount=3、带 ori_question
    const sent = JSON.parse(calls[calls.length - 1].body)
    assert.equal(calls[calls.length - 1].url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(sent.query, 'DeepSeek V4 发布')
    assert.equal(sent.count, 3)
    assert.equal(sent.ori_question, '最新模型是什么')
    assert.equal(sent.need_content, false)
  })

  await t.test('fetch：正文按 fetchMaxChars 截断', async () => {
    const r = await call(base, '/v1/tools/fetch', {
      method: 'POST',
      body: { url: 'https://example.com/article' }
    })
    assert.equal(r.status, 200)
    const d = await json(r)
    assert.equal(d.title, 'P')
    assert.equal(d.content.length, 120)
    assert.equal(d.truncated, true)
    assert.equal(JSON.parse(calls[calls.length - 1].body).url, 'https://example.com/article')
  })

  await t.test('fetch：非法 url → 400', async () => {
    for (const bad of ['', 'ftp://x/a', 'https://u:p@example.com/a', 'https:///nohost']) {
      const r = await call(base, '/v1/tools/fetch', { method: 'POST', body: { url: bad } })
      assert.equal(r.status, 400, 'url=' + bad)
    }
  })

  await t.test('按天限额（perDayPerDevice=2）→ 第 3 次 429', async () => {
    // 前面已成功 2 次（search+fetch），第 3 次应被限额
    const r = await call(base, '/v1/tools/search', { method: 'POST', body: { query: 'third' } })
    assert.equal(r.status, 429)
    const d = await json(r)
    assert.equal(d.error.code, 'tools_daily_limit')
  })

  await t.test('未签名请求被拒绝', async () => {
    const r = await fetch(base + '/v1/tools/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ds-Client': CLIENT },
      body: JSON.stringify({ query: 'anon' })
    })
    assert.equal(r.status, 401)
  })
})

test('AMR 构建号/版本号自动识别：融合字面量、dev 拼接产物、抢跑防护、元数据兜底', async () => {
  // 1) prod 风格：store 里是构建期融合好的单个字面量（build-wrapper 写进
  //    build-info.js 的 APP_VERSION），没有 release.json 也能识别构建号
  const fused = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 177,
    entries: [['store-abc.js', "var APP_VERSION = '0.2.0 build 177';"]]
  }), { name: '8000000000182376.0_2_0.amr' })
  assert.equal(fused.version, '0.2.0')
  assert.equal(fused.build, 177)
  assert.equal(fused.source, 'store-abc.js')

  // 2) dev 风格：版本串是运行时拼接（'0.2.0 build ' + BUILD_NUM），历史上
  //    这种产物导致后台「未能从包内提取构建号」；现在靠 BUILD_NUM 常量档兜底
  const dev = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 177,
    entries: [
      ['store-abc.js', "var BUILD_NUM = 177; var APP_VERSION = '0.2.0 build ' + BUILD_NUM;"]
    ]
  }), { name: 'dev.amr' })
  assert.equal(dev.build, 177)
  assert.equal(dev.source, 'store-abc.js')

  // 3) 抢跑防护：排在 store 前面的无关文件里恰有 `rebuild=1` / `build: 1`，
  //    不允许给出错误构建号——版本锚定的融合字面量档最优先
  const race = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 177,
    entries: [
      ['a-early.js', 'cfg.rebuild=1; var o = { build: 1 };'],
      ['store-abc.js', "var APP_VERSION = '0.2.0 build 177';"]
    ]
  }), { name: 'race.amr' })
  assert.equal(race.build, 177)
  assert.equal(race.source, 'store-abc.js')

  // 3b) 没有融合字面量时，BUILD_NUM 常量档也优先于无关文件的宽松 `build: 1`
  const raceConst = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 177,
    entries: [
      ['a-early.js', 'var o = { build: 1 };'],
      ['store-abc.js', "var BUILD_NUM = 177; var APP_VERSION = '0.2.0 build ' + BUILD_NUM;"]
    ]
  }), { name: 'race2.amr' })
  assert.equal(raceConst.build, 177)

  // 4) release.json 在子目录（重打包布局）也能被找到
  const nested = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 177,
    entries: [['meta/release.json', JSON.stringify({ build: 176 })]]
  }), { name: 'nested.amr' })
  assert.equal(nested.build, 176)
  assert.equal(nested.source, 'meta/release.json')

  // 5) manifest 缺 version 时从官方流水线文件名兜底（8000000000182376.0_2_0.amr）
  const noVer = inspectAmr(createTestAmr({
    version: '',
    build: 177,
    entries: [['store-abc.js', "var BUILD_NUM = 177;"]]
  }), { name: '8000000000182376.0_2_0.amr' })
  assert.equal(noVer.version, '0.2.0')
  assert.equal(noVer.build, 177)

  // 6) 包里确实什么构建信息都没有 → build=0，由调用方报「未能提取构建号」
  const none = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 0,
    entries: [['readme.json', '{"hello":"world"}']]
  }), { name: 'plain.amr' })
  assert.equal(none.build, 0)

  // 7) 根目录 release.json 仍然最高优先（现网 build-wrapper 的正常产物）
  const release = inspectAmr(createTestAmr({
    version: '0.2.0',
    build: 177,
    entries: [
      ['release.json', JSON.stringify({ build: 176 })],
      ['store-abc.js', "var APP_VERSION = '0.2.0 build 177';"]
    ]
  }), { name: 'rel.amr' })
  assert.equal(release.build, 176)
  assert.equal(release.source, 'release.json')
})
