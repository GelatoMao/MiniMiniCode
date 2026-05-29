/**
 * edit_file — 精确字符串替换
 *
 * [K-18] search 必须在文件中存在，否则返回 ok: false。
 * replaceAll=true 时替换所有出现位置；默认只替换第一处。
 * 修改后通过 applyReviewedFileChange 触发 diff 审查。
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = {
  path: string
  search: string
  replace: string
  replaceAll?: boolean
}

export const editFileTool: ToolDefinition<Input> = {
  name: 'edit_file',
  description: 'Edit a text file by replacing exact text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to cwd' },
      search: { type: 'string', description: 'Exact text to find (must exist in file)' },
      replace: { type: 'string', description: 'Text to replace it with' },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences instead of only the first (default: false)',
      },
    },
    required: ['path', 'search', 'replace'],
  },
  schema: z.object({
    path: z.string().min(1),
    search: z.string().min(1),
    replace: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    const original = await readFile(target, 'utf8')

    if (!original.includes(input.search)) {
      return { ok: false, output: `Text not found in ${input.path}` }
    }

    // replaceAll 用 split/join 实现，避免正则特殊字符问题
    const next = input.replaceAll
      ? original.split(input.search).join(input.replace)
      : original.replace(input.search, input.replace)

    return applyReviewedFileChange(context, input.path, target, next)
  },
}
