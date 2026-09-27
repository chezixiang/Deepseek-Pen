// 拍照与取景：JPEG 帧循环取景 + 单帧拍照。
//
// 硬件事实（2026-09-25/27 真机取证）：
// - 主摄两颗输出节点：video29（rkisp mainpath）、video30（selfpath），可并存。
// - 取景的稳定路径：video29 帧循环转 JPEG，image 组件按帧刷新（~7fps）。
//   kmssink overlay 曾用于尝试 30fps，但 plane 进程存活不等于画面可见；
//   在 UI 盖住视频 plane 的设备状态下会出现整块黑屏，因此不再将其作为
//   用户可见预览的判定条件。
// - 拍照：v4l2-ctl 单帧（video29，UYVY 1920x1080）→ ffmpeg 裁成与预览窗口
//   等比的 1920x768 带转 JPEG（所见即所得）。帧循环与拍照共用 video29，
//   快门前先暂停取景。
// 注意：3A 依赖系统"AI拍照"app 每次开机后启动过一次（行业已知限制）。

import { execShell, waitForFile, writeFile, readFile, joinPath, dataDirBase, statSize, sleep } from './native.js'

const VIDEO_SELF = '/dev/video30'
const VIDEO_MAIN = '/dev/video29'

// ---------- 硬件 overlay 取景（视频 plane 置顶方案，30fps 零 CPU） ----------
// - 面板原生竖屏 280x936（DRM summary 实证），UI plane = Esmart0(节点54)
//   默认 zpos 3，视频 plane = Esmart1(节点75) 默认 zpos 2 → 视频被 UI 盖死。
// - modetest -w 54:zpos:1 把 UI 压到 1（框架不会改回，真机验证稳定），
//   视频 2 即在 UI 之上；每次 startPreview 重写（重启后自愈）。
// - render-rectangle 把视频限制在面板矩形 <0,236,280,700> = 用户横屏坐标
//   的左侧 700x280 窗口，右侧 236px 留给按钮条（用户要求按钮在右侧）。
// - 取景管道：video30 640x360@30 → videocrop 裁 640x256（窗口等比带）→
//   videoflip 90l（面板竖屏必须转向）→ 缩放 280x700 → kmssink 置顶窗口输出。
const UI_PLANE_ZPOS_CMD = 'modetest -w 54:zpos:1'
const VIDEO_PLANE_ZPOS_CMD = 'modetest -w 75:zpos:2'
// Falcon 提交 UI surface 时可能把 plane 54 的默认 zpos=3 写回去；只在
// gst 启动前设置一次会再次被 UI 盖住。视频 plane 也显式设为 2，并在管道
// 启动后的短窗口内重复写入，确保最终顺序是 video(2) > UI(1)。
const LAYER_ZPOS_CMD = VIDEO_PLANE_ZPOS_CMD + '; ' + UI_PLANE_ZPOS_CMD
const KMS_CMD =
    'gst-launch-1.0 v4l2src device=' + VIDEO_SELF +
    ' ! video/x-raw,width=640,height=360,framerate=30/1' +
    ' ! videocrop top=52 bottom=52' +
    ' ! videoflip video-direction=90l' +
    ' ! videoscale ! video/x-raw,width=280,height=700' +
    " ! kmssink plane-id=75 sync=false driver-name=rockchip force-aspect-ratio=true render-rectangle='<0,236,280,700>'"
// 启动脚本：先调层级，再启动 gst；gst 接管 plane 后继续重写 20 次，覆盖
// Falcon 后续的 surface commit。整个脚本在后台执行，不阻塞 JS/UI 线程。
const KMS_STOP_CMD = "pkill -9 -f 'gst-launch.*kmssink' 2>/dev/null; true"
const KMS_LAUNCH_CMD =
    LAYER_ZPOS_CMD +
    '; (' + KMS_CMD + ' >/dev/null 2>&1) & gst_pid=$!; ' +
    'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do ' +
    'kill -0 "$gst_pid" 2>/dev/null || break; ' +
    LAYER_ZPOS_CMD +
    '; sleep 0.15; done; wait "$gst_pid"'

// 预览管道是否在跑（ps 输出落文件读回，execShell 无回显）
async function kmRunning() {
    const probe = joinPath(dataDirBase(), 'ds-kms-ps.txt')
    await writeFile(probe, '')
    execShell("ps -A 2>/dev/null | grep -c 'gst-launch.*kmssink' > " + shq(probe) + '; true')
    const out = String(await waitForFile(probe, 3000) || '0').trim()
    execShell('rm -f ' + shq(probe) + ' 2>/dev/null || true')
    return parseInt(out, 10) > 0
}

let previewActive = false

/**
 * 启动取景。默认使用 image 帧循环（~7fps，video29）。
 *
 * kmssink 进程即使已经存在，也可能因为 DRM plane 被 UI 盖住而只输出黑色；
 * 仅用 ps 判断进程存活会把这种黑屏误判成 hardware 模式，UI 随后会一直显示
 * 黑底。帧循环走已经验证过的 JPEG/image 绘制路径，先保证取景可见；保留
 * kmssink 常量和探针供后续设备专项验证，但不再让它决定用户看到的模式。
 *
 * onFrame(jpgPath) 在每个新帧就绪时回调。返回 'frames' | 'dead'。
 */
export async function startPreview(onFrame) {
    if (previewActive) stopPreview()
    else execShell(KMS_STOP_CMD)
    previewActive = true
    startFramePreview(onFrame)
    return 'frames'
}

export function stopPreview() {
    previewActive = false
    stopFramePreview()
    execShell(KMS_STOP_CMD)
}

export async function previewAlive() {
    return kmRunning()
}

function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// 异步执行命令并把完成标记落文件（execShell 无回显，等标记文件判断结束）
async function runCapture(cmd, timeoutMs) {
    const resultFile = joinPath(dataDirBase(), 'ds-cam-result.txt')
    await writeFile(resultFile, '')
    execShell(cmd + '; printf ok > ' + shq(resultFile))
    const r = await waitForFile(resultFile, timeoutMs)
    execShell('rm -f ' + shq(resultFile) + ' 2>/dev/null || true')
    return r !== null
}

// ---------- 帧循环取景（2026-09-26 重构：~1.5fps → ~7fps） ----------
// 旧方案慢的根因（真机实测）：sh 循环 0.5s 一步 + 每步 ps -A 扫 /proc（几十 ms）
// + UI 每帧 rm done 文件的 execShell 往返。重构后：
//   - gst 侧 videorate 节流到 10fps（jpegenc 软编 30fps 会吃掉大半颗核）；
//   - sh 循环 0.1s 一步，存活检查用 kill -0 pid（不再 ps）；
//   - 完整性校验：cp 快照后看尾部两字节是否 JPEG EOI（ffd9）——multifilesink
//     覆盖写期间 cp 可能抓到半截文件，image 组件解不出来会闪黑；
//   - 握手改成**单调帧号**：done 文件内容 "n"，每帧落到不同文件名；
//     同一路径覆盖写会命中 Falcon image 缓存并反复显示旧画面，单调文件名彻底绕开它。
// 退出条件：__FRAME_BASE__.stop 出现。
// 为什么 double-fork：execShell 会话结束时的清理会连坐"nohup sh ... &"这种
// 直接子进程（真机实证：单层 nohup 的 sh 在 v4l2 之后被杀）；外层 () 子 shell
// 立即退出、内层进程变孤儿后才能存活 —— 后端 restart 同款结构（native.js）。
const CAMFEED_SH = [
    '#!/bin/sh',
    'rm -f __FRAME_BASE__.stop __FRAME_BASE__.done __FRAME_BASE___*.jpg /tmp/ds_tmp.jpg',
    'start_gst() {',
    '  gst-launch-1.0 v4l2src device=/dev/video29 ! video/x-raw,width=640,height=360 ! videocrop top=52 bottom=52 ! videorate ! video/x-raw,framerate=10/1 ! videoconvert ! jpegenc ! multifilesink location=__FRAME_BASE__.jpg >/dev/null 2>&1 &',
    '  echo $! > __FRAME_BASE__.pid',
    '}',
    'start_gst',
    'n=0',
    'while [ ! -f __FRAME_BASE__.stop ]; do',
    '    read pid < __FRAME_BASE__.pid 2>/dev/null',
    '    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then',
    '        sleep 0.3',
    '        [ -f __FRAME_BASE__.stop ] && break',
    '        start_gst',
    '    fi',
    '    if [ -s __FRAME_BASE__.jpg ]; then',
    '        cp -f __FRAME_BASE__.jpg /tmp/ds_tmp.jpg 2>/dev/null',
    '        t=$(tail -c 2 /tmp/ds_tmp.jpg 2>/dev/null | od -An -tx1 | tr -d " \\n")',
    '        if [ "$t" = "ffd9" ]; then',
    '            n=$((n + 1))',
    '            mv -f /tmp/ds_tmp.jpg __FRAME_BASE___$n.jpg',
    '            printf "%d\\n" "$n" > __FRAME_BASE__.done.n',
    '            mv -f __FRAME_BASE__.done.n __FRAME_BASE__.done',
    '            old=$((n - 8))',
    '            if [ "$old" -gt 0 ]; then rm -f __FRAME_BASE___$old.jpg; fi',
    '        fi',
    '    fi',
    '    sleep 0.1',
    'done',
    // 退出清理必须以 stop 文件仍在为前提：新一轮取景 start 时会先删 stop，
    // 若旧脚本此刻正退出、无条件清理会把新会话的文件/pkill 掉（自愈靠
    // 新脚本的 watchdog 重启 gst，但能免则免）。
    'if [ -f __FRAME_BASE__.stop ]; then',
    '    pkill -9 -f "gst-launch.*video29" 2>/dev/null',
    '    rm -f __FRAME_BASE__.pid __FRAME_BASE__.done __FRAME_BASE___*.jpg /tmp/ds_tmp.jpg __FRAME_BASE__.jpg __FRAME_BASE__.stop',
    'fi',
].join('\n')

let framePollSeq = 0
let activeFrameBase = '/tmp/ds_feed'

function newFrameBase() {
    return '/tmp/ds_feed_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36)
}

/**
 * 启动帧循环取景。onFrame(jpgPath) 在每帧就绪时回调（每帧使用唯一文件名）。
 * 与 capturePhoto 共用 video29：拍照期间调用方先 stopFramePreview。
 */
export function startFramePreview(onFrame) {
    stopFramePreview()
    const seq = ++framePollSeq
    const frameBase = newFrameBase()
    activeFrameBase = frameBase
    ;(async () => {
        // 给上一轮脚本留出退出时间（循环粒度 0.1s + 清理），避免新旧会话文件互踩
        await sleep(250)
        if (seq !== framePollSeq) return
        try {
            const script = joinPath(dataDirBase(), 'camfeed.sh')
            await writeFile(script, CAMFEED_SH.replace(/__FRAME_BASE__/g, frameBase))
            execShell('( nohup sh ' + shq(script) + ' >/dev/null 2>&1 & )')
        } catch (e) { /* 脚本写失败则永远无帧，UI 保持黑底（可接受降级） */ }
        let lastN = 0
        while (seq === framePollSeq) {
            // done 内容是单调帧号；每帧使用新文件名，避免 image 组件缓存覆盖后的旧内容。
            const content = await readFile(frameBase + '.done')
            if (seq !== framePollSeq) return
            if (content) {
                const n = parseInt(String(content).trim(), 10)
                if (n > lastN) {
                    lastN = n
                    onFrame(frameBase + '_' + n + '.jpg')
                }
            }
            await sleep(100)
        }
    })()
}

export function stopFramePreview() {
    framePollSeq += 1
    execShell('touch ' + shq(activeFrameBase + '.stop') + '; pkill -9 -f "gst-launch.*video29" 2>/dev/null; true')
}

// 拍照输出：与取景窗口等比的"带"。取景窗口 700x280（2.5:1），传感器原始
// 16:9 的上下部分在窗口里本来就被 videocrop 裁掉看不见——直接裁成所见即
// 所得的带（1920x768，居中，71% 视野）。预览管道 videocrop 52/52 与拍照
// 裁的带完全一致。
const BAND_W = 1920
const BAND_H = 768

// 拍照成品的源尺寸（确认页裁剪框 → 源像素映射用）
export const PHOTO_W = BAND_W
export const PHOTO_H = BAND_H

/**
 * 拍一张照片（v4l2-ctl 单帧 1920x1080 + ffmpeg 裁带转 JPEG）。
 * 拍照走 video29，与帧循环预览共用节点；调用方在快门前先 stopFramePreview。
 * 返回 { ok, path?, preview?, error? }。
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

    // UYVY 4:2:2 → JPEG，同一次转换里居中裁出屏幕等比带（方向真机比对过，无需 transpose）
    const convCmd =
        'ffmpeg -y -f rawvideo -video_size 1920x1080 -pixel_format uyvy422 -i ' + shq(raw) +
        ' -vf ' + shq('crop=' + BAND_W + ':' + BAND_H + ':0:' + Math.floor((1080 - BAND_H) / 2)) +
        ' -frames:v 1 -q:v 2 ' + shq(out) + ' >/dev/null 2>&1'
    const okConv = await runCapture(convCmd, 20000)
    execShell('rm -f ' + shq(raw) + ' 2>/dev/null || true')
    if (!okConv) return { ok: false, error: '照片转换失败' }
    const jpgSize = await statSize(out)
    if (jpgSize < 10000) return { ok: false, error: '照片生成失败，请重试' }

    // 确认浮层用的缩略预览：带图 1920x768 直接进 image 会大块解码，
    // 真机教训（相册原图进列表把渲染线程堵死），这里先出一张 640 宽的预览图。
    const preview = out.replace('.jpg', '_prev.jpg')
    const prevCmd = 'ffmpeg -y -i ' + shq(out) + ' -vf ' + shq('scale=640:-1') +
        ' -frames:v 1 -q:v 4 ' + shq(preview) + ' >/dev/null 2>&1'
    const okPrev = await runCapture(prevCmd, 15000)
    return { ok: true, path: out, preview: okPrev ? preview : out }
}

/**
 * 按矩形裁剪照片。rect 为**源图像素**坐标 {x,y,w,h}（由确认页把屏幕上的
 * 裁剪框映射过来，见 index.vue confirmShot）。越界部分收敛到图内，宽高
 * 取偶（YUV/编码器对齐习惯）。失败返回原图（宁可不裁也不弄丢照片）。
 */
export async function cropFrame(srcPath, rect) {
    if (!rect) return srcPath
    const r = rect && typeof rect === 'object' ? rect : {}
    const maxW = BAND_W
    const maxH = BAND_H
    let w = Math.min(Math.round(Number(r.w) || 0), maxW)
    let h = Math.min(Math.round(Number(r.h) || 0), maxH)
    if (w < 16 || h < 16) return srcPath
    let x = Math.round(Number(r.x) || 0)
    let y = Math.round(Number(r.y) || 0)
    x = Math.max(0, Math.min(x, maxW - w))
    y = Math.max(0, Math.min(y, maxH - h))
    w -= w % 2
    h -= h % 2
    if (w < 16 || h < 16) return srcPath
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
