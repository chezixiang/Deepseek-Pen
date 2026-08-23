//! High-level Shumei captcha validation-logic helpers.
//!
//! These mirror the extracted `smCaptcha` methods (`getFullPageData`,
//! `getMouseAction`, `getSafeParams`, `checkApi`) without requiring a browser
//! or a JavaScript runtime.

use crate::sm_des::{
    sm_base64_decode, sm_base64_encode, sm_des_decrypt_ecb_zero_pad_bytes,
    sm_des_encrypt_ecb_zero_pad_bytes,
};
use crate::stringify::SmValue;

/// Derives the per-session DES key from `registerData.k` / `registerData.l`.
///
/// JS equivalent:
/// `DES("sshummei", base64Decode(k), 0, 0).substr(0, l)`
pub fn derive_key(register_k: &str, register_l: usize) -> Vec<u8> {
    let decoded = sm_base64_decode(register_k);
    let decrypted = sm_des_decrypt_ecb_zero_pad_bytes(b"sshummei", &decoded);
    let end = register_l.min(decrypted.len());
    decrypted[..end].to_vec()
}

/// `getEncryptContent(value, key)` from the SDK.
///
/// Strings are used as-is; other values are serialized with `smStringify`.
pub fn encrypt_content(value: SmValue, key: &str) -> String {
    let text = match &value {
        SmValue::String(s) => s.clone(),
        _ => value.stringify(),
    };
    let raw = sm_des_encrypt_ecb_zero_pad_bytes(key.as_bytes(), text.as_bytes());
    sm_base64_encode(&raw)
}

/// `getFullPageData()` from the SDK.
pub fn get_full_page_data(
    register_k: &str,
    register_l: usize,
    mousemove_data: SmValue,
    mouse_left_click_data: SmValue,
    mouse_right_click_data: SmValue,
    keyboard_data: SmValue,
    os: &str,
    run_bot_detection: i64,
    console_open: i64,
) -> String {
    let key = derive_key(register_k, register_l);
    let obj = SmValue::Object(vec![
        ("mm".to_string(), mousemove_data),
        ("mlc".to_string(), mouse_left_click_data),
        ("mrc".to_string(), mouse_right_click_data),
        ("kb".to_string(), keyboard_data),
        ("os".to_string(), SmValue::String(os.to_string())),
        ("wd".to_string(), SmValue::Number(run_bot_detection)),
        ("sm".to_string(), SmValue::Number(1)),
        ("cs".to_string(), SmValue::Number(console_open)),
    ]);
    let serialized = obj.stringify();
    let raw = sm_des_encrypt_ecb_zero_pad_bytes(&key, serialized.as_bytes());
    sm_base64_encode(&raw)
}

/// `getSafeParams()` from the SDK.
///
/// On an embedded/native client both flags are normally `false`, giving `"00"`.
pub fn get_safe_params(browser: bool, hook_test: bool) -> String {
    let a = if browser { "1" } else { "0" };
    let b = if browser && hook_test { "1" } else { "0" };
    format!("{}{}", a, b)
}

/// `getMouseAction()` from the SDK, returned as ordered key/value pairs.
///
/// The returned pairs are intended to be merged into the verify request.
pub fn get_mouse_action(
    register_k: &str,
    register_l: usize,
    mode: &str,
    mouse_data: SmValue,
    start_time: i64,
    end_time: i64,
    mouse_end_x: i64,
    true_width: i64,
    true_height: i64,
    select_data: SmValue,
    block_width: i64,
    os: &str,
    console_open: i64,
    run_bot_detection: i64,
) -> Vec<(String, String)> {
    // The derived key is stored in `_data.__key` but not used by the individual
    // field encryptions below (they pass explicit 8-byte hex keys).
    let _key = derive_key(register_k, register_l);

    let mut out: Vec<(String, String)> = Vec::new();
    match mode {
        "select" | "icon_select" | "seq_select" | "spatial_select" => {
            out.push(("sp".into(), encrypt_content(select_data, "735c85df")));
            out.push(("ox".into(), encrypt_content(mouse_data, "b06aad3b")));
            out.push((
                "gt".into(),
                encrypt_content(SmValue::Number(end_time - start_time), "ed4576ba"),
            ));
            out.push((
                "sn".into(),
                encrypt_content(SmValue::Number(true_width), "cfa425d6"),
            ));
            out.push((
                "xb".into(),
                encrypt_content(SmValue::Number(true_height), "04a24a06"),
            ));
        }
        "slide" | "auto_slide" => {
            let or_value = if mode == "auto_slide" {
                if true_width - block_width == 0 {
                    SmValue::Number(0)
                } else {
                    SmValue::Float(mouse_end_x as f64 / (true_width - block_width) as f64)
                }
            } else if true_width == 0 {
                SmValue::Number(0)
            } else {
                SmValue::Float(mouse_end_x as f64 / true_width as f64)
            };
            let or_value = if mode == "slide" && true_width == 11966 {
                SmValue::Number(0)
            } else {
                or_value
            };
            out.push(("or".into(), encrypt_content(or_value, "f0e5bc10")));
            out.push(("ox".into(), encrypt_content(mouse_data, "b06aad3b")));
            out.push((
                "gt".into(),
                encrypt_content(SmValue::Number(end_time - start_time), "ed4576ba"),
            ));
            out.push((
                "sn".into(),
                encrypt_content(SmValue::Number(true_width), "cfa425d6"),
            ));
            out.push((
                "xb".into(),
                encrypt_content(SmValue::Number(true_height), "04a24a06"),
            ));
        }
        _ => {}
    }
    out.push(("act.os".to_string(), os.to_string()));
    out.push((
        "eg".into(),
        encrypt_content(SmValue::Number(console_open), "3f6a0c6f"),
    ));
    out.push((
        "xz".into(),
        encrypt_content(SmValue::Number(run_bot_detection), "cfcad8db"),
    ));
    out.push((
        "lo".into(),
        encrypt_content(SmValue::Number(-1), "4f3dbadb"),
    ));
    out
}

/// Builds the `checkApi` verify-request parameter map (base fields only).
pub fn build_verify_base_params(
    organization: &str,
    app_id: &str,
    channel: &str,
    lang: &str,
    rid: &str,
    rversion: &str,
    sdkver: &str,
    safe_params: &str,
) -> Vec<(String, String)> {
    vec![
        ("organization".to_string(), organization.to_string()),
        ("te".to_string(), encrypt_content(SmValue::String(app_id.to_string()), "ef4bef0b")),
        ("fr".to_string(), encrypt_content(SmValue::String(channel.to_string()), "60c83964")),
        ("fq".to_string(), encrypt_content(SmValue::String(lang.to_string()), "5992a161")),
        ("gr".to_string(), encrypt_content(SmValue::String(safe_params.to_string()), "3954fb84")),
        ("rid".to_string(), rid.to_string()),
        ("rversion".to_string(), rversion.to_string()),
        ("sdkver".to_string(), sdkver.to_string()),
        ("protocol".to_string(), "207".to_string()),
        ("ostype".to_string(), "web".to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_page_data_and_verify_params_do_not_panic() {
        // Values are arbitrary; this mainly checks the wiring compiles and runs.
        let k = sm_base64_encode(&sm_des_encrypt_ecb_zero_pad_bytes(
            b"sshummei",
            b"01234567",
        ));
        let l = 8usize;
        let act = get_full_page_data(
            &k,
            l,
            SmValue::Array(vec![SmValue::Object(vec![("x".into(), SmValue::Number(1))])]),
            SmValue::Array(vec![]),
            SmValue::Array(vec![]),
            SmValue::Array(vec![]),
            "web_pc",
            0,
            0,
        );
        assert!(!act.is_empty());

        let safe = get_safe_params(false, false);
        let mouse = get_mouse_action(
            &k,
            l,
            "slide",
            SmValue::Array(vec![]),
            100,
            200,
            50,
            300,
            150,
            SmValue::Array(vec![]),
            40,
            "web_pc",
            0,
            0,
        );
        let params = build_verify_params(
            "org",
            "app",
            "channel",
            "zh-cn",
            "rid123",
            "1.0.0",
            "2.6.10",
            &safe,
            mouse,
        );
        assert!(params.iter().any(|(key, _)| key == "te"));
        assert!(params.iter().any(|(key, _)| key == "or"));
    }
}

/// Convenience: full ordered verify-request params (base + mouse-action fields).
pub fn build_verify_params(
    organization: &str,
    app_id: &str,
    channel: &str,
    lang: &str,
    rid: &str,
    rversion: &str,
    sdkver: &str,
    safe_params: &str,
    mouse_action: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut params = build_verify_base_params(
        organization,
        app_id,
        channel,
        lang,
        rid,
        rversion,
        sdkver,
        safe_params,
    );
    params.extend(mouse_action);
    params
}
