/**
 * ToolRegistry 单元测试
 *
 * 覆盖点：
 * [K-03] Registry Pattern - 注册/查找/幂等性
 * [K-02] Zod 运行时验证 - 验证成功/失败路径
 * [K-26] awaitUser 信号传递
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../src/tool.js'
import type { ToolDefinition, ToolContext } from '../src/tool.js'

// ── 测试用工具工厂函数 ──────────────────────────────────────────────────────

/** 创建一个总是返回成功的简单工具 */
function makeEchoTool(name = 'echo'): ToolDefinition<{ message: string }> {
  return {
    name,
    description: '回显消息',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    schema: z.object({ message: z.string() }),
    async run(input) {
      return { ok: true, output: input.message }
    },
  }
}

/** 创建一个总是抛异常的工具 */
function makeThrowTool(): ToolDefinition<{ msg: string }> {
  return {
    name: 'throw_tool',
    description: '抛异常',
    inputSchema: { type: 'object', properties: {}, required: [] },
    schema: z.object({ msg: z.string() }),
    async run() {
      throw new Error('工具内部异常')
    },
  }
}

const ctx: ToolContext = { cwd: '/tmp' }

// ── 测试套件 ───────────────────────────────────────────────────────────────

describe('ToolRegistry - 基础注册与查找 [K-03]', () => {
  it('构造时注册工具，list() 可以列出', () => {
    const reg = new ToolRegistry([makeEchoTool()])
    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0]!.name).toBe('echo')
  })

  it('find() 按名称找到已注册工具', () => {
    const reg = new ToolRegistry([makeEchoTool()])
    expect(reg.find('echo')).toBeDefined()
  })

  it('find() 返回 undefined 当工具不存在时', () => {
    const reg = new ToolRegistry()
    expect(reg.find('not_exist')).toBeUndefined()
  })

  it('addTools() 追加新工具', () => {
    const reg = new ToolRegistry([makeEchoTool('echo1')])
    reg.addTools([makeEchoTool('echo2')])
    expect(reg.list()).toHaveLength(2)
  })

  it('addTools() 跳过同名重复工具（幂等性）', () => {
    const reg = new ToolRegistry([makeEchoTool()])
    reg.addTools([makeEchoTool()]) // 同名
    expect(reg.list()).toHaveLength(1)
  })
})

describe('ToolRegistry - execute() 路径 [K-02]', () => {
  it('工具不存在时返回 ok=false', async () => {
    const reg = new ToolRegistry()
    const result = await reg.execute('no_such_tool', {}, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('未知工具')
  })

  it('Zod 验证失败时返回 ok=false', async () => {
    const reg = new ToolRegistry([makeEchoTool()])
    // 传入错误类型的 input：message 应为 string，这里传 number
    const result = await reg.execute('echo', { message: 123 }, ctx)
    expect(result.ok).toBe(false)
  })

  it('执行成功时 ok=true，output 为工具返回值', async () => {
    const reg = new ToolRegistry([makeEchoTool()])
    const result = await reg.execute('echo', { message: 'hello' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('hello')
  })

  it('工具抛出异常时捕获并返回 ok=false', async () => {
    const reg = new ToolRegistry([makeThrowTool()])
    const result = await reg.execute('throw_tool', { msg: 'test' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('工具内部异常')
  })
})

describe('ToolRegistry - awaitUser 信号 [K-26]', () => {
  it('工具返回 awaitUser=true 时原样传递', async () => {
    const askTool: ToolDefinition<{ question: string }> = {
      name: 'ask_user',
      description: '询问用户',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      schema: z.object({ question: z.string() }),
      async run(input) {
        return { ok: true, output: input.question, awaitUser: true }
      },
    }
    const reg = new ToolRegistry([askTool])
    const result = await reg.execute('ask_user', { question: '你好吗？' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.awaitUser).toBe(true)
    expect(result.output).toBe('你好吗？')
  })
})
