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

use std::path::Path;

use crate::config::Config;

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
        match crate::ds_core::mint_device_id(&ua).await {
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
/// 若已有有效凭据直接返回原值；否则 mint 新的。返回 `(device_id, smid)`。
pub async fn ensure_one(user_agent: &str, current_device_id: &str, current_smid: &str) -> (String, String) {
    if is_issued(current_device_id) {
        return (current_device_id.to_string(), current_smid.to_string());
    }
    match crate::ds_core::mint_device_id(user_agent).await {
        Ok((id, smid)) => {
            log::info!(
                target: "device_mint",
                "设备凭据已即时生成（{} 字符）", id.len()
            );
            (id, if smid.is_empty() { current_smid.to_string() } else { smid })
        }
        Err(e) => {
            log::warn!(target: "device_mint", "设备凭据即时生成失败: {e}");
            (current_device_id.to_string(), current_smid.to_string())
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
}
