// DES 往返自测：encrypt → b64 → decode → decrypt → 明文
use sm_des::{sm_des_decrypt_ecb_zero_pad, sm_des_encrypt_ecb_zero_pad};

fn b64e(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

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
fn des_roundtrip() {
    let key = "ysu63re6";
    let pt = "-480";
    let ct_bytes = sm_des_encrypt_ecb_zero_pad(key, pt);
    let ct_b64 = b64e(&ct_bytes);
    println!("ct_bytes = {:02x?}", ct_bytes);
    println!("ct_b64   = {ct_b64}  (期望 uMfKlkexGvw=)");
    let decoded = b64d(&ct_b64);
    println!("decoded  = {:02x?}", decoded);
    let ct_str: String = decoded.iter().map(|b| *b as char).collect();
    let back = sm_des_decrypt_ecb_zero_pad(key, &ct_str);
    println!("back     = {:02x?}", back);
    println!("back_str = {}", String::from_utf8_lossy(&back));
    assert_eq!(String::from_utf8_lossy(&back), pt);
}
