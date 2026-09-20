// 解密真实浏览器 payload 的全部 DES 字段 → 输出明文格式
// 运行：cargo test --test decrypt_fields -- --nocapture
// 输入：tools/fp-reverse/des-fields-to-decrypt.json（含 key 与密文）
use sm_des::sm_des_decrypt_ecb_zero_pad;

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
fn decrypt_all_fields() {
    let path = std::env::var("FIELDS_JSON")
        .unwrap_or_else(|_| "G:/youdao/Deepseek/tools/fp-reverse/des-fields-to-decrypt.json".into());
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("读取 manifest"),
    )
    .expect("解析 manifest");
    let mut out = serde_json::Map::new();
    for (field, spec) in manifest.as_object().unwrap() {
        let key = spec["key"].as_str().unwrap();
        let cipher_b64 = spec["cipher_b64"].as_str().unwrap();
        let ct_bytes = b64d(cipher_b64);
        let ct_str: String = ct_bytes.iter().map(|b| *b as char).collect();
        let pt_bytes = sm_des_decrypt_ecb_zero_pad(key, &ct_str);
        let pt = String::from_utf8_lossy(&pt_bytes).to_string();
        out.insert(field.clone(), serde_json::Value::String(pt));
    }
    println!(
        "DECRYPTED_FIELDS={}",
        serde_json::to_string_pretty(&out).unwrap()
    );
}
