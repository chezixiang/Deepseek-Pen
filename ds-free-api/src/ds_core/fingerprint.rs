//! 设备指纹采集模块 —— 动态采集 + Linux aarch64 Chrome 身份模板
//!
//! 实现策略：
//! 1. 浏览器身份固定为 **Linux aarch64 Chrome**（目标运行平台即 aarch64 Linux，
//!    词典笔原生就是该平台，身份与硬件天然一致）；
//! 2. 硬件相关字段（CPU 核数 / 内存 / 屏幕 / 时区 / 语言 / GPU）在运行时从
//!    当前系统**动态采集**（/proc、/sys、chrono 本地时区等），不写死模板；
//! 3. Canvas 哈希无法在无浏览器环境渲染，改用设备稳定标识（machine-id /
//!    设备树序列号）派生的确定性哈希替代——同设备恒定、跨设备不同；
//! 4. 纯 HTTP/文件读取实现，无 JavaScript 执行依赖。
//!
//! 注意：数美（Shumei）device_id 是真正的登录风控凭据，**不可伪造**，
//! 由账号配置单独提供（见 config.rs 的 Account.device_id）；本模块产出的
//! 指纹用于身份一致性（UA / 平台头）与未来的指纹上报通道，两者互不替代。

use serde::{Deserialize, Serialize};
use serde_json::json;

/// 默认 User-Agent —— Linux aarch64 桌面 Chrome。
///
/// 平台段 `(X11; Linux aarch64)` 与 Chromium 在 ARM64 Linux 上由
/// `uname -m` 生成的 UA 一致；Chrome 版本必须与 wreq 的
/// `Emulation::Chrome136`（TLS/JA3/HTTP2 指纹）保持同大版本，
/// 否则 UA 与 TLS 指纹不匹配是可识别的自动化特征。
pub fn default_user_agent() -> String {
    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
        .to_string()
}

/// 与 UA 同源的浏览器身份常量
pub const BROWSER_PLATFORM: &str = "Linux aarch64";
/// X-Client-Version 的备用文案（站点部署版本，与浏览器版本无关）
pub const FALLBACK_WEBGL_RENDERER: &str =
    "ANGLE (Arm, Mali-G52 MC2 OpenGL ES 3.2, OpenGL ES)";

/// 设备指纹数据（动态采集，Linux aarch64 Chrome 身份）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFingerprint {
    /// Canvas 指纹（真实浏览器为 2D context 渲染哈希；此处为设备稳定标识
    /// 派生的确定性哈希，同设备恒定、跨设备不同）
    pub canvas_fingerprint: String,
    /// WebGL 指纹（ANGLE renderer 串；尽力从 /sys 采集真实 GPU）
    pub webgl_fingerprint: String,
    /// 安装的字体列表（来自系统字体目录；采集不到时用 Linux 常见集）
    pub fonts: Vec<String>,
    /// 屏幕分辨率（width x height x colorDepth；来自 framebuffer）
    pub screen: String,
    /// 时区偏移（JS getTimezoneOffset 语义，分钟；东八区 = -480）。运行时实测。
    pub timezone_offset: i32,
    /// 语言列表（来自系统 locale）
    pub languages: Vec<String>,
    /// 平台信息（固定 Linux aarch64 身份）
    pub platform: String,
    /// 硬件并发数（CPU 核心数）。运行时实测。
    pub hardware_concurrency: u32,
    /// 设备内存（GB；navigator.deviceMemory 语义，向下取 2 的幂、上限 8）。运行时实测。
    pub device_memory: u32,
    /// User-Agent（Linux aarch64 Chrome，与 wreq TLS 指纹同大版本）
    pub user_agent: String,
}

impl Default for DeviceFingerprint {
    fn default() -> Self {
        Self {
            canvas_fingerprint: String::new(),
            webgl_fingerprint: FALLBACK_WEBGL_RENDERER.to_string(),
            fonts: default_linux_fonts(),
            screen: "1920x1080x24".to_string(),
            timezone_offset: -480,
            languages: vec!["zh-CN".to_string(), "zh".to_string(), "en".to_string()],
            platform: BROWSER_PLATFORM.to_string(),
            hardware_concurrency: 4,
            device_memory: 4,
            user_agent: default_user_agent(),
        }
    }
}

/// Linux 设备常见字体集（采集失败时的兜底，覆盖 Noto/文泉驿/Droid 常见家族）
fn default_linux_fonts() -> Vec<String> {
    [
        "Arial", "Cantarell", "DejaVu Sans", "DejaVu Sans Mono", "Droid Sans",
        "Liberation Sans", "Liberation Mono", "Noto Color Emoji", "Noto Sans",
        "Noto Sans CJK SC", "Noto Serif", "Ubuntu", "WenQuanYi Micro Hei",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

// ── 运行时采集辅助 ──────────────────────────────────────────────────────

fn read_trimmed(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// FNV-1a 64 位哈希（无依赖、确定性）
fn fnv1a64(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 找一个设备稳定标识（重启不变）：machine-id → 设备树序列号 → /proc 降噪信息
fn stable_device_seed() -> Vec<u8> {
    for path in [
        "/etc/machine-id",
        "/var/lib/dbus/machine-id",
        "/proc/device-tree/serial-number",
    ] {
        if let Some(s) = read_trimmed(path) {
            if !s.is_empty() {
                return s.into_bytes();
            }
        }
    }
    // 兜底：/proc/cpuinfo 的型号 + 序列（ARM 设备常见 Serial 行），再退到 host 信息
    if let Ok(cpuinfo) = std::fs::read_to_string("/proc/cpuinfo") {
        let picked: Vec<&str> = cpuinfo
            .lines()
            .filter(|l| {
                let lower = l.to_lowercase();
                lower.starts_with("serial") || lower.starts_with("hardware") || lower.starts_with("model name")
            })
            .collect();
        if !picked.is_empty() {
            return picked.join("\n").into_bytes();
        }
    }
    format!(
        "{}|{}|{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    )
    .into_bytes()
}

/// Canvas 指纹替代：设备稳定标识的 FNV-1a 哈希（16 hex，形如真实 canvas 哈希）
fn canvas_fingerprint_from_device() -> String {
    format!("{:016x}{:016x}", fnv1a64(&stable_device_seed()), {
        // 混入固定盐，避免直接等于裸 machine-id 哈希
        let salt = b"ds-free-api/canvas-v1";
        let mut seed = stable_device_seed();
        seed.extend_from_slice(salt);
        fnv1a64(&seed)
    })
}

/// /proc/meminfo MemTotal → navigator.deviceMemory 语义（GB，向下取 2 的幂，上限 8）
fn detect_device_memory() -> Option<u32> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    if kib == 0 {
        return None;
    }
    let gib = kib as f64 / 1024.0 / 1024.0;
    // deviceMemory 取值域 {0.25,0.5,1,2,4,8}：向下取、封顶 8；本字段以 GB 整数
    // 表达，不足 1GB 的小内存设备按 1 处理（避免出现 0）
    let v = if gib >= 8.0 {
        8
    } else if gib >= 4.0 {
        4
    } else if gib >= 2.0 {
        2
    } else {
        1
    };
    Some(v)
}

/// framebuffer 屏幕分辨率（词典笔等 ARM 设备真实屏幕）→ "WxHx24"
fn detect_screen() -> Option<String> {
    // 1) fb 虚拟尺寸，形如 "1080,2160" 或 "1080x2160"
    for path in [
        "/sys/class/graphics/fb0/virtual_size",
        "/sys/class/graphics/fb1/virtual_size",
    ] {
        if let Some(size) = parse_wxh(&read_trimmed(path).unwrap_or_default()) {
            return Some(format!("{size}x24"));
        }
    }
    // 2) DRM 连接器 modes（无 fb 设备的 rockchip/全志平台走这里；
    //    有道词典笔 X7 Pro 实测 /sys/class/drm/card0-DSI-1/modes = "280x936"）。
    //    优先 DSI 面板，跳过 Writeback 等虚拟连接器。
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        let mut connectors: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 连接器形如 card0-DSI-1 / card0-HDMI-A-1；排除裸 card0 与 Writeback
            if !name.contains('-') || name.contains("Writeback") {
                continue;
            }
            if entry.path().join("modes").exists() {
                connectors.push(name);
            }
        }
        // DSI/eDP/LVDS 面板优先于 HDMI
        connectors.sort_by_key(|n| {
            let pref = if n.contains("-DSI-") || n.contains("-eDP") || n.contains("-LVDS") {
                0
            } else {
                1
            };
            (pref, n.clone())
        });
        for name in connectors {
            let modes = read_trimmed(&format!("/sys/class/drm/{name}/modes")).unwrap_or_default();
            if let Some(size) = parse_wxh(modes.lines().next().unwrap_or("")) {
                return Some(format!("{size}x24"));
            }
        }
    }
    None
}

/// 从 "WxH" / "W,H" 字符串解析出 "WxH"；两个维度都需为正
fn parse_wxh(s: &str) -> Option<String> {
    let digits: Vec<String> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect();
    if digits.len() < 2 {
        return None;
    }
    let w: u32 = digits[0].parse().ok()?;
    let h: u32 = digits[1].parse().ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    Some(format!("{w}x{h}"))
}

/// GPU renderer：尽力识别真实 GPU，拼成 ANGLE 风格串。
///
/// 识别顺序：设备树 GPU 节点 compatible（词典笔 X7 Pro/RK3562 实测
/// `arm,mali-bifrost`）→ DRM 驱动名 → Mali 内核驱动版本。
fn detect_webgl_renderer() -> Option<String> {
    // 1) 设备树 GPU 节点：/proc/device-tree/gpu@*/compatible（NUL 结尾的多值串）
    if let Ok(dt) = std::fs::read_dir("/proc/device-tree") {
        for entry in dt.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("gpu") {
                continue;
            }
            if let Ok(raw) = std::fs::read(entry.path().join("compatible")) {
                let compat = String::from_utf8_lossy(&raw);
                let gpu = if compat.contains("mali-bifrost") {
                    "Mali (Bifrost)"
                } else if compat.contains("mali-midgard") {
                    "Mali (Midgard)"
                } else if compat.contains("mali-utgard") {
                    "Mali (Utgard)"
                } else if compat.contains("panthor") {
                    "Mali (CSF/Panthor)"
                } else if compat.contains("vivante") {
                    "Vivante"
                } else if compat.contains("adreno") || compat.contains("qcom,adreno") {
                    "Adreno"
                } else {
                    ""
                };
                if !gpu.is_empty() {
                    return Some(format!(
                        "ANGLE (Arm, {gpu} OpenGL ES 3.2, OpenGL ES)"
                    ));
                }
            }
        }
    }

    // 2) DRM 驱动名（uevent: DRIVER=panfrost / lima / rockchip-drm 等）
    let drm_driver = (0..=2)
        .find_map(|i| {
            let uevent = read_trimmed(&format!("/sys/class/drm/card{i}/device/uevent"))?;
            uevent
                .lines()
                .find(|l| l.starts_with("DRIVER="))
                .map(|l| l.trim_start_matches("DRIVER=").to_string())
        })
        .or_else(|| std::fs::read_to_string("/proc/device-tree/gpu_status").ok().map(|_| "mali".to_string()));
    // 3) Mali 内核驱动版本（/sys/class/misc/mali0/device/version，形如 "g8p0-00eac0"）
    let mali = read_trimmed("/sys/class/misc/mali0/device/version");

    match (drm_driver.as_deref(), mali.as_deref()) {
        (Some(driver), Some(ver)) => Some(format!(
            "ANGLE (Arm, Mali {driver}/{ver} OpenGL ES 3.2, OpenGL ES)"
        )),
        (Some(driver), None) => {
            Some(format!("ANGLE (Arm, {driver} OpenGL ES 3.2, OpenGL ES)"))
        }
        (None, Some(ver)) => Some(format!("ANGLE (Arm, Mali/{ver} OpenGL ES 3.2, OpenGL ES)")),
        (None, None) => None,
    }
}

/// 系统字体目录采样（/usr/share/fonts 与 /system/fonts 的目录名，最多 32 个）
fn detect_fonts() -> Option<Vec<String>> {
    for root_path in ["/usr/share/fonts", "/system/fonts"] {
        let root = match std::fs::read_dir(root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut out = Vec::new();
        for entry in root.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if let Ok(sub) = std::fs::read_dir(&path) {
                    for s in sub.flatten() {
                        let n = s.file_name().to_string_lossy().to_string();
                        if s.path().is_dir() {
                            out.push(n);
                        }
                    }
                }
            } else if root_path == "/system/fonts" {
                // Android 风格扁平目录：文件名即字体（去掉扩展名）
                if let Some(stem) = name.split('.').next() {
                    out.push(stem.to_string());
                }
            } else {
                out.push(name);
            }
            if out.len() >= 32 {
                break;
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    None
}

/// 系统 locale → navigator.languages（zh-CN 优先，与站点语言一致）
fn detect_languages() -> Option<Vec<String>> {
    let raw = std::env::var("LANG")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| read_trimmed("/etc/locale.conf").and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("LANG="))
                .map(|l| l.trim_start_matches("LANG=").trim_matches('"').to_string())
        }))?;
    // zh_CN.UTF-8 → zh-cn
    let base = raw.split('.').next().unwrap_or("zh_CN").replace('-', "_");
    let mut parts = base.splitn(2, '_');
    let lang = parts.next().unwrap_or("zh").to_lowercase();
    let region = parts.next().map(|r| r.to_uppercase());
    let primary = match &region {
        Some(r) if !r.is_empty() => format!("{lang}-{r}"),
        _ => lang.clone(),
    };
    Some(vec![primary, lang, "en".to_string()])
}

/// JS getTimezoneOffset 语义（分钟；东八区 = -480）。chrono 运行时实测。
fn detect_timezone_offset() -> i32 {
    let local = chrono::Local::now();
    let offset_secs = local.offset().local_minus_utc();
    // 东八区 +28800s → JS 偏移 -480 分钟
    -(offset_secs / 60)
}

impl DeviceFingerprint {
    /// 从当前运行环境动态采集指纹。
    ///
    /// 在词典笔（aarch64 Linux）上采集到的即设备真实硬件特征；
    /// 采集不到的字段回落到 Linux aarch64 模板默认值。
    pub fn collect() -> Self {
        let mut fp = Self::default();
        fp.canvas_fingerprint = canvas_fingerprint_from_device();
        if let Some(r) = detect_webgl_renderer() {
            fp.webgl_fingerprint = r;
        }
        if let Some(f) = detect_fonts() {
            fp.fonts = f;
        }
        if let Some(s) = detect_screen() {
            fp.screen = s;
        }
        fp.timezone_offset = detect_timezone_offset();
        if let Some(l) = detect_languages() {
            fp.languages = l;
        }
        fp.platform = BROWSER_PLATFORM.to_string();
        fp.user_agent = default_user_agent();
        fp.hardware_concurrency = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(fp.hardware_concurrency);
        if let Some(m) = detect_device_memory() {
            fp.device_memory = m;
        }
        fp
    }

    /// 从配置文件加载自定义指纹（如果用户提供了真实浏览器指纹），否则动态采集
    pub fn from_config(config: Option<&serde_json::Value>) -> Self {
        match config {
            Some(cfg) if !cfg.is_null() => {
                let mut fp = Self::collect();
                // 配置里只覆盖显式给出的字段（逐字段合并，未给的保持动态采集值）
                if let Some(v) = cfg.get("canvas_fingerprint").and_then(|v| v.as_str()) {
                    fp.canvas_fingerprint = v.to_string();
                }
                if let Some(v) = cfg.get("webgl_fingerprint").and_then(|v| v.as_str()) {
                    fp.webgl_fingerprint = v.to_string();
                }
                if let Some(v) = cfg.get("fonts").and_then(|v| serde_json::from_value(v.clone()).ok()) {
                    fp.fonts = v;
                }
                if let Some(v) = cfg.get("screen").and_then(|v| v.as_str()) {
                    fp.screen = v.to_string();
                }
                if let Some(v) = cfg.get("timezone_offset").and_then(|v| v.as_i64()) {
                    fp.timezone_offset = v as i32;
                }
                if let Some(v) = cfg.get("languages").and_then(|v| serde_json::from_value(v.clone()).ok()) {
                    fp.languages = v;
                }
                if let Some(v) = cfg.get("platform").and_then(|v| v.as_str()) {
                    fp.platform = v.to_string();
                }
                if let Some(v) = cfg.get("hardware_concurrency").and_then(|v| v.as_u64()) {
                    fp.hardware_concurrency = v as u32;
                }
                if let Some(v) = cfg.get("device_memory").and_then(|v| v.as_u64()) {
                    fp.device_memory = v as u32;
                }
                if let Some(v) = cfg.get("user_agent").and_then(|v| v.as_str()) {
                    fp.user_agent = v.to_string();
                }
                fp
            }
            _ => Self::collect(),
        }
    }

    /// 生成发送到 DeepSeek 指纹服务的 JSON payload
    pub fn to_payload(&self) -> serde_json::Value {
        json!({
            "canvas": self.canvas_fingerprint,
            "webgl": self.webgl_fingerprint,
            "fonts": self.fonts,
            "screen": self.screen,
            "timezone": self.timezone_offset,
            "languages": self.languages,
            "platform": self.platform,
            "hardwareConcurrency": self.hardware_concurrency,
            "deviceMemory": self.device_memory,
            "userAgent": self.user_agent,
        })
    }
}

/// 上报设备指纹到 DeepSeek（或第三方指纹服务）
///
/// 注意：HAR 显示官方调用 `https://fp-it-acc.portal101.cn/deviceprofile/v4`，
/// 但该接口可能需要特定 API Key。当前策略是准备数据结构，实际上报由上层决定。
pub async fn submit_fingerprint(
    client: &wreq::Client,
    fingerprint: &DeviceFingerprint,
    endpoint: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let payload = fingerprint.to_payload();

    let resp = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(format!("指纹上报失败: {}", resp.status()).into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_collect_fills_all_fields() {
        let fp = DeviceFingerprint::collect();
        assert!(!fp.canvas_fingerprint.is_empty());
        assert!(!fp.user_agent.is_empty());
        // 身份固定为 Linux aarch64 Chrome（含 Windows 版本号的一律视为错误）
        assert_eq!(fp.platform, "Linux aarch64");
        assert!(fp.user_agent.contains("X11; Linux aarch64"), "{}", fp.user_agent);
        assert!(!fp.user_agent.contains("Windows"), "{}", fp.user_agent);
        assert!(fp.hardware_concurrency >= 1);
        assert_eq!(fp.timezone_offset, detect_timezone_offset());
    }

    #[test]
    fn test_canvas_hash_is_stable() {
        let a = canvas_fingerprint_from_device();
        let b = canvas_fingerprint_from_device();
        assert_eq!(a, b, "同设备同次运行内 canvas 替代哈希必须稳定");
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn test_default_user_agent_matches_tls_emulation() {
        let ua = default_user_agent();
        assert!(ua.contains("Chrome/136."), "UA 必须与 Emulation::Chrome136 同大版本: {ua}");
        assert!(ua.contains("Linux aarch64"));
    }

    #[test]
    fn test_payload_generation() {
        let fp = DeviceFingerprint::collect();
        let payload = fp.to_payload();
        assert!(payload.get("canvas").is_some());
        assert!(payload.get("webgl").is_some());
        assert!(payload.get("fonts").is_some());
        assert!(payload.get("hardwareConcurrency").is_some());
    }

    #[test]
    fn test_config_override_merges_fields() {
        let cfg = serde_json::json!({ "screen": "360x640x24" });
        let fp = DeviceFingerprint::from_config(Some(&cfg));
        assert_eq!(fp.screen, "360x640x24");
        // 未覆盖的字段保持动态采集值
        assert_eq!(fp.platform, "Linux aarch64");
    }

    #[test]
    fn test_device_memory_parsing() {
        // 解析逻辑不依赖环境（直接构造函数不可行时至少验证 fallback 安全）
        let fp = DeviceFingerprint::default();
        assert!(fp.device_memory >= 1);
    }

    #[test]
    fn test_parse_wxh() {
        assert_eq!(parse_wxh("280x936").as_deref(), Some("280x936"));
        assert_eq!(parse_wxh("1080,2160").as_deref(), Some("1080x2160"));
        assert_eq!(parse_wxh("0x936"), None, "零维度无效");
        assert_eq!(parse_wxh(""), None);
        assert_eq!(parse_wxh("abc"), None);
    }
}
