// ds.js 的纯文本/解析函数（无 native 桥、无网络依赖），独立成模块以便在 Node 里
// 做回归测试（scripts/test-ds-text.mjs）。ds.js 引用这些实现，行为不变。
//
// parseSse 喂着每一条流式消息：CRLF、跨 chunk 撕裂的事件、多行 data: 的拼接
// 都在这里，是历史上最容易出"消息丢字/重复"的地方。

// 把用户填写的服务地址拼成完整接口 URL。
//
// 用户填的地址两种写法都常见：`http://host:22217` 和 `http://host:22217/v1`
// （设置页默认值本身就带 /v1）。旧代码无条件再拼一个 `/v1/...`，
// 结果是 `…/v1/v1/chat/completions` → 404，并被错报成"接口不存在，请检查服务地址"。
// 这里检测尾部是否已有 /v1 再决定是否补。
export function apiUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const suffix = String(path || '').replace(/^\/+/, '')
  const root = /\/v1$/.test(base) ? base : base + '/v1'
  return root + '/' + suffix
}

// 水平空白折叠只作用于围栏（``` / ~~~）外的行：围栏内的缩进是代码语义，
// 全局折叠曾把代码块缩进全部压掉——不仅显示错，内容还会写回消息持久化、
// 作为历史回传给模型（丢语义）。标签清洗仍对全文生效（防泄露优先）。
export function collapseOutsideFences(text) {
  const lines = String(text).split('\n')
  let inFence = false
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence
      out.push(line)
      continue
    }
    out.push(inFence ? line : line.replace(/[ \t]{2,}/g, ' '))
  }
  return out.join('\n')
}

// 移除模型回复中可能泄露的内部协议标签，防止发给 DeepSeek 官方 API 或展示给用户导致封号。
// 注意：标签替换为空串；空白折叠只发生在围栏外——
// 旧版全局折叠既会吞掉换行（#14），也会毁掉代码缩进。
export function stripInternalTags(text) {
  if (!text) return text
  return collapseOutsideFences(
    String(text)
      .replace(/<\|tool_calls_begin\|>/gi, '')
      .replace(/<\|tool_calls_end\|>/gi, '')
      .replace(/<\|tool_call_begin\|>/gi, '')
      .replace(/<\|tool_call_end\|>/gi, '')
      .replace(/<\|begin_of_function\|>/gi, '')
      .replace(/<\|end_of_function\|>/gi, '')
      .replace(/<\|tool▁calls▁begin\|>/gi, '')
      .replace(/<\|tool▁calls▁end\|>/gi, '')
      .replace(/<\|tool▁call▁begin\|>/gi, '')
      .replace(/<\|tool▁call▁end\|>/gi, '')
      .replace(/<\|[^|]{1,40}\|>/g, '')
      .replace(/<invoke>/gi, '')
      .replace(/<\/invoke>/gi, '')
      .replace(/<parameter>/gi, '')
      .replace(/<\/parameter>/gi, '')
      .replace(/<\/tool_call>/gi, '')
  )
}

// 解析 SSE 文本流：按空行切分完整事件，返回已完成事件列表和剩余未完成 buffer。
// buffer 语义：上次未凑齐完整事件（缺空行结尾）的残段，调用方必须原样带回下次拼接。
export function parseSse(buffer) {
  const events = []
  let rest = String(buffer || '').replace(/\r\n/g, '\n')
  let idx
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const part = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const dataLines = []
    const lines = part.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.indexOf('data:') === 0) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'))
    }
  }
  return { events, rest }
}
