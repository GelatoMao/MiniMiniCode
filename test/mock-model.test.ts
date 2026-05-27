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
