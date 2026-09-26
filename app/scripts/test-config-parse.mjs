// config.toml 解析的回归用例（对齐后端 toml crate 的真实输出形态）
// 运行：cd app && node scripts/test-config-parse.mjs
//
// 背景（bug 2）：后端写 config.toml 时，值里含 " 或 \ 会改用**单引号字面量**、
// 含换行会改用**多行字符串**；应用侧旧正则只认双引号 → 把已登录账号读成
// "未配置" → 进账号页就被弹去登录页。
import {
  tomlStringValue,
  accountSections,
  accountIdFromSection
} from '../src/services/toml-config.js'

let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// 后端实测输出（examples/toml_strfmt_probe.rs 的结果）
const cases = [
  ['基本字符串', 'password = "SimplePw123"\n', 'SimplePw123'],
  ['字面量（含双引号）', "password = 'has\"quote'\n", 'has"quote'],
  ['基本字符串（含单引号）', 'password = "has\'apostrophe"\n', "has'apostrophe"],
  ['字面量（含反斜杠）', "password = 'has\\backslash'\n", 'has\\backslash'],
  ['含井号', 'password = "has#hash"\n', 'has#hash'],
  ['中文', 'password = "中文密码测试"\n', '中文密码测试'],
  ['含制表符', 'password = "with\\ttab"\n', 'with\ttab'],
  ['转义的反斜杠', 'password = "esc\\\\aped"\n', 'esc\\aped'],
  ['转义的双引号', 'password = "quo\\"ted"\n', 'quo"ted']
]
for (const [name, src, want] of cases) {
  check(name, tomlStringValue(src, 'password'), want)
}

// 多行字符串（值里有换行时 toml 的写法）。
// 期望值取自标准解析器（见 ds-free-api/examples/toml_strfmt_probe.rs 的对照输出）：
// TOML 规定开定界符后紧跟的那个换行会被裁掉，所以是 "line1\nline2\n" 而不是
// "\nline1\nline2\n"。
const multiline = 'password = """\nline1\nline2\n"""\n'
check('多行基本字符串', tomlStringValue(multiline, 'password'), 'line1\nline2\n')
const multilineLit = "password = '''\nraw\n'''\n"
check('多行字面量字符串', tomlStringValue(multilineLit, 'password'), 'raw\n')
// 多行基本字符串里的转义同样要还原
const multilineEsc = 'password = """\nhas\\ttab\n"""\n'
check('多行基本字符串中的转义', tomlStringValue(multilineEsc, 'password'), 'has\ttab\n')

// 后端真实形态的完整片段（[[accounts]] 在文件开头，含 device_id/smid）
const real = `[[accounts]]
email = "someone@example.com"
mobile = ""
area_code = ""
password = 'has"quote'
device_id = "BUw7leNjQOG9aMIczAVSNccTQaQLLKtuSWDE6kxamFBfY/Mwhgp+KRO8enxC3SGogjEX627FDMK0bFzy7dZuCTA=="
smid = "20260922215533437339c5eddfee26e90ece715a0560d8007428466bedd5c40"

[server]
host = "127.0.0.1"
port = 22217

[[api_keys]]
key = "testkey123"
description = "test"
`
const secs = accountSections(real)
check('段数', secs.length, 1)
check('账号 id', accountIdFromSection(secs[0]).id, 'someone@example.com')
check('段内密码', tomlStringValue(secs[0], 'password'), 'has"quote')
check('不会跨段读到 api key', tomlStringValue(secs[0], 'key'), '')
check('api key 段', tomlStringValue(real.split('[[api_keys]]')[1], 'key'), 'testkey123')

// 手机号账号
const phone = `[[accounts]]
email = ""
mobile = "13800138000"
area_code = "+86"
password = "pw"
`
const ps = accountSections(phone)
check('手机号账号 id', accountIdFromSection(ps[0]).id, '13800138000')

// 空账号（未登录）：有段但没标识、没密码 → 视为未配置
const empty = `[[accounts]]
email = ""
mobile = ""
area_code = "+86"
password = ""
`
const es = accountSections(empty)
check('空账号无 id', accountIdFromSection(es[0]).id, '')
check('空账号无密码', tomlStringValue(es[0], 'password'), '')

console.log(fail ? ('\n' + fail + ' 个用例失败') : '\n全部通过')
process.exit(fail ? 1 : 0)
