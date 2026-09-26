//! 探针：toml crate 序列化字符串的字面量形态，以及多行字符串回读后的确切值。
//!
//! 应用侧（app/src/services/toml-config.js）要能读回后端写的各种形态；
//! 这里给出"标准解析器认为的正确值"，作为应用侧解析的对照基准。
//! 运行：cargo run --example toml_strfmt_probe

fn main() {
    println!("== 序列化形态（值 => 后端写出的样子）==");
    let cases: [&str; 7] = [
        "SimplePw123",
        "has\"quote",
        "has'apostrophe",
        "has\\backslash",
        "中文密码测试",
        "with\ttab",
        "newline\ninside",
    ];
    for pw in cases {
        let mut m = std::collections::BTreeMap::new();
        m.insert("password", pw.to_string());
        let s = toml::to_string(&m).unwrap();
        println!("PW={pw:?}\n  => {}", s.trim());
    }

    println!("\n== 多行字符串回读（验证开定界符后的换行是否被裁掉）==");
    let src = "password = \"\"\"\nline1\nline2\n\"\"\"\n";
    let v: std::collections::BTreeMap<String, String> = toml::from_str(src).unwrap();
    println!("SRC={src:?}");
    println!("PARSED={:?}", v.get("password").unwrap());

    let src2 = "password = '''\nraw\n'''\n";
    let v2: std::collections::BTreeMap<String, String> = toml::from_str(src2).unwrap();
    println!("SRC2={src2:?}");
    println!("PARSED2={:?}", v2.get("password").unwrap());
}
