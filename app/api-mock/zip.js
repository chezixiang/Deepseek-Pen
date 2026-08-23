/**
 * zip 模块浏览器 mock：extractall 空实现。
 * 机制见 api-mock/langningchen.js 头注释。
 */

class MockZipFile {
  constructor(path) {
    this._path = path
  }
  async extractall(outPath) {
    console.log(`[mock] zip.ZipFile(${this._path}).extractall(${outPath})`)
    return 0
  }
}

export default {
  ZipFile: MockZipFile
}
