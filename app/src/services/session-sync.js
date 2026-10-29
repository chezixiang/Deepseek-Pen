import { deleteRemoteSession, ensureUpstreamAuth, fetchRemoteSession, listRemoteSessions, purgeRemoteSessions, pushSession, upstreamBase } from './cloud-control.js'
import { appLog, appLogError, normalizeMessages, uid$1 as uid } from './store.js'

// 会话云同步（上游模式）。

// 每个会话一个防抖定时器：连续修改（重试、修改消息）只上传最后一次。
const timers = {};
const PUSH_DELAY_MS = 1200;

async function authCtx(settings, persist) {
  if (!settings || !settings.upstreamMode) return null
  const auth = await ensureUpstreamAuth({ settings, persist });
  if (!auth) return null
  return { baseUrl: upstreamBase(settings), auth }
}

/**
 * 排队推送一条会话（覆盖式快照）。
 * @param {Object} p { settings, conversation, messages, persist }
 */
function queueSessionPush({ settings, conversation, messages, persist }) {
  const s = settings || {};
  const conv = conversation || {};
  if (!s.upstreamMode || !conv.id) return
  const key = String(conv.id);
  if (timers[key]) clearTimeout(timers[key]);
  const snapshot = Array.isArray(messages) ? messages.slice() : [];
  timers[key] = setTimeout(() => {
    delete timers[key];
    pushNow({ settings: s, conversation: conv, messages: snapshot, persist });
  }, PUSH_DELAY_MS);
  if (timers[key].unref) timers[key].unref();
}

// 立即推送（删除前/退出时可调用；正常路径走 queueSessionPush）
async function pushNow({ settings, conversation, messages, persist }) {
  const ctx = await authCtx(settings, persist);
  if (!ctx) {
    appLogError('sync.auth', new Error('设备未注册或网络不可用，会话未上传'), 'conv=' + (conversation && conversation.id));
    return { ok: false, reason: 'no_auth' }
  }
  try {
    const r = await pushSession({
      baseUrl: ctx.baseUrl,
      auth: ctx.auth,
      conversation,
      messages
    });
    conversation.remoteSyncedAt = Date.now();
    return { ok: true, result: r }
  } catch (e) {
    appLogError('sync.push', e, 'conv=' + (conversation && conversation.id));
    return { ok: false, message: e && e.message ? e.message : String(e) }
  }
}

// 删除云端会话（本地已删完再调；失败只记录）
async function syncDelete({ settings, conversation, persist }) {
  const conv = conversation || {};
  if (!settings || !settings.upstreamMode || !conv.id) return { ok: true, skipped: true }
  const ctx = await authCtx(settings, persist);
  if (!ctx) {
    appLogError('sync.auth', new Error('设备未注册或网络不可用，云端会话未删除'), 'conv=' + (conv.id || conv.cloudId));
    return { ok: false, reason: 'no_auth' }
  }
  try {
    await deleteRemoteSession({ baseUrl: ctx.baseUrl, auth: ctx.auth, sessionId: conv.cloudId || conv.id });
    appLog('[sync] 已删除云端会话 ' + (conv.cloudId || conv.id));
    return { ok: true }
  } catch (e) {
    appLogError('sync.delete', e, 'conv=' + conv.id);
    return { ok: false, message: e && e.message ? e.message : String(e) }
  }
}

// 清空全部云端会话（设置页「清空全部对话」）
async function syncPurgeAll({ settings, persist }) {
  if (!settings || !settings.upstreamMode) return { ok: true, skipped: true }
  const ctx = await authCtx(settings, persist);
  if (!ctx) {
    appLogError('sync.auth', new Error('设备未注册或网络不可用，云端会话未清空'));
    return { ok: false, reason: 'no_auth' }
  }
  try {
    const r = await purgeRemoteSessions({ baseUrl: ctx.baseUrl, auth: ctx.auth });
    appLog('[sync] 已清空云端会话 ' + (r && r.deleted ? r.deleted : 0) + ' 条');
    return { ok: true, deleted: (r && r.deleted) || 0 }
  } catch (e) {
    appLogError('sync.purge', e);
    return { ok: false, message: e && e.message ? e.message : String(e) }
  }
}

function remoteToMessages(list) {
  const out = [];
  let seq = 0;
  const now = Date.now();
  const mapImages = (imgs) => (Array.isArray(imgs) ? imgs : [])
    .filter((i) => i && i.path)
    .map((i) => ({ name: i.name || '', path: i.path }));
  for (const m of list || []) {
    if (!m || !m.role) continue
    if (m.role === 'user') {
      const mapFiles = (fs) => (Array.isArray(fs) ? fs : [])
        .filter((f) => f && f.path)
        .map((f) => ({ name: f.name || '', path: f.path, size: Number(f.size) || 0, mime: f.mime || '' }));
      const revisions = Array.isArray(m.revisions) && m.revisions.length
        ? m.revisions.map((r) => ({
          content: r.content || '',
          images: mapImages(r.images),
          files: mapFiles(r.files),
          createdAt: Number(r.createdAt) || now
        }))
        : null;
      out.push({
        id: String(m.id || uid('u')),
        role: 'user',
        content: m.content || '',
        images: mapImages(m.images),
        files: mapFiles(m.files),
        createdAt: Number(m.createdAt) || (now + seq++),
        revisions: revisions || undefined,
        activeRevision: typeof m.activeRevision === 'number' ? m.activeRevision : undefined
      });
    } else {
      const attempts = Array.isArray(m.attempts) && m.attempts.length
        ? m.attempts.map((a) => ({
          id: uid('a'),
          content: a.content || '',
          reasoning: a.reasoning || '',
          error: a.error || '',
          pending: false,
          createdAt: Number(a.createdAt) || now
        }))
        : null;
      out.push({
        id: String(m.id || uid('a')),
        role: 'assistant',
        content: m.content || '',
        reasoning: m.reasoning || '',
        error: m.error || '',
        pending: false,
        createdAt: Number(m.createdAt) || (now + seq++),
        attempts: attempts || undefined,
        activeAttempt: typeof m.activeAttempt === 'number' ? m.activeAttempt : undefined
      });
    }
  }
  return normalizeMessages(out)
}

function remoteToConversation(remote) {
  return {
    // 直接用远端 id 作为本地 id：下次推送仍是同一条，不会产生第二份备份
    id: String(remote.id),
    title: String(remote.title || '新对话').slice(0, 30),
    mode: remote.mode || 'fast',
    thinking: remote.thinking !== false,
    search: remote.search === true,
    createdAt: Number(remote.createdAt) || Date.now(),
    updatedAt: Number(remote.updatedAt) || Date.now(),
    cloudId: String(remote.id),
    cloudLoaded: true,
    remoteSyncedAt: Date.now()
  }
}

/**
 * 拉取本地缺失的会话（重装/换机恢复，或设置页手动恢复）。
 * @param {Object} p { settings, existingIds, max, persist }
 * @returns {Promise<Array<{conversation, messages}>>}
 */
async function pullMissing({ settings, existingIds = [], max = 20, persist } = {}) {
  const ctx = await authCtx(settings, persist);
  if (!ctx) return []
  let list = [];
  try {
    list = await listRemoteSessions({ baseUrl: ctx.baseUrl, auth: ctx.auth });
  } catch (e) {
    appLogError('sync.list', e);
    return []
  }
  const have = {};
  for (const id of existingIds) have[String(id)] = true;
  const todo = list
    .filter((s) => s && s.id && !have[String(s.id)] && (Number(s.messageCount) || 0) > 0)
    .slice(0, Math.max(1, Number(max) || 20));

  const out = [];
  for (const s of todo) {
    try {
      const detail = await fetchRemoteSession({ baseUrl: ctx.baseUrl, auth: ctx.auth, sessionId: s.id });
      out.push({
        conversation: remoteToConversation(detail),
        messages: remoteToMessages(detail.messages)
      });
    } catch (e) {
      appLogError('sync.fetch', e, 'session=' + s.id);
    }
  }
  if (out.length) appLog('[sync] 已从云端恢复 ' + out.length + ' 条会话');
  return out
}


export { PUSH_DELAY_MS, authCtx, pullMissing, pushNow, queueSessionPush, remoteToConversation, remoteToMessages, syncDelete, syncPurgeAll, timers };
