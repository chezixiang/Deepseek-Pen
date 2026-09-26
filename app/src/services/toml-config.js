// ds-free-api config.toml 的最小读取器（应用侧只读，不写）。
//
// 为什么单独成模块：**账号真源是后端写的 config.toml**，而后端（toml crate）
// 会按值的内容选择不同的字符串字面量形态：
//   key = "value"      基本字符串（值里没有 " 和 \）
//   key = 'value'      字面量字符串 —— 值里有 " 或 \ 时 toml 自动改用这种
//   key = """…"""      多行基本字符串 —— 值里有换行时
//   key = '''…'''      多行字面量字符串
// 应用侧只用双引号正则去读，会把这类账号读成"未配置" → dsConfigured=false →
// 进账号页就被弹去登录页（bug 2）。这里统一处理全部形态，并有回归用例
// （scripts/test-config-parse.mjs）。

/// 取某个键的字符串值；读不到返回 ''。
/// 只在**该键所在行**取值，不会跨段误匹配到别的段（如把 api_keys 的 key 当成账号的）。
/// 重复键按 TOML 语义取最后一次出现（旧版 match 取第一次，与 TOML 规范相反）。
export function tomlStringValue(raw, key) {
  const src = String(raw || '')
  const re = new RegExp(
    '(?:^|\\n)\\s*' + key + '\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*(?:[A-Za-z_]+\\s*=|\\[|$))',
    'g'
  )
  let m = null
  let last = null
  while ((m = re.exec(src)) !== null) {
    last = m
    if (m.index === re.lastIndex) re.lastIndex++
  }
  if (!last) return ''
  const v = String(last[1]).trim()
  if (v.indexOf('"""') === 0) {
    // 多行基本字符串：开定界符后紧跟的换行会被 TOML 丢掉，内容里仍做转义
    const body = v.slice(3).replace(/"""[\s\S]*$/, '').replace(/^\r?\n/, '')
    return unescapeTomlBasic(body)
  }
  if (v.indexOf("'''") === 0) {
    // 多行字面量字符串：同样丢掉紧跟开定界符的换行，内容不转义
    return v.slice(3).replace(/'''[\s\S]*$/, '').replace(/^\r?\n/, '')
  }
  // 单行值优先按「完整引号字符串」提取，忽略其后的行内注释 ——
  // 手工编辑的 config.toml 常有 password = "abc" # 备注 这类写法，
  // 旧版整体捕获后首尾引号配对失败，直接返回 ''（已登录被读成未登录）。
  let q = v.match(/^"((?:[^"\\]|\\.)*)"/)
  if (q) return unescapeTomlBasic(q[1])
  q = v.match(/^'([^']*)'/)
  if (q) return q[1]
  if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
    return unescapeTomlBasic(v.slice(1, -1))
  }
  if (v.length >= 2 && v.charAt(0) === "'" && v.charAt(v.length - 1) === "'") {
    return v.slice(1, -1) // 字面量字符串：内部不转义
  }
  return ''
}

// 基本字符串的反转义（与写入端 native.js 的 tomlEscape 相反）。
// 顺序要紧：先把 \\ 还原成占位符，再还原 \" \n \t 等，最后把占位符换回 \，
// 否则 "a\\\\\"b" 这类会被解错。
export function unescapeTomlBasic(s) {
  const BACKSLASH = '\u0000BACKSLASH\u0000'
  return String(s)
    .replace(/\\\\/g, BACKSLASH)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\u0000BACKSLASH\u0000/g, '\\')
}

/// 去掉以 # 开头的注释行（避免把示例/注释误判为真实配置）。
/// 多行字符串（""" / '''）内部的 # 行是**值的一部分**，不能当注释删——
/// 旧版无脑过滤曾把多行密码里以 # 开头的行吃掉，解出来的值就错了。
export function stripTomlComments(raw) {
  const lines = String(raw || '').split('\n')
  const out = []
  let fence = null // 当前所处的多行字符串定界符：null | '"""' | "'''"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      out.push(line)
      // 出现与开定界符相同的定界符 → 多行字符串结束
      if (line.indexOf(fence) >= 0) fence = null
      continue
    }
    if (line.trim().indexOf('#') === 0) continue // 顶层注释行
    const m = line.match(/("""|''')/)
    if (m) {
      const first = line.indexOf(m[1])
      const second = line.indexOf(m[1], first + 3)
      // 同一行内成对出现（value = """x"""）不算进入多行字符串
      if (second < 0) fence = m[1]
    }
    out.push(line)
  }
  return out.join('\n')
}

/// 取某个段（如 '[[accounts]]' / '[deepseek]'）的正文，到下一个段头为止
export function sectionBody(raw, sectionHeader) {
  const src = String(raw || '')
  const at = src.indexOf(sectionHeader)
  if (at < 0) return ''
  const after = src.slice(at + sectionHeader.length)
  const next = after.search(/\n\s*\[/)
  return next >= 0 ? after.slice(0, next) : after
}

/// 取全部 [[accounts]] 段的正文
export function accountSections(raw) {
  const src = String(raw || '')
  const out = []
  const parts = src.split('[[accounts]]')
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]
    const next = seg.search(/\n\s*\[/)
    out.push(next >= 0 ? seg.slice(0, next) : seg)
  }
  return out
}

/// 从 [[accounts]] 段取账号标识（邮箱优先，其次手机号）
export function accountIdFromSection(section) {
  const email = tomlStringValue(section, 'email').trim()
  const mobile = tomlStringValue(section, 'mobile').trim()
  return { id: email || mobile, email, mobile }
}
