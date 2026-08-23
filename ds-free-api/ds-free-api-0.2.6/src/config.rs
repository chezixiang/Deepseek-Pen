//! 配置加载模块 —— 统一配置入口
//!
//! 支持 `-c <path>` 命令行参数，默认值见下方函数。
//! config.toml 中注释项使用代码默认值。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 应用配置根结构
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    /// 账号池（必需，可为空——启动后通过管理面板添加）
    #[serde(default)]
    pub accounts: Vec<Account>,
    /// DeepSeek 相关配置
    #[serde(default)]
    pub deepseek: DeepSeekConfig,
    /// HTTP 服务器配置（必填）
    pub server: ServerConfig,
    /// 代理配置（可选，用于绕过 WAF）
    #[serde(default)]
    pub proxy: ProxyConfig,
    /// Admin 配置（bcrypt 密码哈希、JWT 密钥等，由管理面板管理）
    #[serde(default)]
    pub admin: AdminConfig,
    /// API Key 列表（由管理面板管理）
    #[serde(default)]
    pub api_keys: Vec<ApiKeyEntry>,
}

/// Admin 配置
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AdminConfig {
    /// bcrypt 哈希后的密码
    #[serde(default)]
    pub password_hash: String,
    /// JWT 签名密钥（hex 编码的 32 字节随机值）
    #[serde(default)]
    pub jwt_secret: String,
    /// 最近一次 JWT 签发时间（用于吊销旧 token）
    #[serde(default)]
    pub jwt_issued_at: u64,
    /// 修改密码：旧密码明文（仅 PUT 接收，不落地 config.toml）
    #[serde(default, skip_serializing)]
    pub old_password: String,
    /// 修改密码：新密码明文（仅 PUT 接收，不落地 config.toml）
    #[serde(default, skip_serializing)]
    pub new_password: String,
}

/// API Key 条目
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiKeyEntry {
    pub key: String,
    pub description: String,
}

/// 代理配置
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ProxyConfig {
    /// 代理 URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891
    pub url: Option<String>,
}

/// 单个账号配置
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Account {
    /// 邮箱（与 mobile 二选一）
    pub email: String,
    /// 手机号（与 email 二选一）
    pub mobile: String,
    /// 区号（与 mobile 配合使用，如 "+86"）
    pub area_code: String,
    /// 密码
    pub password: String,
}

/// DeepSeek 客户端配置
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeepSeekConfig {
    /// API 基础地址
    #[serde(default = "default_api_base")]
    pub api_base: String,
    /// WASM 文件完整 URL（PoW 计算所需，版本号可能变动）
    #[serde(default = "default_wasm_url")]
    pub wasm_url: String,
    /// User-Agent 请求头
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    /// X-Client-Version 请求头（用于 expert 模型等功能）
    #[serde(default = "default_client_version")]
    pub client_version: String,
    /// X-Client-Platform 请求头
    #[serde(default = "default_client_platform")]
    pub client_platform: String,
    /// X-Client-Locale 请求头
    #[serde(default = "default_client_locale")]
    pub client_locale: String,
    /// 定义支持的模型类型列表，每种类型会自动映射为 OpenAI 的 model_id：deepseek-<type>
    #[serde(default = "default_model_types")]
    pub model_types: Vec<String>,
    /// 各模型类型的输入 token 限制（与 model_types 按索引一一对应）
    #[serde(default = "default_max_input_tokens")]
    pub max_input_tokens: Vec<u32>,
    /// 各模型类型的输出 token 限制（与 model_types 按索引一一对应）
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: Vec<u32>,
    /// 工具调用标签配置（自定义回退标签）
    #[serde(default)]
    pub tool_call: ToolCallTagConfig,
    /// 模型别名：按 index 对齐 model_types，默认无别名
    /// 如 model_types = ["default", "expert"], model_aliases = ["", "deepseek-v4-pro"]
    /// 则仅 deepseek-v4-pro → expert（index 1），空字符串被跳过
    #[serde(default)]
    pub model_aliases: Vec<String>,
}

/// 工具调用标签配置
///
/// 内置模糊匹配：`｜`(U+FF5C)↔`|`、`▁`(U+2581)↔`_`，自动覆盖大多数字符级幻觉变体。
/// 此处配置的 extra 列表用于处理格式完全不同的标签（如 `<tool_call>`），
/// 模糊匹配无法覆盖的情况。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolCallTagConfig {
    /// 额外开始标签（内置 `<|tool▁calls▁begin|>` + 模糊匹配，此处只加格式完全不同的变体）
    #[serde(default = "default_tool_call_starts")]
    pub extra_starts: Vec<String>,
    /// 额外结束标签（内置 `<|tool▁calls▁end|>` + 模糊匹配，此处只加格式完全不同的变体）
    #[serde(default = "default_tool_call_ends")]
    pub extra_ends: Vec<String>,
}

impl Default for ToolCallTagConfig {
    fn default() -> Self {
        Self {
            extra_starts: default_tool_call_starts(),
            extra_ends: default_tool_call_ends(),
        }
    }
}

fn default_tool_call_starts() -> Vec<String> {
    vec![
        "<|tool_call_begin|>".into(),
        "<tool_calls>".into(),
        "<tool_call>".into(),
    ]
}

fn default_tool_call_ends() -> Vec<String> {
    vec![
        "<|tool_call_end|>".into(),
        "</tool_calls>".into(),
        "</tool_call>".into(),
    ]
}

impl Default for DeepSeekConfig {
    fn default() -> Self {
        Self {
            api_base: default_api_base(),
            wasm_url: default_wasm_url(),
            user_agent: default_user_agent(),
            client_version: default_client_version(),
            client_platform: default_client_platform(),
            client_locale: default_client_locale(),
            model_types: default_model_types(),
            max_input_tokens: default_max_input_tokens(),
            max_output_tokens: default_max_output_tokens(),
            tool_call: ToolCallTagConfig::default(),
            model_aliases: Vec::new(),
        }
    }
}

fn default_model_types() -> Vec<String> {
    vec!["default".to_string(), "expert".to_string(), "vl".to_string()]
}

fn default_max_input_tokens() -> Vec<u32> {
    vec![1_048_576, 1_048_576, 1_048_576]
}

fn default_max_output_tokens() -> Vec<u32> {
    vec![384_000, 384_000, 384_000]
}

impl DeepSeekConfig {
    /// 生成 OpenAI 模型注册表映射
    pub fn model_registry(&self) -> std::collections::HashMap<String, String> {
        let mut map = std::collections::HashMap::new();
        for (i, ty) in self.model_types.iter().enumerate() {
            map.insert(format!("deepseek-{}", ty).to_lowercase(), ty.clone());
            if let Some(alias) = self.model_aliases.get(i) {
                let alias = alias.trim().to_lowercase();
                if !alias.is_empty() {
                    map.insert(alias, ty.clone());
                }
            }
        }
        map
    }
}

/// HTTP 服务器配置（必填）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
    /// 监听地址
    pub host: String,
    /// 监听端口
    pub port: u16,
    /// CORS 允许的 Origin 列表，默认 ["http://localhost:22217"]
    /// 设为 ["*"] 则允许所有（不推荐生产使用）
    #[serde(default = "default_cors_origins")]
    pub cors_origins: Vec<String>,
    /// 调试模式：true 时监听 0.0.0.0（方便外部调试），忽略 host 字段
    #[serde(default)]
    pub debug: bool,
}

fn default_cors_origins() -> Vec<String> {
    vec!["http://localhost:22217".to_string()]
}

/// 默认 API 基础地址
fn default_api_base() -> String {
    "https://chat.deepseek.com/api/v0".to_string()
}

/// 默认 WASM 文件 URL（版本号可能变动，建议配置文件中显式指定）
fn default_wasm_url() -> String {
    "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm".to_string()
}

/// 默认 User-Agent —— 与 rquest 的 Emulation::Chrome136（TLS/JA3 指纹）保持一致。
/// 此前默认值为 "DeepSeek/2.0.4 Android/35"（app 端 UA），但 TLS 指纹是桌面 Chrome 136，
/// 服务端指纹分析可识别 UA 与 TLS 不匹配，易触发风控/禁言。统一为桌面 Chrome 136 web 端组合。
fn default_user_agent() -> String {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36".to_string()
}

/// 默认 X-Client-Version —— 对应 DeepSeek web 端
fn default_client_version() -> String {
    "2.3.0".to_string()
}

/// 默认 X-Client-Platform —— 与桌面 Chrome UA 匹配
fn default_client_platform() -> String {
    "web".to_string()
}

/// 默认 X-Client-Locale
fn default_client_locale() -> String {
    "zh-CN".to_string()
}

impl Config {
    /// 从指定路径加载配置
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path)?;
        let mut config: Self = toml::de::from_str(&content)?;
        config.dedup_accounts();
        config.validate()?;
        Ok(config)
    }

    /// 按 email（优先）或 mobile 去重，保留首次出现的账号
    fn dedup_accounts(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.accounts.retain(|a| {
            let key = if a.email.is_empty() {
                a.mobile.clone()
            } else {
                a.email.clone()
            };
            seen.insert(key)
        });
    }

    /// 解析命令行参数并加载配置
    ///
    /// 支持 `-c <path>` 指定配置文件路径，默认使用 `config.toml`
    /// 也支持 `DS_CONFIG_PATH` 环境变量（优先级：`-c` > `DS_CONFIG_PATH` > 默认值）
    /// 若文件不存在且非 `-c` 显式指定，自动创建最小配置
    /// 返回 (加载的配置, 配置文件的路径)
    pub fn load_with_args(
        args: impl Iterator<Item = String>,
    ) -> Result<(Self, PathBuf), ConfigError> {
        let mut explicit_c = false;
        let mut config_path = None;
        let mut iter = args.skip(1); // 跳过程序名

        while let Some(arg) = iter.next() {
            if arg == "-c" {
                explicit_c = true;
                if let Some(path) = iter.next() {
                    config_path = Some(path);
                } else {
                    return Err(ConfigError::Cli("-c 参数需要指定路径".to_string()));
                }
            }
        }

        let path: PathBuf = config_path
            .map(PathBuf::from)
            .or_else(|| std::env::var("DS_CONFIG_PATH").ok().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("config.toml"));

        if !path.exists() {
            if explicit_c {
                return Err(ConfigError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("指定配置文件不存在: {}", path.display()),
                )));
            }
            // 自动创建最小配置
            let default = Config {
                accounts: Vec::new(),
                deepseek: DeepSeekConfig::default(),
                server: ServerConfig {
                    host: "127.0.0.1".into(),
                    port: 22217,
                    cors_origins: default_cors_origins(),
                    debug: false,
                },
                proxy: ProxyConfig::default(),
                admin: AdminConfig::default(),
                api_keys: Vec::new(),
            };
            if let Some(parent) = path.parent() {
                let parent_str = parent.as_os_str();
                if !parent_str.is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            default.save(&path)?;
            log::info!(target: "config", "已创建默认配置文件: {}", path.display());
            return Ok((default, path));
        }

        let config = Self::load(&path)?;
        Ok((config, path))
    }
    /// 验证配置有效性
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if self.deepseek.model_types.is_empty() {
            return Err(ConfigError::Validation("model_types 不能为空".to_string()));
        }
        let n = self.deepseek.model_types.len();
        if self.deepseek.max_input_tokens.len() != n {
            return Err(ConfigError::Validation(format!(
                "max_input_tokens 长度({})必须与 model_types 长度({})一致",
                self.deepseek.max_input_tokens.len(),
                n
            )));
        }
        if self.deepseek.max_output_tokens.len() != n {
            return Err(ConfigError::Validation(format!(
                "max_output_tokens 长度({})必须与 model_types 长度({})一致",
                self.deepseek.max_output_tokens.len(),
                n
            )));
        }
        let mut seen_keys = std::collections::HashSet::new();
        for k in &self.api_keys {
            if !seen_keys.insert(&k.key) {
                let prefix = if k.key.len() > 12 {
                    &k.key[..12]
                } else {
                    &k.key
                };
                return Err(ConfigError::Validation(format!(
                    "API key 重复: {}...",
                    prefix
                )));
            }
        }
        Ok(())
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        let toml_str = toml::to_string_pretty(self).map_err(ConfigError::TomlSerialization)?;
        let tmp = path.as_ref().with_extension("toml.tmp");
        std::fs::write(&tmp, &toml_str)?;
        std::fs::rename(&tmp, path.as_ref())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            std::fs::set_permissions(path.as_ref(), perms)?;
        }
        Ok(())
    }
}

/// 配置加载错误类型
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("TOML 解析错误: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("配置验证错误: {0}")]
    Validation(String),
    #[error("命令行参数错误: {0}")]
    Cli(String),
    #[error("TOML 序列化错误: {0}")]
    TomlSerialization(#[from] toml::ser::Error),
}
