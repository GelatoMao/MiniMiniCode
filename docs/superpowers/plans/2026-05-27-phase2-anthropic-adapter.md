# Phase 2：Anthropic API 适配器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Anthropic API 适配器，使 `adapter.next(messages)` 能真实调用 LLM 并返回 `AgentStep`，同时提供离线 `MockModelAdapter` 用于测试。

**Architecture:** 四个文件顺序实现：工具函数（`utils/errors.ts` + `utils/context.ts`）→ 运行时配置（`config.ts`）→ 离线适配器（`mock-model.ts`）→ 真实适配器（`anthropic-adapter.ts`）。适配器通过 `ModelAdapter` 接口与 Agent Loop 解耦，内部负责消息格式转换、重试逻辑和响应解析。

**Tech Stack:** TypeScript 5.4, Node.js fetch API, Vitest, Zod（已有）

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/utils/errors.ts` | ENOENT 错误检测工具函数 |
| `src/utils/context.ts` | 按模型名解析 max_output_tokens |
| `src/config.ts` | 从环境变量加载 RuntimeConfig |
| `src/mock-model.ts` | 离线 MockModelAdapter，解析 slash 命令 |
| `src/anthropic-adapter.ts` | AnthropicModelAdapter：格式转换 + 重试 + 解析 |
| `test/utils.test.ts` | errors.ts / context.ts 单元测试 |
| `test/mock-model.test.ts` | MockModelAdapter 单元测试 |
| `test/anthropic-adapter.test.ts` | AnthropicModelAdapter 单元测试（mock fetch） |

---

## Task 1：工具函数 utils/errors.ts + utils/context.ts

**Files:**
- Create: `src/utils/errors.ts`
- Create: `src/utils/context.ts`
- Create: `test/utils.test.ts`

- [ ] **Step 1：写失败测试**

```typescript
// test/utils.test.ts
import { describe, it, expect } from 'vitest'
import { isEnoentError, getErrorCode } from '../src/utils/errors.js'
import { resolveMaxOutputTokens } from '../src/utils/context.js'

describe('isEnoentError', () => {
  it('code=ENOENT 的 Error 对象返回 true', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    expect(isEnoentError(err)).toBe(true)
  })

  it('其他 code 返回 false', () => {
    const err = Object.assign(new Error('access denied'), { code: 'EACCES' })
    expect(isEnoentError(err)).toBe(false)
  })

  it('非 Error 对象返回 false', () => {
    expect(isEnoentError('string error')).toBe(false)
    expect(isEnoentError(null)).toBe(false)
  })
})

describe('resolveMaxOutputTokens', () => {
  it('已知模型返回对应默认值', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6')).toBe(64_000)
    expect(resolveMaxOutputTokens('claude-haiku-4-5-20251001')).toBe(64_000)
  })

  it('未知模型返回 32_000', () => {
    expect(resolveMaxOutputTokens('unknown-model-xyz')).toBe(32_000)
  })

  it('配置值在 upperLimit 内时生效', () => {
    // claude-sonnet-4-6 upperLimit = 64_000
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', 10_000)).toBe(10_000)
  })

  it('配置值超过 upperLimit 时被截断', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', 999_999)).toBe(64_000)
  })

  it('配置值为 0 或负数时使用默认值', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', 0)).toBe(64_000)
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', -1)).toBe(64_000)
  })
})
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npm test test/utils.test.ts
```

预期：FAIL — 找不到模块

- [ ] **Step 3：实现 src/utils/errors.ts**

```typescript
// [K-08] Node.js 文件系统错误通过 code 字段而非类型识别
export function getErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }

  if (
    error instanceof Error &&
    typeof error.cause === 'object' &&
    error.cause !== null &&
    'code' in error.cause &&
    typeof (error.cause as { code?: unknown }).code === 'string'
  ) {
    return (error.cause as { code: string }).code
  }

  return null
}

export function isEnoentError(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT'
}
```

- [ ] **Step 4：实现 src/utils/context.ts**

```typescript
type ModelMaxOutputTokens = {
  default: number
  upperLimit: number
}

const FALLBACK: ModelMaxOutputTokens = { default: 32_000, upperLimit: 64_000 }

// 匹配规则：pattern 是子串，模型名 toLowerCase 包含它即匹配
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

// 这些工具的输出适合被压缩（Phase 6 使用）
export const COMPACTABLE_TOOLS = new Set([
  'read_file',
  'run_command',
  'list_files',
  'web_fetch',
])
```

- [ ] **Step 5：运行测试，确认通过**

```bash
npm test test/utils.test.ts
```

预期：7 tests passed

- [ ] **Step 6：提交**

```bash
git add src/utils/errors.ts src/utils/context.ts test/utils.test.ts
git commit -m "feat(phase2): 实现 utils/errors.ts 和 utils/context.ts [K-06][K-08]"
```

---

## Task 2：运行时配置 src/config.ts

**Files:**
- Create: `src/config.ts`
- Test: 直接用 vitest 中的环境变量注入测试（不需要单独文件）

- [ ] **Step 1：在 test/utils.test.ts 追加 config 测试**

```typescript
// 追加到 test/utils.test.ts 末尾
import { loadRuntimeConfig } from '../src/config.js'

describe('loadRuntimeConfig', () => {
  it('读取 ANTHROPIC_API_KEY 和 ANTHROPIC_MODEL', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.ANTHROPIC_MODEL = 'claude-test'
    const cfg = await loadRuntimeConfig()
    expect(cfg.apiKey).toBe('test-key')
    expect(cfg.model).toBe('claude-test')
    expect(cfg.baseUrl).toBe('https://api.anthropic.com')
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_MODEL
  })

  it('未设置任何 auth 时抛出错误', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    await expect(loadRuntimeConfig()).rejects.toThrow('ANTHROPIC_API_KEY')
    if (saved) process.env.ANTHROPIC_API_KEY = saved
  })
})
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npm test test/utils.test.ts
```

预期：FAIL — 找不到 config 模块

- [ ] **Step 3：实现 src/config.ts**

```typescript
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
    (process.env.ANTHROPIC_MODEL ?? '').trim() || 'claude-opus-4-7'
  const baseUrl =
    (process.env.ANTHROPIC_BASE_URL ?? '').trim() || 'https://api.anthropic.com'
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim() || undefined
  const authToken = (process.env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined

  if (!apiKey && !authToken) {
    throw new Error(
      'No auth configured. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.',
    )
  }

  const rawMax = process.env.ANTHROPIC_MAX_OUTPUT_TOKENS
  const parsedMax = rawMax === undefined ? NaN : Number(rawMax)
  const maxOutputTokens =
    Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : undefined

  return { model, baseUrl, apiKey, authToken, maxOutputTokens }
}
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npm test test/utils.test.ts
```

预期：9 tests passed

- [ ] **Step 5：提交**

```bash
git add src/config.ts test/utils.test.ts
git commit -m "feat(phase2): 实现 src/config.ts 从环境变量加载 RuntimeConfig"
```

---

## Task 3：离线适配器 src/mock-model.ts

**Files:**
- Create: `src/mock-model.ts`
- Create: `test/mock-model.test.ts`

- [ ] **Step 1：写失败测试**

```typescript
// test/mock-model.test.ts
import { describe, it, expect } from 'vitest'
import { MockModelAdapter } from '../src/mock-model.js'
import type { ChatMessage } from '../src/types.js'

function userMsg(content: string): ChatMessage {
  return { role: 'user', content }
}

function toolResult(toolName: string, content: string): ChatMessage {
  return { role: 'tool_result', toolUseId: 'x', toolName, content, isError: false }
}

describe('MockModelAdapter [K-09]', () => {
  const adapter = new MockModelAdapter()

  it('/ls 触发 list_files 工具调用', async () => {
    const step = await adapter.next([userMsg('/ls')])
    expect(step.type).toBe('tool_calls')
    if (step.type === 'tool_calls') {
      expect(step.calls[0]!.toolName).toBe('list_files')
    }
  })

  it('/ls src/ 传递 path 参数', async () => {
    const step = await adapter.next([userMsg('/ls src/')])
    if (step.type === 'tool_calls') {
      expect(step.calls[0]!.input).toEqual({ path: 'src/' })
    }
  })

  it('/read README.md 触发 read_file', async () => {
    const step = await adapter.next([userMsg('/read README.md')])
    expect(step.type).toBe('tool_calls')
    if (step.type === 'tool_calls') {
      expect(step.calls[0]!.toolName).toBe('read_file')
      expect(step.calls[0]!.input).toEqual({ path: 'README.md' })
    }
  })

  it('/cmd pwd 触发 run_command', async () => {
    const step = await adapter.next([userMsg('/cmd pwd')])
    if (step.type === 'tool_calls') {
      expect(step.calls[0]!.toolName).toBe('run_command')
    }
  })

  it('工具结果到来后返回 assistant 文本', async () => {
    const messages: ChatMessage[] = [
      userMsg('/ls'),
      { role: 'assistant_tool_call', toolUseId: 'x', toolName: 'list_files', input: {} },
      toolResult('list_files', 'src/\ntest/'),
    ]
    const step = await adapter.next(messages)
    expect(step.type).toBe('assistant')
    if (step.type === 'assistant') {
      expect(step.content).toContain('src/')
    }
  })

  it('未知命令返回帮助文本', async () => {
    const step = await adapter.next([userMsg('hello')])
    expect(step.type).toBe('assistant')
    if (step.type === 'assistant') {
      expect(step.content).toContain('/ls')
    }
  })
})
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npm test test/mock-model.test.ts
```

预期：FAIL — 找不到模块

- [ ] **Step 3：实现 src/mock-model.ts**

```typescript
/**
 * [K-09] 适配器模式：MockModelAdapter 实现 ModelAdapter 接口，
 * 用 slash 命令解析代替真实 API 调用，无需网络即可测试完整 Agent Loop。
 */
import type { AgentStep, ChatMessage, ModelAdapter } from './types.js'

function lastUserContent(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user')
  return last?.role === 'user' ? last.content.trim() : ''
}

function lastToolResult(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find(m => m.role === 'tool_result')
}

function lastToolCallName(messages: ChatMessage[]): string | undefined {
  const last = [...messages].reverse().find(m => m.role === 'assistant_tool_call')
  return last?.role === 'assistant_tool_call' ? last.toolName : undefined
}

export class MockModelAdapter implements ModelAdapter {
  async next(messages: ChatMessage[]): Promise<AgentStep> {
    // 优先处理工具结果
    const toolResult = lastToolResult(messages)
    if (toolResult?.role === 'tool_result') {
      const lastCall = lastToolCallName(messages)
      const prefix =
        lastCall === 'list_files' ? '目录内容：\n\n' :
        lastCall === 'read_file' ? '文件内容：\n\n' :
        '工具结果：\n\n'
      return { type: 'assistant', content: prefix + toolResult.content }
    }

    const text = lastUserContent(messages)

    if (text === '/tools') {
      return { type: 'assistant', content: '可用工具：ask_user, list_files, grep_files, read_file, write_file, run_command' }
    }

    if (text.startsWith('/ls')) {
      const dir = text.slice('/ls'.length).trim()
      return {
        type: 'tool_calls',
        calls: [{ id: `mock-${Date.now()}`, toolName: 'list_files', input: dir ? { path: dir } : {} }],
      }
    }

    if (text.startsWith('/read ')) {
      return {
        type: 'tool_calls',
        calls: [{ id: `mock-${Date.now()}`, toolName: 'read_file', input: { path: text.slice('/read '.length).trim() } }],
      }
    }

    if (text.startsWith('/grep ')) {
      const payload = text.slice('/grep '.length).trim()
      const [pattern, searchPath] = payload.split('::')
      return {
        type: 'tool_calls',
        calls: [{ id: `mock-${Date.now()}`, toolName: 'grep_files', input: { pattern: pattern!.trim(), path: searchPath?.trim() || undefined } }],
      }
    }

    if (text.startsWith('/cmd ')) {
      const [command, ...args] = text.slice('/cmd '.length).trim().split(/\s+/)
      return {
        type: 'tool_calls',
        calls: [{ id: `mock-${Date.now()}`, toolName: 'run_command', input: { command, args } }],
      }
    }

    if (text.startsWith('/write ')) {
      const payload = text.slice('/write '.length)
      const splitAt = payload.indexOf('::')
      if (splitAt === -1) return { type: 'assistant', content: '用法: /write 路径::内容' }
      return {
        type: 'tool_calls',
        calls: [{ id: `mock-${Date.now()}`, toolName: 'write_file', input: { path: payload.slice(0, splitAt).trim(), content: payload.slice(splitAt + 2) } }],
      }
    }

    return {
      type: 'assistant',
      content: ['这是离线 Mock 模式，支持以下命令：', '/tools', '/ls [目录]', '/read 路径', '/grep 模式::目录', '/cmd 命令', '/write 路径::内容'].join('\n'),
    }
  }
}
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npm test test/mock-model.test.ts
```

预期：6 tests passed

- [ ] **Step 5：提交**

```bash
git add src/mock-model.ts test/mock-model.test.ts
git commit -m "feat(phase2): 实现 MockModelAdapter [K-09]"
```

---

## Task 4：Anthropic API 适配器 src/anthropic-adapter.ts

**Files:**
- Create: `src/anthropic-adapter.ts`
- Create: `test/anthropic-adapter.test.ts`

- [ ] **Step 1：写失败测试**

```typescript
// test/anthropic-adapter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../src/types.js'
import { getRetryDelayMs, toAnthropicMessages } from '../src/anthropic-adapter.js'

// ── 消息格式转换测试 [K-06] ────────────────────────────────────────────────
describe('toAnthropicMessages [K-06]', () => {
  it('system 消息提取为独立字段', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]
    const { system, messages: out } = toAnthropicMessages(messages)
    expect(system).toBe('你是助手')
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
  })

  it('相邻同角色消息合并为一条', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
    ]
    const { messages: out } = toAnthropicMessages(messages)
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toHaveLength(2)
  })

  it('assistant_tool_call 转为 tool_use block', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '帮我读文件' },
      { role: 'assistant_tool_call', toolUseId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } },
    ]
    const { messages: out } = toAnthropicMessages(messages)
    const assistantMsg = out.find(m => m.role === 'assistant')!
    const block = assistantMsg.content[0]!
    expect(block.type).toBe('tool_use')
    if (block.type === 'tool_use') {
      expect(block.id).toBe('c1')
      expect(block.name).toBe('read_file')
    }
  })

  it('tool_result 转为 tool_result block（user 角色）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '读文件' },
      { role: 'assistant_tool_call', toolUseId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } },
      { role: 'tool_result', toolUseId: 'c1', toolName: 'read_file', content: '文件内容', isError: false },
    ]
    const { messages: out } = toAnthropicMessages(messages)
    const userMsg = out[out.length - 1]!
    expect(userMsg.role).toBe('user')
    const block = userMsg.content[0]!
    expect(block.type).toBe('tool_result')
  })

  it('assistant_progress 包裹为 <progress> 标签', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant_progress', content: '正在处理...' },
    ]
    const { messages: out } = toAnthropicMessages(messages)
    const assistantMsg = out.find(m => m.role === 'assistant')!
    const block = assistantMsg.content[0]!
    expect(block.type).toBe('text')
    if (block.type === 'text') {
      expect(block.text).toContain('<progress>')
      expect(block.text).toContain('正在处理...')
    }
  })
})

// ── 重试延迟计算测试 [K-07] ────────────────────────────────────────────────
describe('getRetryDelayMs [K-07]', () => {
  it('有 retryAfterMs 时直接返回该值', () => {
    expect(getRetryDelayMs(1, 3000)).toBe(3000)
  })

  it('没有 retryAfterMs 时指数递增', () => {
    // attempt=1: base = min(500 * 2^0, 8000) = 500
    const delay1 = getRetryDelayMs(1, null)
    expect(delay1).toBeGreaterThanOrEqual(500)
    expect(delay1).toBeLessThanOrEqual(500 * 1.25 + 1)

    // attempt=2: base = min(500 * 2^1, 8000) = 1000
    const delay2 = getRetryDelayMs(2, null)
    expect(delay2).toBeGreaterThanOrEqual(1000)
    expect(delay2).toBeLessThanOrEqual(1000 * 1.25 + 1)
  })

  it('延迟上限为 8000ms（加 jitter 前）', () => {
    const delay = getRetryDelayMs(100, null)
    expect(delay).toBeLessThanOrEqual(8000 * 1.25 + 1)
  })
})

// ── AnthropicModelAdapter 集成测试（mock fetch）────────────────────────────
import { AnthropicModelAdapter } from '../src/anthropic-adapter.js'
import { ToolRegistry } from '../src/tool.js'

function makeMockFetch(response: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(response),
  })
}

const mockConfig = {
  model: 'claude-opus-4-7',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'test-key',
}

describe('AnthropicModelAdapter', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('文本响应返回 assistant AgentStep', async () => {
    globalThis.fetch = makeMockFetch({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '你好！' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const adapter = new AnthropicModelAdapter(new ToolRegistry(), async () => mockConfig)
    const step = await adapter.next([{ role: 'user', content: '你好' }])
    expect(step.type).toBe('assistant')
    if (step.type === 'assistant') {
      expect(step.content).toBe('你好！')
      expect(step.usage?.totalTokens).toBe(15)
    }
  })

  it('tool_use 响应返回 tool_calls AgentStep', async () => {
    globalThis.fetch = makeMockFetch({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/main.ts' } },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    })

    const adapter = new AnthropicModelAdapter(new ToolRegistry(), async () => mockConfig)
    const step = await adapter.next([{ role: 'user', content: '读文件' }])
    expect(step.type).toBe('tool_calls')
    if (step.type === 'tool_calls') {
      expect(step.calls[0]!.toolName).toBe('read_file')
      expect(step.calls[0]!.input).toEqual({ path: 'src/main.ts' })
    }
  })

  it('429 响应后重试，第二次成功', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '0' }, // retry-after: 0 秒
          text: async () => JSON.stringify({ error: { message: 'rate limit' } }),
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '重试成功' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      }
    })

    const adapter = new AnthropicModelAdapter(new ToolRegistry(), async () => mockConfig)
    const step = await adapter.next([{ role: 'user', content: '你好' }])
    expect(step.type).toBe('assistant')
    expect(callCount).toBe(2)
  })

  it('非重试状态码（400）立即抛出错误', async () => {
    globalThis.fetch = makeMockFetch(
      { error: { message: '参数错误' } },
      400,
    )

    const adapter = new AnthropicModelAdapter(new ToolRegistry(), async () => mockConfig)
    await expect(
      adapter.next([{ role: 'user', content: '你好' }]),
    ).rejects.toThrow('参数错误')
  })
})
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npm test test/anthropic-adapter.test.ts
```

预期：FAIL — 找不到 `toAnthropicMessages` 和 `getRetryDelayMs` 导出

- [ ] **Step 3：实现 src/anthropic-adapter.ts**

```typescript
/**
 * [K-06] Anthropic Messages API 适配器
 *
 * 职责：
 * 1. 将内部 ChatMessage[] 转换为 Anthropic API 格式
 * 2. 发送 HTTP 请求，含指数退避重试 [K-07]
 * 3. 解析响应（text / tool_use / thinking 块）
 */
import type { ToolRegistry } from './tool.js'
import type { ChatMessage, ModelAdapter, ProviderThinkingBlock, ProviderUsage, StepDiagnostics, ToolCall } from './types.js'
import type { RuntimeConfig } from './config.js'
import { resolveMaxOutputTokens } from './utils/context.js'

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

// ── Anthropic API 内部类型 ──────────────────────────────────────────────────

type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
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
 * 公式：min(BASE * 2^(attempt-1), MAX) * (1 + random * 0.25)
 */
export function getRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs
  const base = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS)
  return Math.floor(base + Math.random() * 0.25 * base)
}

function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'object' && data !== null) {
    if ('error' in data) {
      const e = (data as { error: unknown }).error
      if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message?: unknown }).message === 'string') {
        return (e as { message: string }).message.trim()
      }
      if (typeof e === 'string') return e.trim()
    }
    if ('message' in data && typeof (data as { message?: unknown }).message === 'string') {
      return ((data as { message: string }).message).trim()
    }
  }
  return `Model request failed: ${status}`
}

// ── 消息格式转换 [K-06] ──────────────────────────────────────────────────────

/**
 * 将相邻同角色消息推入数组（合并 content 块）
 * Anthropic API 要求相邻 user 或 assistant 消息必须合并为一条
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

/** 将 assistant_progress 包裹为 <progress> 标签，方便模型识别中间状态 */
function assistantText(msg: Extract<ChatMessage, { role: 'assistant' | 'assistant_progress' }>): string {
  return msg.role === 'assistant_progress'
    ? `<progress>\n${msg.content}\n</progress>`
    : msg.content
}

/** 将内部 ChatMessage[] 转换为 Anthropic API 所需的 { system, messages } 格式 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicApiMessage[]
} {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => m.role === 'system' ? m.content : '')
    .join('\n\n')

  const out: AnthropicApiMessage[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'system': break // 已提取

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

// ── AnthropicModelAdapter ────────────────────────────────────────────────────

/**
 * [K-09] 适配器模式实现：AnthropicModelAdapter 实现 ModelAdapter 接口。
 * 通过 getRuntimeConfig 工厂函数注入配置，支持动态刷新（Phase 5 需要）。
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

    // [K-07] 重试循环：429 / 5xx 触发指数退避重试
    const maxRetries = Number.isFinite(Number(process.env.ANTHROPIC_MAX_RETRIES))
      ? Math.max(0, Math.floor(Number(process.env.ANTHROPIC_MAX_RETRIES)))
      : DEFAULT_MAX_RETRIES

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

    // [K-08] 响应块解析：区分 text / tool_use / thinking 块
    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()

    for (const block of data.content ?? []) {
      blockTypes.push(block.type)
      if (block.type === 'text' && typeof (block as AnthropicTextBlock).text === 'string') {
        textParts.push((block as AnthropicTextBlock).text)
      } else if (
        block.type === 'tool_use' &&
        typeof (block as AnthropicToolUseBlock).id === 'string'
      ) {
        const b = block as AnthropicToolUseBlock
        toolCalls.push({ id: b.id, toolName: b.name, input: b.input })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        thinkingBlocks.push(block as ProviderThinkingBlock)
      } else {
        ignoredBlockTypes.add(block.type)
      }
    }

    const rawText = textParts.join('\n').trim()
    const diagnostics: StepDiagnostics = {
      stopReason: data.stop_reason,
      blockTypes,
      ignoredBlockTypes: [...ignoredBlockTypes],
    }
    const usage = normalizeUsage(data.usage)

    // 解析 <final> / <progress> / [FINAL] / [PROGRESS] 标记
    const parsedText = parseAssistantMarkers(rawText)

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls' as const,
        calls: toolCalls,
        content: parsedText.content || undefined,
        contentKind: parsedText.kind === 'progress' ? ('progress' as const) : undefined,
        thinkingBlocks,
        diagnostics,
        usage,
      }
    }

    return {
      type: 'assistant' as const,
      content: parsedText.content,
      kind: parsedText.kind,
      thinkingBlocks,
      diagnostics,
      usage,
    }
  }
}

function parseAssistantMarkers(text: string): { content: string; kind?: 'final' | 'progress' } {
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
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npm test test/anthropic-adapter.test.ts
```

预期：11 tests passed

- [ ] **Step 5：运行全部测试**

```bash
npm test && npm run check
```

预期：全部通过，tsc 无报错

- [ ] **Step 6：提交**

```bash
git add src/anthropic-adapter.ts test/anthropic-adapter.test.ts
git commit -m "feat(phase2): 实现 AnthropicModelAdapter [K-06][K-07][K-08][K-09]"
```

---

## Task 5：更新 KNOWLEDGE.md 并最终提交

**Files:**
- Modify: `docs/KNOWLEDGE.md`

- [ ] **Step 1：在 docs/KNOWLEDGE.md Phase 2 部分填写以下内容**

在 `## Phase 2（待实现）` 章节替换为：

```markdown
## Phase 2：Anthropic API 适配器

### [K-06] Anthropic Messages API 格式转换

**文件**：`src/anthropic-adapter.ts` → `toAnthropicMessages()`

内部 `ChatMessage[]` 与 Anthropic API 格式的关键差异：

1. `system` 消息单独提取，不放入 messages 数组
2. 相邻同角色消息必须合并为一条（API 限制）
3. `assistant_tool_call` → `tool_use` block（assistant 角色）
4. `tool_result` → `tool_result` block（user 角色）
5. `assistant_progress` → `<progress>...</progress>` 包裹的 text block

```
内部格式：             Anthropic API 格式：
system               → system: string（独立字段）
user                 → { role: 'user', content: [{ type: 'text', text }] }
assistant            → { role: 'assistant', content: [{ type: 'text', text }] }
assistant_tool_call  → { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
tool_result          → { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
```

---

### [K-07] 指数退避 + Jitter 重试策略

**文件**：`src/anthropic-adapter.ts` → `getRetryDelayMs()`

触发条件：HTTP 429（限流）或 5xx（服务端错误）

```
delay = min(500 * 2^(attempt-1), 8000) * (1 + random * 0.25)
```

- **指数退避**：每次重试间隔翻倍，避免持续冲击限流的 API
- **Jitter（抖动）**：加入随机因子，防止多个客户端同时重试造成"惊群效应"
- **上限 8000ms**：避免等待时间过长影响用户体验
- **优先读取 Retry-After**：服务端告知等待时间时直接使用

---

### [K-08] 响应块解析（Text / Tool Use / Thinking）

**文件**：`src/anthropic-adapter.ts` → `AnthropicModelAdapter.next()`

Anthropic API 响应的 `content` 字段是混合块数组，需要按类型分拣：

```typescript
for (const block of data.content ?? []) {
  if (block.type === 'text') textParts.push(block.text)
  else if (block.type === 'tool_use') toolCalls.push(...)
  else if (block.type === 'thinking') thinkingBlocks.push(block)
  else ignoredBlockTypes.add(block.type) // 未来新块类型的容错
}
```

决策逻辑：
- `toolCalls.length > 0` → 返回 `{ type: 'tool_calls', calls }`
- 否则 → 返回 `{ type: 'assistant', content }`

---

### [K-09] 适配器模式（MockModelAdapter）

**文件**：`src/mock-model.ts`

通过实现相同的 `ModelAdapter` 接口，`MockModelAdapter` 可以在测试时替代 `AnthropicModelAdapter`：
- 无需真实 API Key
- 无网络延迟
- 响应完全可控

这是依赖倒置原则（DIP）的典型应用：Agent Loop 只依赖 `ModelAdapter` 接口，
不关心背后是真实 API 还是 Mock。
```

- [ ] **Step 2：运行全部测试最终确认**

```bash
npm test && npm run check
```

预期：全部通过

- [ ] **Step 3：提交文档更新**

```bash
git add docs/KNOWLEDGE.md
git commit -m "docs: 更新 KNOWLEDGE.md Phase 2 知识点 [K-06][K-07][K-08][K-09]"
```

---

## 自查清单

**Spec 覆盖：**
- [x] 2.1 消息格式转换 → Task 4 `toAnthropicMessages()`
- [x] 2.2 重试机制 → Task 4 `getRetryDelayMs()` + 重试循环
- [x] 2.3 响应解析 → Task 4 response block 解析
- [x] 2.4 Mock 适配器 → Task 3 `MockModelAdapter`

**类型一致性：**
- `AnthropicModelAdapter` 构造函数接受 `ToolRegistry`（Phase 1 已有）和 `() => Promise<RuntimeConfig>`
- 导出 `toAnthropicMessages` 和 `getRetryDelayMs` 用于测试
- `RuntimeConfig` 在 `config.ts` 中定义，adapter 直接 import
