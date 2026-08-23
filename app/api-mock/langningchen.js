/**
 * langningchen 原生模块的浏览器 mock（供 aiot-vue-cli web/simulator 构建使用）。
 *
 * 机制：aiot-vue-cli 会把 api-mock/*.js 注册为同名虚拟模块（见其 src/libs/common.js getMockApi），
 * 因此在 web/simulator 环境下 `import { AI } from 'langningchen'` 会命中本文件；
 * 设备构建（-p 打包）时 api-mock 不参与，import 交给 pluginFalconModule 由设备端 QuickJS 解析原生模块。
 *
 * 行为对齐 jsapi/src 下各模块的 C++ 实现签名，返回模拟数据便于纯前端开发调试。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- AI ----------
const _conversation = [
  {
    id: 'root', role: 0, content: '', parentId: '', childIds: ['m1'],
    timestamp: new Date().toISOString(), stopReason: 6
  },
  {
    id: 'm1', role: 0, content: '你好，请介绍一下你自己', parentId: 'root', childIds: ['m2'],
    timestamp: new Date().toISOString(), stopReason: 0
  },
  {
    id: 'm2', role: 1, content: '你好！我是词典笔上的 AI 助手，由 langningchen 原生模块驱动。', parentId: 'm1', childIds: [],
    timestamp: new Date().toISOString(), stopReason: 0
  }
]

export const AI = {
  initialize() {
    console.log('[mock] AI.initialize()')
  },
  getCurrentPath() {
    return _conversation.slice()
  },
  getChildNodes(nodeId) {
    const node = _conversation.find((n) => n.id === nodeId)
    return node ? node.childIds.slice() : []
  },
  switchToNode(nodeId) {
    console.log(`[mock] AI.switchToNode(${nodeId})`)
  },
  getCurrentNodeId() {
    return 'm2'
  },
  getRootNodeId() {
    return 'root'
  },
  getCurrentConversationId() {
    return 'conv-mock-001'
  },

  async addUserMessage(message) {
    console.log(`[mock] AI.addUserMessage(${message})`)
    _conversation.push({
      id: `u${Date.now()}`, role: 0, content: message, parentId: 'm2', childIds: [],
      timestamp: new Date().toISOString(), stopReason: 6
    })
  },
  async generateResponse() {
    // 模拟流式输出：通过 ai_stream 事件分段发布
    const chunks = ['这是', 'mock ', 'AI ', '的', '回复。']
    for (const chunk of chunks) {
      AI.on && AI._emitter && AI._emitter(chunk)
      await sleep(200)
    }
    _conversation.push({
      id: `a${Date.now()}`, role: 1, content: chunks.join(''), parentId: _conversation[_conversation.length - 1].id, childIds: [],
      timestamp: new Date().toISOString(), stopReason: 0
    })
    return chunks.join('')
  },
  stopGeneration() {
    console.log('[mock] AI.stopGeneration()')
  },
  async getModels() {
    return ['gpt-4o-mini', 'deepseek-chat', 'qwen-turbo']
  },
  async getUserBalance() {
    return 10
  },

  async getConversationList() {
    return [
      { id: 'conv-mock-001', title: '新对话', createdAt: '1710000000000', updatedAt: '1710000000000' }
    ]
  },
  async createConversation(title = '新对话') {
    console.log(`[mock] AI.createConversation(${title})`)
  },
  async loadConversation(conversationId) {
    console.log(`[mock] AI.loadConversation(${conversationId})`)
  },
  async deleteConversation(conversationId) {
    console.log(`[mock] AI.deleteConversation(${conversationId})`)
  },
  async updateConversationTitle(conversationId, title) {
    console.log(`[mock] AI.updateConversationTitle(${conversationId}, ${title})`)
  },

  setSettings(apiKey, baseUrl, modelName, maxTokens, temperature, topP, systemPrompt) {
    console.log('[mock] AI.setSettings()', { apiKey, baseUrl, modelName, maxTokens, temperature, topP, systemPrompt })
  },
  getSettings() {
    return {
      apiKey: 'sk-mock', baseUrl: 'https://api.example.com/v1', modelName: 'gpt-4o-mini',
      maxTokens: 2048, temperature: 0.7, topP: 1, systemPrompt: '你是一个乐于助人的助手。'
    }
  },

  _emitter: null,
  on(event, callback) {
    if (event === 'ai_stream') {
      this._emitter = callback
    }
  }
}

// ---------- IME ----------
const _candidates = [
  { pinyin: ['ni', 'hao'], hanZi: '你好', freq: 100 },
  { pinyin: ['ni', 'hao'], hanZi: '尼豪', freq: 10 },
  { pinyin: ['ni', 'hao'], hanZi: '你嚎', freq: 5 }
]

export const IME = {
  async initialize() {
    console.log('[mock] IME.initialize()')
  },
  getCandidates(rawPinyin) {
    console.log(`[mock] IME.getCandidates(${rawPinyin})`)
    if (!rawPinyin) return []
    return _candidates.slice()
  },
  updateWordFrequency(pinyin, hanZi) {
    console.log(`[mock] IME.updateWordFrequency(${pinyin.join('')}, ${hanZi})`)
  },
  splitPinyin(rawPinyin) {
    // 简单按字符切分，真实实现按声母韵母表切分
    return rawPinyin.split(/(?<=[aeiou])/).filter(Boolean)
  }
}

// ---------- ScanInput ----------
export const ScanInput = {
  async initialize() {
    console.log('[mock] ScanInput.initialize()')
  },
  async deinitialize() {
    console.log('[mock] ScanInput.deinitialize()')
  },
  on(event, callback) {
    if (event === 'scan_input') {
      console.log('[mock] ScanInput.on(scan_input) 已注册（浏览器中不会真实触发）')
      this._callback = callback
    }
  },
  // 调试辅助：模拟扫描输入
  _simulate(text) {
    if (this._callback) this._callback(text)
  }
}

// ---------- Shell ----------
export const Shell = {
  initialize() {
    console.log('[mock] Shell.initialize()')
  },
  async exec(cmd) {
    console.log(`[mock] Shell.exec(${cmd})`)
    if (cmd.trim() === 'pwd') return '/userdisk\n'
    if (cmd.trim().startsWith('echo')) return cmd.slice(5).trim() + '\n'
    return '[mock] 浏览器环境不执行真实命令，请安装到词典笔后使用。\n'
  }
}

// ---------- Update ----------
const _config = {
  owner: 'octocat', repo: 'Hello-World', downloadPath: '/userdisk/downloads',
  currentVersion: '1.0.0', filterPattern: '.*\\.(tar\\.gz|zip|apk|bin)$'
}

export const Update = {
  setRepo(config) {
    Object.assign(_config, config)
    console.log('[mock] Update.setRepo()', _config)
  },
  async check() {
    return { success: true, hasUpdate: false, currentVersion: _config.currentVersion, latestVersion: _config.currentVersion }
  },
  async download() {
    return { success: false, error: '浏览器环境不可下载，请安装到词典笔后使用' }
  },
  async getConfig() {
    return { ..._config }
  },
  cleanup(maxAgeDays = 7) {
    return { success: true, deleted: 0, errors: 0 }
  }
}
