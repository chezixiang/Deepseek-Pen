#!/bin/bash
# 修补 aiot-vue-cli 使其兼容新版 @vue/compiler-sfc。
# 内容来自 miniapp 官方 CI（.github/workflows/*.yml）验证过的 sed 命令，
# 在 npm install 的 postinstall 钩子中自动执行。
#
# 若本脚本失败（比如 node_modules 布局变化），请对照官方 CI 手动执行。
set -e

CLI_DIR="$(dirname "$0")/../node_modules/aiot-vue-cli"

if [ ! -d "$CLI_DIR" ]; then
  echo "[patch-cli] 未找到 $CLI_DIR，跳过（可能尚未安装依赖）" >&2
  exit 0
fi

# 逐个 sed 替换，均幂等（替换目标不存在时 sed 无副作用即返回 0）。
# 每条先检查目标文件存在：aiot-vue-cli 是 ^1.0.32 的浮动版本，上游布局一变
# （文件改名/移动），set -e 会让整个 npm ci/postinstall 挂掉且报错难懂；
# 跳过 + 显式提示比硬失败更好排查。
patch_file() {
  local file="$1"; shift
  if [ ! -f "$file" ]; then
    echo "[patch-cli] 跳过不存在的文件: $file（CLI 布局可能已变化，请核对补丁）" >&2
    return 0
  fi
  sed -i "$@" "$file"
}

patch_file "$CLI_DIR/src/libs/rollup.config.js" \
  "s/commonjs(),/commonjs(),require('@rollup\/plugin-typescript')(),/g"
patch_file "$CLI_DIR/web-loaders/falcon-vue-loader/lib/parser.js" \
  "s/compiler.parseComponent(content, { pad: 'line' })/compiler.parse(content, { pad: 'line' }).descriptor/g"
patch_file "$CLI_DIR/cli-libs/index.js" \
  "s/path.resolve(__dirname, '.\/vue\/packages\/vue-template-compiler\/index.js')/'@vue\/compiler-sfc'/g"
patch_file "$CLI_DIR/src/libs/parser.js" \
  "s/compiler.parseComponent(content, { pad: true })/compiler.parse(content, { pad: true }).descriptor/g"
patch_file "$CLI_DIR/web-loaders/falcon-vue-loader/lib/template-compiler/index.js" \
  "s/compiler.compile/compiler.compileTemplate/g"
patch_file "$CLI_DIR/src/libs/rollup.config.js" \
  "s/const replaceValues = {}/const replaceValues = { 'defineComponent': '' }/g"

# CI 中额外用于规避依赖跟踪报错的 CMake 补丁（仅编译原生模块时需要，见文档 §2.5）
# sed -i '/project(/a\set(CMAKE_DEPEND_INFO_SKIP 1)\nset(CMAKE_LINK_DEPENDS_USE_LINKER 0)' ./jsapi/CMakeLists.txt

echo "[patch-cli] aiot-vue-cli 补丁应用完成"
