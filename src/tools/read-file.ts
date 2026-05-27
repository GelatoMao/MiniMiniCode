/**
 * read_file 工具：读取工作目录内的 UTF-8 文本文件
 *
 * 演示 ToolDefinition<TInput> 的完整用法：
 * 1. inputSchema → 发送给 LLM 的 JSON Schema
 * 2. schema (Zod) → 运行时验证 [K-02]
 * 3. run(input, context) → 类型安全的执行逻辑
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'

// [K-02] Zod 推断出的类型：{ path: string; offset?: number; limit?: number }
type Input = z.infer<typeof inputSchema>

const DEFAULT_READ_LIMIT = 8_000
const MAX_READ_LIMIT = 20_000

const inputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
})

export const readFileTool: ToolDefinition<Input> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file relative to the workspace root. ' +
    'Large files can be read in chunks via offset and limit.',

  // JSON Schema 格式，Agent Loop 会把它传给 LLM API
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to cwd' },
      offset: { type: 'number', description: 'Character offset to start reading from' },
      limit: { type: 'number', description: 'Maximum number of characters to read' },
    },
    required: ['path'],
  },

  // Zod schema：与 inputSchema 保持同构，但提供运行时验证能力
  schema: inputSchema,

  async run(input, context) {
    // path.resolve 确保路径始终在 cwd 下（简单安全防护）
    const target = path.resolve(context.cwd, input.path)

    let content: string
    try {
      content = await readFile(target, 'utf8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, output: `读取文件失败: ${msg}` }
    }

    const offset = Math.max(0, input.offset ?? 0)
    const limit = Math.min(MAX_READ_LIMIT, input.limit ?? DEFAULT_READ_LIMIT)
    const end = Math.min(content.length, offset + limit)
    const chunk = content.slice(offset, end)
    const truncated = end < content.length

    // 返回带元信息的 header，方便 LLM 判断是否需要继续分页读取
    const header = [
      `FILE: ${input.path}`,
      `OFFSET: ${offset}`,
      `END: ${end}`,
      `TOTAL_CHARS: ${content.length}`,
      truncated ? `TRUNCATED: yes - call read_file again with offset ${end}` : 'TRUNCATED: no',
      '',
    ].join('\n')

    return { ok: true, output: header + chunk }
  },
}
