/**
 * fs 模块浏览器 mock：用内存 Map 模拟应用 data 目录。
 * 机制见 api-mock/langningchen.js 头注释。
 */

const _files = new Map() // path -> string 内容
const _dirs = new Set(['.'])

function normalize(p) {
  return String(p || '.').replace(/\\/g, '/')
}

function parentDir(p) {
  const i = normalize(p).lastIndexOf('/')
  return i <= 0 ? '.' : normalize(p).slice(0, i)
}

export default {
  async readdir(path, options) {
    const p = normalize(path)
    const names = [..._files.keys(), ..._dirs]
      .filter((f) => parentDir(f) === p && f !== p)
      .map((f) => f.slice(f.lastIndexOf('/') + 1))
    const uniq = [...new Set(names)]
    if (options && options.withFileTypes) {
      return uniq.map((name) => ({
        name,
        isFile: () => _files.has(p === '.' ? name : `${p}/${name}`),
        isDirectory: () => _dirs.has(p === '.' ? name : `${p}/${name}`)
      }))
    }
    return uniq
  },

  async stat(path) {
    const p = normalize(path)
    const content = _files.get(p)
    const now = Date.now()
    return {
      size: content !== undefined ? content.length : 0,
      atimeMs: now,
      mtimeMs: now,
      birthtimeMs: now
    }
  },

  async exists(path) {
    const p = normalize(path)
    return _files.has(p) || _dirs.has(p)
  },

  async readFile(path) {
    const p = normalize(path)
    if (!_files.has(p)) {
      throw new Error(`[mock] fs.readFile: 文件不存在 ${p}`)
    }
    return _files.get(p)
  },

  async mkdir(path) {
    const p = normalize(path)
    _dirs.add(p)
    return true
  },

  async rm(path) {
    const p = normalize(path)
    _files.delete(p)
    _dirs.delete(p)
    for (const f of [..._files.keys()]) {
      if (f.startsWith(p + '/')) _files.delete(f)
    }
    return true
  },

  /** mock 专有：写文件（真实 fs 模块无此接口，测试/演示用） */
  async _writeFile(path, content) {
    const p = normalize(path)
    const dir = parentDir(p)
    if (dir !== '.') _dirs.add(dir)
    _files.set(p, String(content))
  }
}
