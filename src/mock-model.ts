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
    // 优先处理工具结果：工具执行完毕后给出文本回复
    const result = lastToolResult(messages)
    if (result?.role === 'tool_result') {
      const lastCall = lastToolCallName(messages)
      const prefix =
        lastCall === 'list_files' ? '目录内容：\n\n' :
        lastCall === 'read_file'  ? '文件内容：\n\n' :
        '工具结果：\n\n'
      return { type: 'assistant', content: prefix + result.content }
    }

    const text = lastUserContent(messages)

    if (text === '/tools') {
      return {
        type: 'assistant',
        content: '可用工具：ask_user, list_files, grep_files, read_file, write_file, run_command',
      }
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
        calls: [{
          id: `mock-${Date.now()}`,
          toolName: 'grep_files',
          input: { pattern: pattern!.trim(), path: searchPath?.trim() || undefined },
        }],
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
        calls: [{
          id: `mock-${Date.now()}`,
          toolName: 'write_file',
          input: { path: payload.slice(0, splitAt).trim(), content: payload.slice(splitAt + 2) },
        }],
      }
    }

    return {
      type: 'assistant',
      content: [
        '这是离线 Mock 模式，支持以下命令：',
        '/tools',
        '/ls [目录]',
        '/read 路径',
        '/grep 模式::目录',
        '/cmd 命令',
        '/write 路径::内容',
      ].join('\n'),
    }
  }
}
