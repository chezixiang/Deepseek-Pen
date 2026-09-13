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
const minify = arg === 'prod';
const qjsc = arg === 'prod';

async function main() {
  // 必须先初始化 appInfo，否则 getFalconBuildDir 会抛异常
  await appInfo.init('.');

  // #17 版本号随编译自动递增：src/services/build-info.js 的 BUILD_NUM +1
  try {
    const infoPath = path.resolve(__dirname, '..', 'src', 'services', 'build-info.js');
    const infoSrc = fs.readFileSync(infoPath, 'utf8');
    const m = infoSrc.match(/BUILD_NUM\s*=\s*(\d+)/);
    const next = (m ? parseInt(m[1], 10) : 0) + 1;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.writeFileSync(
      infoPath,
      '// 构建信息：BUILD_NUM 由 scripts/build-wrapper.js 在每次构建时自动 +1（#17）。\n' +
      '// 手动编辑本文件即可校准版本号。提交到 git，保证不同克隆的构建序号连续。\n' +
      'export const BUILD_NUM = ' + next + '\n' +
      'export const BUILD_AT = \'' + stamp + '\'\n'
    );
    console.log('[build-wrapper] 版本号递增 => build ' + next + '（' + stamp + '）');
  } catch (e) {
    console.error('[build-wrapper] 版本号递增失败（不影响构建继续）: ' + e.message);
  }

  // 自动生成 backend-blob.js，避免打包进旧的 musl 二进制
  console.log('[build-wrapper] 自动生成 backend-blob.js...');
  try {
    execSync('node scripts/inline-backend.js', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    console.log('[build-wrapper] backend-blob.js 生成完成');
  } catch (e) {
    console.error('[build-wrapper] backend-blob.js 生成失败，请先确保 backend/ 目录下有对应二进制');
    process.exit(1);
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

  // 4. 不再复制 backend/ 目录（二进制已转 base64 内嵌在 backend-blob.js 中）

  // 5. Generate manifest
  console.log('[build-wrapper] 生成 manifest...')
  await manifest.generate();
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