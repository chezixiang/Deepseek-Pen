//! Pure-Rust port of the custom Shumei "DES"-like cipher and base64 encoder
//! from `_module_0x5b.js`.
//!
//! The JS `DES(key, plaintext, 1, 0)` function is not standard DES:
//! * the key schedule consumes the entire key string (8-byte keys produce 32
//!   subkeys and one Feistel pass; longer keys produce 96 subkeys and three
//!   Feistel passes);
//! * the round function uses eight 6-bit -> 32-bit SP tables;
//! * mode `0` appends eight NUL bytes but only processes
//!   `ceil(plaintext.len()/8)` blocks, i.e. zero padding to a block boundary.

/// Key-schedule constants.  Order matches the JS local arrays:
/// d97, 849, 732, 5ec, 2f1, 2fc, 4ff, 1f5, 0dd, 5f7, 8a4, 4ba, 37f, 17c, 2d0.
const KS_TABLES: [[u32; 16]; 15] = [
    [0,268435456,8,268435464,0,268435456,8,268435464,1024,268436480,1032,268436488,1024,268436480,1032,268436488],
    [0,16777216,512,16777728,2097152,18874368,2097664,18874880,67108864,83886080,67109376,83886592,69206016,85983232,69206528,85983744],
    [0,4096,134217728,134221824,524288,528384,134742016,134746112,16,4112,134217744,134221840,524304,528400,134742032,134746128],
    [0,65536,2048,67584,536870912,536936448,536872960,536938496,131072,196608,133120,198656,537001984,537067520,537004032,537069568],
    [0,0,1,1,1,1,1,1,0,1,1,1,1,1,1,0],
    [0,262144,0,262144,2,262146,2,262146,33554432,33816576,33554432,33816576,33554434,33816578,33554434,33816578],
    [0,4,256,260,0,4,256,260,1,5,257,261,1,5,257,261],
    [0,268435456,524288,268959744,2,268435458,524290,268959746,0,268435456,524288,268959744,2,268435458,524290,268959746],
    [0,262144,16,262160,0,262144,16,262160,4096,266240,4112,266256,4096,266240,4112,266256],
    [0,1024,32,1056,0,1024,32,1056,33554432,33555456,33554464,33555488,33554432,33555456,33554464,33555488],
    [0,4,536870912,536870916,65536,65540,536936448,536936452,512,516,536871424,536871428,66048,66052,536936960,536936964],
    [0,32,0,32,1048576,1048608,1048576,1048608,8192,8224,8192,8224,1056768,1056800,1056768,1056800],
    [0,1,1048576,1048577,67108864,67108865,68157440,68157441,256,257,1048832,1048833,67109120,67109121,68157696,68157697],
    [0,2097152,134217728,136314880,8192,2105344,134225920,136323072,131072,2228224,134348800,136445952,139264,2236416,134356992,136454144],
    [0,8,2048,2056,16777216,16777224,16779264,16779272,0,8,2048,2056,16777216,16777224,16779264,16779272],
];

/// DES round SP tables.  Order: 83a, 1a3, 2c8, 56e, 1dc, 94f, 1f8, 71a.
const SP_TABLES: [[u32; 64]; 8] = [
    [16843776,0,65536,16843780,16842756,66564,4,65536,1024,16843776,16843780,1024,16778244,16842756,16777216,4,1028,16778240,16778240,66560,66560,16842752,16842752,16778244,65540,16777220,16777220,65540,0,1028,66564,16777216,65536,16843780,4,16842752,16843776,16777216,16777216,1024,16842756,65536,66560,16777220,1024,4,16778244,66564,16843780,65540,16842752,16778244,16777220,1028,66564,16843776,1028,16778240,16778240,0,65540,66560,0,16842756],
    [2148565024,2147516416,32768,1081376,1048576,32,2148532256,2147516448,2147483680,2148565024,2148564992,2147483648,2147516416,1048576,32,2148532256,1081344,1048608,2147516448,0,2147483648,32768,1081376,2148532224,1048608,2147483680,0,1081344,32800,2148564992,2148532224,32800,0,1081376,2148532256,1048576,2147516448,2148532224,2148564992,32768,2148532224,2147516416,32,2148565024,1081376,32,32768,2147483648,32800,2148564992,1048576,2147483680,1048608,2147516448,2147483680,1048608,1081344,0,2147516416,32800,2147483648,2148532256,2148565024,1081344],
    [520,134349312,0,134348808,134218240,0,131592,134218240,131080,134217736,134217736,131072,134349320,131080,134348800,520,134217728,8,134349312,512,131584,134348800,134348808,131592,134218248,131584,131072,134218248,8,134349320,512,134217728,134349312,134217728,131080,520,131072,134349312,134218240,0,512,131080,134349320,134218240,134217736,512,0,134348808,134218248,131072,134217728,134349320,8,131592,131584,134217736,134348800,134218248,520,134348800,131592,8,134348808,131584],
    [8396801,8321,8321,128,8396928,8388737,8388609,8193,0,8396800,8396800,8396929,129,0,8388736,8388609,1,8192,8388608,8396801,128,8388608,8193,8320,8388737,1,8320,8388736,8192,8396928,8396929,129,8388736,8388609,8396800,8396929,129,0,0,8396800,8320,8388736,8388737,1,8396801,8321,8321,128,8396929,129,1,8192,8388609,8193,8396928,8388737,8193,8320,8388608,8396801,128,8388608,8192,8396928],
    [256,34078976,34078720,1107296512,524288,256,1073741824,34078720,1074266368,524288,33554688,1074266368,1107296512,1107820544,524544,1073741824,33554432,1074266112,1074266112,0,1073742080,1107820800,1107820800,33554688,1107820544,1073742080,0,1107296256,34078976,33554432,1107296256,524544,524288,1107296512,256,33554432,1073741824,34078720,1107296512,1074266368,33554688,1073741824,1107820544,34078976,1074266368,256,33554432,1107820544,1107820800,524544,1107296256,1107820800,34078720,0,1074266112,1107296256,524544,33554688,1073742080,524288,0,1074266112,34078976,1073742080],
    [536870928,541065216,16384,541081616,541065216,16,541081616,4194304,536887296,4210704,4194304,536870928,4194320,536887296,536870912,16400,0,4194320,536887312,16384,4210688,536887312,16,541065232,541065232,0,4210704,541081600,16400,4210688,541081600,536870912,536887296,16,541065232,4210688,541081616,4194304,16400,536870928,4194304,536887296,536870912,16400,536870928,541081616,4210688,541065216,4210704,541081600,0,541065232,16,16384,541065216,4210704,16384,4194320,536887312,0,541081600,536870912,4194320,536887312],
    [2097152,69206018,67110914,0,2048,67110914,2099202,69208064,69208066,2097152,0,67108866,2,67108864,69206018,2050,67110912,2099202,2097154,67110912,67108866,69206016,69208064,2097154,69206016,2048,2050,69208066,2099200,2,67108864,2099200,67108864,2099200,2097152,67110914,67110914,69206018,69206018,2,2097154,67108864,67110912,2097152,69208064,2050,2099202,69208064,2050,67108866,69208066,69206016,2099200,0,2,69208066,0,2099202,69206016,2048,67108866,67110912,2048,2097154],
    [268439616,4096,262144,268701760,268435456,268439616,64,268435456,262208,268697600,268701760,266240,268701696,266304,4096,64,268697600,268435520,268439552,4160,266240,262208,268697664,268701696,4160,0,0,268697664,268435520,268439552,266304,262144,266304,262144,268701696,4096,64,268697664,4096,266304,268439552,64,268435520,268697600,268697664,268435456,262144,268439616,0,268701760,262208,268435520,268697600,268439552,268439616,0,268701760,266240,266240,4160,4160,262208,268435456,268701696],
];

/// DES key-shift schedule (same as JS `_0x52f1a6`).
const KEY_SHIFTS: [u32; 16] = [0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0];

#[inline]
fn load_be(bytes: &[u8], offset: usize) -> u32 {
    let mut v = 0u32;
    for k in 0..4 {
        let b = bytes.get(offset + k).copied().unwrap_or(0) as u32;
        v |= b << (24 - 8 * k);
    }
    v
}

/// The JS `_0x452f92` key schedule.  Returns 32 subkeys for keys <= 8 bytes
/// and 96 subkeys for longer keys.
pub fn sm_des_key_schedule(key: &str) -> Vec<u32> {
    sm_des_key_schedule_bytes(key.as_bytes())
}

/// Byte-string variant of [`sm_des_key_schedule`].
pub fn sm_des_key_schedule_bytes(key: &[u8]) -> Vec<u32> {
    let bytes = key;
    let groups = if bytes.len() > 8 { 3 } else { 1 };
    let mut out = Vec::with_capacity(32 * groups);

    for g in 0..groups {
        let off = g * 8;
        // JS loads `_0x46ec51` (right half) first from the first four chars,
        // then `_0x6fd0f1` (left half) from the next four chars.
        let mut r = load_be(bytes, off);
        let mut l = load_be(bytes, off + 4);

        // Mixing / initial permutation from the JS key schedule.
        let mut t = ((r >> 4) ^ l) & 0x0f0f_0f0f;
        l ^= t;
        r ^= t << 4;

        t = ((l >> 16) ^ r) & 0x0000_ffff;
        r ^= t;
        l ^= t << 16;

        t = ((r >> 2) ^ l) & 0x3333_3333;
        l ^= t;
        r ^= t << 2;

        t = ((l >> 16) ^ r) & 0x0000_ffff;
        r ^= t;
        l ^= t << 16;

        t = ((r >> 1) ^ l) & 0x5555_5555;
        l ^= t;
        r ^= t << 1;

        t = ((l >> 8) ^ r) & 0x00ff_00ff;
        r ^= t;
        l ^= t << 8;

        t = ((r >> 1) ^ l) & 0x5555_5555;
        l ^= t;
        r ^= t << 1;

        t = (r << 8) | ((l >> 20) & 0xf0);
        let old_l = l;
        r = (old_l << 24)
            | ((old_l << 8) & 0x00ff_0000)
            | ((old_l >> 8) & 0x0000_ff00)
            | ((old_l >> 24) & 0xf0);
        l = t;

        for i in 0..16 {
            // The JS key schedule uses custom left "rotations":
            // shift-2 is `<< 2 | >>> 26`, shift-1 is `<< 1 | >>> 27`.
            if KEY_SHIFTS[i] == 1 {
                r = (r << 2) | (r >> 26);
                l = (l << 2) | (l >> 26);
            } else {
                r = (r << 1) | (r >> 27);
                l = (l << 1) | (l >> 27);
            }
            // JS uses `& -15` which is 0xfffffff1 (keeps bit 0 and bits 4+).
            r &= 0xffff_fff1;
            l &= 0xffff_fff1;

            // Right-half lookup.
            let r_out = KS_TABLES[10][(r >> 28) as usize]          // 8a4
                | KS_TABLES[12][((r >> 24) & 15) as usize]         // 37f
                | KS_TABLES[14][((r >> 20) & 15) as usize]         // 2d0
                | KS_TABLES[13][((r >> 16) & 15) as usize]         // 17c
                | KS_TABLES[8][((r >> 12) & 15) as usize]          // 0dd
                | KS_TABLES[9][((r >> 8) & 15) as usize]           // 5f7
                | KS_TABLES[7][((r >> 4) & 15) as usize];          // 1f5

            // Left-half lookup.
            let l_out = KS_TABLES[3][(l >> 28) as usize]           // 5ec
                | KS_TABLES[5][((l >> 24) & 15) as usize]          // 2fc
                | KS_TABLES[0][((l >> 20) & 15) as usize]          // d97
                | KS_TABLES[11][((l >> 16) & 15) as usize]         // 4ba
                | KS_TABLES[1][((l >> 12) & 15) as usize]          // 849
                | KS_TABLES[2][((l >> 8) & 15) as usize]           // 732
                | KS_TABLES[6][((l >> 4) & 15) as usize];          // 4ff

            let t2 = ((l_out >> 16) ^ r_out) & 0xffff;
            // JS executes `case 4` (right-half subkey) before `case 3`
            // (left-half subkey), so the right value is emitted first.
            out.push(r_out ^ t2);
            out.push(l_out ^ (t2 << 16));
        }
    }

    out
}

#[inline]
fn des_f(a: u32, b: u32) -> u32 {
    // `a` is `_0x2d0c9a` (right ^ K[i]); `b` is `_0x510866`
    // (rotated right ^ K[i+1]).
    SP_TABLES[1][((a >> 24) & 63) as usize]
        | SP_TABLES[3][((a >> 16) & 63) as usize]
        | SP_TABLES[5][((a >> 8) & 63) as usize]
        | SP_TABLES[7][(a & 63) as usize]
        | SP_TABLES[0][((b >> 24) & 63) as usize]
        | SP_TABLES[2][((b >> 16) & 63) as usize]
        | SP_TABLES[4][((b >> 8) & 63) as usize]
        | SP_TABLES[6][(b & 63) as usize]
}

fn des_encrypt_block(ks: &[u32], pattern: &[i32], block: &[u8; 8]) -> [u8; 8] {
    let mut l = u32::from_be_bytes([block[0], block[1], block[2], block[3]]);
    let mut r = u32::from_be_bytes([block[4], block[5], block[6], block[7]]);

    // Initial permutation.
    let mut t = ((l >> 4) ^ r) & 0x0f0f_0f0f;
    r ^= t;
    l ^= t << 4;

    t = ((l >> 16) ^ r) & 0x0000_ffff;
    r ^= t;
    l ^= t << 16;

    t = ((r >> 2) ^ l) & 0x3333_3333;
    l ^= t;
    r ^= t << 2;

    t = ((r >> 8) ^ l) & 0x00ff_00ff;
    l ^= t;
    r ^= t << 8;

    t = ((l >> 1) ^ r) & 0x5555_5555;
    r ^= t;
    l ^= t << 1;

    l = l.rotate_left(1);
    r = r.rotate_left(1);

    for triple in pattern.chunks_exact(3) {
        let start = triple[0];
        let end = triple[1];
        let step = triple[2];
        let mut idx = start;
        while idx != end {
            let a = r ^ ks[idx as usize];
            let b = r.rotate_right(4) ^ ks[idx as usize + 1];
            let f = des_f(a, b);
            let old_l = l;
            l = r;
            r = old_l ^ f;
            idx += step;
        }
        // JS performs one extra swap after the inner 16-subkey loop.
        std::mem::swap(&mut l, &mut r);
    }

    // Inverse permutation.
    l = l.rotate_right(1);
    r = r.rotate_right(1);

    t = ((l >> 1) ^ r) & 0x5555_5555;
    r ^= t;
    l ^= t << 1;

    t = ((r >> 8) ^ l) & 0x00ff_00ff;
    l ^= t;
    r ^= t << 8;

    t = ((r >> 2) ^ l) & 0x3333_3333;
    l ^= t;
    r ^= t << 2;

    t = ((l >> 16) ^ r) & 0x0000_ffff;
    r ^= t;
    l ^= t << 16;

    t = ((l >> 4) ^ r) & 0x0f0f_0f0f;
    r ^= t;
    l ^= t << 4;

    let mut out = [0u8; 8];
    out[..4].copy_from_slice(&l.to_be_bytes());
    out[4..].copy_from_slice(&r.to_be_bytes());
    out
}

/// Matches `DES(key, plaintext, 1, 0)` from the JS module.
pub fn sm_des_encrypt_ecb_zero_pad(key: &str, plaintext: &str) -> Vec<u8> {
    sm_des_encrypt_ecb_zero_pad_bytes(key.as_bytes(), plaintext.as_bytes())
}

/// Byte-string variant of [`sm_des_encrypt_ecb_zero_pad`].
pub fn sm_des_encrypt_ecb_zero_pad_bytes(key: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let pattern: &[i32] = if key.len() > 8 {
        &[0, 32, 2, 62, 30, -2, 64, 96, 2]
    } else {
        &[0, 32, 2]
    };
    sm_des_crypt_ecb_zero_pad_bytes(key, plaintext, pattern)
}

/// Matches `DES(key, ciphertext, 0, 0)` from the JS module (decryption).
pub fn sm_des_decrypt_ecb_zero_pad(key: &str, ciphertext: &str) -> Vec<u8> {
    sm_des_decrypt_ecb_zero_pad_bytes(key.as_bytes(), ciphertext.as_bytes())
}

/// Byte-string variant of [`sm_des_decrypt_ecb_zero_pad`].
pub fn sm_des_decrypt_ecb_zero_pad_bytes(key: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let pattern: &[i32] = if key.len() > 8 {
        &[94, 62, -2, 32, 64, 2, 30, -2, -2]
    } else {
        &[30, -2, -2]
    };
    sm_des_crypt_ecb_zero_pad_bytes(key, ciphertext, pattern)
}

fn sm_des_crypt_ecb_zero_pad_bytes(key: &[u8], text: &[u8], pattern: &[i32]) -> Vec<u8> {
    if text.is_empty() {
        return Vec::new();
    }

    let ks = sm_des_key_schedule_bytes(key);
    let original = text;
    let mut padded = original.to_vec();
    padded.extend_from_slice(&[0u8; 8]);

    let mut out = Vec::with_capacity(original.len().div_ceil(8) * 8);
    let mut pos = 0usize;
    while pos < original.len() {
        let mut block = [0u8; 8];
        block.copy_from_slice(&padded[pos..pos + 8]);
        out.extend_from_slice(&des_encrypt_block(&ks, pattern, &block));
        pos += 8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypt_matches_js_reference() {
        // JS: DES("sshummei", "hello", 1, 0) => 7fb7c023cf6581c2
        let cipher = sm_des_encrypt_ecb_zero_pad("sshummei", "hello");
        assert_eq!(sm_base64_encode(&cipher), "f7fAI89lgcI=");

        // JS: DES("sshummei", ciphertext, 0, 0) returns the zero-padded block.
        let plain = sm_des_decrypt_ecb_zero_pad_bytes(b"sshummei", &cipher);
        assert_eq!(&plain, b"hello\0\0\0");

        // Longer-key three-pass round trip.
        let cipher2 = sm_des_encrypt_ecb_zero_pad("ishumei.com", "hello");
        let plain2 = sm_des_decrypt_ecb_zero_pad_bytes(b"ishumei.com", &cipher2);
        assert_eq!(&plain2, b"hello\0\0\0");
    }

    /// 与 main.rs 自检同一组的 known-answer 向量（对照官方 SDK JS 逐字节核实），
    /// `cargo test` 可跑而 `cargo run` 不会 —— 防止 main.rs 被改动后自检丢失。
    #[test]
    fn known_answer_vectors_from_sdk() {
        let cases: &[(&str, &str, &str)] = &[
            ("sshummei", "hello", "f7fAI89lgcI="),
            ("ed4576ba", "hello", "UgnWaap2sqQ="),
            ("ishumei.com", "hello", "LlJSUNclnOI="),
            (
                "0123456789abcdef",
                "0123456789abcdef",
                "yGp9USVRfz53CcymFR5+3Q==",
            ),
        ];
        for (key, pt, expected) in cases {
            let ct = sm_des_encrypt_ecb_zero_pad(key, pt);
            assert_eq!(&sm_base64_encode(&ct), expected, "key={key} pt={pt}");
            // 解密应还原明文（剥掉补位 \0）
            let back = sm_des_decrypt_ecb_zero_pad_bytes(key.as_bytes(), &ct);
            let s = String::from_utf8(back).unwrap();
            assert_eq!(s.trim_end_matches('\0'), *pt);
        }
    }

    #[test]
    fn base64_round_trip() {
        let data = b"hello\0\0\0";
        let s = sm_base64_encode(data);
        assert_eq!(sm_base64_decode(&s), data);
    }

    /// 回归：密文含 >=0x80 字节时必须走 *_bytes 变体。
    /// &str 变体经 as_bytes() 消费的是「字节被 UTF-8 重编码后的串」，
    /// 高字节密文喂给它必然得到乱码（tests/verify_bc.rs 的历史 bug）。
    #[test]
    fn high_byte_ciphertext_roundtrip_via_bytes_variant() {
        let key = "pceqy3rl";
        let pt = "d41d8cd98f00b204e9800998ecf8427e"; // 32 位 md5 hex
        let ct = sm_des_encrypt_ecb_zero_pad(key, pt);
        assert!(ct.iter().any(|&b| b >= 0x80), "前置条件：密文应含高字节");
        let back = sm_des_decrypt_ecb_zero_pad_bytes(key.as_bytes(), &ct);
        assert_eq!(String::from_utf8_lossy(&back).trim_end_matches('\0'), pt);
    }
}

/// Matches the module's `base64Decode` (standard base64 over byte values).
pub fn sm_base64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &b in s.as_bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        } as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

/// Matches the module's `base64Encode` (standard base64 over byte values).
pub fn sm_base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0usize;
    while i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = *bytes.get(i + 1).unwrap_or(&0) as u32;
        let b2 = *bytes.get(i + 2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if i + 1 < bytes.len() {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if i + 2 < bytes.len() {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}
