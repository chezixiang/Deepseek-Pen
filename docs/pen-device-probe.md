# 词典笔真机探针结果（有道词典笔 X7 Pro）

> 采集日期：2026-09-19，通过 adb 连接实测（设备序列号 `MEC1700009003678`）。
> 用途：`ds-free-api/src/ds_core/fingerprint.rs` 动态指纹采集的路径验证与备查；
> 换机型/换固件时按「采集项 → 命令」复测并更新本文。

## 1. 设备与系统概览

| 项目 | 实测值 | 采集命令 |
|------|--------|----------|
| 设备序列号（adb） | `MEC1700009003678` | `adb devices` |
| CPU 架构 | `aarch64` | `adb shell uname -m` |
| SoC 平台 | Rockchip **RK3562**（compatible: `rockchip,rk3562-y02-v10`） | `cat /proc/device-tree/compatible`（NUL 分隔） |
| 内核 | Linux，无 Android 用户态（**没有 `getprop`**） | — |
| Shell | busybox 风格 `/bin/sh` | — |
| CPU 核数 | **4** | `grep -c processor /proc/cpuinfo` |
| 内存 | MemTotal = **1015568 kB ≈ 0.97 GB** | `grep MemTotal /proc/meminfo` |

## 2. 指纹采集项逐项实测（fingerprint.rs 路径对照）

| 采集项 | fingerprint.rs 检测路径 | 本机实际命中 | 采集值 |
|--------|------------------------|--------------|--------|
| `hardware_concurrency` | `std::thread::available_parallelism` | ✅ 直接命中 | 4 |
| `device_memory` | `/proc/meminfo` MemTotal | ✅ 直接命中 | **1**（0.97GB 向下取整，「不足 1GB 按 1」分支正好覆盖） |
| `screen` | ① `/sys/class/graphics/fb0/virtual_size`（本机**无 fb 设备**）→ ② DRM 连接器 `modes` | ✅ 走 ② | **280x936**（`/sys/class/drm/card0-DSI-1/modes`，DSI 面板优先） |
| `webgl_fingerprint` | ① 设备树 GPU 节点 → ② DRM DRIVER → ③ mali0 version | ✅ 走 ① | `ANGLE (Arm, Mali (Bifrost) OpenGL ES 3.2, OpenGL ES)`（`/proc/device-tree/gpu@ff320000/compatible = arm,mali-bifrost`；DRM 显示驱动为 `rockchip-drm`，NPU 为 `RKNPU`；本机无 `/sys/class/misc/mali0`） |
| `canvas_fingerprint` | `machine-id` → `dbus machine-id` → 设备树序列号 → `/proc/cpuinfo` Serial/Hardware 行 | ✅ 走第 4 级兜底 | 种子 = `Serial : 8c571a98d606d768`（本机无 `/etc/machine-id`、无 `/var/lib/dbus/machine-id`、无 `/proc/device-tree/serial-number`；`/proc/sys/kernel/random/boot_id` 存在但随重启变化，不采用） |
| `timezone_offset` | chrono::Local（`/etc/localtime`） | ✅ 直接命中 | **-480**（`/etc/localtime → ../usr/share/zoneinfo/Asia/Shanghai`，`date +%Z%z` = CST+0800） |
| `languages` | `$LANG` → `/etc/locale.conf` | 视进程环境 | adb shell 环境 `LANG=en_US.utf8`（无 locale.conf）；app 经 execShell 启动后端时环境可能无 LANG → 回落默认 `["zh-CN","zh","en"]` |
| `fonts` | `/usr/share/fonts` → `/system/fonts` | ❌ 均不存在 | 回落 Linux 常见字体集（系统无独立字体文件，渲染字体内置于框架） |
| `platform` / `user_agent` | 固定模板 | ✅ | `Linux aarch64` / `Mozilla/5.0 (X11; Linux aarch64) … Chrome/136.0.0.0 Safari/537.36` |

## 3. 存储与目录布局（部署相关）

```
/                       根（Rockchip 定制 Linux）
├── /etc/localtime      → Asia/Shanghai
├── /etc/…              无 machine-id、无 locale.conf
├── /proc/device-tree/  设备树（compatible / gpu@ff320000 / serial-number 缺失）
├── /sys/class/drm/     card0(DSI 面板) card0-Writeback-1 card1 renderD128(DSI) renderD129(RKNPU)
├── /data/
│   ├── miniapp/        小程序框架（data、resources/env.json、slot_info.sh）
│   └── …
├── /userdata/mini_app/ 小程序框架另一挂载点
├── /userdisk/          用户盘：Download / Favorite / Music / Pictures / DictPenData / YoudaoDictPen / applog / cfg / lib / local / miniapp …
├── /usr/share/         有 zoneinfo（时区库），无 fonts
└── /system/            存在但无 fonts
```

- 应用 data 目录（`$dataDir`）由 Falcon 框架在运行时提供；后端部署在 `$dataDir/ds-free-api`（见 `app/src/services/native.js` 的 `dsHomeDir()`）。
- 本机尚未部署 ds-free-api（`/data/miniapp` 下无 ds-free-api 目录，无运行中进程）。

## 4. 真机端到端验证记录（2026-09-19，v0.2.7 二进制）

把融合后的新二进制（UPX 压缩，4.5MB）推到 `/userdisk/ds-free-api-test/` 实跑验证（已清理）：

1. 启动成功，指纹动态采集日志与预期完全一致：

```
设备指纹（动态采集）: platform=Linux aarch64,
  ua=Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36,
  screen=280x936x24, cores=4, memGB=1, tz=-480min,
  webgl=ANGLE (Arm, Mali (Bifrost) OpenGL ES 3.2, OpenGL ES)
```

2. wasm 下载、PoW solver 初始化、端口绑定（约 2.3 秒）全部正常：
   `成功绑定到 127.0.0.1:22217`
3. `/health` 返回 `{"accounts":{"available":false,"busy":0,"idle":0,"total":0},"status":"ok"}`（空账号配置，降级模式符合预期）。
4. 附带确认：busybox `ps` 需要 `ps -o pid,comm` 才能按名过滤（裸 `ps | grep` 匹配不到）；`nohup` 后台进程在 adb shell 断开时会跟随退出。

## 5. 探针方法备忘

```bash
adb devices                          # 确认连接
adb shell uname -m                   # aarch64
adb shell "grep -c processor /proc/cpuinfo; grep MemTotal /proc/meminfo"
adb shell "cat /sys/class/drm/card0-DSI-1/modes"          # 屏幕分辨率
adb shell "cat /proc/device-tree/compatible | tr '\0' '\n'"  # SoC 型号
adb shell "cat /proc/device-tree/gpu@ff320000/compatible | tr '\0' ' '"  # GPU
adb shell "ls -la /etc/localtime; date +%Z%z"             # 时区
adb shell "grep -E 'Serial|Hardware' /proc/cpuinfo"        # canvas 种子来源
```

注意：
- adb shell 无 `getprop`，`/bin/sh` 为 busybox，复杂命令建议包在双引号里整条下发。
- 设备端 curl 为 busybox 精简版，调试模式代理测试时 `socks5` 支持情况未验证（后端代理在 Rust 侧 wreq 实现，不依赖设备 curl）。
- 屏幕分辨率取自 DRM 面板 modes 的**首选模式**；若固件升级后出现 fb 设备，fb 路径优先。
