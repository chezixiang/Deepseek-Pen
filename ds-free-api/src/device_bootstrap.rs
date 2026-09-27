//! 设备凭据自动补齐（用户无感）——启动时/运行时为新账号静默 mint device_id。
//!
//! 背景：DeepSeek 登录要求数美签发的 device_id（格式形如 `B` + base64，88+ 字符）。
//! 上游实测伪造值会被 RISK_DEVICE_DETECTED（biz_code 11）拒绝，但**注册协议本身**
//! 可以合法走通（逆向见 docs/deepseek-verification-analysis.md §5d–5f）：
//! `ds_core::mint_device_id` 直接向数美 deviceprofile/v4 注册并取得服务端签发的
//! 凭据——等价于"在一台新设备上首次打开网页"，非伪造。
//!
//! 本模块把该流程做成**完全自动**：
//! - 启动时：为所有缺有效 device_id 的账号补齐并持久化到 config.toml
//! - 运行时：`ensure_one` 供添加账号/重登失败时补漏
//! - 幂等：已有 `B`/`D` 前缀凭据的账号直接跳过，不重复注册
//! - 容错：失败不阻断（沿用旧值重试登录，行为与升级前一致），仅记日志

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::config::Config;

/// 运行时 mint 凭据回写所需的配置文件路径（server 启动时记录一次）。
static RUNTIME_CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 记录配置文件路径，供运行时 mint 后回写凭据（`persist_account_credentials`）。
pub fn init_config_path(path: &Path) {
    let _ = RUNTIME_CONFIG_PATH.set(path.to_path_buf());
}

/// 启动时记录的配置文件路径。
pub fn config_path() -> Option<&'static Path> {
    RUNTIME_CONFIG_PATH.get().map(|p| p.as_path())
}

/// 判断 device_id 是否已是数美签发格式。
///
/// 数美 SDK 的 `getDeviceId()` 返回 `'B' + 服务端签发值` 或 `'D' + 本地加密包；
/// 因此以这两个字母开头即视为已签发。随机 UUID（旧版兜底）与其它的都算缺失。
pub fn is_issued(device_id: &str) -> bool {
    let t = device_id.trim();
    t.starts_with('B') || t.starts_with('D')
}

fn display_id(acct: &crate::config::Account) -> String {
    if acct.email.is_empty() {
        acct.mobile.clone()
    } else {
        acct.email.clone()
    }
}

/// 启动时批量补齐：为所有缺凭据的账号 mint 并落盘。
///
/// 返回成功补齐的账号数。失败仅告警（登录会在 poll 里表现为账号异常，
/// 由恢复任务重试）。
pub async fn ensure_device_credentials(config: &mut Config, config_path: &Path) -> usize {
    let ua = config.deepseek.user_agent.clone();
    let proxy_url = config.proxy.url.clone();
    let mut fixed = 0usize;

    for acct in config.accounts.iter_mut() {
        if is_issued(&acct.device_id) {
            continue;
        }
        let id = display_id(acct);
        log::info!(
            target: "device_mint",
            "账号 {} 缺少设备凭据，正在自动生成（用户无需操作）…", id
        );
        match crate::ds_core::mint_device_id(&ua, proxy_url.as_deref()).await {
            Ok((device_id, smid)) => {
                log::info!(
                    target: "device_mint",
                    "账号 {} 设备凭据已生成（{} 字符），登录将自动使用", id, device_id.len()
                );
                acct.device_id = device_id;
                // 注册流程同时产出 smid（本地生成的 smidV2），一并写入以保持
                // "device_id + smid 双绑定"与真实浏览器一致
                if !smid.is_empty() {
                    acct.smid = smid;
                }
                fixed += 1;
            }
            Err(e) => {
                log::warn!(
                    target: "device_mint",
                    "账号 {} 设备凭据生成失败（将沿用旧值重试登录，可稍后重启再试）: {e}", id
                );
            }
        }
    }

    if fixed > 0 {
        match config.save(config_path) {
            Ok(_) => log::info!(
                target: "device_mint",
                "{} 个账号的设备凭据已写入配置", fixed
            ),
            Err(e) => log::warn!(target: "device_mint", "设备凭据持久化失败: {e}"),
        }
    }
    fixed
}

/// 运行时补齐单个账号（添加账号/重登前调用）。
///
/// 若已有有效凭据直接返回原值；否则 mint 新的。
/// 返回 `(device_id, smid, minted)`，`minted` 为 true 时调用方应把凭据回写
/// 持久化（`persist_account_credentials`），否则重启后同一账号会重新 mint，
/// 设备身份漂移。
pub async fn ensure_one(
    user_agent: &str,
    proxy_url: Option<&str>,
    current_device_id: &str,
    current_smid: &str,
) -> (String, String, bool) {
    if is_issued(current_device_id) {
        return (current_device_id.to_string(), current_smid.to_string(), false);
    }
    match crate::ds_core::mint_device_id(user_agent, proxy_url).await {
        Ok((id, smid)) => {
            log::info!(
                target: "device_mint",
                "设备凭据已即时生成（{} 字符）", id.len()
            );
            let smid = if smid.is_empty() { current_smid.to_string() } else { smid };
            (id, smid, true)
        }
        Err(e) => {
            log::warn!(target: "device_mint", "设备凭据即时生成失败: {e}");
            (current_device_id.to_string(), current_smid.to_string(), false)
        }
    }
}

/// 运行时 mint 出的设备凭据回写配置文件（修复"重启后重新 mint → 身份漂移"）。
///
/// 按 email/mobile 匹配账号，device_id/smid 与现值不同才写（幂等）。
/// 找不到目标账号、无变化或写失败返回 false——登录已带新值继续，仅日志可见。
/// 注意：load→改→save 与 `ensure_device_credentials` 同款，不与内存中的
/// Config 并发合并；运行时改配置的其它路径（管理面板）落盘后此读取才可见。
pub fn persist_account_credentials(
    config_path: &Path,
    email: &str,
    mobile: &str,
    device_id: &str,
    smid: &str,
) -> bool {
    let mut config = match Config::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(target: "device_mint", "读取配置失败，无法回写设备凭据: {e}");
            return false;
        }
    };
    let mut updated = false;
    for acct in config.accounts.iter_mut() {
        let matched = (!email.is_empty() && acct.email == email)
            || (!mobile.is_empty() && acct.mobile == mobile);
        if matched {
            if acct.device_id != device_id {
                acct.device_id = device_id.to_string();
                updated = true;
            }
            if !smid.is_empty() && acct.smid != smid {
                acct.smid = smid.to_string();
                updated = true;
            }
            break;
        }
    }
    if !updated {
        return false;
    }
    match config.save(config_path) {
        Ok(_) => {
            log::info!(target: "device_mint", "设备凭据已回写配置（重启后不再重新 mint）");
            true
        }
        Err(e) => {
            log::warn!(target: "device_mint", "设备凭据回写失败: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issued_format_detection() {
        assert!(is_issued("Babc123"));
        assert!(is_issued("Dxyz"));
        assert!(is_issued("  Bpadded  "));
        assert!(!is_issued(""));
        assert!(!is_issued("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!is_issued("some-random-string"));
    }

    /// 已有有效凭据时必须短路返回原值且不 mint（不发网络请求）。
    #[tokio::test]
    async fn ensure_one_short_circuits_on_issued_credentials() {
        let (device_id, smid, minted) =
            ensure_one("test-ua", None, "Bexisting-id", "smid-existing").await;
        assert_eq!(device_id, "Bexisting-id");
        assert_eq!(smid, "smid-existing");
        assert!(!minted, "已有凭据不得触发 mint");
    }

    /// 修复②回归：运行时 mint 的凭据必须能回写配置文件，
    /// 消除"重启后重新 mint → 设备身份漂移"。
    #[test]
    fn persist_account_credentials_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dsfb-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "[server]\nhost = \"127.0.0.1\"\nport = 22217\n\n[[accounts]]\nemail = \"a@b.c\"\nmobile = \"\"\narea_code = \"\"\npassword = \"pw\"\n",
        )
        .expect("写测试配置");

        // 匹配 email 的账号被回写，其余字段保持
        assert!(persist_account_credentials(&path, "a@b.c", "", "Bnew-id", "smid-new"));
        let config = Config::load(&path).expect("重读配置");
        let acct = &config.accounts[0];
        assert_eq!(acct.device_id, "Bnew-id");
        assert_eq!(acct.smid, "smid-new");
        assert_eq!(acct.password, "pw", "回写不得破坏其它字段");

        // 回写后幂等：同值再写返回 false（不产生无意义的文件写入）
        assert!(!persist_account_credentials(&path, "a@b.c", "", "Bnew-id", "smid-new"));

        // 不匹配的账号返回 false，文件不变
        assert!(!persist_account_credentials(&path, "nobody@x.y", "", "Bother", ""));
        let config = Config::load(&path).expect("重读配置");
        assert_eq!(config.accounts[0].device_id, "Bnew-id");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
