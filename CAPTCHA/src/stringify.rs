//! A minimal re-implementation of the SDK's `smStringify`.
//!
//! The JS `smStringify` is a JSON-like serializer with these quirks:
//! * keys are not escaped;
//! * a string value is quoted and only its first `"` is backslash-escaped;
//! * `undefined` is serialized as `undefined` for primitives and `null` inside
//!   arrays;
//! * object values that are primitive and not `undefined` are serialized
//!   directly, otherwise they are recursively serialized.

#[derive(Debug, Clone)]
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
    pub fn stringify(&self) -> String {
        match self {
            SmValue::Null => "null".to_string(),
            SmValue::Bool(b) => b.to_string(),
            SmValue::Number(n) => n.to_string(),
            SmValue::Float(f) => {
                // JS Number#toString for integers prints without a decimal point.
                if f.fract() == 0.0 && f.is_finite() {
                    (*f as i64).to_string()
                } else {
                    f.to_string()
                }
            }
            SmValue::String(s) => format!("\"{}\"", escape_first_quote(s)),
            SmValue::Array(items) => {
                let inner = items
                    .iter()
                    .map(|v| match v {
                        SmValue::Null => "null".to_string(),
                        _ => v.stringify(),
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("[{}]", inner)
            }
            SmValue::Object(fields) => {
                let mut parts = Vec::with_capacity(fields.len());
                for (k, v) in fields {
                    let is_primitive = matches!(
                        v,
                        SmValue::Bool(_)
                            | SmValue::Number(_)
                            | SmValue::Float(_)
                            | SmValue::String(_)
                    );
                    if is_primitive {
                        parts.push(format!("\"{}\":{}", k, v.stringify()));
                    } else {
                        parts.push(format!("\"{}\":{}", k, v.stringify()));
                    }
                }
                format!("{{{}}}", parts.join(","))
            }
        }
    }
}

fn escape_first_quote(s: &str) -> String {
    match s.find('"') {
        Some(i) => {
            let mut out = String::with_capacity(s.len() + 1);
            out.push_str(&s[..i]);
            out.push('\\');
            out.push('"');
            out.push_str(&s[i + 1..]);
            out
        }
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stringify_matches_js_quirks() {
        let v = SmValue::Object(vec![
            ("a".into(), SmValue::Number(1)),
            ("b".into(), SmValue::String("x\"y".into())),
            (
                "c".into(),
                SmValue::Array(vec![
                    SmValue::Number(1),
                    SmValue::String("two".into()),
                    SmValue::Null,
                ]),
            ),
            ("d".into(), SmValue::Bool(true)),
        ]);
        assert_eq!(
            v.stringify(),
            r#"{"a":1,"b":"x\"y","c":[1,"two",null],"d":true}"#
        );
    }
}
