/**
 * Phase 4 集成测试：ToolRegistry + runAgentTurn
 *
 * 用 ScriptedModelAdapter 预定义模型步骤，验证：
 * 1. 工具注册表组装正确（12 个工具）
 * 2. read_file → write_file 完整链路
 * 3. ask_user 的 awaitUser 信号让 Loop 正确暂停
 * 4. edit_file 精确替换
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterEach } from 'vitest'
import type { AgentStep, ChatMessage, ModelAdapter } from '../types.js'
import { runAgentTurn } from '../agent-loop.js'
import { createDefaultToolRegistry } from './index.js'

// ── ScriptedModelAdapter：按预定步骤顺序返回响应 ──────────────────────────

class ScriptedModelAdapter implements ModelAdapter {
  private steps: AgentStep[]
  private index = 0

  constructor(steps: AgentStep[]) {
    this.steps = steps
  }

  async next(_messages: ChatMessage[]): Promise<AgentStep> {
    const step = this.steps[this.index]
    if (!step) {
      // 步骤用完后返回 final 响应，防止无限循环
      return { type: 'assistant', content: '<final>done', kind: 'final' }
    }
    this.index++
    return step
  }
}

// ── 测试辅助 ─────────────────────────────────────────────────────────────

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

async function makeTmpDir() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'phase4-test-'))
  return tmpDir
}

// ── 测试用例 ──────────────────────────────────────────────────────────────

describe('createDefaultToolRegistry', () => {
  it('注册 12 个工具', () => {
    const tools = createDefaultToolRegistry({ cwd: process.cwd() })
    expect(tools.list().length).toBe(12)
  })

  it('包含所有预期工具名', () => {
    const tools = createDefaultToolRegistry({ cwd: process.cwd() })
    const names = new Set(tools.list().map(t => t.name))
    const expected = [
      'ask_user', 'list_files', 'grep_files', 'read_file',
      'write_file', 'modify_file', 'edit_file', 'patch_file',
      'run_command', 'load_skill', 'web_fetch', 'web_search',
    ]
    for (const name of expected) {
      expect(names.has(name), `工具 ${name} 应已注册`).toBe(true)
    }
  })
})

describe('Phase 4 集成：read_file → write_file', () => {
  it('Agent 能读取文件内容并写入新文件', async () => {
    const cwd = await makeTmpDir()
    await writeFile(path.join(cwd, 'source.txt'), 'hello world', 'utf8')

    const tools = createDefaultToolRegistry({ cwd })
    const model = new ScriptedModelAdapter([
      // Step 1: 读取源文件
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', toolName: 'read_file', input: { path: 'source.txt' } }],
      },
      // Step 2: 把内容写入目标文件
      {
        type: 'tool_calls',
        calls: [{ id: 'c2', toolName: 'write_file', input: { path: 'output.txt', content: 'hello mini-code' } }],
      },
      // Step 3: 返回最终响应
      { type: 'assistant', content: '<final>已完成', kind: 'final' },
    ])

    await runAgentTurn({
      model,
      tools,
      messages: [{ role: 'user', content: '把 source.txt 内容读出来写入 output.txt' }],
      cwd,
    })

    const content = await readFile(path.join(cwd, 'output.txt'), 'utf8')
    expect(content).toBe('hello mini-code')
  })
})

describe('Phase 4 集成：edit_file 精确替换', () => {
  it('edit_file 能替换文件中的特定文本', async () => {
    const cwd = await makeTmpDir()
    await writeFile(path.join(cwd, 'code.ts'), 'const x = 1\nconst y = 2', 'utf8')

    const tools = createDefaultToolRegistry({ cwd })
    const model = new ScriptedModelAdapter([
      {
        type: 'tool_calls',
        calls: [{
          id: 'c1',
          toolName: 'edit_file',
          input: { path: 'code.ts', search: 'const y = 2', replace: 'const y = 99' },
        }],
      },
      { type: 'assistant', content: '<final>已修改', kind: 'final' },
    ])

    await runAgentTurn({
      model,
      tools,
      messages: [{ role: 'user', content: '把 y 改成 99' }],
      cwd,
    })

    const content = await readFile(path.join(cwd, 'code.ts'), 'utf8')
    expect(content).toBe('const x = 1\nconst y = 99')
  })
})

describe('Phase 4 集成：ask_user awaitUser 暂停', () => {
  it('ask_user 让 Loop 返回并在消息尾部包含问题', async () => {
    const cwd = await makeTmpDir()
    const tools = createDefaultToolRegistry({ cwd })
    const model = new ScriptedModelAdapter([
      {
        type: 'tool_calls',
        calls: [{
          id: 'c1',
          toolName: 'ask_user',
          input: { question: '你确定要继续吗？' },
        }],
      },
    ])

    const messages = await runAgentTurn({
      model,
      tools,
      messages: [{ role: 'user', content: '开始任务' }],
      cwd,
    })

    // Loop 因 awaitUser 暂停后，最后一条消息是 assistant 角色的问题
    const lastMsg = messages.at(-1)
    expect(lastMsg?.role).toBe('assistant')
    if (lastMsg?.role === 'assistant') {
      expect(lastMsg.content).toContain('你确定要继续吗？')
    }
  })
})

describe('Phase 4 集成：list_files', () => {
  it('list_files 能列举目录文件', async () => {
    const cwd = await makeTmpDir()
    await writeFile(path.join(cwd, 'a.ts'), '', 'utf8')
    await writeFile(path.join(cwd, 'b.ts'), '', 'utf8')

    const tools = createDefaultToolRegistry({ cwd })
    const results: string[] = []

    const model = new ScriptedModelAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', toolName: 'list_files', input: {} }],
      },
      { type: 'assistant', content: '<final>listed', kind: 'final' },
    ])

    await runAgentTurn({
      model,
      tools,
      messages: [{ role: 'user', content: '列举文件' }],
      cwd,
      onToolResult: (_name, output) => { results.push(output) },
    })

    expect(results[0]).toContain('a.ts')
    expect(results[0]).toContain('b.ts')
  })
})
