# Phase 3: Agent Loop 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ReAct Agent 主循环，让 Agent 能自主完成"调用工具 → 分析结果 → 继续推理"的多步任务。

**Architecture:** `runAgentTurn` 函数接收初始消息列表，在 for 循环里反复调用 `model.next()` 驱动推理；遇到 `tool_calls` 则顺序执行工具并将结果追加到消息历史；遇到 `assistant` 类型（且非 progress/空响应情况）时退出循环并返回完整消息历史。`prompt.ts` 负责构建系统提示词，Phase 3 仅含基础版本（无 MCP/skills/memory，这些是 Phase 5 的内容）。

**Tech Stack:** TypeScript, vitest（测试），Node.js ESM（type: module）

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/prompt.ts` | 新建 | 构建 system prompt 字符串（K-15） |
| `src/agent-loop.ts` | 新建 | Agent 主循环，含韧性恢复逻辑（K-10 ~ K-14） |
| `test/agent-loop.test.ts` | 新建 | 集成测试，覆盖所有控制流分支 |
| `test/prompt.test.ts` | 新建 | prompt 单元测试 |
| `docs/KNOWLEDGE.md` | 修改 | 填写 K-10 ~ K-15 知识点 |

---

## Task 1: 系统提示词 —— `src/prompt.ts`（K-15）

**Files:**
- Create: `src/prompt.ts`
- Test: `test/prompt.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/prompt.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompt.js'

describe('buildSystemPrompt [K-15]', () => {
  it('包含 cwd 路径', async () => {
    const prompt = await buildSystemPrompt('/home/user/project')
    expect(prompt).toContain('/home/user/project')
  })

  it('包含结构化响应协议说明', async () => {
    const prompt = await buildSystemPrompt('/tmp')
    expect(prompt).toContain('<progress>')
    expect(prompt).toContain('<final>')
  })

  it('包含 mini-code 角色定义', async () => {
    const prompt = await buildSystemPrompt('/tmp')
    expect(prompt).toContain('mini-code')
  })

  it('返回字符串，不为空', async () => {
    const prompt = await buildSystemPrompt('/tmp')
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(100)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/prompt.test.ts
```

预期输出：`FAIL test/prompt.test.ts` — 找不到模块 `../src/prompt.js`

- [ ] **Step 3: 实现 `src/prompt.ts`**

```typescript
/**
 * [K-15] System Prompt 工程
 *
 * 系统提示词动态注入：
 * - cwd：让模型知道工作目录，工具操作默认相对于此路径
 * - 结构化响应协议：约定 <progress>/<final> 标签，Agent Loop 据此判断是否退出
 *
 * Phase 5 会扩展：注入权限摘要、skills 列表、MCP 服务器列表、MEMORY 文件内容
 */
export async function buildSystemPrompt(cwd: string): Promise<string> {
  const parts = [
    'You are mini-code, a terminal coding assistant.',
    'Default behavior: inspect the repository, use tools, make code changes when appropriate, and explain results clearly.',
    'Prefer reading files, searching code, editing files, and running verification commands over giving purely theoretical advice.',
    `Current cwd: ${cwd}`,
    'You can inspect or modify paths outside the current cwd when the user asks.',
    'When making code changes, keep them minimal, practical, and working-oriented.',
    'If the user clearly asked you to build, modify, optimize, or generate something, do the work instead of stopping at a plan.',
    'If you need user clarification, call the ask_user tool with one concise question. Do not ask clarifying questions as plain assistant text.',
    'Do not choose subjective preferences such as colors, visual style, copy tone, or naming unless the user explicitly told you to decide yourself.',
    'Structured response protocol:',
    '- When you are still working and will continue with more tool calls, start your text with <progress>.',
    '- Only when the task is actually complete and you are ready to hand control back, start your text with <final>.',
    '- Do not stop after a progress update. After a <progress> message, continue the task in the next step.',
    '- Plain assistant text without <progress> is treated as a completed assistant message for this turn.',
  ]

  return parts.join('\n\n')
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/prompt.test.ts
```

预期输出：`PASS test/prompt.test.ts` — 4 个测试通过

- [ ] **Step 5: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add src/prompt.ts test/prompt.test.ts && git commit -m "feat(phase3): add buildSystemPrompt [K-15]"
```

---

## Task 2: Agent Loop 骨架 —— 基础 assistant 流（K-10）

**Files:**
- Create: `src/agent-loop.ts`
- Create: `test/agent-loop.test.ts`

- [ ] **Step 1: 写失败测试（基础 assistant 流）**

创建 `test/agent-loop.test.ts`：

```typescript
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
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：`FAIL` — 找不到模块 `../src/agent-loop.js`

- [ ] **Step 3: 实现 agent-loop.ts 骨架（仅支持 assistant 分支）**

创建 `src/agent-loop.ts`：

```typescript
/**
 * [K-10] ReAct Agent 主循环
 *
 * ReAct = Reason（推理）+ Act（工具执行）反复迭代，直到任务完成。
 *
 * 核心控制流：
 *   for step in maxSteps:
 *     next = model.next(messages)
 *     if next.type === 'assistant' → （可能重试或）退出循环
 *     if next.type === 'tool_calls' → 顺序执行工具，追加消息，继续
 */
import type { ChatMessage, ModelAdapter, ProviderThinkingBlock } from './types.js'
import type { ToolRegistry } from './tool.js'

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

/**
 * [K-14] Thinking Block 跨轮次保留
 *
 * Extended Thinking 块必须保留在消息历史里，模型才能"接续思考"。
 * 如果清除了 thinking 块，下一轮 API 会报告"thinking block 丢失"错误。
 */
function appendThinkingBlocks(
  messages: ChatMessage[],
  blocks: ProviderThinkingBlock[] | undefined,
): ChatMessage[] {
  if (!blocks || blocks.length === 0) return messages
  return [...messages, { role: 'assistant_thinking', blocks }]
}

/**
 * [K-12] 判断是否为可恢复的 Thinking 阶段停止
 *
 * 触发条件：模型在 thinking 阶段触发 pause_turn 或 max_tokens，
 * 文本内容为空（因为只有 thinking 块，没有文本输出）。
 * 此时应注入 continuation prompt 让模型继续，而非视为错误。
 */
function isRecoverableThinkingStop(args: {
  isEmpty: boolean
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): boolean {
  if (!args.isEmpty) return false
  if (args.stopReason !== 'pause_turn' && args.stopReason !== 'max_tokens') return false
  return (
    (args.blockTypes ?? []).includes('thinking') ||
    (args.ignoredBlockTypes ?? []).includes('thinking')
  )
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

export async function runAgentTurn(args: {
  model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  /** 最大工具调用步数，防止无限循环（默认 100）*/
  maxSteps?: number
  onToolStart?: (toolName: string, input: unknown) => void
  onToolResult?: (toolName: string, output: string, isError: boolean) => void
  onAssistantMessage?: (content: string) => void
  onProgressMessage?: (content: string) => void
}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps ?? 100
  let messages = args.messages
  let emptyResponseRetryCount = 0
  let recoverableThinkingRetryCount = 0
  let toolErrorCount = 0
  let sawToolResultThisTurn = false

  // [K-13] 注入续写提示词，驱动模型继续未完成的任务
  const pushContinuationPrompt = (content: string) => {
    messages = [...messages, { role: 'user', content }]
  }

  for (let step = 0; step < maxSteps; step++) {
    const next = await args.model.next(messages)

    // ── assistant 分支 ─────────────────────────────────────────────────────
    if (next.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(next.content)

      // [K-14] 保留 thinking blocks（无论是否空响应都要先保留）
      messages = appendThinkingBlocks(messages, next.thinkingBlocks)

      // [K-12] Thinking 阶段可恢复停止（最多重试 3 次）
      if (
        isRecoverableThinkingStop({
          isEmpty,
          stopReason: next.diagnostics?.stopReason,
          blockTypes: next.diagnostics?.blockTypes,
          ignoredBlockTypes: next.diagnostics?.ignoredBlockTypes,
        }) &&
        recoverableThinkingRetryCount < 3
      ) {
        recoverableThinkingRetryCount++
        const progressContent =
          next.diagnostics?.stopReason === 'max_tokens'
            ? '模型在 thinking 阶段触发 max_tokens，正在继续请求后续步骤...'
            : '模型返回 pause_turn，正在继续请求后续步骤...'
        args.onProgressMessage?.(progressContent)
        messages = [...messages, { role: 'assistant_progress', content: progressContent }]
        pushContinuationPrompt(
          next.diagnostics?.stopReason === 'max_tokens'
            ? 'Your previous response hit max_tokens during thinking. Resume immediately with the next concrete tool call, code change, or an explicit <final> answer only if the task is complete.'
            : 'Resume from the previous pause_turn and continue the task immediately.',
        )
        continue
      }

      // [K-12] 空响应重试（最多 2 次），注入续写提示让模型继续
      if (isEmpty && emptyResponseRetryCount < 2) {
        emptyResponseRetryCount++
        pushContinuationPrompt(
          sawToolResultThisTurn
            ? 'Your last response was empty after recent tool results. Continue immediately by trying the next concrete step, adapting to any tool errors, or giving an explicit <final> answer only if the task is complete.'
            : 'Your last response was empty. Continue immediately with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
        continue
      }

      // [K-12] 重试耗尽 → 优雅降级，生成诊断消息并退出
      if (isEmpty) {
        const fallbackContent =
          sawToolResultThisTurn
            ? toolErrorCount > 0
              ? `工具执行后模型返回空响应，已停止当前回合。最近有 ${toolErrorCount} 个工具报错；请重试、调整命令，或要求模型改用其他方案。`
              : '工具执行后模型返回空响应，已停止当前回合。请重试，或要求模型继续完成剩余步骤。'
            : '模型返回空响应，已停止当前回合。请重试，或要求模型继续。'
        args.onAssistantMessage?.(fallbackContent)
        return [...messages, { role: 'assistant', content: fallbackContent }]
      }

      // [K-13] progress 类型：追加进度消息 + continuation prompt，继续循环
      if (next.kind === 'progress') {
        args.onProgressMessage?.(next.content)
        messages = [...messages, { role: 'assistant_progress', content: next.content }]
        pushContinuationPrompt(
          'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
        continue
      }

      // 正常 assistant 响应 → 退出循环，返回完整消息历史
      args.onAssistantMessage?.(next.content)
      return [...messages, { role: 'assistant', content: next.content }]
    }

    // ── tool_calls 分支（Task 3 实现，此处先留空占位）──────────────────────
    // TODO: Task 3 填充工具执行逻辑
    return messages
  }

  // [K-12] 超过 maxSteps → 优雅降级
  const maxStepContent = '达到最大工具步数限制，已停止当前回合。'
  args.onAssistantMessage?.(maxStepContent)
  return [...messages, { role: 'assistant', content: maxStepContent }]
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：`PASS test/agent-loop.test.ts` — 前 3 个测试通过（仅 ReAct 骨架测试）

- [ ] **Step 5: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add src/agent-loop.ts test/agent-loop.test.ts && git commit -m "feat(phase3): add runAgentTurn skeleton — assistant branch [K-10]"
```

---

## Task 3: 工具执行 + 消息追加（K-11）

**Files:**
- Modify: `src/agent-loop.ts`（填充 tool_calls 分支）
- Modify: `test/agent-loop.test.ts`（追加测试用例）

- [ ] **Step 1: 在 test/agent-loop.test.ts 追加工具执行测试**

在文件末尾（最后一个 `}` 之前）追加：

```typescript
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

  it('工具失败（ok: false）时 isError=true，toolErrorCount 增加', async () => {
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

    // ToolRegistry.execute 对未知工具返回 {ok: false}
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

    // awaitUser=true 时，问题作为 assistant 消息输出，循环停止（第二个 adapter 步骤不会被调用）
    expect(onAssistantMessage).toHaveBeenCalledWith('你叫什么名字？')
    expect(onAssistantMessage).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试，确认新测试失败**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：工具执行测试全部 FAIL（agent-loop.ts 里 tool_calls 分支是空的）

- [ ] **Step 3: 实现 agent-loop.ts 的 tool_calls 分支**

将 `src/agent-loop.ts` 里的 `// ── tool_calls 分支` 占位注释替换为：

```typescript
    // ── tool_calls 分支 ────────────────────────────────────────────────────

    // [K-14] tool_calls 也可能携带 thinking blocks，需要先保留
    messages = appendThinkingBlocks(messages, next.thinkingBlocks)

    // [K-13] tool_calls 的前置文本（模型在发起工具调用前可能先说一句话）
    if (next.content) {
      if (next.contentKind === 'progress') {
        args.onProgressMessage?.(next.content)
        messages = [...messages, { role: 'assistant_progress', content: next.content }]
      } else {
        args.onAssistantMessage?.(next.content)
        messages = [...messages, { role: 'assistant', content: next.content }]
      }
    }

    // [K-11] 顺序执行所有工具调用
    // 设计原则：失败不中断——一个工具失败不影响后续工具的执行，
    // 错误信息以 isError=true 的 tool_result 反馈给模型，让模型自行决策
    const toolCallMessages: ChatMessage[] = []
    const toolResultMessages: ChatMessage[] = []
    let awaitUserResult: { output: string } | undefined

    for (const call of next.calls) {
      args.onToolStart?.(call.toolName, call.input)
      const result = await args.tools.execute(call.toolName, call.input, { cwd: args.cwd })

      sawToolResultThisTurn = true
      if (!result.ok) toolErrorCount++
      args.onToolResult?.(call.toolName, result.output, !result.ok)

      toolCallMessages.push({
        role: 'assistant_tool_call',
        toolUseId: call.id,
        toolName: call.toolName,
        input: call.input,
      })

      toolResultMessages.push({
        role: 'tool_result',
        toolUseId: call.id,
        toolName: call.toolName,
        content: result.output,
        isError: !result.ok,
      })

      // [K-26] awaitUser 信号：工具希望 Agent Loop 暂停，等待用户输入
      // 收到信号后立即停止执行后续工具，退出循环
      if (result.awaitUser) {
        awaitUserResult = { output: result.output }
        break
      }
    }

    messages = [...messages, ...toolCallMessages, ...toolResultMessages]

    if (awaitUserResult) {
      const question = awaitUserResult.output.trim()
      if (question.length > 0) {
        args.onAssistantMessage?.(question)
        messages = [...messages, { role: 'assistant', content: question }]
      }
      return messages
    }
```

同时删除原来那行 `return messages`（Task 2 遗留的占位符）。

- [ ] **Step 4: 运行全部 agent-loop 测试**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：`PASS test/agent-loop.test.ts` — 所有工具执行测试通过

- [ ] **Step 5: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add src/agent-loop.ts test/agent-loop.test.ts && git commit -m "feat(phase3): implement tool execution branch [K-11, K-26]"
```

---

## Task 4: 韧性设计 —— 空响应 + Thinking 恢复（K-12）

**Files:**
- Modify: `test/agent-loop.test.ts`（追加测试用例）

> `agent-loop.ts` 已在 Task 2 实现了 K-12 逻辑，本 Task 仅补充测试覆盖。

- [ ] **Step 1: 追加 K-12 韧性测试**

在 `test/agent-loop.test.ts` 末尾追加：

```typescript
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
    // 降级消息应包含"空响应"相关提示
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
    expect(lastUserMsg?.role === 'user' && lastUserMsg.content).toContain('empty')
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
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：`PASS test/agent-loop.test.ts` — 所有 K-12 测试通过

- [ ] **Step 3: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add test/agent-loop.test.ts && git commit -m "test(phase3): add resilience tests [K-12]"
```

---

## Task 5: Progress 消息 + Continuation Prompt（K-13）

**Files:**
- Modify: `test/agent-loop.test.ts`（追加测试用例）

> `agent-loop.ts` 的 progress 逻辑已在 Task 2 实现，本 Task 仅补充测试。

- [ ] **Step 1: 追加 K-13 测试**

在 `test/agent-loop.test.ts` 末尾追加：

```typescript
// ── [K-13] Continuation Prompt ──────────────────────────────────────────────

describe('runAgentTurn — Continuation Prompt [K-13]', () => {
  it('kind=progress 时追加 assistant_progress 消息 + continuation prompt 并继续', async () => {
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

    // onProgressMessage 被调用了
    expect(onProgressMessage).toHaveBeenCalledWith('正在分析...')
    // 最终结果包含 assistant_progress 消息
    const progressMsg = result.find(m => m.role === 'assistant_progress')
    expect(progressMsg).toBeDefined()
    // 最终 assistant 消息是"分析完成"
    expect(onAssistantMessage).toHaveBeenCalledWith('分析完成')
  })

  it('tool_calls 的前置 progress 文本被正确追加', async () => {
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
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：`PASS test/agent-loop.test.ts` — K-13 测试全部通过

- [ ] **Step 3: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add test/agent-loop.test.ts && git commit -m "test(phase3): add continuation prompt tests [K-13]"
```

---

## Task 6: Thinking Block 跨轮次保留（K-14）

**Files:**
- Modify: `test/agent-loop.test.ts`（追加测试用例）

> `agent-loop.ts` 的 thinking block 逻辑已在 Task 2、3 实现，本 Task 仅补充测试。

- [ ] **Step 1: 追加 K-14 测试**

在 `test/agent-loop.test.ts` 末尾追加：

```typescript
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
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run test/agent-loop.test.ts
```

预期：`PASS test/agent-loop.test.ts` — K-14 测试全部通过

- [ ] **Step 3: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add test/agent-loop.test.ts && git commit -m "test(phase3): add thinking block preservation tests [K-14]"
```

---

## Task 7: 全量测试 + 类型检查

**Files:**
- 无新增文件

- [ ] **Step 1: 运行全量测试套件**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run
```

预期：所有测试文件通过，无 FAIL

- [ ] **Step 2: TypeScript 类型检查**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx tsc --noEmit
```

预期：无编译错误

- [ ] **Step 3: 提交（如果有未提交改动）**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git status
# 只在有改动时执行：
git add -A && git commit -m "test(phase3): verify full test suite passes"
```

---

## Task 8: 填写 KNOWLEDGE.md（K-10 ~ K-15）

**Files:**
- Modify: `docs/KNOWLEDGE.md`（填充第三层知识点）

- [ ] **Step 1: 替换 KNOWLEDGE.md 中 K-10 ~ K-15 的占位内容**

将 `docs/KNOWLEDGE.md` 中以下 6 个占位块：

```markdown
### [K-10] ReAct 框架

> 待实现 Phase 3 时填写
```
... 直到 `### [K-15]` 结束的整段内容，替换为：

```markdown
## 第三层：Agent 核心

### [K-10] ReAct 框架

**文件**：`src/agent-loop.ts` → `runAgentTurn()`

ReAct = **Re**ason（推理）+ **Act**（执行）的交替循环。

```
┌──────────────────────────────────────────────┐
│  for step in maxSteps:                       │
│    next = model.next(messages)               │
│    ┌── 'assistant' ──► 退出循环（或重试）    │
│    └── 'tool_calls' ──► 执行工具 ──► 继续   │
└──────────────────────────────────────────────┘
```

每一轮都向 `messages` 追加新消息，消息历史是模型"记忆"的唯一载体。
`maxSteps` 是安全阀，防止模型进入无限工具调用循环。

---

### [K-11] 工具执行与错误收集

**文件**：`src/agent-loop.ts` → `tool_calls` 分支

**三个设计决策：**

1. **顺序执行（非并行）**：工具 B 的输入可能依赖工具 A 的输出，串行更安全。
2. **失败不中断**：一个工具失败后继续执行剩余工具，错误作为 `isError=true` 的 `tool_result` 反馈给模型，让模型自行决策是重试还是换策略。
3. **awaitUser 信号例外**：收到此信号后立即 `break`，不再执行后续工具，因为需要等待用户输入后才能继续。

```typescript
for (const call of next.calls) {
  const result = await tools.execute(call.toolName, call.input, { cwd })
  toolCallMessages.push({ role: 'assistant_tool_call', ... })
  toolResultMessages.push({ role: 'tool_result', isError: !result.ok, ... })
  if (result.awaitUser) break  // [K-26] 暂停等待用户
}
messages = [...messages, ...toolCallMessages, ...toolResultMessages]
```

---

### [K-12] 韧性设计模式（Resilience Patterns）

**文件**：`src/agent-loop.ts`

三类异常情况及恢复策略：

| 异常 | 触发条件 | 恢复策略 |
|------|---------|---------|
| 空响应 | `content.trim() === ''` | 注入 continuation prompt，最多重试 2 次；耗尽后降级输出提示消息 |
| Thinking 阶段中断 | `stopReason=pause_turn/max_tokens` 且有 thinking block | 注入 continuation prompt，最多重试 3 次 |
| maxSteps 超限 | `step >= maxSteps` | 退出循环，输出"达到最大步数"提示消息 |

为什么空响应要重试而不立即报错？
LLM 在复杂上下文下偶尔会产生空输出（特别是 Extended Thinking 场景），通常一次 continuation prompt 就能恢复。重试成本低，直接报错会中断本可以完成的任务。

---

### [K-13] Continuation Prompt 工程

**文件**：`src/agent-loop.ts` → `pushContinuationPrompt()`

Agent Loop 在三种情况下注入 continuation prompt（作为 `user` 角色消息追加到历史）：

1. **空响应**：`'Your last response was empty. Continue immediately...'`
2. **Progress 消息**：`'Continue immediately from your <progress> update...'`
3. **Thinking 中断**：`'Your previous response hit max_tokens during thinking. Resume immediately...'`

设计要点：
- 必须是 `user` 角色（模型视角：用户催促继续），而非 `assistant`
- 措辞要求"立即"行动（immediately），防止模型再次产生纯文字分析
- 根据上下文（是否有工具结果、错误）选择不同措辞，帮助模型理解当前状态

---

### [K-14] Extended Thinking 跨轮次状态管理

**文件**：`src/agent-loop.ts` → `appendThinkingBlocks()`

Extended Thinking 的关键约束：

> Anthropic API 要求：如果上一轮响应包含 `thinking` 块，下一轮请求的 messages 中必须包含对应的 `assistant_thinking` 消息，否则 API 会报错（thinking block 缺失）。

**实现**：每次模型返回（无论是 `assistant` 还是 `tool_calls`），都先检查 `thinkingBlocks` 字段，非空时立即追加 `assistant_thinking` 消息到 `messages`，然后再处理其他逻辑。

```typescript
// 保留 thinking blocks 的位置：先于一切其他消息追加
messages = appendThinkingBlocks(messages, next.thinkingBlocks)
```

---

### [K-15] System Prompt 工程

**文件**：`src/prompt.ts` → `buildSystemPrompt()`

System Prompt 是模型行为的"宪法"，需要覆盖：

| 内容 | 作用 |
|------|------|
| 角色定义 | 告诉模型它是谁（mini-code，终端编程助手）|
| 工作目录 `cwd` | 让模型知道工具操作的默认路径 |
| 行为偏好 | 优先动手而非给建议；不做未被要求的主观选择 |
| 结构化响应协议 | 约定 `<progress>`/`<final>` 标签，Agent Loop 据此判断是否退出 |

Phase 5 会在此基础上扩展：注入权限摘要、skills 列表、MCP 服务器信息、MEMORY 文件内容（K-40）。
```

- [ ] **Step 2: 运行全量测试，确认文档更新不影响测试**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && npx vitest run
```

预期：`PASS` — 测试与文档修改无关，全部通过

- [ ] **Step 3: 提交**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode && git add docs/KNOWLEDGE.md && git commit -m "docs(phase3): fill K-10~K-15 in KNOWLEDGE.md"
```

---

## 验收标准

Phase 3 完成后可验证：

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode

# 1. 全量测试通过
npx vitest run
# 预期：所有测试文件通过

# 2. 类型检查通过
npx tsc --noEmit
# 预期：无编译错误

# 3. 新增文件确认
ls src/agent-loop.ts src/prompt.ts
# 预期：两个文件都存在

# 4. 新增测试文件确认
ls test/agent-loop.test.ts test/prompt.test.ts
# 预期：两个测试文件都存在
```

集成验证（需要真实 API Key）：

```bash
# 用 MockModelAdapter 离线演示完整工具调用流程
ANTHROPIC_API_KEY=dummy npx tsx -e "
import { runAgentTurn } from './src/agent-loop.js'
import { MockModelAdapter } from './src/mock-model.js'
import { ToolRegistry } from './src/tool.js'
import { readFileTool } from './src/tools/read-file.js'

const result = await runAgentTurn({
  model: new MockModelAdapter(),
  tools: new ToolRegistry([readFileTool]),
  messages: [{ role: 'user', content: '/read README.md' }],
  cwd: process.cwd(),
  onToolStart: (name, input) => console.log('[工具调用]', name, input),
  onToolResult: (name, output) => console.log('[工具结果]', name, output.slice(0, 100)),
  onAssistantMessage: (content) => console.log('[助手]', content.slice(0, 200)),
})
console.log('消息历史长度:', result.length)
" 2>/dev/null
```

---

## 自查清单

**Spec 覆盖：**
- ✅ 3.1 主循环骨架（K-10）→ Task 2
- ✅ 3.2 工具调用顺序执行（K-11）→ Task 3
- ✅ 3.3 空响应/异常恢复（K-12）→ Task 2 实现 + Task 4 测试
- ✅ 3.4 Continuation Prompt（K-13）→ Task 2 实现 + Task 5 测试
- ✅ 3.5 Thinking Block 跨轮次保留（K-14）→ Task 2、3 实现 + Task 6 测试
- ✅ 3.6 系统提示词构建（K-15）→ Task 1
