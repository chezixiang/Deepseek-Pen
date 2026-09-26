// DES 往返自测：encrypt → b64 → decode → decrypt → 明文
//
// 历史注记：本测试曾长期失败，根因不在 sm_des 实现（与官方 SDK JS 逐字节
// 一致，见 src/sm_des.rs 的 known-answer 测试），而在本测试脚本自己：
//   1. 手写的 b64d 在末尾 2/3 值分组会多吐一个 0x00 字节（条件写反：
//      4 值组才出 3 字节、3 值组出 2 字节、2 值组出 1 字节）；
//   2. `b as char` 再 collect 成 String 会把 >=0x80 的字节按 UTF-8 重新编码，
//      交给 &str 版解密函数时密文早已被改写；
//   3. 断言没有剥掉加密时补的 \0 padding（JS 参考实现同样返回带 padding 的块）。
// 修正：统一用库内的 sm_base64_decode / *_bytes 变体，断言前 trim \0。
use sm_des::{
    sm_base64_decode, sm_base64_encode, sm_des_decrypt_ecb_zero_pad_bytes,
    sm_des_encrypt_ecb_zero_pad,
};

#[test]
fn des_roundtrip() {
    let key = "ysu63re6";
    let pt = "-480";
    let ct_bytes = sm_des_encrypt_ecb_zero_pad(key, pt);
    let ct_b64 = sm_base64_encode(&ct_bytes);
    assert_eq!(ct_b64, "uMfKlkexGvw=", "密文应与官方 SDK JS 输出一致");
    let decoded = sm_base64_decode(&ct_b64);
    assert_eq!(decoded, ct_bytes, "base64 解码应无损还原密文字节");
    let back = sm_des_decrypt_ecb_zero_pad_bytes(key.as_bytes(), &decoded);
    let back_str = String::from_utf8(back).unwrap();
    assert_eq!(back_str.trim_end_matches('\0'), pt);
}
