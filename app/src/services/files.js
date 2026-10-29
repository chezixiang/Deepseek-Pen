// 词典笔本地文件：给聊天输入区提供"上传文件"入口。
//
// 设备没有通用文件选择器。这里提供一个简单的文件浏览器：从 /userdisk
// （用户盘根，必存在）出发逐级进入目录，任意文件都可选中发送，不做
// 扩展名过滤；读取时用 busybox base64 落盘再读回——Falcon fs 的
// readFile 是文本接口，不能直接把 PDF/DOCX 二进制塞进 QuickJS。
//
// 体积上限刻意保守：后端会把 file_data 再放进请求 JSON，弱内存设备上
// 1.5MB 原文件已经接近可承受范围。

import { dataDirBase, debugLog, execShell, joinPath, readFile, shq, statSize, waitForFile } from './store.js'

const MAX_ATTACH_BYTES = 1.5 * 1024 * 1024
const MAX_ATTACH_COUNT = 2
// 单目录最多展示的条目数，防止误入巨型目录把 UI/内存拖垮
const MAX_LIST = 200
// 浏览器根目录：不允许越出用户盘，避免接触系统目录
const BROWSER_ROOT = '/userdisk'
const MIME = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  epub: 'application/epub+zip',
  rtf: 'application/rtf'
}

function extOf(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  return i >= 0 ? s.slice(i + 1).toLowerCase() : ''
}

function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream'
}

function fmtSize(n) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + 'MB'
  if (v >= 1024) return Math.round(v / 1024) + 'KB'
  return v + 'B'
}

/**
 * 浏览一个目录，返回「子目录在前、文件在后」的条目列表。
 *
 * Falcon fs 只有 readdir（纯名字，无类型），判断目录/文件要么逐条试探
 * readdir，要么交给 shell。这里用 root shell 跑一次 `ls -1Ap`：-p 给目录
 * 名加尾部 /，-A 去掉 . ..，-1 每行一个条目，结果落盘到应用可读的临时
 * 文件再取回（execShell 异步，沿用 base64 上传的 waitForFile 模式）。
 * 文件大小再用 fs.stat 逐个补齐；ls 与 stat 都失败时大小按 0 显示。
 *
 * @returns {Promise<Array<{name,path,isDir,size,sizeText,mime}>>}
 */
async function browseDir(dir) {
  const path = String(dir || BROWSER_ROOT)
  if (!path.startsWith(BROWSER_ROOT)) throw new Error('只能浏览 ' + BROWSER_ROOT + ' 下的目录')
  const id = Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
  const out = joinPath(dataDirBase(), 'file_ls_' + id + '.txt')
  execShell('ls -1Ap ' + shq(path) + ' > ' + shq(out) + ' 2>/dev/null; echo done > ' + shq(out) + '.ok')
  const ok = await waitForFile(out + '.ok', 15000)
  let raw = ''
  try {
    if (ok === null) throw new Error('列目录超时，请重试')
    raw = await readFile(out) || ''
  } finally {
    execShell('rm -f ' + shq(out) + ' ' + shq(out) + '.ok 2>/dev/null || true')
  }
  const dirs = []
  const files = []
  const lines = String(raw).split('\n')
  for (const line of lines) {
    if (dirs.length + files.length >= MAX_LIST) break
    const entry = line.replace(/\r$/, '')
    if (!entry) continue
    const isDir = entry.slice(-1) === '/'
    const name = isDir ? entry.slice(0, -1) : entry
    if (!name) continue
    const item = { name, path: joinPath(path, name), isDir }
    if (isDir) dirs.push(item)
    else {
      item.size = 0
      item.sizeText = fmtSize(0)
      item.mime = mimeOf(name)
      files.push(item)
    }
  }
  for (const f of files) {
    let size = 0
    try { size = await statSize(f.path) } catch (e) { size = 0; debugLog('[files] 读取大小失败 ' + f.path) }
    f.size = size
    f.sizeText = fmtSize(size)
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  dirs.sort(byName)
  files.sort(byName)
  return dirs.concat(files)
}

/**
 * 读取本地文件并转成 data URL。超过上限直接抛错，避免把设备内存打爆。
 * @returns {Promise<string>} data:{mime};base64,...
 */
async function readLocalFileDataUrl(path, name) {
  const size = await statSize(path)
  if (!size) throw new Error('文件为空或无法读取')
  if (size > MAX_ATTACH_BYTES) {
    throw new Error('文件不能超过 ' + fmtSize(MAX_ATTACH_BYTES) + '（当前 ' + fmtSize(size) + '）')
  }
  const id = Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
  const out = joinPath(dataDirBase(), 'file_b64_' + id + '.txt')
  execShell('base64 ' + shq(path) + ' > ' + shq(out) + ' 2>/dev/null; echo done > ' + shq(out) + '.ok')
  const ok = await waitForFile(out + '.ok', 30000)
  if (ok === null) {
    execShell('rm -f ' + shq(out) + ' ' + shq(out) + '.ok 2>/dev/null || true')
    throw new Error('读取文件超时')
  }
  let raw = ''
  try {
    raw = await readFile(out) || ''
  } finally {
    execShell('rm -f ' + shq(out) + ' ' + shq(out) + '.ok 2>/dev/null || true')
  }
  const clean = String(raw).replace(/\s+/g, '')
  if (!clean) throw new Error('文件编码为空，无法上传')
  if (clean.length > Math.ceil(MAX_ATTACH_BYTES * 4 / 3) + 1024) throw new Error('文件超出体积上限')
  return 'data:' + mimeOf(name || path) + ';base64,' + clean
}

export {
  BROWSER_ROOT,
  MAX_ATTACH_BYTES,
  MAX_ATTACH_COUNT,
  extOf,
  fmtSize,
  browseDir,
  mimeOf,
  readLocalFileDataUrl
}
