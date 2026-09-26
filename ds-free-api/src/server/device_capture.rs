//! 设备验证辅助页 —— 在笔上的 WPE WebKit 浏览器 miniapp（appid 8001779591038449）
//! 中运行真实的数美 fp.min.js，为本机 mint 一个**真实**的 device_id + smidV2。
//!
//! 背景：登录请求体里的 device_id 由数美 SDK↔deviceprofile/v4 的注册流程签发，
//! 不可伪造（伪造值 → RISK_DEVICE_DETECTED / biz_code 11）。词典笔上没有 PC，
//! 用户无法做 DevTools 抓取；但笔自带一个 WPE WebKit 浏览器小程序，可以直接
//! 打开本服务提供的本地页面 —— 于是在**真实浏览器环境**里跑**真的 SDK**：
//!
//! 1. 笔端 app 通过 `$falcon.navTo('falcon://1779591038449/index', {url})` 打开
//!    `http://127.0.0.1:{port}/device?key=<apiKey>`
//! 2. 页面设置 `window._smConf`（与 DeepSeek 页面相同的 organization/公钥）并
//!    加载 `https://chat.deepseek.com/static/fp.min.js`
//! 3. SDK 在真实 WebKit 中采集（真实 aarch64 指纹）、向 apiHost 注册、签发 SMID
//! 4. `SMSdk.getDeviceId()` 拿到 device_id，连同 SDK 本地生成的 smidV2 一并
//!    POST 回 `/device-id-capture/submit`（同源 localhost，无跨域问题）
//! 5. 服务端写入 config.toml 对应账号并重新登录
//!
//! 安全：page/端点均要求 `key` 等于本服务已配置的某个 API Key（与笔端 app
//! 已持有的 key 一致）；本服务默认只绑 127.0.0.1，浏览器也在笔上，无外部暴露。

use axum::{
    Json,
    extract::{Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::handlers::AppState;

/// DeepSeek 传给数美 SDK 的配置（main bundle 逆向：
/// `(0,eu.Uo)({organization:"P9usCUBauxft8eAmUXaZ", ...})`）
const SM_ORGANIZATION: &str = "P9usCUBauxft8eAmUXaZ";
const SM_APP_ID: &str = "default";
const SM_API_HOST: &str = "fp-it-acc.portal101.cn";
const SM_PUBLIC_KEY: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDetfEgYD4aE1ZjmWJ6/jnPurhzI+yeRoJHWrnNtQMte3stQ4VjG3yu21FuN75E6cDpA9KtDXwcB2M/FiGUAe3G0rNotbWI8+SjZfUbW/OILFTzY0uaeEkmVGW5WyJ6weQbbr1xTCPa2OO3YIMeZljWUYHG5h21WAm/PATg8im8cQIDAQAB";
/// fp.min.js 在 DeepSeek 静态资源上的路径（无 hash，稳定）
const FP_SCRIPT_URL: &str = "https://chat.deepseek.com/static/fp.min.js";

/// 设备验证专用 LAN 监听端口（独立于主服务端口段 22217-22222，
/// 只暴露 /device* 路由，主服务的 chat/admin 端点不对 LAN 开放）
pub const CAPTURE_PORT: u16 = 22230;

/// 本机局域网 IPv4（优先私网段；找不到返回 None）
pub fn lan_ipv4() -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    for iface in if_addrs::get_if_addrs().ok()?.into_iter() {
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
            let ip = v4.ip.to_string();
            if ip.starts_with("127.") {
                continue;
            }
            candidates.push(ip);
        }
    }
    // 优先 192.168 / 10. / 172. 私网段
    candidates.sort_by_key(|ip| {
        let pref = if ip.starts_with("192.168.")
            || ip.starts_with("10.")
            || ip.starts_with("172.")
        {
            0
        } else {
            1
        };
        (pref, ip.clone())
    });
    candidates.into_iter().next()
}

/// 设备验证页完整 URL（供二维码编码）
pub fn capture_url(lan_ip: &str, key: &str) -> String {
    format!(
        "http://{}:{}/device?key={}",
        lan_ip,
        CAPTURE_PORT,
        urlencoding_lite(key)
    )
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 生成二维码 PNG 字节（手机扫码直达验证页）
fn qr_png_bytes(content: &str) -> Result<Vec<u8>, String> {
    use image::Luma;
    let code = qrcode::QrCode::with_error_correction_level(
        content.as_bytes(),
        qrcode::EcLevel::M,
    )
    .map_err(|e| format!("QR 编码失败: {e}"))?;
    let img = code.render::<Luma<u8>>().quiet_zone(true).build();
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(buf.into_inner())
}

#[derive(Debug, Deserialize)]
pub struct KeyQuery {
    pub key: Option<String>,
}

/// 校验 key 与本服务已配置的某个 API Key 一致；未配置任何 Key 时放行
/// （与无鉴权部署的信任级别一致，页面本身只暴露在 127.0.0.1）。
fn key_ok(state: &AppState, key: &Option<String>) -> bool {
    let Some(provided) = key.as_deref().filter(|k| !k.is_empty()) else {
        return false;
    };
    // 在异步锁里取配置会把 guard 传进来，这里用 try_read 足够（页面/提交都是低频操作）
    match state.config.try_read() {
        Ok(guard) => {
            let keys = &guard.api_keys;
            if keys.is_empty() {
                return true;
            }
            keys.iter().any(|k| k.key == provided)
        }
        Err(_) => false,
    }
}

fn unauthorized() -> Response {
    (
        axum::http::StatusCode::FORBIDDEN,
        "无效的 key（请在应用设置里重新打开本页面）",
    )
        .into_response()
}

/// GET /device —— 自包含验证页（ES5 兼容，WPE WebKit 版本未知）
pub async fn page(Query(q): Query<KeyQuery>, State(state): State<AppState>) -> Response {
    if !key_ok(&state, &q.key) {
        return unauthorized();
    }
    let key = q.key.unwrap_or_default();
    // JS/CSS 里的花括号不做 format!，用占位符替换，避免转义地狱
    let html = PAGE_TEMPLATE
        .replace("__KEY__", &html_attr_escape(&key))
        .replace("__ORG__", SM_ORGANIZATION)
        .replace("__APPID__", SM_APP_ID)
        .replace("__APIHOST__", SM_API_HOST)
        .replace("__PUBKEY__", SM_PUBLIC_KEY)
        ;
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

fn html_attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// GET /device-id-capture/accounts —— 账号列表（登录标识打码）
pub async fn accounts(Query(q): Query<KeyQuery>, State(state): State<AppState>) -> Response {
    if !key_ok(&state, &q.key) {
        return unauthorized();
    }
    let guard = state.config.read().await;
    let list: Vec<Value> = guard
        .accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let id = if !a.email.is_empty() {
                &a.email
            } else {
                &a.mobile
            };
            serde_json::json!({
                "index": i,
                "id": id,
                "display": mask_id(id),
                "has_device_id": !a.device_id.trim().is_empty(),
            })
        })
        .collect();
    Json(serde_json::json!({ "accounts": list })).into_response()
}

fn mask_id(id: &str) -> String {
    let id = id.trim();
    if id.contains('@') {
        // 邮箱：保留首字符与域名
        if let Some(at) = id.find('@') {
            let (name, domain) = id.split_at(at);
            let head: String = name.chars().take(2).collect();
            return format!("{head}***{domain}");
        }
    }
    if id.len() >= 7 {
        let head: String = id.chars().take(3).collect();
        let tail: String = id.chars().skip(id.len() - 4).collect();
        return format!("{head}****{tail}");
    }
    "***".to_string()
}

/// GET /device/qr —— 生成二维码 PNG 并写入后端工作目录，返回 {url, qr_path}。
///
/// 供无浏览器 miniapp 的笔使用：app 显示二维码图片，用户手机扫码后在其真实
/// 浏览器里完成验证（与 PC/笔浏览器流程同一页面同一提交端点）。
pub async fn qr(Query(q): Query<KeyQuery>, State(state): State<AppState>) -> Response {
    if !key_ok(&state, &q.key) {
        return unauthorized();
    }
    let key = q.key.clone().unwrap_or_default();
    let Some(ip) = lan_ipv4() else {
        return Json(serde_json::json!({
            "ok": false,
            "message": "未找到局域网 IP（设备未联网或未连接 WiFi）"
        }))
        .into_response();
    };
    let url = capture_url(&ip, &key);
    let png = match qr_png_bytes(&url) {
        Ok(b) => b,
        Err(e) => {
            return Json(serde_json::json!({ "ok": false, "message": e })).into_response()
        }
    };
    // 写入 config.toml 同目录（app 的 fs 模块可直接读该目录）
    let qr_path = state
        .config_path
        .parent()
        .map(|p| p.join("device-qr.png"))
        .unwrap_or_else(|| std::path::PathBuf::from("device-qr.png"));
    if let Err(e) = std::fs::write(&qr_path, &png) {
        return Json(serde_json::json!({
            "ok": false,
            "message": format!("二维码写入失败: {e}")
        }))
        .into_response();
    }
    Json(serde_json::json!({
        "ok": true,
        "url": url,
        "qr_path": qr_path.to_string_lossy(),
        "ip": ip,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct SubmitBody {
    pub key: Option<String>,
    /// 账号登录标识（完整 email 或 mobile）
    pub account: String,
    /// 数美 SDK 签发的 device_id
    pub device_id: String,
    /// SDK 本地生成的 smidV2（可选，同一 SDK 会话产出，建议一并保存）
    #[serde(default)]
    pub smid: String,
}

/// POST /device-id-capture/submit —— 写入 device_id/smid 并重新登录该账号
pub async fn submit(
    State(state): State<AppState>,
    Json(body): Json<SubmitBody>,
) -> Response {
    if !key_ok(&state, &body.key) {
        return unauthorized();
    }
    let device_id = body.device_id.trim().to_string();
    if device_id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "message": "device_id 为空" })).into_response();
    }
    let account_id = body.account.trim().to_string();
    if account_id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "message": "未选择账号" })).into_response();
    }
    let smid = body.smid.trim().to_string();

    // 1. 更新配置并落盘
    let updated_account = {
        let mut guard = state.config.write().await;
        let Some(acct) = guard.accounts.iter_mut().find(|a| {
            (!a.email.is_empty() && a.email == account_id)
                || (!a.mobile.is_empty() && a.mobile == account_id)
        }) else {
            return Json(serde_json::json!({
                "ok": false,
                "message": format!("配置中未找到账号 {account_id}")
            }))
            .into_response();
        };
        acct.device_id = device_id;
        if !smid.is_empty() {
            acct.smid = smid;
        }
        let snapshot = acct.clone();
        if let Err(e) = guard.save(&state.config_path) {
            return Json(serde_json::json!({
                "ok": false,
                "message": format!("配置写入失败: {e}")
            }))
            .into_response();
        }
        snapshot
    };

    // 2. 用新凭据重建池中账号（移除旧态 + 全量初始化 = 用新 device_id 重新登录）
    let display = if !updated_account.email.is_empty() {
        updated_account.email.clone()
    } else {
        updated_account.mobile.clone()
    };
    let Ok(adapter) = state.adapter().await else {
        // 启动中：凭据已写入 config，后台初始化会带上新凭据登录
        return Json(serde_json::json!({
            "ok": true,
            "message": "设备凭据已写入，后端启动完成后将用新凭据登录"
        }))
        .into_response();
    };
    let _ = adapter.remove_account(&display).await;
    match adapter.add_account(&updated_account).await {
        Ok(_) => Json(serde_json::json!({
            "ok": true,
            "message": "设备凭据已写入并重新登录成功"
        }))
        .into_response(),
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "message": format!("凭据已写入，但重新登录失败：{e}。可在应用设置里保存一次账号触发重试")
        }))
        .into_response(),
    }
}

/// 设备验证专用路由（同时挂主服务与 LAN 监听器）
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/device", axum::routing::get(page))
        .route("/device/qr", axum::routing::get(qr))
        .route("/device/fp-patched.js", get(fp_patched_js))
        .route(
            "/device-id-capture/accounts",
            axum::routing::get(accounts),
        )
        .route("/device-id-capture/submit", post(submit))
        .route("/device-id-capture/debug", post(debug_capture))
        .with_state(state)
}

// ── fp.min.js 打补丁服务（1902 调试用：泄漏加密前明文/密钥/uid）──

static FP_PATCHED: tokio::sync::OnceCell<Result<String, String>> = tokio::sync::OnceCell::const_new();

pub async fn fp_patched_js() -> Response {
    let result: Result<String, String> = FP_PATCHED
        .get_or_init(|| async { download_and_patch_fp().await })
        .await
        .clone();
    match result {
        Ok(js) => (
            [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
            js,
        )
            .into_response(),
        Err(e) => (axum::http::StatusCode::BAD_GATEWAY, format!("// {e}")).into_response(),
    }
}

async fn download_and_patch_fp() -> Result<String, String> {
    let client = wreq::Client::builder()
        .user_agent(crate::ds_core::default_user_agent())
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let cid = crate::server::net_capture::begin();
    crate::server::net_capture::req(
        cid,
        "GET",
        FP_SCRIPT_URL,
        &wreq::header::HeaderMap::new(),
        None,
    );
    let resp = client
        .get(FP_SCRIPT_URL)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    match &resp {
        Ok(r) => crate::server::net_capture::resp(cid, r.status().as_u16(), r.headers(), false),
        Err(e) => crate::server::net_capture::err(cid, &e.to_string()),
    }
    let resp = resp.map_err(|e| format!("下载 fp.min.js 失败: {e}"))?;
    let code = resp.text().await.map_err(|e| format!("读取: {e}"))?;
    crate::server::net_capture::body(
        cid,
        code.as_bytes(),
        code.len() > crate::server::net_capture::MAX_BODY_BYTES,
    );
    apply_fp_patches(&code)
}

/// 与 tools/fp-reverse/harness.js 相同的三处插桩
fn apply_fp_patches(code: &str) -> Result<String, String> {
    let aes_call = "_0x54fe30['AES']['encrypt'](_0x527184,_0x55d7b3,";
    if !code.contains(aes_call) {
        return Err("fp.min.js 结构变化：AES 调用点未找到（需更新补丁）".to_string());
    }
    let mut out = code.replace(
        aes_call,
        "globalThis.__lastPlain=(typeof _0x527184==='string'?_0x527184:String(_0x527184)),\
         globalThis.__fpAesKey=(typeof _0x55d7b3.toString==='function'?_0x55d7b3.toString():String(_0x55d7b3)),\
         globalThis.__fpAesIv=(typeof _0x401bc7.toString==='function'?_0x401bc7.toString():String(_0x401bc7)),\
         _0x54fe30['AES']['encrypt'](_0x527184,_0x55d7b3,",
    );
    let rsa_sig = "['rsaEncrypt']=function(_0x395634,_0x435ad9){";
    if out.contains(rsa_sig) {
        out = out.replace(
            rsa_sig,
            "['rsaEncrypt']=function(_0x395634,_0x435ad9){globalThis.__fpUid=_0x395634;",
        );
    }
    Ok(out)
}

/// 调试捕获：真实浏览器的 (uid, aesKey, aesIv, 加密前明文, 线缆请求体)
#[derive(Debug, Deserialize)]
pub struct DebugBody {
    pub key: Option<String>,
    #[serde(default)]
    pub uid: Value,
    #[serde(default)]
    pub aes_key: Value,
    #[serde(default)]
    pub aes_iv: Value,
    #[serde(default)]
    pub last_plain: Value,
    #[serde(default)]
    pub xhr_body: Value,
}

pub async fn debug_capture(
    State(state): State<AppState>,
    Json(body): Json<DebugBody>,
) -> Response {
    if !key_ok(&state, &body.key) {
        return unauthorized();
    }
    let record = json!({
        "t": now_ms_iso(),
        "uid": body.uid,
        "aes_key": body.aes_key,
        "aes_iv": body.aes_iv,
        "last_plain": body.last_plain,
        "xhr_body": body.xhr_body,
    });
    let path = state
        .config_path
        .parent()
        .map(|p| p.join("device-debug.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("device-debug.json"));
    match std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap_or_default()) {
        Ok(_) => Json(json!({ "ok": true, "path": path.to_string_lossy() })).into_response(),
        Err(e) => Json(json!({ "ok": false, "message": format!("写入失败: {e}") })).into_response(),
    }
}

fn now_ms_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%z").to_string()
}

const PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>设备验证</title>
<style>
body { font-family: sans-serif; background: #0c1014; color: #f5f7fa; margin: 0; padding: 14px; }
h1 { font-size: 20px; margin: 0 0 10px; }
p, li { font-size: 15px; line-height: 1.6; }
.box { background: #151b22; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
button { background: #2f81f7; color: #fff; border: 0; border-radius: 8px; padding: 12px 18px; font-size: 16px; width: 100%; }
button[disabled] { background: #33414f; }
select, input { width: 100%; font-size: 15px; padding: 8px; background: #0c1014; color: #f5f7fa; border: 1px solid #33414f; border-radius: 6px; }
#status { color: #8fd0ff; }
#detail { color: #c8d3da; font-size: 13px; word-break: break-all; }
.ok { color: #56d364; }
.err { color: #ffb4a8; }
</style>
</head>
<body>
<h1>设备验证</h1>
<div class="box">
  <p>本页面在<strong>本机浏览器</strong>中运行 DeepSeek 官方设备识别组件，
  为当前设备生成登录凭据并写入后端配置。全程在本机完成。</p>
  <p><label>选择账号</label><br><select id="account"></select></p>
  <p><button id="go" disabled>正在加载组件…</button></p>
  <p id="status">初始化…</p>
  <p id="detail"></p>
</div>
<script>
var KEY = "__KEY__";
var SM_CONF = {
  organization: "__ORG__",
  appId: "__APPID__",
  publicKey: "__PUBKEY__",
  protocol: "https",
  apiHost: "__APIHOST__"
};
function $(id) { return document.getElementById(id); }
function setStatus(cls, text) { var el = $("status"); el.className = cls || ""; el.textContent = text; }
function setDetail(text) { $("detail").textContent = text || ""; }

function readSmidV2() {
  try {
    var m = document.cookie.match(/(?:^|;\s*)smidV2=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (e) {}
  try {
    var v = localStorage.getItem("smidV2");
    if (v) return v;
  } catch (e) {}
  return "";
}

// 1902 调试：捕获真实 SDK 的内部状态（uid/AES key/加密前明文/线缆请求体）
window.__fpDebug = {};
(function() {
  var RawXhrOpen = XMLHttpRequest.prototype.open;
  var RawXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) {
    this.__dbgM = m; this.__dbgU = u;
    return RawXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    try {
      if (this.__dbgU && this.__dbgU.indexOf("deviceprofile") >= 0) {
        window.__fpDebug.xhrBody = String(body === undefined || body === null ? "" : body);
      }
    } catch (e) {}
    return RawXhrSend.apply(this, arguments);
  };
})();

function postDebug() {
  try {
    var d = window.__fpDebug;
    if (typeof window.__lastPlain !== 'undefined' && window.__lastPlain) d.lastPlain = window.__lastPlain;
    if (typeof window.__fpAesKey !== 'undefined' && window.__fpAesKey) d.aesKey = window.__fpAesKey;
    if (typeof window.__fpAesIv !== 'undefined' && window.__fpAesIv) d.aesIv = window.__fpAesIv;
    if (typeof window.__fpUid !== 'undefined' && window.__fpUid) d.uid = window.__fpUid;
    if (!d.lastPlain && !d.xhrBody) return;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/device-id-capture/debug", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify({
      key: KEY,
      uid: d.uid || "",
      aes_key: d.aesKey || "",
      aes_iv: d.aesIv || "",
      last_plain: d.lastPlain || "",
      xhr_body: d.xhrBody || ""
    }));
  } catch (e) {}
}
setInterval(postDebug, 4000);

function loadAccounts(cb) {
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/device-id-capture/accounts?key=" + encodeURIComponent(KEY), true);
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      try {
        var data = JSON.parse(xhr.responseText);
        var sel = $("account");
        sel.innerHTML = "";
        var list = data.accounts || [];
        for (var i = 0; i < list.length; i++) {
          var opt = document.createElement("option");
          opt.value = list[i].id;
          opt.textContent = list[i].display + (list[i].has_device_id ? "（已有凭据）" : "（无凭据）");
          sel.appendChild(opt);
        }
        cb(list.length > 0 ? null : "配置中还没有账号，请先在应用里填写账号密码");
      } catch (e) { cb(String(e)); }
    };
    xhr.send();
  } catch (e) { cb(String(e)); }
}

function submitResult(deviceId) {
  setStatus("", "正在写入配置并重新登录…");
  var smid = readSmidV2();
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/device-id-capture/submit", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      try {
        var data = JSON.parse(xhr.responseText);
        if (data.ok) {
          setStatus("ok", "✓ " + (data.message || "完成"));
          setDetail("device_id 已写入，可退出浏览器返回应用继续使用");
          $("go").textContent = "已完成（可退出）";
        } else {
          setStatus("err", "写入失败：" + (data.message || "未知错误"));
          $("go").disabled = false;
          $("go").textContent = "重试写入";
        }
      } catch (e) {
        setStatus("err", "响应解析失败：" + e);
        $("go").disabled = false;
      }
    };
    xhr.send(JSON.stringify({
      key: KEY,
      account: $("account").value,
      device_id: deviceId,
      smid: smid
    }));
  } catch (e) {
    setStatus("err", "提交异常：" + e);
    $("go").disabled = false;
  }
}

function runSdk() {
  setStatus("", "正在等待设备组件就绪（首次注册约需数秒）…");
  var done = false;
  try {
    window.SMSdk.ready(function() {
      try {
        var id = window.SMSdk.getDeviceId ? window.SMSdk.getDeviceId() : "";
        done = true;
        if (!id) {
          setStatus("err", "组件就绪但未返回凭据，请点按钮重试");
          $("go").disabled = false;
          $("go").textContent = "重试";
          return;
        }
        setDetail("凭据已生成（长度 " + id.length + "）");
        submitResult(id);
      } catch (e) {
        setStatus("err", "获取凭据异常：" + e);
        $("go").disabled = false;
      }
    });
    // 等待 SDK 内部流程把调试数据填好后再首次触发提交轮询
    setTimeout(function() {
      if (done) return;
      setStatus("err", "组件加载超时。请确认设备已联网后点按钮重试");
      $("go").disabled = false;
      $("go").textContent = "重试";
    }, 15000);
  } catch (e) {
    setStatus("err", "SDK 初始化异常：" + e);
    $("go").disabled = false;
  }
}

function boot() {
  loadAccounts(function(err) {
    if (err) { setStatus("err", err); $("go").disabled = true; return; }
    runSdk();
  });
}

window._smConf = SM_CONF;
window.__fpDebug = {};
window.SMSdk = { ready: function(cb) { if (cb) window._smReadyFuncs.push(cb); } };
window._smReadyFuncs = [];
document.write('<script src="/device/fp-patched.js"><\/script>');
window.addEventListener("load", function() {
  $("go").onclick = function() { $("go").disabled = true; boot(); };
  boot();
});
</script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_template_has_placeholders() {
        assert!(PAGE_TEMPLATE.contains("__KEY__"));
        assert!(PAGE_TEMPLATE.contains("/device/fp-patched.js"));
        assert!(PAGE_TEMPLATE.contains("device-id-capture/submit"));
        assert!(PAGE_TEMPLATE.contains("device-id-capture/debug"));
    }

    #[test]
    fn masking_hides_identity() {
        assert_eq!(mask_id("ab@example.com"), "ab***@example.com");
        assert_eq!(mask_id("13800138000"), "138****8000");
        assert_eq!(mask_id("x"), "***");
    }
}
