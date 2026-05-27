/**
 * ChatMessage 类型系统运行时测试
 *
 * TypeScript 的类型只在编译期存在，但我们可以验证运行时值
 * 与类型的"形状"匹配，同时作为 discriminated union 的活文档。
 *
 * [K-01] 可辨别联合：通过 role 字段收窄类型
 */
import { describe, it, expect } from 'vitest'
import type { ChatMessage, AgentStep } from '../src/types.js'

/** 辅助：提取消息中的文本内容（演示类型收窄） */
function extractContent(msg: ChatMessage): string | null {
  // TypeScript 在每个 if 分支里自动收窄 msg 的类型
  if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') {
    return msg.content // 只有这三个 role 才有 content: string
  }
  if (msg.role === 'tool_result') {
    return msg.content // tool_result 也有 content
  }
  return null
}

describe('ChatMessage 可辨别联合 [K-01]', () => {
  it('user 消息具有正确结构', () => {
    const msg: ChatMessage = { role: 'user', content: '你好' }
    expect(extractContent(msg)).toBe('你好')
  })

  it('assistant 消息可携带 usage 元数据', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '我在这里',
      providerUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'anthropic' },
    }
    expect(msg.role).toBe('assistant')
    // TypeScript 收窄后可访问 providerUsage
    if (msg.role === 'assistant') {
      expect(msg.providerUsage?.totalTokens).toBe(15)
    }
  })

  it('tool_result 消息包含 isError 标志', () => {
    const msg: ChatMessage = {
      role: 'tool_result',
      toolUseId: 'call_001',
      toolName: 'read_file',
      content: '文件内容...',
      isError: false,
    }
    if (msg.role === 'tool_result') {
      expect(msg.isError).toBe(false)
      expect(msg.toolName).toBe('read_file')
    }
  })

  it('assistant_tool_call 消息携带工具调用参数', () => {
    const msg: ChatMessage = {
      role: 'assistant_tool_call',
      toolUseId: 'call_abc',
      toolName: 'read_file',
      input: { path: 'src/main.ts' },
    }
    if (msg.role === 'assistant_tool_call') {
      expect(msg.toolName).toBe('read_file')
      expect(msg.input).toEqual({ path: 'src/main.ts' })
    }
  })

  it('非文本角色的消息 extractContent 返回 null', () => {
    const msg: ChatMessage = {
      role: 'assistant_tool_call',
      toolUseId: 'x',
      toolName: 'y',
      input: {},
    }
    expect(extractContent(msg)).toBeNull()
  })
})

describe('AgentStep 可辨别联合 [K-04]', () => {
  it('assistant 类型含 content', () => {
    const step: AgentStep = { type: 'assistant', content: '任务完成' }
    if (step.type === 'assistant') {
      expect(step.content).toBe('任务完成')
    }
  })

  it('tool_calls 类型含 calls 数组', () => {
    const step: AgentStep = {
      type: 'tool_calls',
      calls: [{ id: 'c1', toolName: 'read_file', input: { path: 'a.txt' } }],
    }
    if (step.type === 'tool_calls') {
      expect(step.calls).toHaveLength(1)
      expect(step.calls[0]!.toolName).toBe('read_file')
    }
  })
})
