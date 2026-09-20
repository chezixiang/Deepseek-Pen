// 解密真实浏览器提交的 ip 字段：DES 解密(key='pceqy3rl') → 应得 32 位 md5 hex
// 运行：IP_B64=<base64> cargo test --test decrypt_ip -- --nocapture
use sm_des::{sm_des_decrypt_ecb_zero_pad, sm_des_encrypt_ecb_zero_pad};
use base64::Engine;

fn b64d(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut vals = Vec::new();
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = T.iter().position(|t| *t == c).expect("bad b64") as u32;
        vals.push(v);
    }
    let mut out = Vec::new();
    for chunk in vals.chunks(4) {
        let mut n = 0u32;
        for (i, v) in chunk.iter().enumerate() {
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 1 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 2 {
            out.push(n as u8);
        }
    }
    out
}

#[test]
fn decrypt_real_ip() {
    let ip_b64 = std::env::var("IP_B64").unwrap_or_default();
    if ip_b64.is_empty() {
        println!("IP_B64 未设置，跳过");
        return;
    }
    let ct = b64d(&ip_b64);
    println!("RUST_CT_HEX={}", ct.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let ct_str: String = ct.iter().map(|b| *b as char).collect();
    let md5_hex = String::from_utf8(sm_des_decrypt_ecb_zero_pad("pceqy3rl", &ct_str))
        .unwrap_or_default()
        .trim_end_matches('\0')
        .to_string();
    let raw = sm_des_decrypt_ecb_zero_pad("pceqy3rl", &ct_str);
    println!("RAW_DECRYPTED_BYTES={:02x?}", raw);
    println!("RAW_AS_CHARS={}", String::from_utf8_lossy(&raw));
    println!("EXPECTED_IP_MD5={md5_hex}");
    println!("EXPECTED_IP_MD5_BYTES={:02x?}", md5_hex.as_bytes());
    if let Ok(cand) = std::env::var("CAND_MD5") {
        let ct = sm_des_encrypt_ecb_zero_pad("pceqy3rl", &cand);
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(ct);
        println!("CAND_IP_B64={b64}");
        println!("CAND_MATCH={}", b64 == ip_b64);
    }
}
