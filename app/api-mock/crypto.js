/**
 * crypto 模块浏览器 mock：md5 简单实现（演示用，非安全场景）。
 * 机制见 api-mock/langningchen.js 头注释。
 */

function md5(input) {
  // 简化实现：FNV 变体散列生成 32 位十六进制近似值（仅保证 mock 流程可用）
  let h1 = 0x811c9dc5, h2 = 0xc9dc5118
  const s = String(input)
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0
    h1 = (h1 * 0x01000193) >>> 0
    h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0
  }
  const hex = (n) => n.toString(16).padStart(8, '0')
  return hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0)
}

class MockHash {
  constructor(method) {
    if (method !== 'md5') {
      throw new Error(`[mock] crypto.Hash: 暂只支持 md5，收到 ${method}`)
    }
    this._method = method
  }
  async hashFile(path) {
    console.log(`[mock] crypto.Hash(${this._method}).hashFile(${path})`)
    return md5(`file:${path}`)
  }
}

export default {
  Hash: MockHash
}
