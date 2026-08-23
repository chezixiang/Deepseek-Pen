use sm_des::{sm_base64_encode, sm_des_encrypt_ecb_zero_pad};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn check(key: &str, plaintext: &str, expected_b64: &str, expected_hex: &str) {
    let out = sm_des_encrypt_ecb_zero_pad(key, plaintext);
    let b64 = sm_base64_encode(&out);
    let h = hex(&out);
    let ok = b64 == expected_b64 && h == expected_hex;
    println!(
        "{} DES({:?}, {:?}) = {} / {} (expected {} / {})",
        if ok { "PASS" } else { "FAIL" },
        key,
        plaintext,
        b64,
        h,
        expected_b64,
        expected_hex
    );
    if !ok {
        std::process::exit(1);
    }
}

fn main() {
    // Reference outputs from _harness_0x5b.js.
    check("sshummei", "hello", "f7fAI89lgcI=", "7fb7c023cf6581c2");
    check("ed4576ba", "hello", "UgnWaap2sqQ=", "5209d669aa76b2a4");
    check("ishumei.com", "hello", "LlJSUNclnOI=", "2e525250d7259ce2");
    check(
        "0123456789abcdef",
        "0123456789abcdef",
        "yGp9USVRfz53CcymFR5+3Q==",
        "c86a7d5125517f3e7709cca6151e7edd",
    );

    let empty = sm_des_encrypt_ecb_zero_pad("sshummei", "");
    assert!(empty.is_empty());
    println!("PASS DES(..., empty) = empty");
}
