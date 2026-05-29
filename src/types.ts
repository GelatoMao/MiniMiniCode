/**
 * [K-01] 可辨别联合类型（Discriminated Union）
 *
 * TypeScript 通过"字面量类型"作为辨别字段（discriminant），让编译器在
 * if/switch 分支里自动收窄类型，无需手写类型断言。
 *
 * 示例：
 *   if (msg.role === 'assistant') {
 *     // 这里 msg 被收窄为只含 content 的那个分支
 *     console.log(msg.content)
 *   }
 *
 * 设计原则：
 * - 每个 role 值对应唯一的数据形状，字段不跨分支复用
 * - 交叉类型（& MessageIdentity）用于添加所有分支共享的可选字段
 */

// ── 工具调用令牌用量（来自 LLM 响应）─────────────────────────────────────
export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 来源标识，例如 "anthropic" */
  source: string
}

export type ProviderUsageMetadata = {
  providerUsage?: ProviderUsage
  /** 是否因 context-collapse 导致用量数据过期 */
  usageStale?: boolean
  usageStaleReason?: string
}

// ── 模型思考块（extended thinking 功能）───────────────────────────────────
export type ProviderThinkingBlock = {
  type: 'thinking' | 'redacted_thinking'
  [key: string]: unknown
}

// ── 所有消息共享的可选标识字段 ─────────────────────────────────────────────
export type MessageIdentity = {
  /** 用于 snip-compact 追踪被删除消息 */
  id?: string
}

/**
 * [K-01] ChatMessage 可辨别联合
 *
 * 内部消息格式，与 Anthropic API 格式分离（[K-06] 见 anthropic-adapter.ts）。
 * 每个 role 代表一种消息语义：
 *
 * - system              → 系统提示词
 * - user                → 用户输入
 * - assistant           → 模型最终回复
 * - assistant_progress  → 模型中间过程消息（不计入最终输出）
 * - assistant_thinking  → 模型 extended thinking 块
 * - assistant_tool_call → 模型发起工具调用
 * - tool_result         → 工具执行结果
 * - context_summary     → [K-34] context-collapse 压缩摘要占位符
 * - snip_boundary       → [K-34] snipCompact 删除边界标记
 */
export type ChatMessage =
  | ({ role: 'system'; content: string } & MessageIdentity)
  | ({ role: 'user'; content: string } & MessageIdentity)
  | ({ role: 'assistant_thinking'; blocks: ProviderThinkingBlock[] } & MessageIdentity)
  | ({ role: 'assistant'; content: string } & ProviderUsageMetadata & MessageIdentity)
  | ({ role: 'assistant_progress'; content: string } & ProviderUsageMetadata & MessageIdentity)
  | ({
      role: 'assistant_tool_call'
      toolUseId: string
      toolName: string
      input: unknown
    } & ProviderUsageMetadata & MessageIdentity)
  | ({
      role: 'tool_result'
      toolUseId: string
      toolName: string
      content: string
      isError: boolean
    } & MessageIdentity)
  | ({
      role: 'context_summary'
      content: string
      compressedCount: number
      timestamp: number
    } & MessageIdentity)
  | ({
      role: 'snip_boundary'
      content: string
      removedMessageIds: string[]
      removedCount: number
      tokensFreed: number
      timestamp: number
    } & MessageIdentity)

// ── 单次工具调用描述 ────────────────────────────────────────────────────────
export type ToolCall = {
  id: string
  toolName: string
  input: unknown
}

// ── 诊断信息（调试用，不影响主流程）────────────────────────────────────────
export type StepDiagnostics = {
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}

/**
 * [K-04] AgentStep：模型单次推理结果
 *
 * 也是可辨别联合，两种变体：
 * - 'assistant'  → 纯文本回复，代表模型认为任务完成或在等待用户
 * - 'tool_calls' → 包含一或多个工具调用请求，Agent Loop 将执行它们
 *
 * Agent Loop 通过 type 字段决定下一步行为：
 *   tool_calls → 执行工具 → 将结果追加消息 → 再次调用 model.next()
 *   assistant  → 返回给用户，本轮结束
 */
export type AgentStep =
  | {
      type: 'assistant'
      content: string
      /** final = 明确完成; progress = 中间状态（仍需继续） */
      kind?: 'final' | 'progress'
      thinkingBlocks?: ProviderThinkingBlock[]
      diagnostics?: StepDiagnostics
      usage?: ProviderUsage
    }
  | {
      type: 'tool_calls'
      calls: ToolCall[]
      /** 工具调用前的可选前置文本 */
      content?: string
      contentKind?: 'progress'
      thinkingBlocks?: ProviderThinkingBlock[]
      diagnostics?: StepDiagnostics
      usage?: ProviderUsage
    }

/**
 * [K-09] ModelAdapter 接口（适配器模式）
 *
 * 将 Agent Loop 与具体 LLM 提供商解耦。
 * Agent Loop 只依赖这个接口，不关心底层是 Anthropic / OpenAI / Mock。
 *
 * 优点：
 * - 测试时可注入 MockModelAdapter，无需真实 API 调用
 * - 切换模型提供商只需替换 Adapter 实现，Loop 代码零修改
 */
export interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}

// ── context-collapse 压缩结果类型 ──────────────────────────────────────────
export type CompressionResult = {
  messages: ChatMessage[]
  summary: Extract<ChatMessage, { role: 'context_summary' }>
  removedCount: number
  tokensBefore: number
  tokensAfter: number
}

// ── 后台任务（K-31）────────────────────────────────────────────────────────
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed'

export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: BackgroundTaskStatus
  startedAt: number
}
