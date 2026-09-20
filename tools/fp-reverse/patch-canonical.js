#!/usr/bin/env node
// 在 fp.min.js 中插桩 canonical 序列化函数并暴露，然后跑 harness 流程
const fs = require('fs');
const src = process.argv[2] || 'fp.min.js';
let code = fs.readFileSync(src, 'utf8');

const target = "_0x99acee['ip']=_0x453428('pceqy3rl',_0x22bd14(_0x99acee))";
const patched = "globalThis.__canonicalStr=_0x22bd14(_0x99acee),globalThis.__canonicalFn=_0x22bd14,_0x99acee['ip']=_0x453428('pceqy3rl',_0x22bd14(_0x99acee))";
if (!code.includes(target)) {
  console.error('PATCH FAILED: ip 赋值点未找到（SDK 结构变化？）');
  process.exit(1);
}
code = code.replace(target, patched);
// 捕获最外层 join 的拼接串（canonical 的 md5 输入）
const joinTarget = "_0x3251b6['join']('');}return _0x282e7f?_0x282e7f['toString']";
if (code.includes(joinTarget)) {
  code = code.replace(joinTarget, "globalThis.__canonicalConcat=_0x3251b6['join']('');}return _0x282e7f?_0x282e7f['toString']");
  console.log('concat capture: ok');
} else {
  console.log('concat capture: join site not found');
}
// 同样暴露主 AES 明文/密钥
code = code.replace(
  "_0x54fe30['AES']['encrypt'](_0x527184,_0x55d7b3,",
  "globalThis.__lastPlain=(typeof _0x527184==='string'?_0x527184:String(_0x527184)),_0x54fe30['AES']['encrypt'](_0x527184,_0x55d7b3,"
);
fs.writeFileSync('fp-canonical-patched.js', code);
console.log('fp-canonical-patched.js written');
