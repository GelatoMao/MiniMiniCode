import os from 'node:os'
import path from 'node:path'

// [K-04] mini-code 本地数据目录（权限持久化、会话存储等）
export const MINI_CODE_DIR = path.join(os.homedir(), '.mini-code')

// [K-06] Phase 2 仅从环境变量加载配置（Phase 5 会扩展为读取 settings.json）
export type RuntimeConfig = {
  model: string
  baseUrl: string
  apiKey?: string
  authToken?: string
  maxOutputTokens?: number
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const model =
    (process.env['ANTHROPIC_MODEL'] ?? '').trim() || 'claude-opus-4-7'
  const baseUrl =
    (process.env['ANTHROPIC_BASE_URL'] ?? '').trim() || 'https://api.anthropic.com'
  const apiKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim() || undefined
  const authToken = (process.env['ANTHROPIC_AUTH_TOKEN'] ?? '').trim() || undefined

  if (!apiKey && !authToken) {
    throw new Error(
      'No auth configured. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.',
    )
  }

  const rawMax = process.env['ANTHROPIC_MAX_OUTPUT_TOKENS']
  const parsedMax = rawMax === undefined ? NaN : Number(rawMax)
  const maxOutputTokens =
    Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : undefined

  return { model, baseUrl, apiKey, authToken, maxOutputTokens }
}
