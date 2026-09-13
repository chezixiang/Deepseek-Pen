// Emoji 字体（实验）：下载 NotoColorEmoji 并通过 dom.addRule 注册，
// 解决设备缺 emoji 字形导致的白块。依赖设备支持 weex dom 模块，
// 不可用时 all 接口返回失败原因，界面降级为普通渲染（不影响使用）。

import { execShell, exists, statSize, shq, waitForFile, joinPath, dataDirBase } from './native.js'
import { appLog } from './app-log.js'

const FONT_DIR = () => joinPath(dataDirBase(), 'fonts')
const FONT_PATH = () => joinPath(FONT_DIR(), 'NotoColorEmoji.ttf')
// NotoColorEmoji v2.047 实际约 10MB；阈值取 8MB，避免被 CDN 错误页/截断响应
// （几十 KB 到几 MB）当成成功下载后注册出一个坏字体。
const MIN_FONT_SIZE = 8 * 1024 * 1024

// 主源 + 备源（jsdelivr 主/子域）
const FONT_URLS = [
  'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/fonts/NotoColorEmoji.ttf',
  'https://fastly.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/fonts/NotoColorEmoji.ttf'
]

export const EMOJI_FONT_FAMILY = 'NotoColorEmoji'

// 注册结果缓存，避免重复 addRule
let registered = false

// 取 dom 模块并说明失败原因。
// 原实现把三种完全不同的情况（无 weex 全局 / 无 requireModule / 模块无 addRule）
// 都压成一句"dom 模块不可用"，并 catch 掉框架的真实报错，导致用户报告无法定位。
// 现在分别返回原因，并把 requireModule 抛出的异常带出来。
function resolveDomModule() {
  if (typeof weex === 'undefined' || !weex) {
    return { dom: null, reason: '当前运行环境没有 weex 全局对象' }
  }
  if (typeof weex.requireModule !== 'function') {
    return { dom: null, reason: 'weex.requireModule 不存在（框架版本不支持）' }
  }
  let mod = null
  try {
    mod = weex.requireModule('dom')
  } catch (e) {
    return {
      dom: null,
      reason: 'requireModule("dom") 抛出异常：' + (e && e.message ? e.message : String(e))
    }
  }
  if (!mod) {
    return { dom: null, reason: 'dom 模块未在本设备注册' }
  }
  if (typeof mod.addRule !== 'function') {
    const keys = (() => {
      try { return Object.keys(mod).join(',') } catch (e) { return '不可枚举' }
    })()
    return {
      dom: null,
      reason: 'dom 模块缺少 addRule 接口（本设备固件不支持动态注册字体）；可用接口：' + (keys || '无')
    }
  }
  return { dom: mod, reason: '' }
}

/**
 * 确保 emoji 字体已就绪并注册。返回 { ok, message }。
 * 流程：已存在且非空 → 直接注册；否则逐个源 curl 下载（-L 跟随重定向）→ 校验大小 → 注册。
 *
 * 注意：字体注册依赖 weex dom.addRule('fontFace')。本项目探针
 * （.probe/jsframework.txt 等）中未发现 addRule 实现，多数词典笔固件不支持，
 * 因此本功能预期在部分设备上直接返回 ok:false —— 这是能力缺失，不是 bug，
 * 界面据此降级为普通渲染。
 */
export async function ensureEmojiFont() {
  const { dom, reason } = resolveDomModule()
  if (!dom) {
    appLog('[emoji] 字体注册不可用：' + reason)
    return { ok: false, message: '设备不支持字体注册（' + reason + '）' }
  }
  if (registered) return { ok: true, message: '已注册' }

  const path = FONT_PATH()
  let size = (await exists(path)) ? await statSize(path) : 0
  if (!size || size < MIN_FONT_SIZE) {
    const dir = FONT_DIR()
    const tmp = path + '.part'
    const resultFile = joinPath(dataDirBase(), 'emoji-font-result.txt')
    let downloaded = false
    for (const url of FONT_URLS) {
      appLog('[emoji] 下载字体: ' + url)
      try {
        execShell('rm -f ' + shq(resultFile) + ' ' + shq(tmp) + ' 2>/dev/null || true')
        const cmd =
          'mkdir -p ' + shq(dir) + ' && ' +
          'curl -L -s -m 300 ' + shq(url) + ' -o ' + shq(tmp) + ' && ' +
          'printf ok > ' + shq(resultFile) + ' || printf failed > ' + shq(resultFile)
        execShell(cmd)
        // 等待下载完成（最长 5 分钟）
        const result = String(await waitForFile(resultFile, 300000) || '')
        if (result.indexOf('ok') === 0) {
          size = await statSize(tmp)
          if (size >= MIN_FONT_SIZE) {
            execShell('mv -f ' + shq(tmp) + ' ' + shq(path))
            downloaded = true
            break
          }
        }
      } catch (e) {
        appLog('[emoji] 下载异常 ' + (e && e.message ? e.message : String(e)))
      }
    }
    try { execShell('rm -f ' + shq(path + '.part') + ' ' + shq(resultFile)) } catch (e) { /* 忽略 */ }
    if (!downloaded) {
      // 带上最后一次拿到的字节数：区分"完全没下到"和"下到一半/拿到错误页"
      const msg = size > 0
        ? '下载不完整（只拿到 ' + Math.round(size / 1024) + 'KB，需要约 10MB），请检查网络后重试'
        : '下载失败（检查网络后重试，字体约 10MB）'
      appLog('[emoji] ' + msg)
      return { ok: false, message: msg }
    }
  }

  try {
    dom.addRule('fontFace', {
      fontFamily: EMOJI_FONT_FAMILY,
      src: "url('file://" + path + "')"
    })
    registered = true
    appLog('[emoji] 字体已注册: ' + path)
    return { ok: true, message: 'Emoji 字体已就绪' }
  } catch (e) {
    const msg = '字体注册失败：' + (e && e.message ? e.message : String(e))
    appLog('[emoji] ' + msg)
    return { ok: false, message: msg }
  }
}
