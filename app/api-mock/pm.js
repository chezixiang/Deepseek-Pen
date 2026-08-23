/**
 * pm 模块浏览器 mock：包管理（内存应用表）。
 * 机制见 api-mock/langningchen.js 头注释。
 */

const _packages = new Map()

export default {
  SUCCESS: 0,
  installPackage(path, callback) {
    console.log(`[mock] pm.installPackage(${path})`)
    const appid = `800${String(Date.now()).slice(-13)}`
    _packages.set(appid, {
      appid, name: `app-${appid.slice(-4)}`, version: '1.0.0', icon: '',
      installPath: `/etc/miniapp/data/mini_app/pkgs/${appid}/a/`, flag: 1
    })
    if (callback) callback({ res: 0 })
  },
  removePackage(appId, callback) {
    console.log(`[mock] pm.removePackage(${appId})`)
    _packages.delete(appId)
    if (callback) callback({ res: 0 })
  },
  getPackageInfo(appId) {
    return _packages.get(appId) || null
  },
  getInstalledPackages() {
    return [..._packages.values()]
  },
  on(event, callback) {
    console.log(`[mock] pm.on(${event}) 已注册`)
    return `${event}_${Date.now()}`
  },
  off(token) {
    console.log(`[mock] pm.off(${token})`)
  }
}
