# 阶段 0 · P4c 验证报告（设备重启自动加载 / 宿主销毁后的晚到回调）

- 执行日期：2026-09-29（Asia/Shanghai）；上午完成离线准备与探针改造，17:29–17:44 完成真机验证
- 范围：仅探针（安装、启动、重启、观察、卸载、回滚），未触碰业务代码，未进入阶段 1B
- 证据目录：`.probe/probe/p4c/`（索引 `p4c/EVIDENCE.md`）；真机原始输出在 `p4c/device/`
- 结论口径：不猜测。每条结论都对应可复核文件；mock 证据与真机证据分开记录

---

## 0. 结论摘要

| 问题 | 结论 | 关键证据 |
|---|---|---|
| **Q1** 设备重启后，探针模块是否仍会自动加载、`custom_init_jsapis` 是否仍被调用 | **不会自动加载，`custom_init_jsapis` 不会被调用**；只有手动 `miniapp_cli start 8000000000182399 index` 后才会加载并调用，且手动启动后功能全部正常 | 重启后启动日志 11 条 `dynamic_load_jsapi` 全为系统自启应用（lookup/dictpen_home/mediaplayer/settings/Eric…），无 `8000000000182399`；全进程 `maps` 扫描无探针 `.so`；手动启动后出现 `dynamic_load_jsapi …/libjsapi_ds_probe_491608796.so` 且 `probe-result.json ok=true`（`p4c/device/post-reboot-*.txt`、`after-reboot-*.txt`） |
| **Q2** 宿主销毁（页面退出 / 小程序停止 / App 进程结束）后是否还有晚到的 JS 回调被投递 | **取决于是哪种“销毁”**：① 退出页面（仅 `onStop`，页面未销毁）→ **仍有投递**；② 切到系统桌面“停止小程序”→ 小程序实例仍驻留 → **仍有投递**；③ 卸载小程序（框架日志明确 `ignore dlclose`）→ **仍有投递，JS 回调在已卸载的 app 上继续执行**；④ `kill -9` 结束宿主进程 → **无投递**（native 线程随进程终止，连 `deadline` 标记都没有） | `p4c/device/s1-*`、`s2-*`、`s3-*`、`s4-*` 四组原始记录；`p4c/device/rollback-*` |

**对阶段 1 的影响（按停止条件的要求写明冲突）**：P4c 结论**与「宿主销毁后框架会停止回调/释放上下文」这一隐含假设冲突**——在本固件上，除“进程被杀”以外，`onStop`、切后台、甚至**卸载**都不会真正终止 native 后台线程或 JS 上下文，晚到回调会被投递到已经“销毁”的 app 上（S4 甚至成功写文件）。因此：

1. Transport/Runtime **不能**把“宿主销毁”当作取消/清理的保证，必须由 JS/`DsRuntime` 显式取消、native 侧显式收任务（I10）；
2. 建议在阶段 1A 契约里把“销毁”细分为：页面停止 / 应用切后台 / 应用销毁（卸载）/ 进程终止，并分别定义回调与线程处理；
3. 在契约更新前，阶段 1B（Transport 实现）不应把生命周期建立在“宿主销毁即停投递”之上。

---

## 1. 目标与验收口径

P4c 要回答：① 设备重启后探针是否仍自动加载、`custom_init_jsapis` 是否仍被调用；② 宿主销毁后是否还有晚到的 JS 回调被投递。验收要求：两个结论都要有可复核证据，mock 与真机证据分开记录，不得把“安装成功”当成 P4c 通过。

---

## 2. 环境

| 项 | 值 |
|---|---|
| 工作区 | `F:\youdao\Deepseek`（历史文档记作 `G:\youdao\Deepseek`；本轮实测盘符为 F:） |
| WSL 视角 | F: 未挂载到 WSL，源码核对/构建走 `C:\Users\seewo\ds-work` 镜像 + Windows 侧 adb |
| 设备 | `YoudaoDictionaryPen-678`，内核 `5.10.160 #18 SMP Tue Jul 28 2026`，adb 序列号脱敏 `MEC17****3678`，root shell |
| 探针 | appid `8000000000182399`，version `0.1.0`，arch 目录 `arm64-popcorn`，QuickJS `20200705 / bigNum=false` |
| 设备工具 | `/bin/miniapp_cli`（install/uninstall/start/startService/capture/captureFB/debugApp/injectKey…，**无 stop/退出类子命令**）、`/usr/bin/miniapp`（宿主进程）、日志 `/userdata/applog/DictPen_<时间戳>.log` |
| 设备日志特性 | 框架**只保留当前会话的一个 DictPen 日志**：宿主进程重启（含被杀）后旧日志文件被删除，新文件以新时间戳重建（本轮因此丢失过一份日志，已改为先拉取再杀进程） |
| 本地工具链 | WSL `aarch64-linux-gnu-g++ 13.3.0`、Windows `node.exe`、工作区 `app\node_modules`（junction 复用）、QuickJS 2020-07-05（mock） |

---

## 3. 时间线

### 3.1 离线准备（12:04–12:15）

| 时间 | 动作 | 结果 |
|---|---|---|
| 12:04–12:07 | 读取任务指定文件（路线/计划/基线/VERIFY/探针源码/构建脚本/Pen-LVGL 参考） | 完成；确认加载链与模块注册约定 |
| 12:06–12:08 | 建立 `C:\Users\seewo\ds-work` 镜像，解决 F: 未挂载 | 完成 |
| 12:08–12:10 | 设备可用性核查（adb/PnP/无线） | 当时设备不在场 → 先做离线工作（`p4c/device/adb-attempts.log`） |
| 12:10–12:12 | 探针增强（`scheduleDelayedEvent` + 5 段 native 标记）、WSL 构建、AMR 打包与校验 | 全部通过（`p4c/build/*`、`p4c/out/*`） |
| 12:13–12:15 | mock 三态验证 | `p4c/mock/out/mock-{alive,drop,survive}` |

### 3.2 真机（17:29–17:44）

| 时间 (CST) | 动作 | 结果 |
|---|---|---|
| 17:29:35 | 设备接入，只读前态 | 探针未安装、`/tmp/ds-probe.amr` 不存在、无探针 `.so` 映射 |
| 17:29:5x | push + install P4c AMR（md5 `133f3dd5…`） | `install ret=0`；落盘 `libjsapi_ds_probe_491608796.so`（197,104 B，md5 `a77b311a…`，SONAME/RUNPATH 被 PMS 重写） |
| 17:29:59 | 基线启动 `start 8000000000182399 index` | `probe-result.json ok=true`（version/sync/event/promise），30 s 后延迟事件完整走通（含 JS 回调落盘） |
| 17:31:0x | `adb reboot`，不做手动启动，观察 60 s+ | 新日志 `DictPen_20260929_173113.log`；11 条 `dynamic_load_jsapi` 无探针；无 `.so` 映射 → **Q1 结论：不自动加载** |
| 17:33:03 | 手动 `start … index` | 日志出现 `dynamic_load_jsapi …/libjsapi_ds_probe_491608796.so`；`ok=true`；延迟事件再次走通 |
| 17:37:09 | S1 退出页面（切到 `blank`） | 页面仅 `onStop`；17:37:29 延迟事件**仍完整投递** |
| 17:38:07 | S2 停止小程序（切到系统桌面 `8080222437664451`） | 探针 `.so` 仍在宿主 `maps`；17:38:27 延迟事件**仍完整投递** |
| 17:40:06 | S3 `kill -9` 宿主进程 | 旧进程消失（无 `deadline` 标记、无 JS 回调）；系统 1–2 s 内重建宿主（新 pid 4053，新日志 `…174006.log`）；探针应用未恢复 |
| 17:42:41 | S4 卸载小程序（此时有 30 s 挂起事件，变体 AMR md5 `61637eeb…`，标记写 `/tmp`） | 日志 `appDestroyed` + `[DynamicLib] … ignore dlclose`；17:43:06 延迟事件**仍完整投递**且 JS 回调写入 `/tmp/p4c-late-hit.json` |
| 17:43:2x–17:44 | 回滚：卸载、清 `/tmp`、清空包目录、重启宿主进程 | 探针不再映射、包目录不存在、`/tmp` 干净、界面恢复正常（截图 `pen-after-rollback.png`） |

---

## 4. 关键命令（真机，可复核）

```text
# 前态
adb devices -l
adb shell "miniapp_cli help"
adb shell "ls -l /userdisk/secondary/miniapp/data/mini_app/pkg/ | grep 8000000000182399"
adb shell "ls -l /tmp/ds-probe.amr"

# 安装 + 基线
adb push F:\youdao\Deepseek\.probe\probe\p4c\out\8000000000182399.0_1_0-p4c.amr /tmp/ds-probe.amr
adb shell "miniapp_cli install /tmp/ds-probe.amr"
adb shell "miniapp_cli start 8000000000182399 index"
adb shell "cat /userdisk/.../8000000000182399/data/probe-result.json"
adb shell "cat /userdisk/.../8000000000182399/data/p4c-native-mark.jsonl"

# Q1
adb reboot; adb wait-for-device; sleep 70
adb shell "grep -nE 'dynamic_load_jsapi|8000000000182399' /userdata/applog/DictPen_*.log"
adb shell "for p in /proc/[0-9]*; do grep -l libjsapi_ds_probe \$p/maps; done"
adb shell "miniapp_cli start 8000000000182399 index"

# Q2 场景动作
adb shell "miniapp_cli start 8000000000182399 blank"        # S1 退出页面
adb shell "miniapp_cli start 8080222437664451"              # S2 切到系统桌面
adb shell "ps -ef | grep /usr/bin/miniapp; kill -9 <pid>"   # S3 结束宿主进程
adb shell "miniapp_cli uninstall 8000000000182399"          # S4 卸载（挂起事件仍在）

# 回滚
adb shell "miniapp_cli uninstall 8000000000182399"
adb shell "rm -f /tmp/ds-probe.amr /tmp/ds-probe-s4.amr /tmp/p4c-*"
```

注意：**`miniapp_cli uninstall` 会清理暂存的 amr**；重装前必须重新 `adb push`（本轮踩过一次，见 `p4c/device/s1-cycle.txt` 的失败记录）。

---

## 5. 探针改动（最小 diff）

1. `src/ds_probe.cpp`：新增 `Probe.scheduleDelayedEvent(ms, markerPath[, tag])`——后台线程 `usleep(ms)` 后经现有 `postJSMessage` 机制投递事件；native 侧写追加式 JSONL 标记 `scheduled → deadline → post-rc-* → trampoline-enter → trampoline-exit(value=delivered)`；新增 libc 依赖仅 `open/write/close/clock_gettime`。
2. `miniapp/src/pages/index/index.vue`：保留原 P1–P3 基线，追加 P4c 段落（注册 `late` 回调 → 调度延迟事件，默认 30 s，可用 `p4c-delay.json {"ms":N}` 覆盖）。
3. 新增 `miniapp/tsconfig.json`（CLI 无条件注册 `@rollup/plugin-typescript`，缺 tsconfig 会 TS18003）与 `build-wsl.sh`（本机无 Windows clang++）。
4. S4 变体 `p4c/index-s4.vue`（仅把标记/回调路径改到 `/tmp`，使证据在卸载后仍可读），对应 AMR `p4c/out/…-p4c-s4.amr`。

diff：`p4c/ds_probe.diff`、`p4c/index.vue.diff`；构建/校验日志：`p4c/build/*`。

---

## 6. 证据

### 6.1 真机（本轮核心）

| 证据 | 路径 |
|---|---|
| 前态与只读核查 | `p4c/device/adb-before.txt`、`device-info.txt`、`miniapp_cli-help.txt`、`pkg-probe-before.txt`、`tmp-amr-before.txt`、`applog-before.txt` |
| 安装与库存证 | `install.log`、`amr-on-device.txt`（AMR md5 一致）、`libs-after-install.txt`、`installed-md5.txt`、`installed-so-analysis.txt`、`installed-libjsapi_ds_probe.so` |
| 基线（宿主存活对照） | `baseline-probe-result.txt`、`baseline-schedule.txt`、`baseline-native-mark.txt`、`baseline-late-hit.txt` |
| Q1 重启 | `reboot-before.txt`、`reboot-after.txt`、`post-reboot-uptime.txt`、`post-reboot-logs.txt`、`post-reboot-processes.txt`、`post-reboot-maps-probe.txt`（空）、`post-reboot-dynamic-load-lines.txt`（11 条系统应用）、`after-reboot-probe-result.txt`、`after-reboot-loader-lines.txt` |
| Q2-S1 退出页面 | `s1-start.txt`、`s1-schedule.txt`、`s1-destroy.txt`、`s1-result.txt`、`s1-log.txt` |
| Q2-S2 停止小程序 | `s2-cycle.txt`、`s2-schedule.txt`、`s2-destroy.txt`、`s2-state-after-stop.txt`、`s2-result.txt` |
| Q2-S3 进程结束 | `s3-cycle.txt`、`s3-schedule.txt`、`s3-pid.txt`（221）、`s3-destroy.txt`、`s3-state-after-kill.txt`、`s3-result.txt`、`s3-maps-after.txt`、`post-kill-DictPen.log` |
| Q2-S4 卸载挂起 | `s4-push.txt`、`s4-install.txt`、`s4-scheduled.txt`、`s4-destroy.txt`、`s4-result.txt`、`s4-native-mark.jsonl`、`s4-late-hit.json`、`s4-log.txt` |
| 回滚 | `rollback-uninstall.txt`、`rollback-cleanup.txt`、`rollback-final.txt`、`rollback-mapped-before-kill.txt`（`(deleted)` 映射）、`rollback-final-after-host-restart.txt`、`rollback-ui-check.txt`、`pen-after-rollback.png`、`final-DictPen.log` |

### 6.2 mock（与真机证据严格分开）

mock = x86-64 宿主（真实 QuickJS 2020-07-05）+ 与设备同源的 `ds_probe.cpp`；销毁语义由 mode 显式指定，不代表设备行为。

| mode | native 标记 | JS 回调 | 退出码 |
|---|---|---|---|
| `alive` | `scheduled → deadline → post-rc-0 → trampoline-enter → trampoline-exit(1)` | 写入成功 | 0 |
| `drop`（销毁并丢队列） | `scheduled → deadline → post-rc-nonzero(-1)` | 无 | 0 |
| `survive`（销毁仍投递到已释放上下文） | `scheduled → deadline → post-rc-0 → trampoline-enter`（无 exit） | 无 | 139 / SIGSEGV |

与真机的差异（重要）：

- 设备上 `postJSMessage` 成功时返回 **1**（mock 返回 0），因此标记名只能用于区分返回值，不能单独判断成败；
- 设备 S4 中“app 已销毁但回调仍执行”**没有崩溃**，原因是框架并未真正 `dlclose`/释放上下文（日志 `ignore dlclose`），而不是 mock `survive` 那种“投递到已释放内存”的语义。

### 6.3 构建产物（离线）

`p4c/build/build-wsl.log`、`check-symbols.log`（UND 24/24 覆盖）、`validate-amr.log`、`readelf.log`、`md5.txt`；主 AMR md5 `133f3dd5d45b72132f14bdce13e77402`，S4 变体 md5 `61637eebd292a011a2b8a8de16e45b09`。

---

## 7. Q1 详细结论

**结论：设备重启后探针模块不会自动加载，`custom_init_jsapis` 不会被调用；手动启动探针小程序后加载与调用都正常。**

1. 重启后（未做任何手动启动）启动日志里 `dynamic_load_jsapi` 共 11 条，全部是系统开机自启应用（`libjsapi_export_core.so`、lookup、dictpen_home、mediaplayer、parentcontrol、user_center、appstoreIndependent、record、settings、Eric 等），**没有一条指向 `8000000000182399` 或 `libjsapi_ds_probe`**；
2. 重启后全进程 `maps` 扫描（`for p in /proc/[0-9]*; do grep -l libjsapi_ds_probe $p/maps; done`）结果为空；宿主只有 `/usr/bin/miniapp` 一个进程；
3. 手动 `miniapp_cli start 8000000000182399 index` 后，日志出现 `init->97 local dynamic_load_jsapi /userdisk/…/libjsapi_ds_probe_491608796.so`（即走 `custom_init_jsapis` 注册模块），随后 `probe-result.json` 的 `version/echo/add/diag/event/promise` 全部通过，证明页面成功 `import` 并调用到 native 模块。

说明：`custom_init_jsapis` 本身没有独立的符号日志，本报告用“框架加载该 `.so` + 页面 import 成功 + 模块方法可用”三者共同证明其被调用；日志中另有 `[custom_init_jsapis] custom_init_jsapis`（框架 core 模块，与探针无关）。

---

## 8. Q2 详细结论

每个场景都是：装/重装探针 → 启动 `index`（`created()` 里登记 30 s 延迟事件）→ 第 10 s 执行销毁动作 → 观察第 30 s 到点后的标记与回调。

| 场景 | 销毁动作（时间） | native 标记（`p4c-native-mark.jsonl`） | JS 回调（`p4c-late-hit.json`） | 框架状态证据 | 结论 |
|---|---|---|---|---|---|
| S1 退出页面 | 17:37:09 `start … blank`（页面切走） | `deadline(17:37:29) → post-rc-nonzero(1) → trampoline-enter → trampoline-exit(1)` | 写入成功（同一毫秒） | 日志仅 `PageLifecycle->onStop … _pageName=index`，**无 onDestroy** | **晚到回调仍被投递**；页面实例及其 JS 上下文未销毁 |
| S2 停止小程序 | 17:38:07 `start 8080222437664451`（切系统桌面） | 同上完整链路（deadline 17:38:27） | 写入成功 | 3 s/45 s 后 `maps` 仍显示探针 `.so`；宿主进程不变 | **晚到回调仍被投递**；小程序只是切到后台，实例驻留 |
| S3 结束 App 进程 | 17:40:06 `kill -9 221` | **只有 `scheduled`，没有 `deadline`** | 无文件 | 旧进程消失；1–2 s 后系统重启宿主（新 pid 4053、新日志 `…174006.log`）；新日志 0 次命中探针 appid | **没有晚到回调**；native 线程随进程终止，宿主未恢复探针应用 |
| S4 卸载（附加场景） | 17:42:41 `uninstall`（30 s 事件挂起中） | 完整链路（deadline 17:43:06，`trampoline-exit(1)`） | **写入成功（`/tmp/p4c-late-hit.json`）** | 日志 `AppLifecycle->appDestroyed` + `[DynamicLib](8000000000182399 …) has no jsapi_check_unload symbol; ignore dlclose. may cause memleak??`；同一秒出现 `mkdir failed, …/pkg/8000000000182399/`（回调里对 data 目录的写失败） | **晚到回调仍被投递，且在“已卸载”的 app 上成功执行 JS**；框架没有真正 dlclose |

补充说明（S1/S2 的“销毁”语义）：本固件没有 `miniapp_cli stop` 类命令，任务书里的“退出页面/停止小程序”在设备上对应“切页/切后台”。日志显示这两种动作都只到 `onStop`/`appPaused`，不销毁实例；因此“晚到回调仍被投递”反映的是**页面/应用实例未被销毁**这一事实，而不是“销毁后仍投递到失效上下文”。

与 mock 的对照：S3 的效果等价于 mock `drop`（消息/线程不复存在，无投递）；S1/S2/S4 则说明本框架在“非进程终止”的销毁路径上没有停止投递——mock `survive`（投递到已释放上下文 → SIGSEGV）在真机上没有出现，因为框架根本没有释放。

---

## 9. 回滚记录

| 项 | 结果 |
|---|---|
| `miniapp_cli uninstall 8000000000182399` | S4 已卸载；回滚阶段再次执行返回 `uninstall failed: 50`（已不存在），记录在 `rollback-uninstall.txt` |
| `/tmp/ds-probe.amr`、`/tmp/ds-probe-s4.amr`、`/tmp/p4c-*` | 已删除并复核（`rollback-cleanup.txt`、`rollback-final.txt`） |
| 卸载残留 | S4 回调触发 `mkdir` 重新生成了一个空的 `pkg/8000000000182399/` 目录，已 `rmdir` 清除 |
| 库仍映射问题 | 卸载后探针 `.so` 仍以 `(deleted)` 形式映射在旧宿主进程（`rollback-mapped-before-kill.txt`），为恢复测试前状态重启宿主进程；新宿主无任何探针映射（`rollback-final-after-host-restart.txt`） |
| 最终状态 | 包目录不存在、`/tmp` 干净、宿主正常运行、界面正常（`pen-after-rollback.png`）、最终日志 0 次命中探针 appid（`final-DictPen.log`） |
| 业务代码 | 未修改（`ds.js`、`native.js`、`backend-blob.js`、`app/**`、`ds-free-api/**` 未动；真机也未安装/启动业务应用 `8000000000182376`） |
| 工作区改动 | 仅 `.probe/probe/**` 与本报告；`重构计划/00-baseline.md` 未改 |

---

## 10. 未决问题与 1A 契约输入

1. **取消/销毁语义必须显式化**（本轮最重要的结论）：既然 `onStop`、切后台、甚至卸载都不停止 native 线程与 JS 回调，`DsRuntime`/Transport 必须自带取消与清理，并假定“宿主不会替我们停任务”。
2. **卸载路径的 dlclose 行为**：框架对无 `jsapi_check_unload` 符号的库“忽略 dlclose”，会保留映射直到进程结束；库更新/替换时的旧线程与旧上下文风险需要在 1A 契约中明确（例如约定导出卸载钩子或先取消任务再卸载）。
3. **`postJSMessage` 返回值语义**：设备成功返回 1（非 0），失败/拒绝时的返回值本轮未覆盖；契约里不要用 0/1 判定成败。
4. **日志保留策略**：宿主重启会删除旧日志文件，后续任何涉及宿主重启/杀进程的验证都必须先拉取日志。
5. 其他未测：同页面重复 `start` 不会重跑 `created()`（本轮再次确认，与 VERIFY.md N2 一致）；`p4c-delay.json` 覆盖机制在真机上只验证了“缺失时走默认 30 s”（`readFile … errno 2` 日志），未验证带值覆盖。

---

## 11. 证据路径速查

```text
.probe/probe/p4c/EVIDENCE.md                    证据索引（mock/真机分开）
.probe/probe/p4c/device/*                       真机原始输出（安装/重启/S1–S4/回滚/日志/截图）
.probe/probe/p4c/mock/out/mock-{alive,drop,survive}/   mock 三态原始日志
.probe/probe/p4c/build/*                        构建、符号、AMR 校验
.probe/probe/p4c/out/*                          主 AMR / S4 变体 AMR / .so / .o
.probe/probe/p4c/ds_probe.diff                  探针源码最小 diff
.probe/probe/p4c/index.vue.diff                 测试页最小 diff
```
