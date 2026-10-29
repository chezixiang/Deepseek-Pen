// E2E 验证脚本（临时，跑完即删）：
// 1) 复现：ds-free-api 私有 file 块原样发给上游 new-api → 预期 400
// 2) 修复：normalizeMessageAttachments 转换后发 → 预期 200
// key 从生产 data/provider.json 读取（后台「上游」页配置处），不打印明文。
import fs from 'node:fs'

const pj = JSON.parse(fs.readFileSync('/opt/penai-upstream/data/provider.json', 'utf8')).provider || {}
const key = pj.apiKey || ''
const base = pj.baseUrl || 'http://127.0.0.1:3000/v1'
const model = pj.defaultModel || 'deepseek-flash'

const { normalizeMessageAttachments } = await import('/opt/penai-upstream/src/attachments.js')

async function chat(messages) {
  const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, stream: false, messages, max_tokens: 100 })
  })
  const text = await r.text()
  return { status: r.status, head: text.slice(0, 200).replace(/\s+/g, ' ') }
}

const filePart = {
  type: 'file',
  file: {
    filename: '笔记.txt',
    file_data: 'data:application/octet-stream;base64,' +
      Buffer.from('今天天气很好，适合出门散步。').toString('base64')
  }
}

// a) 原始私有协议（复现问题）
const raw = [{ role: 'user', content: [{ type: 'text', text: '请用一句话总结这个文件的内容' }, filePart] }]
console.log('RAW :', JSON.stringify(await chat(raw)))

// b) 网关转换后（修复路径）
const converted = normalizeMessageAttachments(JSON.parse(JSON.stringify(raw)))
console.log('CONV parts:', JSON.stringify(converted[0].content.map((p) => p.type)))
console.log('CONV:', JSON.stringify(await chat(converted)))
