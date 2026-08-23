/**
 * storage 模块浏览器 mock：应用级 KV 存储的内存实现。
 * 机制见 api-mock/langningchen.js 头注释。
 */

const _kv = new Map()

export default {
  async getStorage(key) {
    if (!_kv.has(key)) {
      throw new Error(`[mock] storage.getStorage: key 不存在 ${key}`)
    }
    return _kv.get(key)
  },
  async setStorage(key, value) {
    _kv.set(key, String(value))
    return 0
  },
  async getStorageKeys() {
    return [..._kv.keys()]
  },
  async removeStorage(key) {
    _kv.delete(key)
    return 0
  },
  async clearStorage() {
    _kv.clear()
    return 0
  }
}
