#!/usr/bin/env node
// thinking-levels.js 回归用例：模型挡位规则匹配、遗留值折算、循环切换。
// 规则按"具体型号在前、宽泛前缀在后"排序，这里锁住易被截胡的型号。
import { thinkingSpecFor, normalizeThinkingLevel, nextThinkingLevel, thinkingFields } from '../src/services/thinking-levels.js'

let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  =>  ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)))
}

// ---------- thinkingSpecFor：挡位表 ----------
check('DeepSeek-Flash 三档默认 high', thinkingSpecFor('deepseek-flash'), { levels: ['low', 'high', 'max'], default: 'high' })
check('DeepSeek-Flash 大小写/连接符', thinkingSpecFor('DeepSeek-Flash-2026'), { levels: ['low', 'high', 'max'], default: 'high' })
check('GPT-5.6 全档默认 medium（视型号折中）', thinkingSpecFor('gpt-5.6-mini'), { levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('GPT-6.1 Sol 不被 gpt-6-sol 截胡', thinkingSpecFor('gpt-6.1-sol-2026-05'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('GPT-6 Astra', thinkingSpecFor('gpt-6-astra'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('GPT-6 Sol 含 none', thinkingSpecFor('gpt-6-sol'), { levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('GPT-6 Luna 含 none', thinkingSpecFor('gpt6_luna'), { levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('Claude Opus 5.5 默认 medium', thinkingSpecFor('claude-opus-5.5'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('Claude Sonnet 5.5 默认 medium', thinkingSpecFor('claude-sonnet-5.5-2026'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('Claude Haiku 5.5 默认 medium', thinkingSpecFor('claude-haiku-5.5'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
check('Claude Opus 5（5.0 代）默认 high', thinkingSpecFor('claude-opus-5'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' })
check('Claude Sonnet 5.0 默认 high', thinkingSpecFor('claude-sonnet-5.0'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' })
check('Claude Opus 5.5 不被 "-5" 规则截胡（默认 medium 而非 high）', thinkingSpecFor('claude-opus-5.5').default, 'medium')
check('Claude Opus 4.8 默认 high', thinkingSpecFor('claude-opus-4.8'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' })
check('Claude Opus 4.7 默认 xhigh', thinkingSpecFor('claude-opus-4.7'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'xhigh' })
check('Gemini 3.x Pro 默认 high 无 xhigh/max', thinkingSpecFor('gemini-3-pro-preview'), { levels: ['minimal', 'low', 'medium', 'high'], default: 'high' })
check('Gemini 3.x Flash 默认 medium', thinkingSpecFor('gemini-3-flash'), { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' })
check('GLM-5.3 默认 max', thinkingSpecFor('glm-5.3'), { levels: ['low', 'high', 'max'], default: 'max' })
check('GLM-5.3-FLASH 同规则', thinkingSpecFor('glm-5.3-flash'), { levels: ['low', 'high', 'max'], default: 'max' })
check('Grok 4.7 / 4.6', thinkingSpecFor('grok-4.7-fast'), { levels: ['low', 'medium', 'high', 'xhigh'], default: 'high' })
check('Kimi K3 默认 max', thinkingSpecFor('kimi-k3.1-pro'), { levels: ['low', 'high', 'max'], default: 'max' })
check('Qwen3.8 默认 xhigh', thinkingSpecFor('qwen3.8-27b'), { levels: ['xhigh', 'medium', 'low'], default: 'xhigh' })
check('StepFun-3.7 默认 medium', thinkingSpecFor('stepfun-3.7-flash'), { levels: ['low', 'medium', 'high'], default: 'medium' })
check('腾讯 HY3 默认 low', thinkingSpecFor('hy3-preview'), { levels: ['low', 'medium', 'high'], default: 'low' })
check('Mistral 默认 medium', thinkingSpecFor('mistral-small-2506'), { levels: ['low', 'medium', 'high'], default: 'medium' })
check('未命中规则回落 low/high/max 默认 high', thinkingSpecFor('deepseek-chat'), { levels: ['low', 'high', 'max'], default: 'high' })
check('空模型 ID 回落', thinkingSpecFor(''), { levels: ['low', 'high', 'max'], default: 'high' })

// ---------- normalizeThinkingLevel：遗留值折算 ----------
check('true → 模型默认挡', normalizeThinkingLevel('deepseek-flash', true), 'high')
check('true → 规则默认挡（opus-4.7 → xhigh）', normalizeThinkingLevel('claude-opus-4.7', true), 'xhigh')
check('false → none（即使模型档位表无 none，遗留"关"必须保持）', normalizeThinkingLevel('deepseek-flash', false), 'none')
check("'none' → none", normalizeThinkingLevel('gpt-6-sol', 'none'), 'none')
check('合法挡位原样', normalizeThinkingLevel('gpt-6-sol', 'xhigh'), 'xhigh')
check('模型不支持的挡位 → 默认挡', normalizeThinkingLevel('gemini-3-pro', 'max'), 'high')
check('空值 → 默认挡', normalizeThinkingLevel('glm-5.3', ''), 'max')
check('undefined → 默认挡', normalizeThinkingLevel('hy3-preview', undefined), 'low')
check('大写挡位折算', normalizeThinkingLevel('deepseek-flash', 'MAX'), 'max')

// ---------- nextThinkingLevel：点击循环 ----------
check('DeepSeek-Flash：low→high', nextThinkingLevel('deepseek-flash', 'low'), 'high')
check('DeepSeek-Flash：high→max', nextThinkingLevel('deepseek-flash', 'high'), 'max')
check('DeepSeek-Flash：max 循环回 low', nextThinkingLevel('deepseek-flash', 'max'), 'low')
check('DeepSeek-Flash：遗留 none → 从默认挡开始', nextThinkingLevel('deepseek-flash', 'none'), 'high')
check('GPT-6 Sol：none→low', nextThinkingLevel('gpt-6-sol', 'none'), 'low')
check('GPT-6 Sol：max 循环回 none（可关）', nextThinkingLevel('gpt-6-sol', 'max'), 'none')
check('Qwen3.8：xhigh→medium（按档位表顺序）', nextThinkingLevel('qwen3.8-27b', 'xhigh'), 'medium')
check('未知挡位 → 默认挡', nextThinkingLevel('glm-5.3', 'medium'), 'max')

// ---------- thinkingFields：新建会话必须带上挡位 ----------
// 只存布尔 thinking 会让 applyThinking(conv) 把挡位折算回模型默认
// （用户点完挡位、一发消息就被重置的根因）。
check('挡位 + 布尔同步（非 none）', thinkingFields('deepseek-flash', 'max'), { thinkingLevel: 'max', thinking: true })
check('none → thinking=false', thinkingFields('gpt-6-sol', 'none'), { thinkingLevel: 'none', thinking: false })
check('布尔 true → 默认挡', thinkingFields('deepseek-flash', true), { thinkingLevel: 'high', thinking: true })
check('布尔 false → none', thinkingFields('deepseek-flash', false), { thinkingLevel: 'none', thinking: false })
check('模型不支持的挡位折算后仍可回存', thinkingFields('gemini-3-pro', 'max'), { thinkingLevel: 'high', thinking: true })

process.exit(fail ? 1 : 0)
