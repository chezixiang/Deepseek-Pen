/**
 * am 模块浏览器 mock：应用栈管理。
 * 机制见 api-mock/langningchen.js 头注释。
 */

const _listeners = { topApp: [], windowAttachState: [] }

export default {
  getTopApp() {
    return (typeof $appid !== 'undefined' && $appid) || '8000000000000000'
  },
  moveToBack(appId) {
    console.log(`[mock] am.moveToBack(${appId || '本应用'})`)
  },
  hide(appId) {
    console.log(`[mock] am.hide(${appId || '本应用'})`)
  },
  closeApp(appId, forceFinish) {
    console.log(`[mock] am.closeApp(${appId || '本应用'}, ${forceFinish})`)
  },
  hasWindowFocus() { return true },
  isAttachedToWindow() { return true },
  on(event, callback) {
    if (_listeners[event]) _listeners[event].push(callback)
  }
}
