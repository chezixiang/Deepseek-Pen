//! 测试用本地 HTTP 捕获服务（仅 cfg(test) 编译）。
//!
//! 单连接、记录请求行与全部头部、回固定响应。供 mint 协议测试、
//! 仿真头断言、代理路由断言、smidV2 cookie 断言使用——不依赖任何
//! 额外测试框架，tokio + std 即可。

use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) struct CapturedRequest {
    pub method: String,
    pub uri: String,
    pub headers: HashMap<String, String>,
}

impl CapturedRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(|s| s.as_str())
    }
}

/// 在 127.0.0.1 随机端口起捕获服务，返回 `(地址, 结果句柄)`。
/// 句柄 await 后得到捕获到的第一个请求；调用方负责加超时。
pub(crate) fn spawn(
    status: u16,
    body: &'static str,
) -> (
    std::net::SocketAddr,
    tokio::task::JoinHandle<CapturedRequest>,
) {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
    std_listener
        .set_nonblocking(true)
        .expect("set_nonblocking");
    let addr = std_listener.local_addr().expect("local_addr");
    let listener =
        tokio::net::TcpListener::from_std(std_listener).expect("tokio TcpListener::from_std");
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.expect("read");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(head_end) = find_head_end(&buf) {
                if content_length_satisfied(&buf[..head_end], buf.len() - head_end) {
                    break;
                }
            }
            if buf.len() > (1 << 20) {
                break;
            }
        }
        let resp = format!(
            "HTTP/1.1 {status} OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        parse_request(&buf)
    });
    (addr, handle)
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length_satisfied(head: &[u8], body_len: usize) -> bool {
    let text = String::from_utf8_lossy(head);
    match text.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }) {
        Some(need) => body_len >= need,
        None => true,
    }
}

fn parse_request(buf: &[u8]) -> CapturedRequest {
    let text = String::from_utf8_lossy(buf);
    let (head, _body) = text.split_once("\r\n\r\n").unwrap_or((text.as_ref(), ""));
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let uri = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            // 同名多头（如 cookie 不会出现，但稳妥起见）用 ", " 连接
            headers
                .entry(name.trim().to_ascii_lowercase())
                .and_modify(|v: &mut String| {
                    v.push_str(", ");
                    v.push_str(value.trim());
                })
                .or_insert_with(|| value.trim().to_string());
        }
    }
    CapturedRequest {
        method,
        uri,
        headers,
    }
}
