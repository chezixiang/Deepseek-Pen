// 解密真实浏览器 payload 的全部 DES 字段 → 输出明文格式
// 运行：FIELDS_JSON=<manifest> cargo test --test decrypt_fields -- --nocapture --ignored
// 输入：tools/fp-reverse/des-fields-to-decrypt.json（含 key 与密文）
//
// 调试脚本（依赖外部 manifest 输入），非回归测试：默认 #[ignore]，
// 完整 `cargo test` 不会执行它。
//
// 历史注记：旧版本地手写的 b64d 会多吐 0x00 字节，且 `b as char` +
// collect 成 String 会把 >=0x80 的密文字节按 UTF-8 重新编码后再解密，
// 所有含高字节的字段解出来都是乱码。现改用库内 *_bytes 变体。
use sm_des::{sm_base64_decode, sm_des_decrypt_ecb_zero_pad_bytes};

#[test]
#[ignore = "调试脚本：需要 FIELDS_JSON manifest，非回归测试"]
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
        let ct_bytes = sm_base64_decode(cipher_b64);
        let pt_bytes = sm_des_decrypt_ecb_zero_pad_bytes(key.as_bytes(), &ct_bytes);
        let pt = String::from_utf8_lossy(&pt_bytes)
            .trim_end_matches('\0')
            .to_string();
        out.insert(field.clone(), serde_json::Value::String(pt));
    }
    println!(
        "DECRYPTED_FIELDS={}",
        serde_json::to_string_pretty(&out).unwrap()
    );
}
