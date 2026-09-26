// 拍照与取景：完全对齐"计算器"app（8001687764241342）的实现。
//
// 硬件事实（2026-09-25 真机 + DRM 状态实证）：
// - 主摄两颗输出节点：video29（rkisp mainpath）、video30（selfpath），可并存。
// - 预览：计算器用 kmssink 硬件 overlay（DRM plane-id=75，zpos=2 位于 UI 层
//   之下、屏幕中央竖屏区域 280x497）。UI 只要在该区域渲染透明像素，画面
//   就会从下层透出——零 CPU、满帧率。这是"计算器的做法"，本文件照抄。
// - 拍照：v4l2-ctl 单帧（video29，UYVY 1920x1080）→ ffmpeg 转 JPEG。
//   同步、可靠，且与预览管道并存（不同 video 节点）。
// 注意：3A 依赖系统"AI拍照"app 每次开机后启动过一次（行业已知限制）。

import { execShell, waitForFile, writeFile, joinPath, dataDirBase, statSize } from './native.js'

const VIDEO_SELF = '/dev/video30'
const VIDEO_MAIN = '/dev/video29'

// 计算器同款 kmssink 管道（plane 75、360x640 源、硬件缩放居中输出）
const KMS_CMD =
    'gst-launch-1.0 v4l2src device=' + VIDEO_SELF +
    ' ! videoscale ! video/x-raw,width=360,height=640,pixel-aspect-ratio=1/1' +
    ' ! kmssink plane-id=75 sync=false driver-name=rockchip'

function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

async function runCapture(cmd, timeoutMs) {
    const resultFile = joinPath(dataDirBase(), 'ds-cam-result.txt')
    await writeFile(resultFile, '')
    execShell(cmd + '; printf ok > ' + shq(resultFile))
    const r = await waitForFile(resultFile, timeoutMs)
    execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
    return r !== null
}

// 预览管道是否在跑（ps 输出落文件读回，execShell 无回显）
async function kmRunning() {
    const probe = joinPath(dataDirBase(), 'ds-kms-ps.txt')
    await writeFile(probe, '')
    execShell("ps -A 2>/dev/null | grep -c 'gst-launch.*kmssink' > " + shq(probe) + '; true')
    const out = String(await waitForFile(probe, 3000) || '0').trim()
    execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true')
    return parseInt(out, 10) > 0
}

/**
 * 启动取景预览（kmssink 硬件 overlay，幂等）。
 * 必须在 UI 把中央洞区域渲染为透明后才有视觉效果（camera-view 布局保证）。
 */
export async function startPreview() {
    if (await kmRunning()) return true
    execShell("pkill -9 -f 'gst-launch.*kmssink' 2>/dev/null; sleep 0.3; " +
        'nohup sh -c ' + shq(KMS_CMD) + ' >/dev/null 2>&1 &')
    // 3A 预热：首帧可能欠曝，给管道 2-3 秒
    await new Promise((r) => setTimeout(r, 2500))
    return await kmRunning()
}

export function stopPreview() {
    execShell("pkill -9 -f 'gst-launch.*kmssink' 2>/dev/null; true")
}

export async function previewAlive() {
    return kmRunning()
}

// ---------- 帧循环取景（2026-09-25 定案） ----------
// kmssink overlay 透出方案在聊天 app 里不可用：UI 中间"透明洞"依赖 Falcon
// 把该区域画成真透明，但引擎对无背景/近透明背景的 div 一律跳过不画，进入
// 取景前相册浮层的旧像素残留在 UI surface 上（真机实证：洞里显示半截相册）。
// 改为 UI 层帧循环：video29 单帧抓取（与 capturePhoto 同路径，真机实证正常）
// 转 640x360 JPG，image 组件轮换刷新——和相册缩略图同一套已验证的绘制路径。
// 双文件轮换避免"同路径换内容被 image 缓存"的问题。

// 长驻取景脚本（写到 dataDir 后由 double-fork 拉起）：
//   gst 常驻管道持续覆盖写 /tmp/ds_feed.jpg（v4l2src 支持 multiplanar，ffmpeg
//   的 v4l2 demuxer 不支持 —— 真机实证 "Not a video capture device"）；
//   sh 循环 0.5s 把它 cp 到交替文件 0/1 并把最新路径写进 done 文件；
//   UI 轮询 done 拿路径刷新 image。退出条件：/tmp/ds_feed.stop 出现。
// 为什么 double-fork：execShell 会话结束时的清理会连坐"nohup sh ... &"这种
// 直接子进程（真机实证：单层 nohup 的 sh 在 v4l2 之后被杀）；外层 () 子 shell
// 立即退出、内层进程变孤儿后才能存活 —— 后端 restart 同款结构（native.js）。
const CAMFEED_SH = [
    '#!/bin/sh',
    'rm -f /tmp/ds_feed.stop /tmp/ds_feed.done /tmp/ds_feed_0.jpg /tmp/ds_feed_1.jpg',
    'start_gst() { gst-launch-1.0 v4l2src device=/dev/video29 ! video/x-raw,width=640,height=360 ! videoconvert ! jpegenc ! multifilesink location=/tmp/ds_feed.jpg >/dev/null 2>&1 & }',
    'start_gst',
    'i=0',
    'while [ ! -f /tmp/ds_feed.stop ]; do',
    '    if ! ps -A 2>/dev/null | grep -q "gst-launch.*video29"; then sleep 1; if [ ! -f /tmp/ds_feed.stop ]; then start_gst; fi; fi',
    '    if [ -s /tmp/ds_feed.jpg ]; then',
    '        cp -f /tmp/ds_feed.jpg /tmp/ds_feed_$i.jpg 2>/dev/null',
    '        printf /tmp/ds_feed_$i.jpg > /tmp/ds_feed.done 2>/dev/null',
    '        i=$((1 - i))',
    '    fi',
    '    sleep 0.5',
    'done',
    'pkill -9 -f "gst-launch.*video29" 2>/dev/null',
    'rm -f /tmp/ds_feed.done /tmp/ds_feed_0.jpg /tmp/ds_feed_1.jpg /tmp/ds_feed.jpg',
].join('\n')

let framePollSeq = 0

/**
 * 启动帧循环取景。onFrame(jpgPath) 在每帧就绪时回调（路径轮换 0/1）。
 * 与 capturePhoto 共用 video29：拍照期间调用方先 stopFramePreview。
 */
export function startFramePreview(onFrame) {
    stopFramePreview()
    const seq = ++framePollSeq
    ;(async () => {
        try {
            const script = joinPath(dataDirBase(), 'camfeed.sh')
            await writeFile(script, CAMFEED_SH)
            execShell('( nohup sh ' + shq(script) + ' >/dev/null 2>&1 & )')
        } catch (e) { /* 脚本写失败则永远无帧，UI 保持黑底（可接受降级） */ }
        while (seq === framePollSeq) {
            const content = await waitForFile('/tmp/ds_feed.done', 2000)
            if (seq !== framePollSeq) return
            if (content) {
                const p = String(content).trim()
                execShell('rm -f /tmp/ds_feed.done 2>/dev/null; true')
                if (p.indexOf('/tmp/ds_feed_') === 0) onFrame(p)
            }
        }
    })()
}

export function stopFramePreview() {
    framePollSeq += 1
    execShell('touch /tmp/ds_feed.stop 2>/dev/null; pkill -9 -f "gst-launch.*video29" 2>/dev/null; true')
}

/**
 * 拍一张全分辨率照片（计算器同款 v4l2-ctl 单帧 + ffmpeg）。
 * video29 与预览管道（video30）互不干扰。返回 { ok, path?, error? }。
 */
export async function capturePhoto() {
    const out = joinPath(dataDirBase(), 'cam_shot_' + Date.now().toString(36) + '.jpg')
    const raw = '/tmp/ds_cam_frame.yuv'
    // --stream-skip=2：跳过前两帧（AE 收敛中），取第 3 帧
    const grabCmd =
        'v4l2-ctl -d ' + VIDEO_MAIN + ' --silent' +
        ' --set-fmt-video=width=1920,height=1080,pixelformat=UYVY' +
        ' --stream-skip=2 --stream-mmap=1 --stream-poll --stream-count=1' +
        ' --stream-to=' + shq(raw) + ' 2>/dev/null'
    const okGrab = await runCapture(grabCmd, 20000)
    if (!okGrab) return { ok: false, error: '取帧失败（相机忙或未就绪）' }
    const size = await statSize(raw)
    if (size < 100000) {
        execShell('rm -f ' + shq(raw) + ' 2>/dev/null || true')
        return { ok: false, error: '取帧数据不完整，请重试' }
    }

    // UYVY 4:2:2 → JPEG（方向若需旋转，在真机比对后补 transpose）
    const convCmd =
        'ffmpeg -y -f rawvideo -video_size 1920x1080 -pixel_format uyvy422 -i ' + shq(raw) +
        ' -frames:v 1 -q:v 2 ' + shq(out) + ' >/dev/null 2>&1'
    const okConv = await runCapture(convCmd, 20000)
    execShell('rm -f ' + shq(raw) + ' 2>/dev/null || true')
    if (!okConv) return { ok: false, error: '照片转换失败' }
    const jpgSize = await statSize(out)
    if (jpgSize < 10000) return { ok: false, error: '照片生成失败，请重试' }

    // 确认浮层用的缩略预览：全图 1920x1080 直接进 image 会大块解码，
    // 真机教训（相册原图进列表把渲染线程堵死），这里先出一张 640 宽的预览图。
    const preview = out.replace('.jpg', '_prev.jpg')
    const prevCmd = 'ffmpeg -y -i ' + shq(out) + ' -vf ' + shq('scale=640:-1') +
        ' -frames:v 1 -q:v 4 ' + shq(preview) + ' >/dev/null 2>&1'
    const okPrev = await runCapture(prevCmd, 15000)
    return { ok: true, path: out, preview: okPrev ? preview : out }
}

/**
 * 裁剪照片（比例循环用）。ratio: null(全图) | '1:1' | '4:3' | '16:9'。
 */
export async function cropFrame(srcPath, ratio) {
    if (!ratio) return srcPath
    const dims = { '1:1': [1080, 1080], '4:3': [1440, 1080], '16:9': [1920, 1080] }
    const wh = dims[ratio]
    if (!wh) return srcPath
    const w = wh[0]
    const h = wh[1]
    const x = Math.floor((1920 - w) / 2)
    const y = Math.floor((1080 - h) / 2)
    const out = joinPath(dataDirBase(), 'cam_crop_' + Date.now().toString(36) + '.jpg')
    const okFile = out + '.ok'
    const cmd = 'ffmpeg -y -i ' + shq(srcPath) +
        ' -vf ' + shq('crop=' + w + ':' + h + ':' + x + ':' + y) +
        ' -frames:v 1 -q:v 2 ' + shq(out) +
        ' > /dev/null 2>&1; echo done > ' + shq(okFile)
    execShell(cmd)
    const ok = await waitForFile(okFile, 15000)
    execShell('rm -f ' + shq(okFile) + ' 2>/dev/null || true')
    if (ok === null) return srcPath
    return out
}
