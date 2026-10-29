// 文件库：管理后台上传的应用包（.amr）与普通文件，客户端可按 URL 下载。
//
// 设计：
//   - 元数据存 data/files.json，字节存 data/files/<id><ext>（原子写 + 0600）；
//   - 上传走原始二进制（octet-stream + X-File-Name），不引 multipart 依赖；
//   - 普通资源走公开下载 /files/<id>/<name>；应用包（kind=update）必须带短时票据，
//     由 ReleaseManager 签发，避免更新包被脚本无限爬取；
//   - 文件名只用于展示与 Content-Disposition，磁盘路径永远由 id 决定。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_FILE_BYTES = 64 * 1024 * 1024

const MIME_BY_EXT = {
  '.amr': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.log': 'text/plain; charset=utf-8'
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 只保留安全字符；中文/空格转成下划线，避免 Content-Disposition 与路由编码踩坑 */
export function safeName(name, fallback = 'file.bin') {
  const base = path.basename(String(name || '').replace(/\\/g, '/'))
  let out = ''
  for (const ch of base) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else if (/[\u4e00-\u9fa5]/.test(ch)) out += ch
    else out += '_'
  }
  out = out.replace(/_+/g, '_').replace(/^[_.]+/, '')
  if (!out) out = fallback
  return out.slice(-120)
}

function extOf(name) {
  const e = path.extname(String(name || '')).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(e) ? e : ''
}

export function mimeOf(name, fallback = 'application/octet-stream') {
  return MIME_BY_EXT[extOf(name)] || fallback
}

export class FileStore {
  constructor({ dataDir } = {}) {
    this.dir = path.join(dataDir || 'data', 'files')
    this.metaFile = path.join(dataDir || 'data', 'files.json')
    this.items = []
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.metaFile)) {
        const raw = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.items) ? raw.items : [])
        this.items = list.filter((x) => x && x.id).map((x) => ({
          id: String(x.id),
          name: safeName(x.name || ''),
          ext: extOf(x.name || ''),
          mime: String(x.mime || mimeOf(x.name || '')),
          size: Math.max(0, Math.trunc(Number(x.size) || 0)),
          sha256: String(x.sha256 || ''),
          kind: String(x.kind || 'file'),
          note: String(x.note || '').slice(0, 200),
          build: Math.max(0, Math.trunc(Number(x.build) || 0)),
          version: String(x.version || '').slice(0, 40),
          appId: String(x.appId || '').slice(0, 40),
          appName: String(x.appName || '').slice(0, 80),
          createdAt: Math.trunc(Number(x.createdAt) || 0),
          downloads: Math.max(0, Math.trunc(Number(x.downloads) || 0))
        }))
      }
    } catch (e) {
      process.stderr.write('[files] 读取元数据失败（从空开始）：' + e.message + '\n')
      this.items = []
    }
    return this.items
  }

  _write() {
    fs.mkdirSync(path.dirname(this.metaFile), { recursive: true })
    const payload = { version: 1, updatedAt: Date.now(), items: this.items }
    const tmp = this.metaFile + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
    fs.renameSync(tmp, this.metaFile)
  }

  pathOf(id) {
    const item = this.get(id)
    if (!item) return ''
    return path.join(this.dir, item.id + item.ext)
  }

  get(id) {
    const key = String(id || '')
    return this.items.filter((x) => x.id === key)[0] || null
  }

  list({ kind = '' } = {}) {
    return this.items
      .filter((x) => !kind || x.kind === kind)
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  /**
   * 保存一个上传文件。
   * @param {{name:string, buffer:Buffer, mime?:string, kind?:string, note?:string}} input
   */
  save({ name, buffer, mime = '', kind = 'file', note = '', release = null }) {
    if (!buffer || !buffer.length) throw new Error('文件内容为空')
    if (buffer.length > MAX_FILE_BYTES) throw new Error('文件超过 ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + 'MB 上限')
    const clean = safeName(name)
    const ext = extOf(clean)
    const id = 'f_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex')
    fs.mkdirSync(this.dir, { recursive: true })
    const target = path.join(this.dir, id + ext)
    const tmp = target + '.part'
    fs.writeFileSync(tmp, buffer)
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows 无意义 */ }
    fs.renameSync(tmp, target)
    const info = release && typeof release === 'object' ? release : {}
    const item = {
      id,
      name: clean,
      ext,
      mime: String(mime || mimeOf(clean)),
      size: buffer.length,
      sha256: sha256(buffer),
      kind: String(kind || 'file').slice(0, 24),
      note: String(note || '').slice(0, 200),
      build: Math.max(0, Math.trunc(Number(info.build) || 0)),
      version: String(info.version || '').slice(0, 40),
      appId: String(info.appId || '').slice(0, 40),
      appName: String(info.appName || '').slice(0, 80),
      createdAt: Date.now(),
      downloads: 0
    }
    this.items.push(item)
    // 只保留最近 200 条元数据；磁盘上的孤儿文件由 operator 清理
    if (this.items.length > 200) this.items = this.items.slice(-200)
    this._write()
    return item
  }

  /** 补写 AMR 解析结果（旧版本上传的文件没有 build/version 字段）。 */
  updateRelease(id, info = {}) {
    const item = this.get(id)
    if (!item) return null
    item.build = Math.max(0, Math.trunc(Number(info.build) || 0))
    item.version = String(info.version || '').slice(0, 40)
    item.appId = String(info.appId || '').slice(0, 40)
    item.appName = String(info.appName || '').slice(0, 80)
    if (item.kind !== 'update') item.kind = 'update'
    this._write()
    return item
  }

  remove(id) {
    const item = this.get(id)
    if (!item) return false
    const p = this.pathOf(id)
    this.items = this.items.filter((x) => x.id !== item.id)
    this._write()
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch (_) { /* 忽略 */ }
    return true
  }

  /** 记录一次下载（只用于后台展示，失败不影响下载） */
  touchDownload(id) {
    const item = this.get(id)
    if (!item) return
    item.downloads = (item.downloads || 0) + 1
    try { this._write() } catch (_) { /* 忽略 */ }
  }

  /** 公开下载地址（优先用配置里的 publicUrl） */
  urlOf(id, publicUrl = '') {
    const item = this.get(id)
    if (!item) return ''
    const base = String(publicUrl || '').replace(/\/+$/, '')
    const rel = '/files/' + encodeURIComponent(item.id) + '/' + encodeURIComponent(item.name)
    return base ? base + rel : rel
  }
}
