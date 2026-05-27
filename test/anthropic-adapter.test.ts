import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../src/types.js'
import { getRetryDelayMs, toAnthropicMessages, AnthropicModelAdapter } from '../src/anthropic-adapter.js'
import { ToolRegistry } from '../src/tool.js'
import type { RuntimeConfig } from '../src/config.js'

// ── toAnthropicMessages [K-06] ─────────────────────────────────────────────

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
    const lastMsg = out[out.length - 1]!
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content[0]!.type).toBe('tool_result')
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

// ── getRetryDelayMs [K-07] ─────────────────────────────────────────────────

describe('getRetryDelayMs [K-07]', () => {
  it('有 retryAfterMs 时直接返回该值', () => {
    expect(getRetryDelayMs(1, 3000)).toBe(3000)
  })

  it('attempt=1 时 base=500，含 jitter 上限 625', () => {
    const delay = getRetryDelayMs(1, null)
    expect(delay).toBeGreaterThanOrEqual(500)
    expect(delay).toBeLessThanOrEqual(626)
  })

  it('attempt=2 时 base=1000，大于 attempt=1', () => {
    const delay1 = getRetryDelayMs(1, null)
    const delay2 = getRetryDelayMs(2, null)
    // delay2 的 base(1000) > delay1 的 base(500)，在概率上 delay2 >= delay1
    expect(delay2).toBeGreaterThanOrEqual(1000)
  })

  it('超大 attempt 时不超过 MAX * 1.25 + 1', () => {
    const delay = getRetryDelayMs(100, null)
    expect(delay).toBeLessThanOrEqual(8000 * 1.25 + 1)
  })
})

// ── AnthropicModelAdapter（mock fetch）────────────────────────────────────

const mockConfig: RuntimeConfig = {
  model: 'claude-opus-4-7',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'test-key',
}

function makeFetch(body: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  })
}

describe('AnthropicModelAdapter', () => {
  let original: typeof globalThis.fetch

  beforeEach(() => { original = globalThis.fetch })
  afterEach(() => { globalThis.fetch = original })

  it('文本响应返回 assistant AgentStep', async () => {
    globalThis.fetch = makeFetch({
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
    globalThis.fetch = makeFetch({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/main.ts' } }],
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

  it('429 后重试一次成功', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          ok: false, status: 429,
          headers: { get: () => '0' },
          text: async () => JSON.stringify({ error: { message: 'rate limit' } }),
        }
      }
      return {
        ok: true, status: 200,
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

  it('400 立即抛出，不重试', async () => {
    globalThis.fetch = makeFetch({ error: { message: '参数错误' } }, 400)
    const adapter = new AnthropicModelAdapter(new ToolRegistry(), async () => mockConfig)
    await expect(
      adapter.next([{ role: 'user', content: '你好' }]),
    ).rejects.toThrow('参数错误')
  })
})
