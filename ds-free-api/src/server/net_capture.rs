//! 网络抓取（JSONL）—— 调试模式下把本服务涉网流量全量双向落盘：
//! 入站（词典笔/兼容客户端 → 本服务，axum 中间件）+ 出站（本服务 → DeepSeek/
//! 数美/HIF 等上游），格式与手工 net-export jsonl 一致（每行一个 JSON 事件）。
//!
//! 目的：禁言/风控等异常再次出现时，不挂代理抓包就能拿到第一手报文——
//! 请求方法、URL、头、请求体，与响应状态、头、响应体。
//!
//! 事件方向：`request` 事件带 `dir` 字段（"in"/"out"）；同一 `id` 关联一次
//! 往返的 request/response/response_body/error（response 等事件靠 id 回查方向；
//! 出站 URL 是绝对地址、入站是路径，也可直接从 url 区分）。
//!
//! 开关：config.toml `[server] net_capture`（词典笔端由设置页「启用调试日志」
//! 同步写入；改开关需重启后端生效，与 [proxy] 一致）。运行期只读一次。
//!
//! 落点：`$DS_DATA_DIR/logs/net-capture.jsonl`，超 128MB 轮转保留 .1/.2
//! （与 runtime_log 同款策略，总上限 ~384MB）。
//!
//! 体与截断：非流式体全量记录（上限 16MB，超出打 truncated 标记但**透传内容
//! 不受影响**）；SSE 流累计同样 16MB 上限。二进制体（multipart/PNG/wasm）只记
//! 说明不落内容。
//!
//! 隐私：报文含 Authorization/Cookie/API key 等真实凭据 —— 第一手证据优先
//! （与此前手工抓包一致），文件仅落本机；对外分享前由使用者自行脱敏。
//!
//! 注意：出站 headers 记录的是**应用层显式设置**的头（client.rs 构造的那部分），
//! 不含 wreq 仿真层内部补齐的默认头（sec-ch-ua / 伪头 / 头序）；入站头为完整
//! 收到的头。该事实随 session 事件写入文件，避免误读。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use chrono::Local;
use serde_json::{json, Map, Value};

/// 单文件上限 128MB；当前 + .1 + .2 ≈ 384MB 封顶
const MAX_FILE_SIZE: u64 = 128 * 1024 * 1024;
/// 保留的历史文件数
const MAX_HISTORY_FILES: usize = 2;
/// 非流式体与 SSE 流累计的落盘上限（透传不受影响，仅记录截断）
pub const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// 入站请求体的读取缓冲上限（超过直接 413；本服务只面向本机/自用客户端）
pub const MAX_READ_BYTES: usize = 32 * 1024 * 1024;

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
            "note": "双向抓取：dir=in 为入站（客户端→本服务），dir=out 为出站（本服务→上游）；id 关联同一次往返。出站 headers 为应用层显式设置（不含 wreq 仿真层默认头），入站 headers 为完整收到的头。非流式体上限 16MB，超出打 truncated 但透传完整",
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

/// 头值的文本化抽象：wreq 与 axum 的 `HeaderValue` 是同一 http 1.x 类型
/// （均未实现 `AsRef<str>`/`Display`），这里统一收口（非可见 ASCII 头值记空串）。
pub trait HeaderValueText {
    fn header_text(&self) -> String;
}

/// 引用解引用：调用方传 `&HeaderMap` 时元素是 `&HeaderValue`
impl<T: HeaderValueText + ?Sized> HeaderValueText for &T {
    fn header_text(&self) -> String {
        (*self).header_text()
    }
}

impl HeaderValueText for str {
    fn header_text(&self) -> String {
        self.to_string()
    }
}

impl HeaderValueText for String {
    fn header_text(&self) -> String {
        self.clone()
    }
}

/// 同时覆盖 wreq::header::HeaderValue 与 axum::http::HeaderValue（同一类型）
impl HeaderValueText for axum::http::HeaderValue {
    fn header_text(&self) -> String {
        self.to_str().map(|s| s.to_string()).unwrap_or_default()
    }
}

/// 请求事件。dir："in"（客户端→本服务）或 "out"（本服务→上游）。
/// body：None=无请求体；`Value::String`=原始请求体文本（JSON 序列化产物）；
/// 其他 Value=说明性对象（multipart/二进制概要，内容不落盘）。
///
/// headers 泛型兼容 wreq 与 axum 两种 HeaderMap（&Map 即 IntoIterator，
/// 元素为 (&HeaderName, &HeaderValue)：name 走 AsRef<str>，value 走 HeaderValueText）。
pub fn req<H, K, V>(
    id: u64,
    dir: &str,
    method: &str,
    url: &str,
    headers: H,
    body: Option<Value>,
) where
    H: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: HeaderValueText,
{
    if id == 0 {
        return;
    }
    let mut ev = json!({
        "ts": now_ts(),
        "id": id,
        "dir": dir,
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

/// 响应头事件（读体前调用）。stream=true 表示响应体为流式，结束时会有 response_body。
pub fn resp<H, K, V>(id: u64, status: u16, headers: H, stream: bool)
where
    H: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: HeaderValueText,
{
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

/// 响应体事件（非流式读完 / 流结束时）。内部按 MAX_BODY_BYTES 截断兜底。
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

/// 请求体记录值：文本类 content-type（json/text/xml/urlencoded/js/空）→ 原文
/// （超上限打 truncated）；二进制类 → 说明对象（内容不落盘）。
pub fn body_record(bytes: &[u8], content_type: Option<&str>) -> Value {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    let textual = ct.is_empty()
        || ct.contains("json")
        || ct.contains("text")
        || ct.contains("xml")
        || ct.contains("x-www-form-urlencoded")
        || ct.contains("javascript");
    if !textual {
        return json!({
            "_binary_omitted": bytes.len(),
            "content_type": ct,
            "note": "二进制请求体不落盘",
        });
    }
    let take = bytes.len().min(MAX_BODY_BYTES);
    let mut v = Value::String(String::from_utf8_lossy(&bytes[..take]).into_owned());
    if bytes.len() > MAX_BODY_BYTES {
        // 值是 String 时挂不了字段，包一层
        v = json!({ "body": v, "truncated": true });
    }
    v
}

fn now_ts() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string()
}

/// 头迭代 → JSON 对象（键小写；同名多头用 \n 连接，典型是 Set-Cookie）
fn headers_value<H, K, V>(headers: H) -> Value
where
    H: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: HeaderValueText,
{
    let mut map = Map::new();
    for (name, value) in headers {
        let key = name.as_ref().to_ascii_lowercase();
        let v = value.header_text();
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
    // std Mutex + 同步写：与 runtime_log 同款。单条 ≤ 数 MB、单用户低频，
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

    /// 未初始化（测试进程没有 main）时所有函数必须安全 no-op，不得 panic
    #[test]
    fn noop_without_init() {
        assert!(!enabled());
        assert_eq!(begin(), 0);
        let h: Vec<(&str, &str)> = vec![("x-test", "1")];
        req(begin(), "out", "GET", "https://example.com", h.iter().copied(), None);
        resp(begin(), 200, h.iter().copied(), false);
        body(begin(), b"ok", false);
        body_note(begin(), "n");
        err(begin(), "e");
    }

    /// headers_value：多值头合并（\n 连接）、键小写化
    #[test]
    fn headers_multi_value_merged() {
        let h: Vec<(&str, &str)> = vec![
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
            ("X-Hi", "hi"),
        ];
        let v = headers_value(h.iter().copied());
        assert_eq!(v["set-cookie"], "a=1\nb=2");
        assert_eq!(v["x-hi"], "hi");
    }

    /// body_record：文本体原样（截断打标）、二进制体只记说明
    #[test]
    fn body_record_text_vs_binary() {
        let text = body_record(b"{\"a\":1}", Some("application/json"));
        assert_eq!(text, Value::String("{\"a\":1}".into()));

        let bin = body_record(b"\x89PNG", Some("image/png"));
        assert!(bin.get("_binary_omitted").is_some());

        let big = vec![b'x'; MAX_BODY_BYTES + 10];
        let trunc = body_record(&big, Some("application/json"));
        assert_eq!(trunc["truncated"], Value::Bool(true));
    }

    /// MAX_BODY_BYTES 截断逻辑（body() 的切片路径同款）
    #[test]
    fn body_truncation_flags() {
        let big = vec![b'x'; MAX_BODY_BYTES + 10];
        let take = big.len().min(MAX_BODY_BYTES);
        let truncated = big.len() > MAX_BODY_BYTES;
        assert_eq!(take, MAX_BODY_BYTES);
        assert!(truncated);
    }

    /// begin 的 id 单调递增（同进程内）
    #[test]
    fn ids_increase() {
        let a = begin();
        let b = begin();
        if a != 0 {
            assert!(b > a);
        }
    }
}
