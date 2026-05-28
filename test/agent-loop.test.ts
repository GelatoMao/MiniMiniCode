import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { runAgentTurn } from '../src/agent-loop.js'
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'
import { ToolRegistry } from '../src/tool.js'
import type { ToolDefinition } from '../src/tool.js'

// ── 测试辅助 ─────────────────────────────────────────────────────────────────

/** 按顺序依次返回 steps 里的 AgentStep，序列用完后返回默认助手消息 */
function makeMockAdapter(steps: AgentStep[]): ModelAdapter {
  let i = 0
  return {
    async next(): Promise<AgentStep> {
      return steps[i++] ?? { type: 'assistant', content: '（序列结束默认回复）' }
    },
  }
}

/** 构建一个会回显输入 text 的简单工具 */
function makeEchoTool(): ToolDefinition<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo back the input',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    schema: z.object({ text: z.string() }),
    async run({ text }) {
      return { ok: true, output: `echo: ${text}` }
    },
  }
}

// ── [K-10] ReAct 骨架 ─────────────────────────────────────────────────────────

describe('runAgentTurn — ReAct 主循环 [K-10]', () => {
  it('模型直接返回 assistant 时退出循环，结果末尾是 assistant 消息', async () => {
    const adapter = makeMockAdapter([{ type: 'assistant', content: '任务完成' }])
    const registry = new ToolRegistry()
    const messages: ChatMessage[] = [{ role: 'user', content: '你好' }]

    const result = await runAgentTurn({ model: adapter, tools: registry, messages, cwd: '/tmp' })

    const lastMsg = result[result.length - 1]!
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.role === 'assistant' && lastMsg.content).toBe('任务完成')
  })

  it('onAssistantMessage 回调被调用', async () => {
    const adapter = makeMockAdapter([{ type: 'assistant', content: '完成了' }])
    const registry = new ToolRegistry()
    const onAssistantMessage = vi.fn()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行' }],
      cwd: '/tmp',
      onAssistantMessage,
    })

    expect(onAssistantMessage).toHaveBeenCalledWith('完成了')
  })

  it('返回值包含原始用户消息（历史保留）', async () => {
    const adapter = makeMockAdapter([{ type: 'assistant', content: '回答' }])
    const registry = new ToolRegistry()
    const messages: ChatMessage[] = [{ role: 'user', content: '问题' }]

    const result = await runAgentTurn({ model: adapter, tools: registry, messages, cwd: '/tmp' })

    expect(result[0]!.role).toBe('user')
    expect(result[0]!.role === 'user' && result[0]!.content).toBe('问题')
  })
})

// ── [K-11] 工具执行与错误收集 ─────────────────────────────────────────────────

describe('runAgentTurn — 工具执行 [K-11]', () => {
  it('tool_calls → 执行工具 → 追加 tool_result → 再次调用模型', async () => {
    const adapter = makeMockAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', toolName: 'echo', input: { text: 'hello' } }],
      },
      { type: 'assistant', content: '工具执行完毕' },
    ])
    const registry = new ToolRegistry([makeEchoTool()])
    const messages: ChatMessage[] = [{ role: 'user', content: '调用工具' }]

    const onToolStart = vi.fn()
    const onToolResult = vi.fn()

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages,
      cwd: '/tmp',
      onToolStart,
      onToolResult,
    })

    expect(onToolStart).toHaveBeenCalledWith('echo', { text: 'hello' })
    expect(onToolResult).toHaveBeenCalledWith('echo', 'echo: hello', false)

    const toolCallMsg = result.find(m => m.role === 'assistant_tool_call')
    expect(toolCallMsg).toBeDefined()
    if (toolCallMsg?.role === 'assistant_tool_call') {
      expect(toolCallMsg.toolName).toBe('echo')
      expect(toolCallMsg.toolUseId).toBe('c1')
    }

    const toolResultMsg = result.find(m => m.role === 'tool_result')
    expect(toolResultMsg).toBeDefined()
    if (toolResultMsg?.role === 'tool_result') {
      expect(toolResultMsg.content).toBe('echo: hello')
      expect(toolResultMsg.isError).toBe(false)
    }
  })

  it('工具失败（ok: false）时 isError=true', async () => {
    const failTool: ToolDefinition<{ text: string }> = {
      name: 'fail',
      description: '总是失败',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      schema: z.object({ text: z.string() }),
      async run() {
        return { ok: false, output: '故意报错' }
      },
    }
    const adapter = makeMockAdapter([
      { type: 'tool_calls', calls: [{ id: 'c1', toolName: 'fail', input: { text: 'x' } }] },
      { type: 'assistant', content: '工具报错了' },
    ])
    const registry = new ToolRegistry([failTool])
    const onToolResult = vi.fn()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行' }],
      cwd: '/tmp',
      onToolResult,
    })

    expect(onToolResult).toHaveBeenCalledWith('fail', '故意报错', true)
  })

  it('未知工具名返回 isError=true', async () => {
    const adapter = makeMockAdapter([
      { type: 'tool_calls', calls: [{ id: 'c1', toolName: 'nonexistent', input: {} }] },
      { type: 'assistant', content: '未知工具' },
    ])
    const registry = new ToolRegistry()
    const onToolResult = vi.fn()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行' }],
      cwd: '/tmp',
      onToolResult,
    })

    expect(onToolResult).toHaveBeenCalledWith('nonexistent', expect.stringContaining('未知工具'), true)
  })

  it('多个工具调用顺序执行，全部追加到消息历史', async () => {
    const adapter = makeMockAdapter([
      {
        type: 'tool_calls',
        calls: [
          { id: 'c1', toolName: 'echo', input: { text: 'first' } },
          { id: 'c2', toolName: 'echo', input: { text: 'second' } },
        ],
      },
      { type: 'assistant', content: '两个工具都执行了' },
    ])
    const registry = new ToolRegistry([makeEchoTool()])

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行两个工具' }],
      cwd: '/tmp',
    })

    const toolCalls = result.filter(m => m.role === 'assistant_tool_call')
    const toolResults = result.filter(m => m.role === 'tool_result')
    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)
  })

  it('awaitUser=true 时循环立即停止，输出问题给用户', async () => {
    const askUserTool: ToolDefinition<{ question: string }> = {
      name: 'ask_user',
      description: '向用户提问',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
      schema: z.object({ question: z.string() }),
      async run({ question }) {
        return { ok: true, output: question, awaitUser: true }
      },
    }
    const adapter = makeMockAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', toolName: 'ask_user', input: { question: '你叫什么名字？' } }],
      },
      { type: 'assistant', content: '这不应该被调用' },
    ])
    const registry = new ToolRegistry([askUserTool])
    const onAssistantMessage = vi.fn()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '问问我' }],
      cwd: '/tmp',
      onAssistantMessage,
    })

    expect(onAssistantMessage).toHaveBeenCalledWith('你叫什么名字？')
    expect(onAssistantMessage).toHaveBeenCalledTimes(1)
  })
})

// ── [K-12] 韧性设计 ───────────────────────────────────────────────────────────

describe('runAgentTurn — 韧性设计 [K-12]', () => {
  it('空响应最多重试 2 次，第 3 次空响应时降级并返回提示消息', async () => {
    const adapter = makeMockAdapter([
      { type: 'assistant', content: '' }, // 第 1 次空响应 → 注入 continuation
      { type: 'assistant', content: '' }, // 第 2 次空响应 → 注入 continuation
      { type: 'assistant', content: '' }, // 第 3 次空响应 → 降级退出
    ])
    const registry = new ToolRegistry()
    const messages: ChatMessage[] = [{ role: 'user', content: '你好' }]

    const result = await runAgentTurn({ model: adapter, tools: registry, messages, cwd: '/tmp' })

    const lastMsg = result[result.length - 1]!
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.role === 'assistant' && lastMsg.content).toContain('空响应')
  })

  it('空响应后注入了 continuation prompt（user 角色消息）', async () => {
    let callCount = 0
    const capturedMessages: ChatMessage[][] = []
    const adapter: ModelAdapter = {
      async next(msgs): Promise<AgentStep> {
        capturedMessages.push([...msgs])
        callCount++
        if (callCount <= 2) return { type: 'assistant', content: '' }
        return { type: 'assistant', content: '终于回答了' }
      },
    }
    const registry = new ToolRegistry()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '初始问题' }],
      cwd: '/tmp',
    })

    // 第 2 次调用时，消息末尾应该多了一条 user 的 continuation prompt
    const secondCallMsgs = capturedMessages[1]!
    const lastUserMsg = [...secondCallMsgs].reverse().find(m => m.role === 'user')
    expect(lastUserMsg?.role === 'user' && lastUserMsg.content).toContain('为空')
  })

  it('maxSteps 限制防止无限循环', async () => {
    // 模型一直返回工具调用，永不结束
    const adapter: ModelAdapter = {
      async next(): Promise<AgentStep> {
        return {
          type: 'tool_calls',
          calls: [{ id: `c${Date.now()}`, toolName: 'echo', input: { text: 'hi' } }],
        }
      },
    }
    const registry = new ToolRegistry([makeEchoTool()])
    const messages: ChatMessage[] = [{ role: 'user', content: '无限循环' }]

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages,
      cwd: '/tmp',
      maxSteps: 3,
    })

    const lastMsg = result[result.length - 1]!
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.role === 'assistant' && lastMsg.content).toContain('最大')
  })

  it('工具报错后空响应，降级消息中包含工具错误次数', async () => {
    const failTool: ToolDefinition<{ text: string }> = {
      name: 'fail',
      description: '总是失败',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      schema: z.object({ text: z.string() }),
      async run() {
        return { ok: false, output: '工具错误' }
      },
    }
    const adapter = makeMockAdapter([
      { type: 'tool_calls', calls: [{ id: 'c1', toolName: 'fail', input: { text: 'x' } }] },
      { type: 'assistant', content: '' },
      { type: 'assistant', content: '' },
      { type: 'assistant', content: '' }, // 触发降级
    ])
    const registry = new ToolRegistry([failTool])

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行' }],
      cwd: '/tmp',
    })

    const lastMsg = result[result.length - 1]!
    expect(lastMsg.role === 'assistant' && lastMsg.content).toContain('1 个工具报错')
  })
})

// ── [K-13] Continuation Prompt ──────────────────────────────────────────────

describe('runAgentTurn — Continuation Prompt [K-13]', () => {
  it('kind=progress 时追加 assistant_progress 消息并继续循环', async () => {
    const adapter = makeMockAdapter([
      { type: 'assistant', content: '正在分析...', kind: 'progress' },
      { type: 'assistant', content: '分析完成' },
    ])
    const registry = new ToolRegistry()
    const onProgressMessage = vi.fn()
    const onAssistantMessage = vi.fn()

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '分析代码' }],
      cwd: '/tmp',
      onProgressMessage,
      onAssistantMessage,
    })

    expect(onProgressMessage).toHaveBeenCalledWith('正在分析...')
    const progressMsg = result.find(m => m.role === 'assistant_progress')
    expect(progressMsg).toBeDefined()
    expect(onAssistantMessage).toHaveBeenCalledWith('分析完成')
  })

  it('tool_calls 的前置 progress 文本被正确输出', async () => {
    const adapter = makeMockAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', toolName: 'echo', input: { text: 'hi' } }],
        content: '<progress>准备调用工具...</progress>',
        contentKind: 'progress',
      },
      { type: 'assistant', content: '工具完成' },
    ])
    const registry = new ToolRegistry([makeEchoTool()])
    const onProgressMessage = vi.fn()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行' }],
      cwd: '/tmp',
      onProgressMessage,
    })

    expect(onProgressMessage).toHaveBeenCalledWith('<progress>准备调用工具...</progress>')
  })

  it('连续多个 progress 消息后最终返回 assistant', async () => {
    const adapter = makeMockAdapter([
      { type: 'assistant', content: '第一步进行中...', kind: 'progress' },
      { type: 'assistant', content: '第二步进行中...', kind: 'progress' },
      { type: 'assistant', content: '全部完成' },
    ])
    const registry = new ToolRegistry()
    const onProgressMessage = vi.fn()
    const onAssistantMessage = vi.fn()

    await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '执行多步骤任务' }],
      cwd: '/tmp',
      onProgressMessage,
      onAssistantMessage,
    })

    expect(onProgressMessage).toHaveBeenCalledTimes(2)
    expect(onAssistantMessage).toHaveBeenCalledWith('全部完成')
  })
})

// ── [K-14] Thinking Block 跨轮次保留 ─────────────────────────────────────────

describe('runAgentTurn — Thinking Block 跨轮次保留 [K-14]', () => {
  it('assistant 响应的 thinking blocks 被追加为 assistant_thinking 消息', async () => {
    const thinkingBlocks = [{ type: 'thinking' as const, thinking: '让我深入思考...' }]
    const adapter = makeMockAdapter([
      { type: 'assistant', content: '思考完毕，答案是 42', thinkingBlocks },
    ])
    const registry = new ToolRegistry()

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '一个深刻的问题' }],
      cwd: '/tmp',
    })

    const thinkingMsg = result.find(m => m.role === 'assistant_thinking')
    expect(thinkingMsg).toBeDefined()
    if (thinkingMsg?.role === 'assistant_thinking') {
      expect(thinkingMsg.blocks).toHaveLength(1)
      expect(thinkingMsg.blocks[0]!.type).toBe('thinking')
    }
  })

  it('tool_calls 响应的 thinking blocks 也被保留', async () => {
    const thinkingBlocks = [{ type: 'thinking' as const, thinking: '决定调用工具...' }]
    const adapter = makeMockAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', toolName: 'echo', input: { text: 'test' } }],
        thinkingBlocks,
      },
      { type: 'assistant', content: '完成' },
    ])
    const registry = new ToolRegistry([makeEchoTool()])

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '测试 thinking' }],
      cwd: '/tmp',
    })

    const thinkingMsg = result.find(m => m.role === 'assistant_thinking')
    expect(thinkingMsg).toBeDefined()
  })

  it('没有 thinking blocks 时不追加 assistant_thinking 消息', async () => {
    const adapter = makeMockAdapter([{ type: 'assistant', content: '普通回答' }])
    const registry = new ToolRegistry()

    const result = await runAgentTurn({
      model: adapter,
      tools: registry,
      messages: [{ role: 'user', content: '普通问题' }],
      cwd: '/tmp',
    })

    const thinkingMsg = result.find(m => m.role === 'assistant_thinking')
    expect(thinkingMsg).toBeUndefined()
  })
})
