//! 设备指纹采集模块 —— 固定模板方案
//!
//! 实现策略：
//! 1. 固定指纹模板（从真实浏览器抓取一次后保存）
//! 2. 登录前主动调用指纹上报接口
//! 3. 避免 JavaScript 执行依赖，纯 HTTP 实现

use serde::{Deserialize, Serialize};
use serde_json::json;

/// 设备指纹数据（固定模板，模拟真实浏览器环境）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFingerprint {
    /// Canvas 指纹（2D context hash）
    pub canvas_fingerprint: String,
    /// WebGL 指纹（renderer + vendor）
    pub webgl_fingerprint: String,
    /// 安装的字体列表（常见 Windows 字体）
    pub fonts: Vec<String>,
    /// 屏幕分辨率（width x height x colorDepth）
    pub screen: String,
    /// 时区偏移（分钟，东八区 = -480）
    pub timezone_offset: i32,
    /// 语言列表
    pub languages: Vec<String>,
    /// 平台信息
    pub platform: String,
    /// 硬件并发数（CPU 核心数）
    pub hardware_concurrency: u32,
    /// 设备内存（GB）
    pub device_memory: u32,
    /// User-Agent
    pub user_agent: String,
}

impl Default for DeviceFingerprint {
    fn default() -> Self {
        Self {
            // 真实 Canvas 指纹示例（需从浏览器抓取）
            canvas_fingerprint: "a8f3c2e1d9b7f5a4c3e2d1b9f8a7c6e5".to_string(),
            // WebGL 指纹示例
            webgl_fingerprint: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)".to_string(),
            // Windows 11 常见字体
            fonts: vec![
                "Arial", "Calibri", "Cambria", "Consolas", "Courier New",
                "Georgia", "Microsoft YaHei", "Segoe UI", "SimSun", "Tahoma",
                "Times New Roman", "Trebuchet MS", "Verdana",
            ].iter().map(|s| s.to_string()).collect(),
            screen: "1920x1080x24".to_string(),
            timezone_offset: -480, // 东八区（北京时间 UTC+8）
            languages: vec!["zh-CN".to_string(), "zh".to_string(), "en".to_string()],
            platform: "Win32".to_string(),
            hardware_concurrency: 8,
            device_memory: 16,
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36".to_string(),
        }
    }
}

impl DeviceFingerprint {
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

    /// 从配置文件加载自定义指纹（如果用户提供了真实浏览器指纹）
    pub fn from_config(config: Option<&serde_json::Value>) -> Self {
        if let Some(cfg) = config {
            serde_json::from_value(cfg.clone()).unwrap_or_default()
        } else {
            Self::default()
        }
    }
}

/// 上报设备指纹到 DeepSeek（或第三方指纹服务）
///
/// 注意：HAR 显示官方调用 `https://fp-it-acc.portal101.cn/deviceprofile/v4`，
/// 但该接口可能需要特定 API Key。当前策略是准备数据结构，实际上报由上层决定。
pub async fn submit_fingerprint(
    client: &rquest::Client,
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
    fn test_default_fingerprint() {
        let fp = DeviceFingerprint::default();
        assert!(!fp.canvas_fingerprint.is_empty());
        assert_eq!(fp.timezone_offset, -480);
        assert_eq!(fp.platform, "Win32");
    }

    #[test]
    fn test_payload_generation() {
        let fp = DeviceFingerprint::default();
        let payload = fp.to_payload();
        assert!(payload.get("canvas").is_some());
        assert!(payload.get("webgl").is_some());
        assert!(payload.get("fonts").is_some());
    }
}
