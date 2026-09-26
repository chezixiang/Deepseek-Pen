//! 集成测试（公开 API，离线运行）：config.toml 的加载 → 归一化 → 校验 → 持久化往返。
//!
//! 与 src 内单元测试的区别：这里从仓库外视角走 `Config::load` / `Config::save`
//! 的完整公开链路，覆盖"从真实 TOML 文件文本开始"的行为，能抓住序列化层
//! （toml crate）与归一化逻辑（去重、补齐、校验）之间的配合问题。

use ds_free_api::Config;

const BASE_TOML: &str = r#"
[server]
host = "127.0.0.1"
port = 22217

[deepseek]
model_types = ["default"]

[[api_keys]]
key = "sk-test-1234567890"
description = "integration"
"#;

fn temp_path(tag: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "dsfa-it-{}-{}.toml",
        tag,
        std::process::id()
    ));
    p
}

fn write_temp(tag: &str, content: &str) -> std::path::PathBuf {
    let path = temp_path(tag);
    std::fs::write(&path, content).expect("write temp config");
    path
}

/// 缺省字段自动补齐 + save→load 往返保持语义
#[test]
fn load_fills_defaults_and_roundtrips() {
    let path = write_temp("roundtrip", BASE_TOML);
    let cfg = Config::load(&path).expect("合法配置应加载成功");

    // model_types 只有 1 项：limit 列表缺失时由默认值/补齐逻辑对齐长度
    assert_eq!(cfg.deepseek.model_types.len(), 1);
    assert_eq!(
        cfg.deepseek.max_input_tokens.len(),
        cfg.deepseek.model_types.len(),
        "max_input_tokens 必须与 model_types 等长（load 内补齐）"
    );

    // model_registry：模型别名 → 类型映射应包含默认模型
    let registry = cfg.deepseek.model_registry();
    assert!(
        registry.values().any(|v| v == "default"),
        "registry 应含 default 模型: {registry:?}"
    );

    // save → load 往返：key 数量与内容保持
    cfg.save(&path).expect("save 成功");
    let reloaded = Config::load(&path).expect("save 产物必须可再次加载");
    assert_eq!(reloaded.api_keys.len(), cfg.api_keys.len());
    assert_eq!(reloaded.api_keys[0].key, "sk-test-1234567890");
    std::fs::remove_file(&path).ok();
}

/// 回归：重复的**多字节** API key 必须返回配置错误而不是 panic。
/// validate() 曾按字节切 `&key[..12]` 拼错误信息，中文 key（3 字节/字符）
/// 直接切出 panic；从文件加载的完整链路上这是启动期崩溃。
#[test]
fn duplicate_multibyte_api_key_is_rejected_not_panic() {
    let toml = BASE_TOML.to_string()
        + r#"
[[api_keys]]
key = "中文密钥中文密钥中文密钥"
description = "dup-1"

[[api_keys]]
key = "中文密钥中文密钥中文密钥"
description = "dup-2"
"#;
    let path = write_temp("dup-key", &toml);
    let result = Config::load(&path);
    let err = result.expect_err("重复 key 必须报配置错误");
    assert!(err.to_string().contains("重复"), "错误应说明 key 重复: {err}");
    std::fs::remove_file(&path).ok();
}

/// 重复账号按 email/mobile 去重（保留首次出现），不会让校验误伤
#[test]
fn duplicate_accounts_are_deduped_on_load() {
    let toml = BASE_TOML.to_string()
        + r#"
[[accounts]]
email = "same@example.com"
mobile = ""
area_code = ""
password = "pw-1"

[[accounts]]
email = "same@example.com"
mobile = ""
area_code = ""
password = "pw-2"
"#;
    let path = write_temp("dup-account", &toml);
    let cfg = Config::load(&path).expect("重复账号应去重而非报错");
    assert_eq!(cfg.accounts.len(), 1, "重复账号去重为一条");
    std::fs::remove_file(&path).ok();
}

/// 非法配置（模型列表为空）返回校验错误
#[test]
fn empty_model_types_is_rejected() {
    let toml = r#"
[server]
host = "127.0.0.1"
port = 22217

[deepseek]
model_types = []
"#;
    let path = write_temp("empty-models", toml);
    let err = Config::load(&path).expect_err("model_types 为空必须报错");
    assert!(err.to_string().contains("model_types"), "{err}");
    std::fs::remove_file(&path).ok();
}
