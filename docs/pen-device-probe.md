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

## 6. 客户端设备身份（deviceId）派生

2026-10-28 起，客户端设备 ID **只由硬件序列号派生**，不再使用 MAC：

```
deviceId = 'pen-' + SHA-256('deepseek-pen:sn:' + SN).slice(0, 32)
```

SN 来源优先级（客户端 `src/services/device-id.js` + `cloud-control.js`）：

1. `/proc/cpuinfo` 的 `Serial` 行 —— 本机实测 `Serial : 8c571a98d606d768`（0444 只读，芯片唯一）
2. `/proc/device-tree/serial-number`（部分机型提供）
3. eMMC CID：`/sys/block/mmcblk0/device/cid` —— 本机实测 `df011853434136344710165c5c05bb00`
4. `/etc/machine-id` / `/var/lib/dbus/machine-id`
5. 无 SN 时才退回旧 MAC 算法（保证老设备 ID 不变），最后才是随机 UUID

读取方式：**只靠 shell**。OS 4.9.7 的 falcon `fs` 有两个硬限制（真机确认）：

- **没有 `fs.writeFile`** —— 应用侧一切写文件都必须走 shell（`store.writeFile` 内部用
  `base64` 分块 + 哨兵落盘，见 `shell-write.js`）；设备上 `ds_settings.json`、`ds-app.log`
  都是 `root:root` 就是这条的实证。
- `fs.readFile` 读 `/proc`、`/sys` 会失败（旧算法因此拿不到 MAC，退化成随机 UUID）。

所以设备侧只发**一条**命令（`buildProbeCommand`），一次做完三件事：读硬件标识、
`cat` 应用数据目录里的 ID 记录、`cat /userdisk` 里的 ID 记录；结果写进应用数据目录
（该目录 fs 读写都可用）再读回。真机实测整条命令 55ms。

命令结尾必须 `chmod 644`：shell 是 root，若某机型 umask 是 077，写出的文件应用进程
读不到，探测就"看似成功其实全空"——又会退回随机 UUID，正是这次 bug 的老路。

为什么不能用 MAC：

- 冷启动 wlan0 尚未初始化时，`/sys/class/net/wlan0/address` 可能返回 `00:00:00:00:00:00`；
- 不同固件的网卡名是 wlan0 / eth0 / wlan1，读到哪个不确定；
- 部分机型 MAC 随机化；
- 旧版手动配对路径还另生成随机 UUID。

结果就是同一台笔卸载重装后出现两个 deviceId（服务端变成两台设备，旧会话/额度对不上）。

持久化与换机识别：

- 最终 ID 写入 `$dataDir/.ds-device-id.json` 与 `/userdisk/.ds-device-id.json`（用户盘，卸载应用通常不清）；
- 记录里带**全部**可用硬件指纹（`sns` 数组），任一匹配即视为同一台机器，避免"这次只读到 eMMC、下次读到 CPU SN"被误判成换机；
- 换机/克隆用户盘时指纹全部不匹配，会按新机 SN 重新生成，不会两台设备共用一个 ID；
- 原始 SN 不落盘、不上传，只上传哈希。
- 历史随机 UUID 标识会在首次启动时迁移为 SN 派生 ID（旧令牌清空、自动重注册）；`pen-` 开头的历史 MAC ID 保留，避免丢在线会话。
- **随机 UUID 永远不写持久化记录**：写进去会让"下次能读到 SN"也被它锁死；磁盘上若已有 UUID 记录，
  只要本次读到 SN 就丢弃它并收敛到 SN 派生 ID。
- 各来源有最小长度（cpuinfo/device-tree ≥8、eMMC ≥12、machine-id ≥16）：个别固件把芯片型号
  （如 `RK3562`）写进 `Serial`，这种值全机型相同，会让所有笔撞成一个 ID。

adb 复核命令：

```bash
adb shell "grep -i '^Serial' /proc/cpuinfo"
adb shell "cat /sys/block/mmcblk0/device/cid"
adb shell "cat /userdisk/.ds-device-id.json 2>/dev/null"   # 新版本首次运行后生成
```
