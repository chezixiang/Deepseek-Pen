// 相册图片：用 import fs 直接读 /userdisk/Pictures（真机已验证可读），
// 发送前用 ffmpeg 压缩到合理尺寸，再 base64 转 data URL（避免大图在 QuickJS 里内存爆掉导致设备卡死/重启）。
// 不再依赖 langningchen（本设备不存在该模块）。

import { readdir, execShell, waitForFile, sleep, mkdir } from './native.js'

const ALBUM = '/userdisk/Pictures'
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']

// 压缩目标：最长边 512px、JPEG 质量 3（ffmpeg -q:v 2-31，越小越好），
// 单图 base64 后约几十 KB，足够 DeepSeek 识图且不撑爆 QuickJS 内存。
function ext(name) {
  const i = String(name || '').lastIndexOf('.')
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''
}

export function isImage(name) {
  return IMAGE_EXTS.indexOf(ext(name)) >= 0
}

/**
 * 列出相册图片，返回 [{ name, path }]。
 */
export async function listAlbum() {
  const names = await readdir(ALBUM)
  if (!Array.isArray(names)) {
    throw new Error('无法访问相册 /userdisk/Pictures')
  }
  return names
    .filter((n) => isImage(n))
    .map((n) => ({ name: n, path: ALBUM + '/' + n }))
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/**
 * 压缩图片到 $dataDir 下的临时文件，返回压缩后的绝对路径；失败时返回原图路径。
 * 用 ffmpeg scale 到最长边 MAX_DIM 内，并转成 JPEG。
 */
export async function compressImage(srcPath) {
  await mkdir($dataDir)
  const id = Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
  const dst = `${$dataDir}img_${id}.jpg`
  const cmd = 'ffmpeg -y -i ' + shq(srcPath) +
    ' -vf ' + shq('scale=512:512:force_original_aspect_ratio=decrease') +
    ' -q:v 3 ' + shq(dst) +
    ' > /dev/null 2>&1; echo done > ' + shq(dst + '.ok')

  execShell(cmd)
  const ok = await waitForFile(dst + '.ok', 20000)
  if (ok === null) return srcPath
  await sleep(200)
  return dst
}

/**
 * 把本地图片转成 base64 data URL（先压缩）。execShell 无回显，故 base64 输出落盘后读回。
 */
export async function readImageDataUrl(path) {
  const compressed = await compressImage(path)
  const id = Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
  const out = `${$dataDir}b64_${id}.txt`

  // busybox base64 默认每 76 字符换行，JS 侧统一去空白即可。
  execShell('base64 ' + shq(compressed) + ' > ' + shq(out))

  const b64 = await waitForFile(out, 20000)
  if (b64 === null) return null

  const clean = String(b64).replace(/\s+/g, '')
  const name = String(compressed).split('/').pop()
  const extName = ext(name)
  const mime = (extName === 'png') ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${clean}`
}
