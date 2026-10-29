// 构建信息：BUILD_NUM 由 scripts/build-wrapper.js 在每次构建时自动 +1（#17）。
// 手动编辑本文件即可校准版本号。提交到 git，保证不同克隆的构建序号连续。
// APP_VERSION 是构建期融合的单个字面量，不要改回运行时拼接：发布后台
// 靠扫描包内 "<version> build <N>" 字面量自动识别构建号。
export const BUILD_NUM = 201
export const BUILD_AT = '2026-10-29 08:56:43'
export const APP_VERSION = '0.2.0 build 201'
