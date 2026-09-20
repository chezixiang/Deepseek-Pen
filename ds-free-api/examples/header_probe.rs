//! 头指纹探针：检查 wreq Chrome136 emulation + 本服务 web 头覆盖后的实际线缆头。
//! 用途：验证 UA ↔ client-hints（sec-ch-ua-platform）一致性等指纹改动。
//! 运行：cargo run --example header_probe（宿主机，需外网访问 httpbin.org）。

use wreq_util::Emulation;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1) 纯 emulation 默认头
    let client = wreq::Client::builder()
        .emulation(Emulation::Chrome136)
        .build()?;
    let resp = client
        .get("https://httpbin.org/headers")
        .send()
        .await?;
    let text = resp.text().await?;
    println!("=== RAW first 1200 ===");
    println!("{}", &text[..text.len().min(1200)]);
    let body: serde_json::Value = serde_json::from_str(&text)?;
    println!("=== pure emulation default headers ===");
    if let Some(h) = body.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h { println!("  {k}: {}", v.as_str().unwrap_or("?")); }
    }
    if let Some(h) = body.get("x") { println!("http_version: {h}"); }
    if let Some(h) = body.get("tls") {
        println!("ja3_hash: {}", h.get("ja3_hash").map(|v| v.to_string()).unwrap_or_default());
        println!("peetprint_hash: {}", h.get("peetprint_hash").map(|v| v.to_string()).unwrap_or_default());
    }
    if let Some(headers) = body.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            println!("  {k}: {}", v.as_str().unwrap_or("?"));
        }
    }

    // 2) 带 per-request 显式头（模拟 fork 的 web_base_headers 覆盖）
    use wreq::header::{HeaderMap, HeaderValue, ACCEPT, ORIGIN, REFERER, USER_AGENT};
    let mut h = HeaderMap::new();
    h.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"));
    h.insert(ACCEPT, HeaderValue::from_static("*/*"));
    h.insert(ORIGIN, HeaderValue::from_static("https://chat.deepseek.com"));
    h.insert(REFERER, HeaderValue::from_static("https://chat.deepseek.com/"));
    h.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    h.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    h.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    // 与 client.rs web_base_headers 的 platform 修正保持一致
    h.insert("sec-ch-ua-platform", HeaderValue::from_static("\"Linux\""));
    h.insert("priority", HeaderValue::from_static("u=1, i"));
    h.insert("X-Client-Version", HeaderValue::from_static("2.5.0"));
    h.insert("X-Client-Platform", HeaderValue::from_static("web"));
    h.insert("X-Client-Locale", HeaderValue::from_static("zh_CN"));
    h.insert("X-Client-Bundle-Id", HeaderValue::from_static("com.deepseek.chat"));
    h.insert("X-Client-Timezone-Offset", HeaderValue::from_static("28800"));

    let resp2 = client.get("https://httpbin.org/headers").headers(h).send().await?;
    let text2 = resp2.text().await?;
    let body2: serde_json::Value = serde_json::from_str(&text2)?;
    println!("\n=== emulation + fork web_base_headers overrides ===");
    if let Some(h) = body2.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h { println!("  {k}: {}", v.as_str().unwrap_or("?")); }
    }
    Ok(())
}
