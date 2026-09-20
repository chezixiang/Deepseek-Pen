//! 数美 deviceprofile/v4 注册请求伪造 —— 纯笔内 device_id 生成（无浏览器）。
//!
//! 基于 fp.min.js 逆向（完整协议见 docs/deepseek-verification-analysis.md §5d）：
//!
//! ```text
//! uid      = UUID v4
//! priId    = md5(uid)[..16]（已实证 = 主 AES key 的 ASCII 字节）
//! smid     = YYYYMMDDHHMMSS + md5(uid) + "00" + md5("smsk_web_"+base)[..14] + "0"
//! payload  = 78 键指纹 JSON（以服务端已接受的捕获模板为基底，替换身份/时间字段）
//! ip 字段  = DES("pceqy3rl", md5(canonical(payload)))   ← 规范化完整性哈希
//! data     = hex( AES-128-CBC( key = priId 的 ASCII 字节,
//!                              iv  = "0102030405060708", ZeroPadding,
//!                              明文 = base64(gzip(JSON)) ) )
//! ep       = base64( RSA-PKCS1v1.5( uid, 数美公钥 ) )
//! POST deviceprofile/v4 { appId, organization, ep, data }
//! 响应     = { code: 1100, detail: { deviceId } }        ← device_id 的来源
//! ```
//!
//! 17 个 DES 逐字段加密的密钥为硬编码 8 字符串（每字段一个），明文为对应采集
//! 项的短字符串（时区/UA/uid/时间戳/屏幕等），密码学由本地 sm_des crate 提供。

use serde_json::{json, Map, Value};
use chrono::Timelike as _;
use std::io::Write as _;
use rsa::pkcs8::DecodePublicKey;

const SM_ORGANIZATION: &str = "P9usCUBauxft8eAmUXaZ";
const SM_APP_ID: &str = "default";
const SM_API_URL: &str = "https://fp-it-acc.portal101.cn/deviceprofile/v4";
const SM_PUBLIC_KEY_B64: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDetfEgYD4aE1ZjmWJ6/jnPurhzI+yeRoJHWrnNtQMte3stQ4VjG3yu21FuN75E6cDpA9KtDXwcB2M/FiGUAe3G0rNotbWI8+SjZfUbW/OILFTzY0uaeEkmVGW5WyJ6weQbbr1xTCPa2OO3YIMeZljWUYHG5h21WAm/PATg8im8cQIDAQAB";
const SM_AES_IV: &[u8; 16] = b"0102030405060708";

/// 与后端 UA 同一身份（Linux aarch64 Chrome 136）
const PEN_UA: &str =
    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const PEN_PLATFORM: &str = "Linux aarch64";
const PEN_SCREEN: &str = "280_936_24_1";
const PEN_TZ_OFFSET: &str = "-480";
const PEN_TZ_NAME: &str = "Asia/Shanghai";
const PEN_PAGE_HREF: &str = "https://chat.deepseek.com/sign_in";

/// 服务端已接受的捕获 payload（Node 插桩运行 fp.min.js 泄漏的加密前明文）
const PAYLOAD_TEMPLATE: &str = include_str!("fp-payload-template.json");

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn md5_hex(s: &str) -> String {
    use md5::Digest;
    let mut h = md5::Md5::new();
    h.update(s.as_bytes());
    hex_lower(&h.finalize())
}

fn hex_lower(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// UUID v4（与 JS `xxxxxxxx-xxxx-4xxx-yxxx` 模板一致）
fn uuid_v4() -> String {
    let b: [u8; 16] = rand::random();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-4{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6],
        (b[8] & 0x3f) | 0x80, b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

/// getLocalsmid：本地 smidV2（逆向公式）
fn gen_smid_v2() -> String {
    let ts = chrono::Local::now().format("%Y%m%d%H%M%S").to_string();
    let uid = uuid_v4();
    let base = format!("{ts}{}00", md5_hex(&uid));
    let check = &md5_hex(&format!("smsk_web_{base}"))[..14];
    format!("{base}{check}0")
}

/// 字段 DES 加密 + base64（空明文 → 空串，与 SDK 行为一致）
fn field_des(key: &str, plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    let ct = sm_des::sm_des_encrypt_ecb_zero_pad(key, plaintext);
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(ct)
}

/// AES-128-CBC + ZeroPadding（CryptoJS 语义：已对齐时不追加）
fn aes_cbc_zero_encrypt(key: &[u8; 16], iv: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    use aes::cipher::generic_array::GenericArray;
    use aes::cipher::{BlockEncrypt, KeyInit};
    let cipher = aes::Aes128::new(GenericArray::from_slice(key));
    let pad = (16 - (plaintext.len() % 16)) % 16;
    let mut buf = plaintext.to_vec();
    buf.extend(std::iter::repeat(0u8).take(pad));
    let mut out = Vec::with_capacity(buf.len());
    let mut prev: [u8; 16] = *iv;
    for chunk in buf.chunks(16) {
        let mut block = [0u8; 16];
        for i in 0..16 {
            block[i] = chunk[i] ^ prev[i];
        }
        let mut gb = GenericArray::from_mut_slice(&mut block);
        cipher.encrypt_block(&mut gb);
        let ct = *gb;
        prev.copy_from_slice(&ct);
        out.extend_from_slice(&ct);
    }
    out
}

/// JS 值字符串化（`'' + value` 语义）：对象 → "[object Object]"（不递归！）
fn js_value_str(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => (if *b { "true" } else { "false" }).to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(js_value_str)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// canonical：顶层按键排序，数字 → String(10000*n)，其余 → js_value_str，拼接
fn canonical_concat(v: &Value) -> String {
    let Some(map) = v.as_object() else {
        return js_value_str(v);
    };
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    let mut out = String::new();
    for k in keys {
        let val = &map[k];
        if let Some(n) = val.as_i64() {
            out.push_str(&(n.saturating_mul(10000)).to_string());
        } else if let Some(f) = val.as_f64() {
            out.push_str(&js_num_str(f * 10000.0));
        } else {
            out.push_str(&js_value_str(val));
        }
    }
    out
}

/// JS Number → string（与 Rust f64 的差异主要在指数格式；本 payload 数值范围
/// 内直接用 Display，整型走 i64 路径）
fn js_num_str(f: f64) -> String {
    if f.is_finite() && f == f.trunc() && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        let s = format!("{f}");
        s
    }
}

fn des_field(map: &mut Map<String, Value>, name: &str, key: &str, plaintext: &str) {
    map.insert(name.to_string(), json!(field_des(key, plaintext)));
}

/// 组装 payload：81 键全部显式构造（字段值 = 真实浏览器语义 + 笔身份）
fn build_payload_fields(uid: &str, smid: &str, ua: &str) -> Value {
    let now = now_ms();
    let now_str = now.to_string();
    let webgl = "ANGLE (Arm, Mali (Bifrost) OpenGL ES 3.2, OpenGL ES)";
    let vendor = "Google Inc.";
    let im_seq = (now % 100000000).to_string();
    let canvas_md = md5_hex(&format!("{ua}|{PEN_SCREEN}|fp-canvas-v1"));

    json!({
        "protocol": 277,
        "jp": field_des("ihad4k30", SM_ORGANIZATION),
        "hw": field_des("0h69zghq", SM_APP_ID),
        "sd": field_des("yx4yu3qn", "web"),
        "version": "3.0.0",
        "ie": field_des("rdeppcyf", "3.0.0"),
        "ec": "",
        "dj": field_des("imn3shep", "all"),
        "smid": smid,
        "gh": field_des("q716sh5k", "1.0.0"),
        "cl": field_des("8jdmuvor", "85"),
        "pt": field_des("kl0ncs3o", ua),
        "hm": field_des("p0y5f48n", &format!("{:02x}{:02x}", canvas_md.as_bytes()[12], canvas_md.as_bytes()[13])),
        "bc": field_des("ysu63re6", PEN_TZ_OFFSET),
        "qv": field_des("6kan1olr", PEN_PLATFORM),
        "eh": field_des("hv7rlz90", format!("0_0_{PEN_SCREEN}").as_str()),
        "fb": field_des("mw4igkbm", PEN_SCREEN),
        "yn": field_des("h56kqjkd", "0"),
        "wv": field_des("qh3p6632", uid),
        "ph": field_des("wqmcn0cc", &now_str),
        "kp": field_des("h5kzos0e", uid),
        "cc": field_des("q98wfmgx", &now_str),
        "cdp": 0,
        "cpucount": 4,
        "battery": { "charging": 1, "level": 1 },
        "be": 0,
        "cb": 4,
        "connectionRtt": 100,
        "maxTouchPoints": 0,
        "va": ["application/pdf", "text/pdf"],
        "im": format!("{im_seq}_2154_indexedDB:2154"),
        "do": PEN_TZ_NAME,
        "qe": 1,
        "ma": 1,
        "pq": 1,
        "jd": 0,
        "qs": 280,
        "rk": 280,
        "hi": 936,
        "wx": 936,
        "ky": ["chrome"],
        "documentExist": 1,
        "lx": ["location"],
        "dr": "UTF-8",
        "rw": chrono_rw_string(),
        "zg": 1,
        "ke": 0,
        "zs": 0,
        "oc": 0,
        "ot": 0,
        "dt": 0,
        "sg": "srgb",
        "hl": 0,
        "ud": 0,
        "mb": 0,
        "fa": 0,
        "gb": 0,
        "vy": 0,
        "zt": 0,
        "pk": format!("{vendor} -&- {webgl}"),
        "ew": webgl,
        "gv": "48000_2_1_0_2_explicit_speakers|______",
        "zd": format!("{canvas_md}|10011011111000111100001100101101111100110101001110000000000100000"),
        "wy": 1,
        "rt": 0,
        "we": { "red": "0" },
        "ag": {
            "default": 151.703125, "apple": 151.703125, "serif": 136,
            "sans": 151.703125, "mono": 136, "min": 9.484375
        },
        "iv": { "maxTouchPoints": 0, "touchEvent": false, "touchStart": false },
        "incognito": {
            "getDirectoryExist": 1, "getDirectoryIncognito": 0,
            "maxTouchPointsExist": 1, "indexedDBIncognito": 0,
            "openDatabaseExist": 0, "openDatabaseIncognito": 1,
            "localStorageExist": 1, "localStorageIncognito": 0,
            "promiseExist": 1, "promiseAllSettledExist": 1,
            "queryUsageAndQuotaIncognito": 0,
            "webkitRequestFileSystemIncognito": 0,
            "serviceWorkerExist": 0, "indexedDBExist": 0,
            "browserName": "chrome"
        },
        "gs": "",
        "ko": field_des("r2lg58bz", PEN_PAGE_HREF),
        "td": "",
        "dv": 8,
        "pu": "zh-CN",
        "oo": vendor,
        "sm": "Netscape",
        "sr": "Mozilla",
        "ul": ua.trim_start_matches("Mozilla/"),
        "t": now,
        "collectTime": 85
    })
}

/// JS Date().toString() 风格的本地时间串
fn chrono_rw_string() -> String {
    use chrono::Datelike;
    let now = chrono::Local::now();
    const WD: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let wd = WD[now.weekday().num_days_from_sunday() as usize];
    let mo = MO[now.month0() as usize];
    let offset = now.offset().local_minus_utc();
    let sign = if offset >= 0 { "+" } else { "-" };
    let a = offset.abs();
    format!(
        "{} {} {:02} {} {:02}:{:02}:{:02} GMT{}{:02}{:02} (中国标准时间)",
        wd,
        mo,
        now.day(),
        now.year(),
        now.hour(),
        now.minute(),
        now.second(),
        sign,
        a / 3600,
        (a % 3600) / 60
    )
}

/// 执行一次注册，返回 `(device_id, smid)`。
///
/// device_id 为服务端签发的 base64 体（调用方负责加 'B' 前缀，
/// 见 device_bootstrap::is_issued）；smid 为注册流程中本地生成的 smidV2，
/// 与 device_id 构成同一设备身份的两半（真实浏览器两者同源）。
pub async fn mint_device_id(user_agent: &str) -> Result<(String, String), String> {
    let uid = uuid_v4();
    let smid = gen_smid_v2();

    let mut fields: Map<String, Value> = build_payload_fields(&uid, &smid, user_agent)
        .as_object()
        .cloned()
        .unwrap_or_default();

    // ip 字段：canonical 哈希（不含 ip 自身）→ DES
    let canonical = canonical_concat(&Value::Object(fields.clone()));
    let ip_md5 = md5_hex(&canonical);
    fields.insert("ip".to_string(), json!(field_des("pceqy3rl", &ip_md5)));

    // gzip → base64 → AES-CBC(key = md5(uid)[..16] ASCII) → hex
    let json_str = serde_json::to_string(&fields).map_err(|e| format!("序列化: {e}"))?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(json_str.as_bytes()).map_err(|e| format!("gzip: {e}"))?;
    let gz_bytes = gz.finish().map_err(|e| format!("gzip finish: {e}"))?;
    use base64::Engine;
    let gz_b64 = base64::engine::general_purpose::STANDARD.encode(&gz_bytes);

    let uid_md5 = md5_hex(&uid);
    let key: [u8; 16] = uid_md5.as_bytes()[..16]
        .try_into()
        .map_err(|_| "key 长度异常".to_string())?;
    let ct = aes_cbc_zero_encrypt(&key, SM_AES_IV, gz_b64.as_bytes());
    let data_hex = hex_lower(&ct);

    // ep = RSA-PKCS1v1.5(uid, 数美公钥) —— 服务器解出 uid 后同样派生 AES key
    let der = base64::engine::general_purpose::STANDARD
        .decode(SM_PUBLIC_KEY_B64)
        .map_err(|e| format!("公钥解码: {e}"))?;
    let pubkey = rsa::RsaPublicKey::from_public_key_der(&der).map_err(|e| format!("公钥解析: {e}"))?;
    let ep_b64 = {
        let ct = pubkey
            .encrypt(&mut rand_core::OsRng, rsa::Pkcs1v15Encrypt, uid.as_bytes())
            .map_err(|e| format!("RSA: {e}"))?;
        base64::engine::general_purpose::STANDARD.encode(ct)
    };

    let body = json!({
        "appId": SM_APP_ID,
        "organization": SM_ORGANIZATION,
        "ep": ep_b64,
        "data": data_hex,
        // 元数据字段（真实浏览器请求体实证，缺任一项服务器返回 1902）：
        // os=web、encode=5（gzip+base64+AES 编码链）、compress=2（gzip）
        "os": "web",
        "encode": 5,
        "compress": 2,
    });

    // 调试落盘（DS_MINT_DUMP=<path> 时写出明文 payload 与请求体，供离线比对）
    if let Ok(dump) = std::env::var("DS_MINT_DUMP") {
        let _ = std::fs::write(format!("{dump}.payload.json"), &json_str);
        let _ = std::fs::write(
            format!("{dump}.body.json"),
            serde_json::to_string_pretty(&body).unwrap_or_default(),
        );
        log::info!(target: "device_mint", "已落盘调试数据: {dump}.payload.json / .body.json");
    }

    let client = wreq::Client::builder()
        .user_agent(user_agent.to_string())
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let resp = client
        .post(SM_API_URL)
        .header("Origin", "https://chat.deepseek.com")
        .header("Referer", "https://chat.deepseek.com/")
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("注册请求失败: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应: {e}"))?;
    if !status.is_success() {
        return Err(format!("注册 HTTP {}", status.as_u16()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应解析: {e} | {text}"))?;
    // 成功响应：{ code: 1100, detail: { deviceId } }
    if v.get("code").and_then(|c| c.as_i64()) == Some(1100) {
        if let Some(id) = v
            .pointer("/detail/deviceId")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
        {
            return Ok((format!("B{id}"), smid));
        }
    }
    Err(format!("注册未通过: {}", &text[..text.len().min(200)]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smid_matches_captured_format() {
        let smid = gen_smid_v2();
        assert_eq!(smid.len(), 63);
        assert!(smid.starts_with(&chrono::Local::now().format("%Y%m%d%H%M%S").to_string()[..12]));
        // 结构：base(48) + check(14) + '0'(1)
        assert!(smid.ends_with('0'));
    }

    #[test]
    fn canonical_matches_js_semantics() {
        // JS 语义实证（canonical-concat 捕获）：嵌套对象不递归 → "[object Object]"，
        // 顶层数字 → ×10000，数组 → 逗号连接的 toString
        let v: Value = serde_json::from_str(r#"{"b":2,"a":{"c":1},"d":[1,"x"]}"#).unwrap();
        let s = canonical_concat(&v);
        // 排序: a(嵌套对象→[object Object]) b(20000) d(数组 toString: "1,x")
        assert_eq!(s, "[object Object]200001,x");
    }

    #[test]
    fn aes_roundtrip_shape() {
        let key = [7u8; 16];
        let iv = [3u8; 16];
        let pt = b"1234567890123456"; // 已对齐 → 无填充
        let ct = aes_cbc_zero_encrypt(&key, &iv, pt);
        assert_eq!(ct.len(), 16);
        let pt2 = b"abc"; // 3 字节 → ZeroPadding 对齐到 16
        let ct2 = aes_cbc_zero_encrypt(&key, &iv, pt2);
        assert_eq!(ct2.len(), 16);
    }
}
