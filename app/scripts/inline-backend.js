#!/usr/bin/env node
// 把 backend 二进制转成 base64 内嵌到 JS 模块，供 deployBackend() 运行时写入 /userdisk
const fs = require('fs');
const path = require('path');

const backendDir = path.resolve('backend');
const outFile = path.resolve('src/services/backend-blob.js');

function findBinary() {
  const candidates = [
    'backend/linux-aarch64-gnu/ds-free-api',
    'backend/linux-x86_64/ds-free-api',
  ]
  for (const c of candidates) {
    const full = path.resolve(c)
    if (fs.existsSync(full)) return full
  }
  return null
}

// 从候选路径推断架构标签（如 "linux-aarch64-gnu"），供运行时 uname -m 校验
function archTagFor(full) {
  const rel = path.relative(path.resolve('backend'), full)
  const parts = rel.split(path.sep)
  return parts.length > 1 ? parts[0] : 'unknown'
}

const src = findBinary()
if (!src) {
  console.error('未找到 backend 二进制，请先复制到 backend/ 目录')
  process.exit(1)
}

const data = fs.readFileSync(src)
const b64 = data.toString('base64')
const blobName = path.basename(src)
const archTag = archTagFor(src)

const content = `// 此文件由 scripts/inline-backend.js 自动生成，不要手动编辑。
// 内嵌 ds-free-api 二进制（${blobName}，base64，架构 ${archTag}）
export const BACKEND_B64 = ${JSON.stringify(b64)}
export const BACKEND_NAME = ${JSON.stringify(blobName)}
export const BACKEND_ARCH = ${JSON.stringify(archTag)}
`

fs.writeFileSync(outFile, content)
console.log('内嵌完成:', outFile)
console.log('架构标签:', archTag)
console.log('原始大小:', (data.length / 1024).toFixed(1), 'KB')
console.log('Base64 长度:', (b64.length / 1024).toFixed(1), 'KB')