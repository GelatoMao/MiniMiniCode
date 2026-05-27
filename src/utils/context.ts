type ModelMaxOutputTokens = {
  default: number
  upperLimit: number
}

const FALLBACK: ModelMaxOutputTokens = { default: 32_000, upperLimit: 64_000 }

// 匹配规则：模型名 toLowerCase 包含 pattern 子串即匹配
// 更具体的规则放在前面，防止 claude-sonnet-4 匹配到 claude-sonnet-4-6
const RULES: Array<{ patterns: string[]; limits: ModelMaxOutputTokens }> = [
  {
    patterns: ['claude-opus-4-7', 'opus-4-7'],
    limits: { default: 32_000, upperLimit: 32_000 },
  },
  {
    patterns: ['claude-opus-4-6', 'opus-4-6'],
    limits: { default: 128_000, upperLimit: 128_000 },
  },
  {
    patterns: ['claude-sonnet-4-6', 'sonnet-4-6'],
    limits: { default: 64_000, upperLimit: 64_000 },
  },
  {
    patterns: ['claude-haiku-4-5', 'haiku-4-5'],
    limits: { default: 64_000, upperLimit: 64_000 },
  },
  {
    patterns: ['claude-opus-4', 'opus-4'],
    limits: { default: 32_000, upperLimit: 32_000 },
  },
  {
    patterns: ['claude-sonnet-4', 'sonnet-4'],
    limits: { default: 64_000, upperLimit: 64_000 },
  },
  {
    patterns: ['claude-3-7-sonnet', '3-7-sonnet'],
    limits: { default: 8_192, upperLimit: 8_192 },
  },
  {
    patterns: ['claude-3-5-sonnet', '3-5-sonnet'],
    limits: { default: 8_192, upperLimit: 8_192 },
  },
  {
    patterns: ['claude-3-5-haiku', '3-5-haiku'],
    limits: { default: 8_192, upperLimit: 8_192 },
  },
]

export function getModelMaxOutputTokens(model: string): ModelMaxOutputTokens {
  const normalized = model.trim().toLowerCase()
  for (const rule of RULES) {
    if (rule.patterns.some(p => normalized.includes(p))) {
      return rule.limits
    }
  }
  return FALLBACK
}

// [K-06] 用配置值覆盖默认值，但不能超过模型上限
export function resolveMaxOutputTokens(
  model: string,
  configuredMax?: number,
): number {
  const limits = getModelMaxOutputTokens(model)
  if (configuredMax !== undefined && Number.isFinite(configuredMax) && configuredMax > 0) {
    return Math.min(Math.floor(configuredMax), limits.upperLimit)
  }
  return limits.default
}

// Phase 6 压缩策略会用到：这些工具的输出适合被截断/摘要
export const COMPACTABLE_TOOLS = new Set([
  'read_file',
  'run_command',
  'list_files',
  'web_fetch',
])
