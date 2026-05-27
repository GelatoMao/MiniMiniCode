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

// Math.max(0, ms) 防止负数传入 setTimeout 导致行为不确定
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

// 429 = 限流（Too Many Requests），5xx = 服务端临时错误，这两类值得重试
// 4xx 的其他状态码（如 400 参数错误、401 鉴权失败）是客户端问题，重试没有意义
function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

/**
 * 解析 Retry-After 响应头，返回应等待的毫秒数。
 *
 * HTTP 标准允许两种格式：
 *   - 数字字符串："30"  → 表示等待 30 秒
 *   - HTTP 日期字符串："Wed, 21 Oct 2025 07:28:00 GMT" → 表示等到该时刻
 *
 * 返回 null 表示响应头不存在或无法解析，调用方会 fallback 到指数退避。
 */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const asSeconds = Number(value)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.floor(asSeconds * 1000)
  const at = Date.parse(value)
  // Math.max(0, ...) 防止服务端给了一个过去的时间导致负数等待
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * [K-07] 计算本次重试应等待的毫秒数。
 *
 * 优先级：Retry-After 响应头 > 指数退避自算
 *
 * 指数退避公式：
 *   base  = min(500 × 2^(attempt-1), 8000)   ← 每次翻倍，但封顶 8s
 *   delay = base × (1 + random × 0.25)        ← 加最多 25% 随机抖动
 *
 * 为什么加 Jitter？
 * 多个客户端同时被限流后，如果等待时间完全相同，会在同一时刻同时重试，
 * 再次打爆 API。随机抖动让各客户端的重试时间散开，避免"惊群效应"。
 */
export function getRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    MAX_RETRY_DELAY_MS,
  )
  return Math.floor(base + Math.random() * 0.25 * base)
}

/**
 * 从 API 错误响应体中提取可读的错误信息。
 *
 * Anthropic 的错误格式是 { error: { message: "..." } }，
 * 但不同 API 网关或代理可能返回不同结构，这里做了防御性解析：
 *   1. { error: { message: string } }  ← 标准 Anthropic 格式
 *   2. { error: string }               ← 简化格式
 *   3. { message: string }             ← 通用格式
 *   4. 以上都匹配不到时，fallback 到 "Model request failed: {status}"
 */
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
 * 向输出数组追加一个内容块，自动处理同角色消息合并。
 *
 * Anthropic API 硬性要求：消息数组里不能出现相邻的同角色消息。
 * 例如连续两次工具调用会产生两条 assistant_tool_call，转换后都是
 * assistant 角色——如果分成两条消息发送，API 会报 400 错误。
 *
 * 解决方案：检查数组末尾，如果角色相同就把块追加进去，否则新建一条消息。
 *
 *   已有: [{ role: 'assistant', content: [block1] }]
 *   追加: pushBlock(out, 'assistant', block2)
 *   结果: [{ role: 'assistant', content: [block1, block2] }]  ← 合并
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

/**
 * 将 assistant_progress 消息包裹为 <progress> 标签后再发给模型。
 *
 * 为什么需要包裹？
 * agent-loop（Phase 3）发现模型输出的是"进度更新"而非最终答案时，
 * 会把这条消息以 assistant_progress 存入历史，然后继续推进任务。
 * 下次调用 API 时，这条历史消息需要告诉模型"这是你之前说的中间进度"，
 * 用 <progress> 标签标记能防止模型把它误判为最终回复。
 */
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
        // 已在上面单独提取为 system 字段，这里跳过
        break

      case 'user':
        pushBlock(out, 'user', { type: 'text', text: msg.content })
        break

      case 'assistant':
      case 'assistant_progress':
        // assistant_progress 会被包裹为 <progress> 标签（见 assistantText）
        pushBlock(out, 'assistant', { type: 'text', text: assistantText(msg) })
        break

      case 'assistant_thinking':
        // Extended Thinking 的思考块需要原样保留发回给模型，
        // 否则模型不知道自己之前"想"了什么，多轮对话会断层
        for (const block of msg.blocks) {
          pushBlock(out, 'assistant', block as AnthropicContentBlock)
        }
        break

      case 'assistant_tool_call':
        // 工具调用：内部用 toolUseId/toolName/input，API 要求 id/name/input
        pushBlock(out, 'assistant', {
          type: 'tool_use',
          id: msg.toolUseId,
          name: msg.toolName,
          input: msg.input,
        })
        break

      case 'tool_result':
        // 工具结果放在 user 角色里——这是 Anthropic API 的规定：
        // 模型（assistant）发起调用，"环境"（user）返回结果
        pushBlock(out, 'user', {
          type: 'tool_result',
          tool_use_id: msg.toolUseId,  // 注意字段名：tool_use_id（下划线）不是 toolUseId
          content: msg.content,
          is_error: msg.isError,
        })
        break

      case 'context_summary':
        // Phase 5 context-collapse 压缩后的摘要，以 user 消息形式告知模型历史被压缩过
        pushBlock(out, 'user', {
          type: 'text',
          text: `[Context Summary]\n${msg.content}`,
        })
        break

      case 'snip_boundary':
        // Phase 5 snip-compact 删除历史消息后插入的边界占位符，
        // 告知模型：这里有一段对话被省略了
        pushBlock(out, 'user', {
          type: 'text',
          text: '[Earlier conversation history was truncated to save context space]',
        })
        break
    }
  }

  return { system, messages: out }
}

/**
 * 将 Anthropic 原始 usage 字段归一化为内部 ProviderUsage 格式。
 *
 * 为什么要把 cache_creation_input_tokens 和 cache_read_input_tokens 加到 inputTokens？
 * Anthropic 的 Prompt Cache 功能会把部分 token 计入缓存读写，
 * 这些 token 仍然产生费用（只是比普通 input token 便宜），
 * 加总后才是"本次请求实际消耗的总输入 token 数"，用于展示和限额控制。
 *
 * totalTokens <= 0 时返回 undefined，避免把空 usage 对象传播出去。
 */
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

/**
 * 解析模型输出文本里的状态标记，提取内容和状态类型。
 *
 * 为什么需要这个？
 * Agent Loop（Phase 3）需要判断模型的回复是"任务完成"还是"中间进度"。
 * 通过约定 System Prompt 要求模型用标签包裹回复，这里负责解析：
 *   <final>任务完成，最终答案</final>     → kind: 'final'
 *   <progress>正在处理，稍等</progress>  → kind: 'progress'（Loop 继续推进）
 *   没有标签                              → kind: undefined（视上下文而定）
 *
 * 支持 [FINAL] / [PROGRESS] 方括号格式是为了兼容部分模型不擅长输出尖括号的情况。
 * 闭合标签（</final>、</progress>）用正则替换掉，因为模型有时会漏写。
 */
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
