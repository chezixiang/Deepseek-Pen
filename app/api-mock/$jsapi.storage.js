/**
 * $jsapi/storage 浏览器 mock。
 *
 * 机制：aiot-vue-cli 将 api-mock/$jsapi.storage.js 注册为虚拟模块 $jsapi/storage
 * （文件名开头的 "$jsapi." 会被替换为 "$jsapi/"），供 falcon-ui 框架内部或
 * 自行 import '$jsapi/storage' 时在 web/simulator 构建中使用。
 * 设备构建不生效，走运行时真实 jsapi。
 */

const _store = new Map()

export default {
  setStorage({ key, data }) {
    _store.set(key, String(data))
    return Promise.resolve({})
  },
  getStorage({ key }) {
    return Promise.resolve({ data: _store.has(key) ? _store.get(key) : '' })
  },
  getStorageInfo() {
    return Promise.resolve({ keys: [..._store.keys()], currentSize: 0, limitSize: 1024 * 1024 })
  }
}
