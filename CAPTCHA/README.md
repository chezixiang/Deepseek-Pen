# 数美验证码原生验证逻辑（Rust）

本项目从 `captcha-sdk.min.js`（数美 / Shumei `smCaptcha` SDK）中提取并实现了核心验证/加密逻辑，用于**无法运行 JavaScript 的嵌入式设备**上完成同一套人机验证流程。

> **合规声明**
> 本代码仅用于在你自己授权运行的服务中执行正常的人机验证，**不是**用来绕过验证码、批量自动化或破解风控的工具。使用时请遵守数美 SDK 的许可条款和相关法律法规。

## 工作区结构

```text
.
├── Cargo.toml
├── Cargo.lock
├── README.md
├── captcha-sdk.min.js        # 原始 SDK（输入文件）
├── reference/                # 解混淆/提取出的 JS 参考文件
│   ├── smCaptcha.deob.js
│   ├── module_0x58_smCaptcha.js
│   ├── module_0x5b_smEncrypt.js
│   └── module_0x61_smStringify.js
└── src/
    ├── lib.rs                # crate 入口，统一 re-export
    ├── main.rs               # DES 向量自检 demo
    ├── sm_des.rs             # 自定义 DES + Base64
    ├── stringify.rs          # smStringify 序列化
    └── captcha.rs            # 高层验证逻辑
```

## 快速开始

```bash
cargo test
cargo run
```

`cargo run` 会打印已和原 JS 模块比对过的 DES 向量：

```text
PASS DES("sshummei", "hello") = f7fAI89lgcI=
PASS DES("ed4576ba", "hello") = UgnWaap2sqQ=
PASS DES("ishumei.com", "hello") = LlJSUNclnOI=
PASS DES("0123456789abcdef", "0123456789abcdef") = yGp9USVRfz53CcymFR5+3Q==
```

## 核心模块

### 1. `src/sm_des.rs` — 自定义 DES / Base64

该 SDK 的 `DES` 不是标准 DES，而是：

- key schedule 会消费整个 key 字符串；
- 8 字节 key 产生 32 个子密钥、单轮 16 次 Feistel；
- 超过 8 字节的 key 产生 96 个子密钥、三轮 Feistel；
- 加密模式为 ECB + 零填充到 8 字节块边界。

主要函数：

```rust
pub fn sm_des_encrypt_ecb_zero_pad(key: &str, plaintext: &str) -> Vec<u8>;
pub fn sm_des_decrypt_ecb_zero_pad(key: &str, ciphertext: &str) -> Vec<u8>;

// 推荐用于二进制数据：
pub fn sm_des_encrypt_ecb_zero_pad_bytes(key: &[u8], plaintext: &[u8]) -> Vec<u8>;
pub fn sm_des_decrypt_ecb_zero_pad_bytes(key: &[u8], ciphertext: &[u8]) -> Vec<u8>;

pub fn sm_base64_encode(bytes: &[u8]) -> String;
pub fn sm_base64_decode(s: &str) -> Vec<u8>;
```

### 2. `src/stringify.rs` — `smStringify`

实现 SDK 自定义 JSON 风格序列化，保留其怪癖：

- key 不转义；
- 字符串只转义**第一个**双引号；
- 数组中的 `null` 原样输出；
- 对象/数组递归序列化。

```rust
pub enum SmValue {
    Null,
    Bool(bool),
    Number(i64),
    Float(f64),
    String(String),
    Array(Vec<SmValue>),
    Object(Vec<(String, SmValue)>),
}

impl SmValue {
    pub fn stringify(&self) -> String;
}
```

### 3. `src/captcha.rs` — 高层验证逻辑

```rust
/// 由注册响应中的 registerData.k / l 派生会话 key
pub fn derive_key(register_k: &str, register_l: usize) -> Vec<u8>;

/// getEncryptContent(value, key)
pub fn encrypt_content(value: SmValue, key: &str) -> String;

/// 生成注册/无感验证用的 act 参数
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
) -> String;

/// getSafeParams()
pub fn get_safe_params(browser: bool, hook_test: bool) -> String;

/// 生成验证请求里的鼠标行为字段（返回有序 key/value）
pub fn get_mouse_action(
    register_k: &str,
    register_l: usize,
    mode: &str,               // "select" | "icon_select" | "seq_select" | "spatial_select" | "slide" | "auto_slide"
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
) -> Vec<(String, String)>;

/// 验证请求基础参数（te/fr/fq/gr/rid/...）
pub fn build_verify_base_params(
    organization: &str,
    app_id: &str,
    channel: &str,
    lang: &str,
    rid: &str,
    rversion: &str,
    sdkver: &str,
    safe_params: &str,
) -> Vec<(String, String)>;

/// 基础参数 + get_mouse_action 字段，得到完整验证参数
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
) -> Vec<(String, String)>;
```

## 使用示例

```rust
use sm_des::{
    SmValue, derive_key, get_full_page_data, get_mouse_action,
    get_safe_params, build_verify_params,
};

// 假设注册接口已经返回了这些字段
let register_k = "...base64 k from registerData...";
let register_l = 8;

// 1. 派生会话 key（一般不需要直接使用，get_full_page_data 内部会调用）
let key = derive_key(register_k, register_l);

// 2. 构造行为数据（嵌入式端可把采集到的事件转成 SmValue）
let mousemove = SmValue::Array(vec![
    SmValue::Object(vec![
        ("x".into(), SmValue::Number(100)),
        ("y".into(), SmValue::Number(200)),
        ("t".into(), SmValue::Number(123456)),
    ]),
]);
let empty = SmValue::Array(vec![]);

// 3. 生成 act 参数
let act = get_full_page_data(
    register_k,
    register_l,
    mousemove,
    empty.clone(),
    empty.clone(),
    empty.clone(),
    "web_pc", // 或 "web_mobile"
    0,        // runBotDetection 结果，正常环境通常为 0
    0,        // console 检测结果
);

// 4. 生成验证请求字段
let safe = get_safe_params(false, false); // 嵌入式无浏览器 => "00"
let mouse = get_mouse_action(
    register_k,
    register_l,
    "slide",
    empty,
    1000,  // start_time
    5000,  // end_time
    280,   // mouse_end_x
    300,   // true_width
    150,   // true_height
    empty,
    40,    // block_width
    "web_pc",
    0,
    0,
);
let params = build_verify_params(
    "your_organization",
    "your_app_id",
    "your_channel",
    "zh-cn",
    "rid_from_register",
    "1.0.0",
    "2.6.10",
    &safe,
    mouse,
);

// params 即可作为验证请求表单/JSON 参数发送
for (k, v) in params {
    println!("{}={}", k, v);
}
```

## 验证流程

1. **注册**  
   请求 `/ca/v1/register`，参数：  
   `organization`、`appId`、`channel`、`lang`、`model`、`rversion`、`sdkver`、`data`、`captchaUuid`。

2. **保存 `registerData`**  
   从响应 `detail` 中取得 `k`、`l`（以及 `fg`、`bg`、`domains` 等展示字段）。

3. **生成 `act`**  
   调用 `get_full_page_data(...)`。

4. **发送验证/无感验证请求**  
   请求 `/ca/v2/fverify` 或配置的 `fVerifyUrl`，参数由 `build_verify_params(...)` 生成。

5. **使用结果**  
   响应中的 `riskLevel` / `requestId` 决定 `pass`，最终把 `rid` + `pass` 用于你的业务侧校验。

## 关于格式化检测 / 混淆

原 SDK 包含：

- 字符串数组旋转；
- switch 状态机混淆；
- `isJsFormat()` 等反格式化检测。

原生 Rust 实现没有“JS 是否被美化”的问题，因此默认走正常 minified SDK 的加密路径。  
如果你需要模拟“代码被格式化后改用随机长 key”的分支，`sm_des` 已支持超过 8 字节的 key，可参考 `reference/smCaptcha.deob.js` 中 `_0x329deb` 的生成逻辑继续扩展。

## 维护说明

- 数美可能更新 SDK，字段名、固定 key、`protocol` 版本号都可能变化。
- 如果遇到验证失败，优先抓包对比新 SDK 中 `checkApi` / `getFullPageData` / `getMouseAction` 的入参与本实现是否一致。
- `reference/` 下保留了解混淆后的 JS 模块，便于后续 diff 和重新提取。
