/**
 * global 模块浏览器 mock：提供 Global 类（execShell 等）。
 * 机制同 api-mock/langningchen.js 头注释；设备构建走真实原生模块。
 */

class Global {
  execShell(cmd) {
    console.log('[mock] Global.execShell(' + cmd + ')')
    return true
  }
  startTextEdit(inputType) {
    console.log('[mock] Global.startTextEdit(' + inputType + ')')
    return 'mock-uuid-00000000000000000000000000000000'
  }
  isAsrLocalEnabled() {
    console.log('[mock] Global.isAsrLocalEnabled() -> false')
    return false
  }
  closeTextEdit() {
    console.log('[mock] Global.closeTextEdit()')
  }
}

export default {
  Global
}
