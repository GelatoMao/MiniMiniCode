/**
 * [K-06] Anthropic Messages API 适配器
 *
 * 职责：
 * 1. 将内部 ChatMessage[] 转换为 Anthropic API 格式（toAnthropicMessages）
 * 2. 发送 HTTP 请求，含指数退避重试 [K-07]
 * 3. 解析响应块（text / tool_use / thinking）[K-08]
 */
import type { ToolRegistry } from './tool.js'
import type {
  ChatMessage,
  ModelAdapter,
  ProviderThinkingBlock,
  ProviderUsage,
  StepDiagnostics,
  ToolCall,
} from './types.js'
import type { RuntimeConfig } from './config.js'
import { resolveMaxOutputTokens } from './utils/context.js'

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

// ── Anthropic API 内部类型 ──────────────────────────────────────────────────

type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown }

type AnthropicApiMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const asSeconds = Number(value)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.floor(asSeconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * [K-07] 指数退避 + Jitter
 * base = min(500 * 2^(attempt-1), 8000)
 * delay = base * (1 + random * 0.25)
 */
export function getRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    MAX_RETRY_DELAY_MS,
  )
  return Math.floor(base + Math.random() * 0.25 * base)
}

function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>
    if (typeof d['error'] === 'object' && d['error'] !== null) {
      const e = d['error'] as Record<string, unknown>
      if (typeof e['message'] === 'string' && e['message'].trim()) return e['message'].trim()
    }
    if (typeof d['error'] === 'string' && d['error'].trim()) return d['error'].trim()
    if (typeof d['message'] === 'string' && d['message'].trim()) return d['message'].trim()
  }
  return `Model request failed: ${status}`
}

// ── 消息格式转换 [K-06] ──────────────────────────────────────────────────────

/**
 * 将块推入 Anthropic 消息数组，相邻同角色消息自动合并。
 * Anthropic API 要求：相邻的 user 或 assistant 消息必须合并为一条。
 */
function pushBlock(
  out: AnthropicApiMessage[],
  role: 'user' | 'assistant',
  block: AnthropicContentBlock,
): void {
  const last = out.at(-1)
  if (last?.role === role) {
    last.content.push(block)
  } else {
    out.push({ role, content: [block] })
  }
}

function assistantText(msg: Extract<ChatMessage, { role: 'assistant' | 'assistant_progress' }>): string {
  return msg.role === 'assistant_progress'
    ? `<progress>\n${msg.content}\n</progress>`
    : msg.content
}

/**
 * 将内部 ChatMessage[] 转换为 Anthropic API 的 { system, messages } 格式。
 * 导出供测试直接验证转换逻辑。
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicApiMessage[]
} {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => (m.role === 'system' ? m.content : ''))
    .join('\n\n')

  const out: AnthropicApiMessage[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        break

      case 'user':
        pushBlock(out, 'user', { type: 'text', text: msg.content })
        break

      case 'assistant':
      case 'assistant_progress':
        pushBlock(out, 'assistant', { type: 'text', text: assistantText(msg) })
        break

      case 'assistant_thinking':
        for (const block of msg.blocks) {
          pushBlock(out, 'assistant', block as AnthropicContentBlock)
        }
        break

      case 'assistant_tool_call':
        pushBlock(out, 'assistant', {
          type: 'tool_use',
          id: msg.toolUseId,
          name: msg.toolName,
          input: msg.input,
        })
        break

      case 'tool_result':
        pushBlock(out, 'user', {
          type: 'tool_result',
          tool_use_id: msg.toolUseId,
          content: msg.content,
          is_error: msg.isError,
        })
        break

      case 'context_summary':
        pushBlock(out, 'user', {
          type: 'text',
          text: `[Context Summary]\n${msg.content}`,
        })
        break

      case 'snip_boundary':
        pushBlock(out, 'user', {
          type: 'text',
          text: '[Earlier conversation history was truncated to save context space]',
        })
        break
    }
  }

  return { system, messages: out }
}

function normalizeUsage(usage: AnthropicUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const outputTokens = usage.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return { inputTokens, outputTokens, totalTokens, source: 'anthropic' }
}

// 解析 <final> / <progress> / [FINAL] / [PROGRESS] 标记
function parseMarkers(text: string): { content: string; kind?: 'final' | 'progress' } {
  if (!text) return { content: '' }
  const markers: Array<{ prefix: string; kind: 'final' | 'progress' }> = [
    { prefix: '<final>', kind: 'final' },
    { prefix: '[FINAL]', kind: 'final' },
    { prefix: '<progress>', kind: 'progress' },
    { prefix: '[PROGRESS]', kind: 'progress' },
  ]
  for (const { prefix, kind } of markers) {
    if (text.startsWith(prefix)) {
      const inner = text.slice(prefix.length).trim()
      const closing = kind === 'progress' ? /<\/progress>/gi : /<\/final>/gi
      return { content: inner.replace(closing, '').trim(), kind }
    }
  }
  return { content: text }
}

// ── AnthropicModelAdapter ────────────────────────────────────────────────────

/**
 * [K-09] 适配器模式：实现 ModelAdapter 接口。
 * 通过 getRuntimeConfig 工厂函数注入配置，便于动态刷新和测试替换。
 */
export class AnthropicModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(messages: ChatMessage[]) {
    const config = await this.getRuntimeConfig()
    const { system, messages: apiMessages } = toAnthropicMessages(messages)
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`
    const maxTokens = resolveMaxOutputTokens(config.model, config.maxOutputTokens)

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (config.authToken) {
      headers['Authorization'] = `Bearer ${config.authToken}`
    } else if (config.apiKey) {
      headers['x-api-key'] = config.apiKey
    }

    const body = JSON.stringify({
      model: config.model,
      system,
      messages: apiMessages,
      tools: this.tools.list().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      max_tokens: maxTokens,
    })

    // [K-07] 重试循环：429 / 5xx 触发指数退避
    const maxRetries = (() => {
      const v = Number(process.env['ANTHROPIC_MAX_RETRIES'])
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_MAX_RETRIES
    })()

    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetch(url, { method: 'POST', headers, body })
      if (response.ok) break
      if (!shouldRetry(response.status) || attempt >= maxRetries) break
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      await sleep(getRetryDelayMs(attempt + 1, retryAfterMs))
    }

    if (!response) throw new Error('Model request failed before receiving a response')

    const data = JSON.parse(await response.text()) as {
      stop_reason?: string
      content?: AnthropicContentBlock[]
      usage?: AnthropicUsage
    }

    if (!response.ok) throw new Error(extractErrorMessage(data, response.status))

    // [K-08] 响应块分拣：text / tool_use / thinking / unknown
    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()

    for (const block of data.content ?? []) {
      blockTypes.push(block.type)
      if (block.type === 'text' && typeof (block as AnthropicTextBlock).text === 'string') {
        textParts.push((block as AnthropicTextBlock).text)
      } else if (block.type === 'tool_use' && typeof (block as AnthropicToolUseBlock).id === 'string') {
        const b = block as AnthropicToolUseBlock
        toolCalls.push({ id: b.id, toolName: b.name, input: b.input })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        thinkingBlocks.push(block as ProviderThinkingBlock)
      } else {
        ignoredBlockTypes.add(block.type)
      }
    }

    const parsed = parseMarkers(textParts.join('\n').trim())
    const diagnostics: StepDiagnostics = {
      stopReason: data.stop_reason,
      blockTypes,
      ignoredBlockTypes: [...ignoredBlockTypes],
    }
    const usage = normalizeUsage(data.usage)

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls' as const,
        calls: toolCalls,
        content: parsed.content || undefined,
        contentKind: parsed.kind === 'progress' ? ('progress' as const) : undefined,
        thinkingBlocks,
        diagnostics,
        usage,
      }
    }

    return {
      type: 'assistant' as const,
      content: parsed.content,
      kind: parsed.kind,
      thinkingBlocks,
      diagnostics,
      usage,
    }
  }
}
