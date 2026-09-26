//! 数美/Shumei 验证码透传桥。
//!
//! 当 DeepSeek 登录触发人机验证时，ds-free-api 无法在 Rust 侧自动完成交互式验证。
//! 本模块把验证“透传”给用户：
//! 1. 登录失败时生成一个 captcha session；
//! 2. 用户打开 `http://<host>:<port>/captcha/{id}` 看到验证说明（并尽可能加载官方 SDK）；
//! 3. 用户完成验证后点击“我已完成验证”；
//! 4. ds-free-api 收到回调后通知等待中的登录任务重试。

use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Json,
    extract::{Path, State},
    http::header,
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::oneshot;

use super::handlers::AppState;

const SDK_JS: &str = include_str!("../../../CAPTCHA/captcha-sdk.min.js");

#[derive(Clone)]
pub struct CaptchaStore {
    inner: Arc<DashMap<String, PendingCaptcha>>,
}

struct PendingCaptcha {
    detail: Value,
    tx: Option<oneshot::Sender<Value>>,
}

impl CaptchaStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
        }
    }

    /// 创建一个待验证会话，返回 (session_id, 完成通知 receiver)。
    pub fn create(&self, detail: Value) -> (String, oneshot::Receiver<Value>) {
        let id = format!(
            "cap_{:x}{:x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            rand::random::<u32>()
        );
        let (tx, rx) = oneshot::channel();
        self.inner.insert(
            id.clone(),
            PendingCaptcha {
                detail,
                tx: Some(tx),
            },
        );
        (id, rx)
    }

    pub fn get_detail(&self, id: &str) -> Option<Value> {
        self.inner.get(id).map(|p| p.detail.clone())
    }

    /// 清理会话（等待超时/已完成后调用）。没有它，每一次验证码登录
    /// 都会在 DashMap 里留下一条永不回收的条目，长期运行内存无限增长。
    pub fn remove(&self, id: &str) {
        self.inner.remove(id);
    }

    /// 用户完成验证后回调；返回是否成功通知到等待方。
    pub fn submit(&self, id: &str, result: Value) -> bool {
        if let Some(mut p) = self.inner.get_mut(id) {
            if let Some(tx) = p.tx.take() {
                let _ = tx.send(result);
                // 通知已送达，会话使命完成
                drop(p);
                self.inner.remove(id);
                return true;
            }
        }
        false
    }

}

impl Default for CaptchaStore {
    fn default() -> Self {
        Self::new()
    }
}

static GLOBAL: OnceLock<CaptchaStore> = OnceLock::new();

/// 全局验证码透传存储，供 ds_core 在登录失败时直接创建会话。
pub fn global() -> &'static CaptchaStore {
    GLOBAL.get_or_init(CaptchaStore::new)
}

/// 渲染验证透传页面。
pub async fn page(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    let store = &state.captcha;
    let Some(detail) = store.get_detail(&id) else {
        return (axum::http::StatusCode::NOT_FOUND, "captcha session not found").into_response();
    };

    let detail_json = serde_json::to_string_pretty(&detail).unwrap_or_else(|_| "{}".to_string());
    let detail_js = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());

    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek 人机验证</title>
<style>
body {{ font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #222; }}
.card {{ border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }}
h1 {{ font-size: 22px; }}
.btn {{ display: inline-block; margin-top: 16px; background: #1a73e8; color: #fff; border: 0; border-radius: 8px; padding: 10px 20px; font-size: 16px; }}
pre {{ background: #f6f7f9; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }}
</style>
</head>
<body>
<div class="card">
  <h1>DeepSeek 人机验证</h1>
  <p>当前登录触发了数美验证码。请在下方完成验证；如果 SDK 无法自动加载，请打开 DeepSeek 官方页面完成同账号验证后回到本页点击“我已完成验证”。</p>
  <div id="captcha-container"></div>
  <pre>{detail_json}</pre>
  <button class="btn" onclick="finish()">我已完成验证</button>
  <p id="status" style="margin-top:12px;color:#666;"></p>
</div>
<script src="/captcha/{id}/sdk.js"></script>
<script>
// DeepSeek 数美验证码固定参数（来自 HAR 抓包）
var DEEPSEEK_CAPTCHA = {{
  organization: 'P9usCUBauxft8eAmUXaZ',
  appId: 'default',
  channel: 'default',
  lang: 'zh-cn',
  model: 'spatial_select',
  rversion: '1.0.4',
  sdkver: '1.1.3',
  protocol: 207,
  os: 'web_pc'
}};
var detail = Object.assign({{}}, DEEPSEEK_CAPTCHA, {detail_js});
var captchaUuid = 'DS' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function postResult(result) {{
  fetch('/captcha/{id}/callback', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify(Object.assign({{ captchaUuid: captchaUuid }}, result || {{}}))
  }}).then(r => r.json()).then(d => {{
    document.getElementById('status').textContent = '验证结果已提交，可以返回 ds-free-api 重试。';
  }}).catch(e => {{
    document.getElementById('status').textContent = '提交失败：' + e;
  }});
}}

function finish() {{
  postResult({{ manual: true, rid: detail.rid || '' }});
}}

// 尝试初始化数美 SDK。不同版本暴露名可能是 smCaptcha / SMCaptcha / captcha。
try {{
  var CaptchaCtor = window.smCaptcha || window.SMCaptcha || window.captcha;
  if (CaptchaCtor && typeof CaptchaCtor.init === 'function') {{
    CaptchaCtor.init({{
      organization: detail.organization,
      appId: detail.appId,
      channel: detail.channel,
      lang: detail.lang,
      model: detail.model,
      rversion: detail.rversion,
      sdkver: detail.sdkver,
      protocol: detail.protocol,
      captchaUuid: captchaUuid,
      container: document.getElementById('captcha-container'),
      success: function(result) {{
        postResult(result);
      }},
      error: function(err) {{
        document.getElementById('status').textContent = 'SDK 初始化失败：' + (err && err.message ? err.message : JSON.stringify(err));
      }}
    }});
  }} else {{
    document.getElementById('status').textContent = '当前 SDK 未暴露 init 方法，请使用手动确认按钮。';
  }}
}} catch (e) {{
  console.error('captcha init error', e);
  document.getElementById('status').textContent = 'SDK 初始化异常：' + e;
}}
</script>
</body>
</html>"#
    );

    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

/// 返回原始数美 SDK JS。
pub async fn sdk_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        SDK_JS,
    )
        .into_response()
}

/// 接收用户验证完成回调。
pub async fn callback(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(result): Json<Value>,
) -> Json<Value> {
    let ok = state.captcha.submit(&id, result);
    Json(serde_json::json!({ "ok": ok }))
}

/// 等待用户完成验证，最多等待 timeout_secs。
pub async fn wait_for_solution(
    rx: oneshot::Receiver<Value>,
    timeout_secs: u64,
) -> Option<Value> {
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(v)) => Some(v),
        _ => None,
    }
}
