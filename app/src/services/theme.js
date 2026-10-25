// 首帧主题预读：app 启动时 $falcon.__dsTheme 由各页面在挂载前写入，
// 用于避免深色模式下先渲染浅色再切换的闪烁。
export function peekBootTheme() {
  try {
    return ($falcon && $falcon.__dsTheme) || 'light'
  } catch (e) {
    return 'light'
  }
}
