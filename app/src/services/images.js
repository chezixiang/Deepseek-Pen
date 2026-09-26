// 相册图片：用 import fs 直接读 /userdisk/Pictures（真机已验证可读），
// 发送前用 ffmpeg 压缩到合理尺寸，再 base64 转 data URL（避免大图在 QuickJS 里内存爆掉导致设备卡死/重启）。
// 不再依赖 langningchen（本设备不存在该模块）。

import { readdir, execShell, waitForFile, sleep, mkdir, joinPath, dataDirBase, statSize, exists } from './native.js'

const ALBUM = '/userdisk/Pictures'
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']

// 压缩目标：最长边 512px、JPEG 质量 3（ffmpeg -q:v 2-31，越小越好），
// 单图 base64 后约几十 KB，足够 DeepSeek 识图且不撑爆 QuickJS 内存。
function ext(name) {
  const i = String(name || '').lastIndexOf('.')
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''
}

// 单图硬上限：压缩产物超过这个体积就不参与发送。
// 设备只有 ~1GB 内存，data URL 还要再涨 1/3；历史上"大图撑爆 QuickJS 导致设备
// 卡死/重启"就是这么来的（见文件头注释）。注意压缩失败时 compressImage 会
// 回落到原图路径（常见好几 MB），这里必须拦，宁可不发也不能把设备搞挂。
const MAX_IMAGE_BYTES = 900 * 1024
const MAX_BASE64_CHARS = 1280 * 1024

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

// 把源路径映射成稳定的压缩缓存名（djb2）：同一张图会被反复发送
// （重试 / 修改 / 多轮携带），命中缓存可省掉重复的 ffmpeg 调用。
function pathKey(p) {
  const s = String(p || '')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * 为相册列表生成缩略图（256px），返回缩略图路径；失败返回原图路径。
 *
 * 必须用缩略图渲染列表：相册里是相机原图（12MP），几十张原图同时进入
 * image 解码队列会堵死渲染线程——真机表现为"相册浮层全黑"（连头部
 * 都画不出来）。缩略图按 djb2 缓存，重复打开不重做。
 */
export async function ensureThumb(srcPath) {
  await mkdir(dataDirBase())
  const dst = joinPath(dataDirBase(), 'thumb_' + pathKey(srcPath) + '.jpg')
  if (await exists(dst) && (await statSize(dst)) > 0) return dst

  const okFile = dst + '.ok'
  const cmd = 'ffmpeg -y -i ' + shq(srcPath) +
    ' -vf ' + shq('scale=256:256:force_original_aspect_ratio=decrease') +
    ' -q:v 5 ' + shq(dst) +
    ' > /dev/null 2>&1; echo done > ' + shq(okFile)
  execShell(cmd)
  const ok = await waitForFile(okFile, 15000)
  execShell('rm -f ' + shq(okFile) + ' 2>/dev/null || true')
  if (ok === null) return srcPath
  await sleep(80)
  return dst
}

/**
 * 压缩图片到 $dataDir 下的临时文件，返回压缩后的绝对路径；失败时返回原图路径。
 * 用 ffmpeg scale 到最长边 MAX_DIM 内，并转成 JPEG。
 */
export async function compressImage(srcPath) {
  await mkdir(dataDirBase())
  const dst = joinPath(dataDirBase(), 'img_' + pathKey(srcPath) + '.jpg')
  if (await exists(dst) && (await statSize(dst)) > 0) return dst

  const okFile = dst + '.ok'
  const cmd = 'ffmpeg -y -i ' + shq(srcPath) +
    ' -vf ' + shq('scale=512:512:force_original_aspect_ratio=decrease') +
    ' -q:v 3 ' + shq(dst) +
    ' > /dev/null 2>&1; echo done > ' + shq(okFile)

  execShell(cmd)
  const ok = await waitForFile(okFile, 20000)
  execShell('rm -f ' + shq(okFile) + ' 2>/dev/null || true')
  if (ok === null) return srcPath
  await sleep(200)
  return dst
}

/**
 * 把本地图片转成 base64 data URL（先压缩）。execShell 无回显，故 base64 输出落盘后读回。
 * 超过体积上限（或压缩不可用导致回落到原图）时返回 null —— 调用方应据此提示用户，
 * 而不是把几 MB 的图片内联进消息（那是设备重启的已知诱因）。
 */
export async function readImageDataUrl(path) {
  const compressed = await compressImage(path)
  // stat 取不到体积（个别机型 fs.stat 不可用）时放行，靠下面的 base64 长度二次拦截
  const size = await statSize(compressed)
  if (size > MAX_IMAGE_BYTES) return null

  const id = Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
  const out = joinPath(dataDirBase(), 'b64_' + id + '.txt')

  // busybox base64 默认每 76 字符换行，JS 侧统一去空白即可。
  execShell('base64 ' + shq(compressed) + ' > ' + shq(out))

  const b64 = await waitForFile(out, 20000)
  if (b64 === null) return null
  execShell('rm -f ' + shq(out) + ' 2>/dev/null || true')

  const clean = String(b64).replace(/\s+/g, '')
  if (clean.length > MAX_BASE64_CHARS) return null

  const name = String(compressed).split('/').pop()
  const extName = ext(name)
  const mime = (extName === 'png') ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${clean}`
}
