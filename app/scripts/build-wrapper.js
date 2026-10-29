#!/usr/bin/env node
const { execSync } = require('child_process');
const build = require('../node_modules/aiot-vue-cli/src/steps/build');
const qjscAll = require('../node_modules/aiot-vue-cli/src/steps/qjsc');
const manifest = require('../node_modules/aiot-vue-cli/src/steps/manifest');
const pack = require('../node_modules/aiot-vue-cli/src/steps/pack');
const share = require('../node_modules/aiot-vue-cli/src/libs/share');
const fs = require('fs');
const path = require('path');
const appInfo = require('../node_modules/aiot-vue-cli/src/libs/appinfo');

const arg = (process.argv[2] || '').toLowerCase();
// dev 构建目标（npm run build:dev）：不做 minify/qjsc 预编译，且跳过模板审计、
// 回归用例与 backend-blob 重新生成——迭代 UI 时的最快路径。
// 注意：dev 构建产物仍会用现有 backend-blob.js（不重新内嵌），后端改动后
// 需先跑一次 node scripts/inline-backend.js 或直接 npm run build。
const isDev = arg === 'dev';
const minify = arg === 'prod';
const qjsc = arg === 'prod';
let buildNum = 0;

async function main() {
  // 必须先初始化 appInfo，否则 getFalconBuildDir 会抛异常
  await appInfo.init('.');

  if (!isDev) {
    // 模板审计：<text> 带元素子节点会让 Falcon 的 Yoga 断言失败并 abort 整个框架进程
    // （真机表现为"一发消息就闪退、重进又闪退"，corefile 目录留有 dmp）。
    // 这类错误在构建期无法发现、只能上机才炸，所以在打包前静态拦一道。
    console.log('[build-wrapper] 模板审计（<text> 不得有元素子节点）...');
    try {
      execSync('node scripts/audit-text-nesting.js', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    } catch (e) {
      console.error('[build-wrapper] 模板审计未通过，已中止构建（见上方报告）');
      process.exit(1);
    }

    // 纯函数回归用例：LaTeX 显示层转换、config.toml 解析（后端写的字面量形态）。
    // 这两类问题都只在真机上暴露（公式显示成源码 / 已登录被读成未登录），
    // 且改动容易回归，所以每次打包前跑一遍。
    console.log('[build-wrapper] 回归用例（LaTeX / config.toml 解析）...');
    try {
      execSync('node scripts/test-latex.mjs', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
      execSync('node scripts/test-config-parse.mjs', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
      execSync('node scripts/test-ratelimit.mjs', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    } catch (e) {
      console.error('[build-wrapper] 回归用例未通过，已中止构建');
      process.exit(1);
    }
  }

  // #17 版本号随编译自动递增：src/services/build-info.js 的 BUILD_NUM +1
  try {
    const infoPath = path.resolve(__dirname, '..', 'src', 'services', 'build-info.js');
    const infoSrc = fs.readFileSync(infoPath, 'utf8');
    const m = infoSrc.match(/BUILD_NUM\s*=\s*(\d+)/);
    const next = (m ? parseInt(m[1], 10) : 0) + 1;
    buildNum = next;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // APP_VERSION 必须是构建期融合好的单个字符串字面量（"0.2.0 build 177"），
    // 绝不能在运行时拼接：发布后台（penai-upstream/src/amr.js）靠扫描 AMR 包内
    // JS/字节码文本里的 "<version> build <N>" 字面量自动识别构建号，而拼接形态
    // （'0.2.0 build ' + BUILD_NUM）在 dev/未常量折叠的产物里不生成可扫描的
    // 完整字面量，后台就会报「未能从包内提取构建号」。字符串字面量能穿过
    // minify 与 qjsc 字节码常量池，是唯一在所有产物形态下都存活的"标记"。
    const pkgForVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    const versionBase = String(pkgForVersion.version || '0.0.0');
    fs.writeFileSync(
      infoPath,
      '// 构建信息：BUILD_NUM 由 scripts/build-wrapper.js 在每次构建时自动 +1（#17）。\n' +
      '// 手动编辑本文件即可校准版本号。提交到 git，保证不同克隆的构建序号连续。\n' +
      '// APP_VERSION 是构建期融合的单个字面量，不要改回运行时拼接：发布后台\n' +
      '// 靠扫描包内 "<version> build <N>" 字面量自动识别构建号。\n' +
      'export const BUILD_NUM = ' + next + '\n' +
      'export const BUILD_AT = \'' + stamp + '\'\n' +
      'export const APP_VERSION = \'' + versionBase + ' build ' + next + '\'\n'
    );
    console.log('[build-wrapper] 版本号递增 => ' + versionBase + ' build ' + next + '（' + stamp + '）');
  } catch (e) {
    console.error('[build-wrapper] 版本号递增失败（不影响构建继续）: ' + e.message);
  }

  // 自动生成 backend-blob.js（dev 构建跳过：沿用现有 blob，省 6MB base64 处理）
  if (!isDev) {
    console.log('[build-wrapper] 自动生成 backend-blob.js...');
    try {
      execSync('node scripts/inline-backend.js', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
      console.log('[build-wrapper] backend-blob.js 生成完成');
    } catch (e) {
      console.error('[build-wrapper] backend-blob.js 生成失败，请先确保 backend/ 目录下有对应二进制');
      process.exit(1);
    }
  } else {
    console.log('[build-wrapper] dev 模式：沿用现有 backend-blob.js');
  }
  const falconDir = appInfo.getFalconBuildDir();
  fs.rmSync(falconDir, { recursive: true, force: true });
  fs.mkdirSync(falconDir, { recursive: true });

  // 2. Build
  await build({ minify, mock: false, env: [] });

  // 3. Optional qjsc
  if (qjsc) {
    console.log('[build-wrapper] 开始 qjsc 预编译...')
    await qjscAll(share.internalModules);
    console.log('[build-wrapper] qjsc 预编译完成')
  }

  // 4. 复制静态图标（src/assets/icons → .falcon_/icons）：
  //    manifest.generate 会 walk 整个打包目录自动登记 cert，无需额外注册。
  //    按钮禁用文字/emoji（设备字体缺字形渲染白块），一律用 PNG 图标。
  const iconsSrc = path.resolve(__dirname, '..', 'src', 'assets', 'icons');
  if (fs.existsSync(iconsSrc)) {
    const iconsDst = path.join(falconDir, 'icons');
    fs.mkdirSync(iconsDst, { recursive: true });
    for (const f of fs.readdirSync(iconsSrc)) {
      if (f.endsWith('.png')) fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsDst, f));
    }
    console.log('[build-wrapper] 图标复制完成 icons/');
  }

  // 5. 不再复制 backend/ 目录（二进制已转 base64 内嵌在 backend-blob.js 中）

  // 5. Generate manifest
  console.log('[build-wrapper] 生成 manifest...')
  await manifest.generate();
  // 发布管理器直接从 AMR 读取 build；显式写一份元数据，避免依赖压缩包里的
  // 版本字符串格式（minify/qjsc 变化不影响构建号提取）。
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'))
    fs.writeFileSync(path.join(falconDir, 'release.json'), JSON.stringify({
      appId: pkg.appid || '',
      appName: pkg.name || '',
      version: pkg.version || '',
      build: buildNum,
      builtAt: new Date().toISOString()
    }, null, 2) + '\n');
    console.log('[build-wrapper] release.json 已写入（build ' + buildNum + '）')
  } catch (e) {
    console.warn('[build-wrapper] 写 release.json 失败（服务器仍可从 JS 包提取）: ' + e.message)
  }
  console.log('[build-wrapper] manifest 生成完成')

  // 6. Pack
  console.log('[build-wrapper] 打包 AMR...')
  await pack.pack();
  console.log('[build-wrapper] AMR 打包完成');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});