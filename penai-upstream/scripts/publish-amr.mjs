#!/usr/bin/env node
// 发布 AMR 更新包的小型运维工具。
//
// 用途：管理后台不可用 / 需要在服务器上直接发布构建产物时使用。
// 它走同一套 FileStore + ControlStore + ReleaseManager，保证包元数据、
// 云控 update 与发布历史一致；下载地址不再写入公开 /files 直链。
//
// 用法：
//   node scripts/publish-amr.mjs /path/to/app.amr \
//     --notes "修复更新检查" [--force] [--min-build 0] [--note-file notes.txt]
//
// 注意：生产环境建议 `runuser -u penai -- node scripts/publish-amr.mjs …`，
// 避免把 data/ 下的文件写成 root 属主。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { createApp } from '../server.js'
import { inspectAmr } from '../src/amr.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function fail(message) {
  process.stderr.write('[publish-amr] ' + message + '\n')
  process.exit(1)
}

function readArgs(argv) {
  const out = { notes: '', force: false, minBuild: 0 }
  let filePath = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--notes') out.notes = String(argv[++i] || '')
    else if (a === '--note-file') out.notes = fs.readFileSync(String(argv[++i] || ''), 'utf8').trim()
    else if (a === '--force') out.force = true
    else if (a === '--min-build') out.minBuild = Math.max(0, Math.trunc(Number(argv[++i]) || 0))
    else if (!filePath) filePath = a
  }
  if (!filePath) fail('用法：node scripts/publish-amr.mjs <app.amr> [--notes "..."] [--force] [--min-build 0]')
  return { filePath, ...out }
}

const { filePath, notes, force, minBuild } = readArgs(process.argv.slice(2))
const absolutePath = path.resolve(filePath)
const name = path.basename(absolutePath)

let buffer
try {
  buffer = fs.readFileSync(absolutePath)
} catch (e) {
  fail('读取更新包失败：' + e.message)
}

let info
try {
  info = inspectAmr(buffer, { name })
} catch (e) {
  fail('解析 AMR 失败：' + e.message)
}
if (!info.version) fail('AMR 缺少 version 字段')
if (!info.build) fail('未能从 AMR 提取构建号（可在构建产物中包含 release.json）')
if (minBuild > info.build) fail('最低可用构建号不能大于包内构建号')

const config = loadConfig({
  configPath: process.env.UPSTREAM_CONFIG || path.join(ROOT, 'config.json'),
  env: process.env
}).config
const app = createApp({ config })
const ctx = app.ctx

const item = ctx.files.save({
  name,
  buffer,
  kind: 'update',
  note: notes,
  release: info
})

const update = {
  latestBuild: info.build,
  minBuild,
  force,
  version: info.version,
  notes,
  // 不落公开直链：客户端拉云控时由服务端现签短时票据。
  url: '',
  fileId: item.id,
  fileName: item.name,
  size: item.size,
  sha256: item.sha256,
  publishedAt: Date.now()
}

const control = ctx.control.update({ update })
const release = ctx.releases.record({
  ...update,
  scope: 'global',
  name: item.name
})
ctx.store.audit('update_published', {
  fileId: item.id,
  name: item.name,
  build: update.latestBuild,
  version: update.version,
  force,
  source: 'cli'
})

process.stdout.write(JSON.stringify({
  ok: true,
  fileId: item.id,
  releaseId: release.id,
  build: control.update.latestBuild,
  version: control.update.version,
  size: item.size,
  sha256: item.sha256,
  force: control.update.force,
  message: '已发布；更新包仅允许持有效设备票据下载'
}, null, 2) + '\n')
