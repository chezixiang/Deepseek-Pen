// 思考挡位规则（reasoning effort gears）。
//
// 需求：深度思考按钮多次点击循环挡位；可切换的挡位由当前模型决定；
// 没有命中规则的模型按 low/high/max 三档处理。挡位与默认值来自
// 2026-10 各官方模型的档位表（产品提供）。
//
// 规则设计（保持灵活性）：
//   - 正则对模型 ID 的小写形式做子串匹配，命中即返回（先命先生效）；
//   - 更具体的型号（gpt-6.1 / claude-*-5.5 / opus-4.8）必须排在宽泛
//     前缀（gpt-6-sol / claude-*-5）之前，避免被宽泛规则截胡；
//   - 连接符差异（gpt_6_sol / gpt6-sol）用 [.\-_ ]* 兜住；
//   - 未命中一律回落 fallback（low/high/max，默认 high），
//     新模型上线只需在 RULES 里加一行。

// 兜底档位：未命中规则的模型
const FALLBACK_LEVELS = ['low', 'high', 'max'];
const FALLBACK_DEFAULT = 'high';

const RULES = [
  // DeepSeek-Flash：low/high/max，默认 high
  { re: /deepseek[-_ ]?flash/, levels: ['low', 'high', 'max'], default: 'high' },

  // GPT-5.6 系列：none~max 全档；默认"视具体型号而定"→ 取中间档 medium
  { re: /gpt[-_ ]?5\.6/, levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },

  // GPT-6.1 Sol / GPT-6 Astra：low~max（无 none），默认 medium
  // 必须排在 GPT-6 Sol/Luna 之前：'gpt-6.1-sol' 含 "6" 但属 6.1 代
  { re: /gpt[-_ ]?6\.1|gpt[-_ ]?6[.\-_ ]*astra/, levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },

  // GPT-6 Sol / Luna：含 none，默认 medium
  { re: /gpt[-_ ]?6[.\-_ ]*(sol|luna)/, levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },

  // Claude 5.5 代（Opus/Sonnet/Haiku）：默认 medium
  // 必须排在 Claude 5.0 代之前：'claude-opus-5.5' 不能被 "-5" 规则截胡
  { re: /claude[-_ ]?(opus|sonnet|haiku)[-_ ]?5\.5/, levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },

  // Claude Opus 4.8：默认 high
  { re: /claude[-_ ]?opus[-_ ]?4\.8/, levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },

  // Claude Opus 4.7：默认 xhigh（表中唯一以 xhigh 为默认的型号）
  { re: /claude[-_ ]?opus[-_ ]?4\.7/, levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'xhigh' },

  // Claude Opus 5 / Sonnet 5（5.0 代）：默认 high
  // (\.0)? 兼容 'claude-sonnet-5.0'；(?!.*\d) 防止截胡 5.5 等更高小版本
  { re: /claude[-_ ]?(opus|sonnet)[-_ ]?5(\.0)?($|[^.\d])/, levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },

  // Gemini 3.x：minimal~high（无 xhigh/max）；Pro 默认 high、Flash 默认 medium
  { re: /gemini[-_ ]?3[.\-_ ]*pro/, levels: ['minimal', 'low', 'medium', 'high'], default: 'high' },
  { re: /gemini[-_ ]?3[.\-_ ]*flash/, levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },

  // GLM-5.3 / 5.3-FLASH：low/high/max，默认 max
  { re: /glm[-_ ]?5\.3/, levels: ['low', 'high', 'max'], default: 'max' },

  // Grok 4.7 / 4.6：low~xhigh（无 max），默认 high
  { re: /grok[-_ ]?4\.[67]/, levels: ['low', 'medium', 'high', 'xhigh'], default: 'high' },

  // Kimi K3 / K3.1 Pro：low/high/max，默认 max
  { re: /kimi[-_ ]?k3/, levels: ['low', 'high', 'max'], default: 'max' },

  // Qwen3.8-27B：xhigh/medium/low，默认 xhigh
  { re: /qwen[-_ ]?3\.8/, levels: ['xhigh', 'medium', 'low'], default: 'xhigh' },

  // StepFun-3.7-Flash：low/medium/high，默认 medium
  { re: /step(fun)?[-_ ]?3\.7/, levels: ['low', 'medium', 'high'], default: 'medium' },

  // 腾讯 HY3（hy3-preview）：low/medium/high，默认 low
  { re: /hy3/, levels: ['low', 'medium', 'high'], default: 'low' },

  // Mistral（mistral-small 等）：low/medium/high，默认 medium
  // 部分小型号仅 none/high——后台模型目录可按需拆更细规则
  { re: /mistral/, levels: ['low', 'medium', 'high'], default: 'medium' }
];

/**
 * 当前模型的思考挡位规格。
 * @param {string} modelId 模型 ID（如 'gpt-6-sol-2026-05'、'DeepSeek-Flash'）
 * @returns {{levels: string[], default: string}}
 */
export function thinkingSpecFor(modelId) {
  const id = String(modelId || '').toLowerCase();
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(id)) {
      return { levels: RULES[i].levels.slice(), default: RULES[i].default }
    }
  }
  return { levels: FALLBACK_LEVELS.slice(), default: FALLBACK_DEFAULT }
}

/**
 * 把任意历史值规范成当前模型可用的挡位字符串。
 *
 * - false / 'none'   → 'none'（遗留"关"状态必须保持关闭，即使模型档位表
 *                       没列 none——reasoning_effort:'none' 是通用线协议语义）
 * - true / 空 / 未知 → 模型默认挡
 * - 合法挡位字符串    → 原样
 */
export function normalizeThinkingLevel(modelId, value) {
  if (value === false || value === 'none') return 'none'
  const spec = thinkingSpecFor(modelId);
  if (value === true || value === undefined || value === null || value === '') {
    return spec.default
  }
  const s = String(value).toLowerCase();
  return spec.levels.indexOf(s) >= 0 ? s : spec.default
}

/**
 * 点击"深度"按钮：在当前模型的挡位表里循环到下一挡（循环滚动）。
 * 当前挡位不在表里（如遗留 'none' 而模型无 none）→ 从默认挡开始。
 */
export function nextThinkingLevel(modelId, current) {
  const spec = thinkingSpecFor(modelId);
  const idx = spec.levels.indexOf(current);
  if (idx < 0) return spec.default
  return spec.levels[(idx + 1) % spec.levels.length]
}

/**
 * 会话里该存的思考字段：thinkingLevel 是唯一事实来源，thinking 布尔只为兼容旧版本。
 *
 * 新建会话必须把这两个字段一起带上。只写 thinking=true 的话，applyThinking(conv)
 * 会按"布尔 true → 模型默认挡"重新折算——用户刚点出来的 max/low 会在
 * 「空态直接发送 → 自动建会话」的那一刻被压回默认挡（点击后一发送就重置）。
 */
export function thinkingFields(modelId, value) {
  const level = normalizeThinkingLevel(modelId, value);
  return { thinkingLevel: level, thinking: level !== 'none' }
}
