// store.js 的纯函数部分（无 native 桥依赖），独立成模块以便在 Node 里做回归测试
// （scripts/test-store-schema.mjs）。store.js 引用并转发，保持对外 API 不变。
//
// 消息/会话的落盘结构约定见 store.js 顶部注释。

let seq = 0
export function uid(prefix = 'id') {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

// 兼容旧会话：补全 mode / thinking / search 等字段，避免旧数据因字段缺失导致开关失效。
export function normalizeConversation(c) {
  return Object.assign({
    mode: 'fast',
    thinking: true,
    search: false
  }, c || {})
}

// 落盘前剥掉图片的 base64（dataUrl）：它有几 MB 之巨（单图上限 900KB + base64 膨胀），
// 存进会话文件后每次发消息都要重新序列化整个历史、写文件、再由后端 JSON 解析一遍，
// 是弱内存设备上"发一条消息就卡死/重启"的主要压力来源。
// 只保留 path，真正要发的时候由 ds.buildMessages 按 path 重新压缩读取（compressImage
// 已按路径缓存，重复请求不会重复跑 ffmpeg）。
export function stripImagePayloads(list) {
  if (!Array.isArray(list)) return list
  return list.map((m) => {
    if (!m || !Array.isArray(m.images) || m.images.length === 0) return m
    const copy = Object.assign({}, m)
    const clean = (imgs) => imgs.map((i) => ({ name: i.name, path: i.path, dataUrl: null }))
    copy.images = clean(copy.images)
    if (Array.isArray(copy.revisions)) {
      copy.revisions = copy.revisions.map((r) => (r && Array.isArray(r.images))
        ? Object.assign({}, r, { images: clean(r.images) })
        : r)
    }
    return copy
  })
}

// 兼容旧数据：给用户消息补 revisions，给助手消息补 attempts。
// 新版「重试 / 修改」不再覆盖旧内容，而是把每次结果作为版本保存在同一气泡里。
export function normalizeMessages(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const m of list) {
    const msg = Object.assign({}, m)
    if (msg.role === 'user') {
      if (!Array.isArray(msg.revisions) || msg.revisions.length === 0) {
        msg.revisions = [{
          content: msg.content || '',
          images: msg.images || [],
          createdAt: msg.createdAt
        }]
      }
      if (typeof msg.activeRevision !== 'number' || !msg.revisions[msg.activeRevision]) {
        msg.activeRevision = msg.revisions.length - 1
      }
      const rev = msg.revisions[msg.activeRevision]
      msg.content = rev.content || ''
      msg.images = rev.images || []
    } else if (msg.role === 'assistant') {
      if (!Array.isArray(msg.attempts) || msg.attempts.length === 0) {
        msg.attempts = [{
          id: msg.id,
          content: msg.content || '',
          reasoning: msg.reasoning || '',
          error: msg.error || '',
          pending: !!msg.pending,
          createdAt: msg.createdAt
        }]
      }
      if (typeof msg.activeAttempt !== 'number' || !msg.attempts[msg.activeAttempt]) {
        msg.activeAttempt = msg.attempts.length - 1
      }
      const att = msg.attempts[msg.activeAttempt]
      if (att) {
        msg.content = att.content || ''
        msg.reasoning = att.reasoning || ''
        msg.error = att.error || ''
        // errorCode 以当前版本为准：它决定「重试」是按下去还是被拦。
        // 重启后读回旧值时，本该拦住的限流重试会被放行，正好是要避免的动作（bug 1）
        msg.errorCode = att.errorCode || ''
        msg.pending = !!att.pending
        // 兜底：从磁盘读回时还挂着 pending=true，说明上一次流式没有走到终态
        // （进程被杀、流中切换会话导致终态没落盘）。旧版原样恢复，表现为气泡
        // 永远卡在「正在思考…」、重试按钮永不出现、内容也被 buildMessages 跳过。
        // 流式进行中不受影响：index 页在 sending 时不会重载消息。
        if (msg.pending) {
          msg.pending = false
          att.pending = false
          if (!att.error && !msg.error) {
            att.error = msg.error = '生成中断，请重试'
          }
        }
      }
    }
    out.push(msg)
  }
  return out
}

// 账号显示名脱敏（登录页用）
export function maskAccountId(id) {
  const v = String(id || '')
  const at = v.indexOf('@')
  if (at > 0) {
    const name = v.slice(0, at)
    return name.slice(0, 2) + '***' + v.slice(at)
  }
  if (v.length >= 7) return v.slice(0, 3) + '****' + v.slice(-4)
  return v
}
