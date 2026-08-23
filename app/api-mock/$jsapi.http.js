/**
 * $jsapi/http 浏览器 mock。
 *
 * 机制同 $jsapi.storage.js：web/simulator 构建时注册为虚拟模块 $jsapi/http，
 * 用浏览器 fetch 兜底；设备构建走真实 jsapi。
 */

export default {
  request({ url, method = 'GET', headers = {}, data, timeout = 10000 }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const options = {
      method,
      headers,
      signal: controller.signal
    }
    if (data !== undefined) {
      options.body = typeof data === 'string' ? data : JSON.stringify(data)
      if (!headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json'
      }
    }
    return fetch(url, options).then(async (resp) => {
      clearTimeout(timer)
      const text = await resp.text()
      let parsed = text
      try { parsed = JSON.parse(text) } catch (e) { /* 保持文本 */ }
      return { statusCode: resp.status, headers: {}, data: parsed }
    }).catch((err) => {
      clearTimeout(timer)
      return { statusCode: 0, headers: {}, data: null, error: String(err) }
    })
  }
}
