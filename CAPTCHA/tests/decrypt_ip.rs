// 解密真实浏览器提交的 ip 字段：DES 解密(key='pceqy3rl') → 应得 32 位 md5 hex
// 运行：IP_B64=<base64> cargo test --test decrypt_ip -- --nocapture --ignored
//
// 调试脚本（依赖环境变量输入），非回归测试：默认 #[ignore]，
// 完整 `cargo test` 不会执行它。
//
// 历史注记：旧版本地手写的 b64d 在末尾 2/3 值分组会多吐一个 0x00 字节，
// 且 `b as char` + collect 成 String 会把 >=0x80 的密文字节按 UTF-8 重新
// 编码后再解密，得到的全是乱码——本脚本此前对真实密文的输出不可信。
// 现改用库内 sm_base64_decode / *_bytes 变体。
use base64::Engine;
use sm_des::{sm_base64_decode, sm_des_decrypt_ecb_zero_pad_bytes, sm_des_encrypt_ecb_zero_pad};

#[test]
#[ignore = "调试脚本：需要 IP_B64 环境变量，非回归测试"]
fn decrypt_real_ip() {
    let ip_b64 = std::env::var("IP_B64").unwrap_or_default();
    if ip_b64.is_empty() {
        println!("IP_B64 未设置，跳过");
        return;
    }
    let ct = sm_base64_decode(&ip_b64);
    println!("RUST_CT_HEX={}", ct.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let raw = sm_des_decrypt_ecb_zero_pad_bytes("pceqy3rl".as_bytes(), &ct);
    let md5_hex = String::from_utf8(raw.clone())
        .unwrap_or_default()
        .trim_end_matches('\0')
        .to_string();
    println!("RAW_DECRYPTED_BYTES={:02x?}", raw);
    println!("RAW_AS_CHARS={}", String::from_utf8_lossy(&raw));
    println!("EXPECTED_IP_MD5={md5_hex}");
    println!("EXPECTED_IP_MD5_BYTES={:02x?}", md5_hex.as_bytes());
    if let Ok(cand) = std::env::var("CAND_MD5") {
        let ct = sm_des_encrypt_ecb_zero_pad("pceqy3rl", &cand);
        let b64 = base64::engine::general_purpose::STANDARD.encode(ct);
        println!("CAND_IP_B64={b64}");
        println!("CAND_MATCH={}", b64 == ip_b64);
    }
}
