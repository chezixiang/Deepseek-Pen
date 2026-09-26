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
    /// 设备 ID（数美/Shumei 浏览器设备指纹）
    ///
    /// 登录请求体里的 device_id 字段。上游风控对它有硬校验：
    /// - **实测不可伪造**：伪造值（无论 base64 还是普通字符串）登录会返回
    ///   `RISK_DEVICE_DETECTED`（biz_code 11）。留空时本服务会生成随机 UUID
    ///   兜底——若登录被 11 号错误拒绝，请按下方步骤抓取真实值填入。
    /// - 建议**每个账号使用独立的 device_id**：设备级指纹被上游用于关联与画像，
    ///   同一指纹下挂多个账号、累计数百次请求后会被禁言（biz_code 5）。
    ///
    /// 抓取步骤：用 Chrome 打开 https://chat.deepseek.com/sign_in 并登录一次 →
    /// 开发者工具 → Network → 过滤 `users/login` → 复制请求 Payload 里的
    /// `device_id` 值。简化方案：控制台执行 `SMSdk.getDeviceId()`（等 SMSdk 就绪）。
    #[serde(default = "generate_device_id")]
    pub device_id: String,
    /// 数美 smidV2 Cookie（可选，配合 device_id 使用）
    ///
    /// 抓包（.probe/new.jsonl）实证：真实浏览器的登录请求**同时**携带 body 里的
    /// device_id 和 Cookie 里的 smidV2（数美 SDK 写入），两者是同一设备身份的
    /// 两半。仅带 device_id 而无 smidV2 与真实浏览器不符，可能是伪造 device_id
    /// 被风控拒绝的深层原因之一。
    ///
    /// 抓取：同一浏览器 DevTools → Application → Cookies → chat.deepseek.com →
    /// 复制 `smidV2` 的值。同设备的多个账号填同一个值（与真实多账号浏览器一致）。
    /// 留空 = 不发送（维持现有行为）。
    #[serde(default)]
    pub smid: String,
}

/// 生成随机设备 ID（UUID v4 格式）
fn generate_device_id() -> String {
    let rng = std::collections::hash_map::RandomState::new();
    let hash1 = std::hash::BuildHasher::hash_one(&rng, std::time::SystemTime::now());
    let hash2 = std::hash::BuildHasher::hash_one(&rng, std::process::id());
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (hash1 >> 32) as u32,
        (hash1 >> 16) as u16 & 0xffff,
        (hash1 as u16) & 0x0fff,
        (hash2 >> 48) as u16 & 0x3fff | 0x8000,
        hash2 & 0xffffffffffff
    )
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
    /// X-Client-Bundle-Id 请求头（web 端固定 com.deepseek.chat）
    #[serde(default = "default_client_bundle_id")]
    pub client_bundle_id: String,
    /// X-Client-Timezone-Offset 请求头（秒；东八区 = 28800）
    #[serde(default = "default_client_timezone_offset")]
    pub client_timezone_offset: i32,
    /// 定义支持的模型类型列表，每种类型会自动映射为 OpenAI 的 model_id：deepseek-<type>
    #[serde(default = "default_model_types")]
    pub model_types: Vec<String>,
    /// 各模型类型的输入 token 限制（与 model_types 按索引一一对应）
    #[serde(default = "default_max_input_tokens")]
    pub max_input_tokens: Vec<u32>,
    /// 各模型类型的输出 token 限制（与 model_types 按索引一一对应）
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: Vec<u32>,
    /// 各模型类型的单次输入字符数限制（与 model_types 按索引一一对应）。
    /// 上游对全部 model_type 均返回 input_character_limit = 2621440。
    #[serde(default = "default_input_character_limits")]
    pub input_character_limits: Vec<u32>,
    /// 工具调用标签配置（自定义回退标签）
    #[serde(default)]
    pub tool_call: ToolCallTagConfig,
    /// 模型别名：按 index 对齐 model_types，默认无别名
    /// 如 model_types = ["default", "expert"], model_aliases = ["", "deepseek-v4-pro"]
    /// 则仅 deepseek-v4-pro → expert（index 1），空字符串被跳过
    #[serde(default)]
    pub model_aliases: Vec<String>,
    /// 每账号每小时请求上限（0 = 不限制）
    ///
    /// 上游实测同一账号累计约 215 次请求/小时量级会被禁言（biz_code=5），
    /// 且禁言是**延迟判定**的（跑完才封）。配额在账号维度做窗口限流：
    /// 达到上限的账号在本窗口内不再被分配，由池中其他账号承接。
    #[serde(default = "default_hourly_request_quota")]
    pub hourly_request_quota: u64,
    /// 未显式传入 `web_search_options` 时是否默认开启搜索模式（默认 false）
    ///
    /// `false` 严格遵循 OpenAI 语义（未传即关闭），可减少 DeepSeek 侧的
    /// 系统提示词注入，也避免"每次对话都搜索"这一非人分布（风控差异 #8）。
    #[serde(default = "default_search_enabled")]
    pub default_search_enabled: bool,
    /// 设备指纹配置（可选；留空则从运行环境动态采集硬件特征）
    #[serde(default)]
    pub fingerprint: Option<serde_json::Value>,
    /// x-hif-leim / x-hif-dliq 动态凭据（详见 docs/deepseek-verification-analysis.md §3）
    ///
    /// bundle 逆向结论：这两个头**不是本地 JS 生成的**，而是浏览器页面内的
    /// poller 从 DeepSeek 分发服务（hif-leim/hif-dliq.deepseek.com/query）定期
    /// 拉取的公开凭据（无鉴权，TTL 默认 600s）。因此默认由后台任务**动态拉取**
    /// 并在 completion 上附加——与真实浏览器行为一致，无需伪造。
    ///
    /// `hif_leim` / `hif_dliq`：静态覆盖值（仅调试实验用，如复现抓包）。
    /// 非空时优先于动态值。留空 = 使用动态获取。
    #[serde(default)]
    pub hif_leim: String,
    /// x-hif-dliq 的静态覆盖值（同上，留空 = 使用动态获取）
    #[serde(default)]
    pub hif_dliq: String,
    /// 是否自动拉取 HIF 动态凭据（默认 true，与真实浏览器行为一致）。
    /// 关闭后 completion 不带 x-hif-leim/x-hif-dliq 头（服务端当前不强制）。
    #[serde(default = "default_hif_auto_fetch")]
    pub hif_auto_fetch: bool,
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
            client_bundle_id: default_client_bundle_id(),
            client_timezone_offset: default_client_timezone_offset(),
            model_types: default_model_types(),
            max_input_tokens: default_max_input_tokens(),
            max_output_tokens: default_max_output_tokens(),
            input_character_limits: default_input_character_limits(),
            tool_call: ToolCallTagConfig::default(),
            model_aliases: Vec::new(),
            hourly_request_quota: default_hourly_request_quota(),
            default_search_enabled: default_search_enabled(),
            fingerprint: None,
            hif_leim: String::new(),
            hif_dliq: String::new(),
            hif_auto_fetch: default_hif_auto_fetch(),
        }
    }
}

/// 支持的 model_type 列表。
///
/// 2026-09-12 官方合并模型：new.jsonl 的 `client/settings?scope=model` 显示
/// `expert`（专家模式）与 `vision`（识图模式）均已 `enabled:false, switchable:false`，
/// 只剩 `default` 一种（`is_default:true`），且它的 `file_feature.vision=true`
/// —— 图片理解、深度思考、联网搜索全部降级为 default 上的正交开关
/// （`thinking_enabled` / `search_enabled` / `ref_file_ids`）。
/// 继续发送 expert/vision 既拿不到能力，又是明显的过期客户端特征。
fn default_model_types() -> Vec<String> {
    vec!["default".to_string()]
}

fn default_max_input_tokens() -> Vec<u32> {
    // settings 实测 input_character_limit=2621440，file token_limit=890880
    vec![1_048_576]
}

fn default_max_output_tokens() -> Vec<u32> {
    vec![384_000]
}

/// 各模型类型的单次输入字符数限制（上游 settings 实测 2621440）
fn default_input_character_limits() -> Vec<u32> {
    vec![2_621_440]
}

/// 每账号每小时请求上限默认值：60。
/// 远低于上游实测触发禁言的 ~215 次/小时量级，同时单账号仍能支撑常规
/// 交互式使用。需要更高吞吐时应增加账号数量，而不是抬高这个值。
fn default_hourly_request_quota() -> u64 {
    60
}

/// 未传 `web_search_options` 时默认关闭搜索（风控差异 #8）：
/// 100% 的对话都开搜索在真实用户分布里几乎不存在（官方极少用户全搜），
/// 联网需求由应用侧显式传 web_search_options 表达。
fn default_search_enabled() -> bool {
    false
}

/// HIF 动态凭据自动拉取默认开启（与真实浏览器行为一致，失败自动降级为不发）
fn default_hif_auto_fetch() -> bool {
    true
}

/// 默认 X-Client-Bundle-Id —— new.jsonl 实抓 web 端固定值
fn default_client_bundle_id() -> String {
    "com.deepseek.chat".to_string()
}

/// 默认 X-Client-Timezone-Offset —— 东八区 28800 秒
fn default_client_timezone_offset() -> i32 {
    28800
}

impl DeepSeekConfig {
    /// 生成 OpenAI 模型注册表映射
    ///
    /// 每个 model_type 注册两种写法，便于客户端直接用裸名（例如 Claude Code
    /// 里把 `model` 设成 `default`）：
    /// - `deepseek-{ty}`（标准 ID）
    /// - `{ty}`（裸 model_type 名，如 `default`）
    pub fn model_registry(&self) -> std::collections::HashMap<String, String> {
        let mut map = std::collections::HashMap::new();
        for (i, ty) in self.model_types.iter().enumerate() {
            map.insert(format!("deepseek-{}", ty).to_lowercase(), ty.clone());
            // 裸名兜底：不覆盖用户显式起的别名
            map.entry(ty.to_lowercase())
                .or_insert_with(|| ty.clone());
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
    /// 网络抓取：true 时把发往上游（DeepSeek/数美）的全部 HTTP 往返逐条落盘
    /// logs/net-capture.jsonl（JSONL，见 server::net_capture）。
    /// 词典笔端由设置页「启用调试日志」开关联动写入；改值需重启后端生效。
    #[serde(default)]
    pub net_capture: bool,
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

/// 默认 User-Agent —— Linux aarch64 桌面 Chrome（与 wreq 的 Emulation::Chrome136
/// TLS/JA3 指纹同大版本）。目标运行平台即 aarch64 Linux（词典笔），浏览器身份
/// 与真实硬件平台一致；此前是 Windows 桌面 UA，在 ARM64 Linux 设备上属于
/// 可识别的 UA/平台错配。统一由 fingerprint 模块单点维护。
fn default_user_agent() -> String {
    crate::ds_core::default_user_agent()
}

/// 默认 X-Client-Version —— 对应 DeepSeek web 端。
/// new.jsonl（2026-09-12 实抓）显示线上 web 为 2.5.0；该值反映站点部署版本，
/// 与浏览器版本无关，可与 Chrome/136 UA 安全组合。
fn default_client_version() -> String {
    "2.5.0".to_string()
}

/// 默认 X-Client-Platform —— 与桌面 Chrome UA 匹配
fn default_client_platform() -> String {
    "web".to_string()
}

/// 默认 X-Client-Locale —— full.har 实证 web 端为 zh_CN（下划线格式）
fn default_client_locale() -> String {
    "zh_CN".to_string()
}

impl Config {
    /// 从指定路径加载配置
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path)?;
        let mut config: Self = toml::de::from_str(&content)?;
        config.dedup_accounts();
        config.pad_limit_lists();
        config.validate()?;
        Ok(config)
    }

    /// 旧配置兼容：input_character_limits 是后加入的字段，老 config 里没有，
    /// 反序列化后长度为 1，与多模型 model_types 校验必然冲突。按最后一个值
    /// 补齐到与 model_types 等长（多出的项截断）。
    fn pad_limit_lists(&mut self) {
        let n = self.deepseek.model_types.len();
        if n == 0 || self.deepseek.input_character_limits.len() == n {
            return;
        }
        let fill = self.deepseek.input_character_limits.last().copied().unwrap_or(2_621_440);
        self.deepseek.input_character_limits.resize(n, fill);
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
                    net_capture: false,
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
        if self.deepseek.input_character_limits.len() != n {
            return Err(ConfigError::Validation(format!(
                "input_character_limits 长度({})必须与 model_types 长度({})一致",
                self.deepseek.input_character_limits.len(),
                n
            )));
        }
        let mut seen_keys = std::collections::HashSet::new();
        for k in &self.api_keys {
            if !seen_keys.insert(&k.key) {
                // key 是用户可控输入，按字节截前缀在多字节字符中间会 panic
                let prefix: String = k.key.chars().take(12).collect();
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
            // 0644 而非 0600：词典笔应用侧的 fs.readFile 在部分机型上以非 root
            // 身份运行，0600（root 属主）会让应用读不到本文件，报
            // "无法读取 ds-free-api 配置文件"（10201）。内容仅限本机，
            // 应用本就能经 execShell 以 root 读写它，放宽权限不扩大暴露面。
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o644);
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
#[cfg(test)]
mod validate_tests {
    use super::*;

    fn base_config() -> Config {
        Config {
            accounts: Vec::new(),
            deepseek: DeepSeekConfig::default(),
            server: ServerConfig {
                host: "127.0.0.1".into(),
                port: 22217,
                cors_origins: default_cors_origins(),
                debug: false,
                net_capture: false,
            },
            proxy: ProxyConfig::default(),
            admin: AdminConfig::default(),
            api_keys: Vec::new(),
        }
    }

    /// 回归：validate() 曾用 &k.key[..12] 按字节截前缀拼错误信息，
    /// 多字节（中文）key 一旦重复，启动时不是返回配置错误而是 panic。
    #[test]
    fn duplicate_multibyte_api_key_errors_cleanly() {
        let mut cfg = base_config();
        let key = "中文密钥中文密钥中文密钥";
        cfg.api_keys = vec![
            ApiKeyEntry { key: key.into(), description: "a".into() },
            ApiKeyEntry { key: key.into(), description: "b".into() },
        ];
        let err = cfg.validate().expect_err("重复 key 必须报错");
        let msg = err.to_string();
        assert!(msg.contains("重复"), "错误信息应说明 key 重复: {msg}");
    }

    #[test]
    fn distinct_api_keys_pass_validation() {
        let mut cfg = base_config();
        cfg.api_keys = vec![
            ApiKeyEntry { key: "key-one".into(), description: String::new() },
            ApiKeyEntry { key: "key-two".into(), description: String::new() },
        ];
        cfg.validate().expect("不同 key 应通过校验");
    }
}
