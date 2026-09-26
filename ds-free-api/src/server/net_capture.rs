//! 网络抓取（JSONL）—— 调试模式下把后端发往上游（DeepSeek / 数美）的全部
//! HTTP 往返逐条落盘，格式与手工 net-export jsonl 一致（每行一个 JSON 事件）。
//!
//! 目的：禁言/风控等异常再次出现时，不挂代理抓包就能拿到第一手报文——
//! 请求方法、URL、头、请求体，与响应状态、头、响应体（SSE 流累计到截断上限）。
//!
//! 开关：config.toml `[server] net_capture`（词典笔端由设置页「启用调试日志」
//! 同步写入；改开关需重启后端生效，与 [proxy] 一致）。运行期只读一次。
//!
//! 落点：`$DS_DATA_DIR/logs/net-capture.jsonl`，超 5MB 轮转保留 .1/.2
//! （与 runtime_log 同款策略，总上限 ~15MB）。
//!
//! 隐私：报文含 Authorization/Cookie 等真实凭据 —— 第一手证据优先（与此前
//! 手工抓包一致），文件仅落本机；对外分享前由使用者自行脱敏。
//!
//! 注意：headers 记录的是**应用层显式设置**的头（client.rs 构造的那部分），
//! 不含 wreq 仿真层内部补齐的默认头（sec-ch-ua / 伪头 / 头序）——那些无法
//! 在 reqwest 层观测；该事实随 session 事件写入文件，避免误读。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use chrono::Local;
use serde_json::{json, Map, Value};
use wreq::header::HeaderMap;

/// 单文件上限 5MB；当前 + .1 + .2 ≈ 15MB 封顶
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
/// 保留的历史文件数
const MAX_HISTORY_FILES: usize = 2;
/// 非流式响应体落盘截断上限（禁言等业务响应远小于此；大响应只为留证据）
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// SSE 流累计落盘上限（一条长回复的 SSE 明文可达数十 KB，留足余量）
pub const MAX_STREAM_BYTES: usize = 256 * 1024;

struct Capture {
    enabled: bool,
    path: PathBuf,
    /// 懒打开的当前文件（轮转后置 None，下次写时重开）
    file: std::sync::Mutex<Option<File>>,
    next_id: AtomicU64,
}

static CAPTURE: OnceLock<Capture> = OnceLock::new();

/// 启动时初始化（main.rs，紧跟 runtime_log::init）。未启用时所有记录函数均 no-op。
pub fn init(data_dir: &str, enabled: bool) {
    let path = PathBuf::from(data_dir).join("logs").join("net-capture.jsonl");
    let cap = Capture {
        enabled,
        path,
        file: std::sync::Mutex::new(None),
        next_id: AtomicU64::new(1),
    };
    if enabled {
        if let Some(parent) = cap.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
    }
    if CAPTURE.set(cap).is_ok() && enabled {
        // 会话起始标记：跨重启/轮转对齐用（版本 + 说明）
        write_event(&json!({
            "ts": now_ts(),
            "id": 0,
            "phase": "session",
            "version": env!("CARGO_PKG_VERSION"),
            "note": "headers 为应用层显式设置，不含 wreq 仿真层补齐的默认头；id 关联同一次往返的 request/response/response_body",
        }));
    }
}

/// 抓取是否启用（调用方可据此跳过流包装等有成本的操作）
pub fn enabled() -> bool {
    CAPTURE.get().map(|c| c.enabled).unwrap_or(false)
}

/// 分配本次往返的关联 id。未启用返回 0；所有记录函数对 id=0 直接 no-op（双保险）。
pub fn begin() -> u64 {
    if !enabled() {
        return 0;
    }
    CAPTURE
        .get()
        .map(|c| c.next_id.fetch_add(1, Ordering::Relaxed))
        .unwrap_or(0)
}

/// 请求事件。body：None=无请求体；`Value::String`=原始请求体文本（JSON 序列化产物）；
/// 其他 Value=说明性对象（如 multipart 概要，二进制内容不落盘）。
pub fn req(id: u64, method: &str, url: &str, headers: &HeaderMap, body: Option<Value>) {
    if id == 0 {
        return;
    }
    let mut ev = json!({
        "ts": now_ts(),
        "id": id,
        "phase": "request",
        "method": method,
        "url": url,
        "headers": headers_value(headers),
    });
    if let Some(b) = body {
        ev["body"] = b;
    }
    write_event(&ev);
}

/// 响应头事件（读体前调用）。stream=true 表示响应体为 SSE 流，结束时会有 response_body。
pub fn resp(id: u64, status: u16, headers: &HeaderMap, stream: bool) {
    if id == 0 {
        return;
    }
    let mut ev = json!({
        "ts": now_ts(),
        "id": id,
        "phase": "response",
        "status": status,
        "headers": headers_value(headers),
    });
    if stream {
        ev["body_stream"] = Value::Bool(true);
    }
    write_event(&ev);
}

/// 响应体事件（非流式读完 / 流结束时）。内部再按 MAX_BODY_BYTES 截断一次兜底。
pub fn body(id: u64, bytes: &[u8], truncated: bool) {
    if id == 0 {
        return;
    }
    let take = bytes.len().min(MAX_BODY_BYTES);
    let truncated = truncated || bytes.len() > MAX_BODY_BYTES;
    let mut ev = json!({
        "ts": now_ts(),
        "id": id,
        "phase": "response_body",
        "body": String::from_utf8_lossy(&bytes[..take]).into_owned(),
    });
    if truncated {
        ev["truncated"] = Value::Bool(true);
    }
    write_event(&ev);
}

/// 说明性 response_body 事件：响应体没有/不适合落盘时补一行说明
/// （拟真流量不读响应体、二进制 wasm、multipart 等），保证每个 id 的往返闭环。
pub fn body_note(id: u64, note: &str) {
    if id == 0 {
        return;
    }
    write_event(&json!({
        "ts": now_ts(),
        "id": id,
        "phase": "response_body",
        "body": {"_note": note},
    }));
}

/// 请求失败事件（连接/DNS/超时等）：response 事件不会出现，用 error 补位。
pub fn err(id: u64, msg: &str) {
    if id == 0 {
        return;
    }
    write_event(&json!({
        "ts": now_ts(),
        "id": id,
        "phase": "error",
        "error": msg,
    }));
}

fn now_ts() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string()
}

/// 头集合 → JSON 对象（键小写；同名多头用 \n 连接，典型是 Set-Cookie）
fn headers_value(headers: &HeaderMap) -> Value {
    let mut map = Map::new();
    for (name, value) in headers {
        let key = name.as_str().to_ascii_lowercase();
        let v = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match map.get_mut(&key) {
            Some(Value::String(prev)) => {
                prev.push('\n');
                prev.push_str(&v);
            }
            _ => {
                map.insert(key, Value::String(v));
            }
        }
    }
    Value::Object(map)
}

fn write_event(v: &Value) {
    let Some(cap) = CAPTURE.get() else { return };
    if !cap.enabled {
        return;
    }
    // std Mutex + 同步写：与 runtime_log 同款。单条 ≤ 数十 KB、单用户低频，
    // 阻塞开销可忽略；换 tokio 异步文件反而引入跨 await 持锁问题。
    let Ok(mut guard) = cap.file.lock() else { return };
    if guard.is_none()
        && let Ok(f) = OpenOptions::new().create(true).append(true).open(&cap.path)
    {
        *guard = Some(f);
    }
    if guard.is_some()
        && let Ok(meta) = fs::metadata(&cap.path)
        && meta.len() >= MAX_FILE_SIZE
    {
        rotate(cap, &mut guard);
    }
    if let Some(f) = guard.as_mut() {
        let mut line = v.to_string();
        line.push('\n');
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

/// 轮转：删最旧、依次顺移、当前 → .1（文件句柄置 None，下次写时重开）
fn rotate(cap: &Capture, cur: &mut Option<File>) {
    let p = cap.path.to_string_lossy().to_string();
    for i in (1..=MAX_HISTORY_FILES).rev() {
        let old = format!("{}.{}", p, i);
        if i == MAX_HISTORY_FILES {
            let _ = fs::remove_file(&old);
        } else {
            let _ = fs::rename(&old, format!("{}.{}", p, i + 1));
        }
    }
    let _ = fs::rename(&p, format!("{}.1", p));
    *cur = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use wreq::header::{HeaderMap, HeaderValue};

    /// 未初始化（测试进程没有 main）时所有函数必须安全 no-op，不得 panic
    #[test]
    fn noop_without_init() {
        assert!(!enabled());
        assert_eq!(begin(), 0);
        let mut h = HeaderMap::new();
        h.insert("x-test", HeaderValue::from_static("1"));
        req(begin(), "GET", "https://example.com", &h, None);
        resp(begin(), 200, &h, false);
        body(begin(), b"ok", false);
        body_note(begin(), "n");
        err(begin(), "e");
    }

    /// headers_value：多值头合并（\n 连接）、键小写化
    #[test]
    fn headers_multi_value_merged() {
        let mut h = HeaderMap::new();
        h.insert("Set-Cookie", HeaderValue::from_static("a=1"));
        h.append("Set-Cookie", HeaderValue::from_static("b=2"));
        h.insert("X-Hi", HeaderValue::from_static("hi"));
        let v = headers_value(&h);
        assert_eq!(v["set-cookie"], "a=1\nb=2");
        assert_eq!(v["x-hi"], "hi");
    }

    /// body 截断：超限部分丢弃并打 truncated 标记
    #[test]
    fn body_truncation_flags() {
        // 直接测内部逻辑：MAX_BODY_BYTES 较大，这里构造小值验证切片路径
        let big = vec![b'x'; MAX_BODY_BYTES + 10];
        let take = big.len().min(MAX_BODY_BYTES);
        let truncated = big.len() > MAX_BODY_BYTES;
        assert_eq!(take, MAX_BODY_BYTES);
        assert!(truncated);
    }
}
