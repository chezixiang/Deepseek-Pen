# 项目结构变更通知（2026-09-13）

仓库：`D:\codes\youdao\Deepseek`（有道词典笔 X7 Pro 上的 DeepSeek 客户端 monorepo）

## 最近一次目录整理做了什么

1. **拍平了 `ds-free-api/` 一层**
   - 旧：`ds-free-api/ds-free-api-0.2.6/src/...`
   - 新：`ds-free-api/src/...`
   - 这层 `ds-free-api-0.2.6/` 是本地加的版本目录，上游（NIyueeE/ds-free-api）没有，所以移掉了。
   - 影响范围：所有原来带 `ds-free-api-0.2.6/` 的路径都要按新路径引用。

2. **删除了两个手工 release 骨架**
   - 删除：`ds-free-api/ds-free-api-v0.2.6-linux-aarch64-gnu/`
   - 删除：`ds-free-api/ds-free-api-v0.2.6-windows-x86_64/`
   - 这两个是手工产物，不进 git 也能通过 CI 重生成。

3. **同步修改了两处路径引用（已完成，不用你再改）**
   - `ds-free-api/Cargo.toml`：`sm_des = { path = "../CAPTCHA" }`（原为 `../../CAPTCHA`）
   - `ds-free-api/src/server/captcha_bridge.rs`：
     `include_str!("../../../CAPTCHA/captcha-sdk.min.js")`（原为 4 个 `..`）

## 未完成 / WIP 状态（重要）

- `ds-free-api/src/ds_core/fingerprint.rs` **是骨架**，设备指纹功能**未实现**。
- `ds-free-api/src/config.rs` 的 `DeepSeekConfig` 里 `fingerprint: Option<serde_json::Value>`
  字段存在，但 `Default` impl 里是 `fingerprint: None`（占位，加注释 TODO(wip)）。
- **不要**因为看到这个字段就假设功能已完成，也不要删掉它。
- 前端 `app/src/services/native.js` 里有 `fixFingerprint()` 做 config.toml 文本层修复，
  那是**另一件事**（修 UA/client_version 字段），和上面的 Rust 端指纹功能不是同一个东西。

## 尚未做的整理（不要擅自做）

以下都讨论过但**明确推迟**，在得到用户明确指示前**不要执行**：

- `CAPTCHA/` → `captcha/` 大小写改名（会同时断 `Cargo.toml` 和 `include_str!`，需原子修改）
- 删除 `app/.temp/`
- 合并根 `HOWTOBUILD.md` 和 `app/HOWTOBUILD.md`，去掉里面的测试凭据
- 新建根 `README.md`
- `app/package.json` 里 `file:D:/codes/youdao/sdk/packages/core` 硬编码路径
- 与上游 `NIyueeE/ds-free-api` 同步 / rebase

## 当前 git 状态

- 分支 `main`，HEAD 是目录整理 commit
- `backup-before-restructure` 分支是整理前的快照，**保留，不要删**
- `upstream` remote 已加，指向 `https://github.com/NIyueeE/ds-free-api`，用于对照
- 后端编译环境：**WSL 里的交叉编译**（`wsl --cd /mnt/d/codes/youdao/Deepseek/ds-free-api bash -ic "cargo build --release"`）
  - Windows 原生 `cargo` 未配置 toolchain，**不要在 PowerShell 里跑 `cargo check`**
  - 目标架构：`aarch64-unknown-linux-gnu`（跑在词典笔上）

## 续做时的正确路径

| 你想找的东西 | 在哪 |
|---|---|
| Rust 后端源码 | `ds-free-api/src/` |
| 后端配置 | `ds-free-api/config.example.toml` |
| 后端 Web 管理面板（React） | `ds-free-api/web/` |
| CAPTCHA crate（`sm_des`） | `CAPTCHA/`（大写，未改名） |
| 前端小程序 | `app/src/` |
| 前端构建脚本 | `app/scripts/` |
| 后端二进制（本地） | `app/backend/linux-aarch64-gnu/ds-free-api`（gitignore，不进 git） |

## 一句总结

**目录已经整理好了，编译能过。你的任务是继续修 bug / 实现指纹功能，不是在目录结构上做二次加工。** 有疑问先问，别自作主张移动文件。