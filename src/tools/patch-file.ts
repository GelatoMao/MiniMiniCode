/**
 * patch_file — 一次提交多个精确替换
 *
 * [K-19] replacements 按顺序应用到同一文件。
 * 任一 search 不存在时整体失败（原子性：要么全成功，要么全不改）。
 * 相比多次调用 edit_file，只产生一次 diff 审查，效率更高。
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const ReplacementSchema = z.object({
  search: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().optional(),
})

type Input = {
  path: string
  replacements: Array<z.infer<typeof ReplacementSchema>>
}

export const patchFileTool: ToolDefinition<Input> = {
  name: 'patch_file',
  description: 'Apply multiple exact-text replacements to one file in a single operation.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to cwd' },
      replacements: {
        type: 'array',
        description: 'List of replacements to apply in order',
        items: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Exact text to find' },
            replace: { type: 'string', description: 'Replacement text' },
            replaceAll: { type: 'boolean' },
          },
          required: ['search', 'replace'],
        },
      },
    },
    required: ['path', 'replacements'],
  },
  schema: z.object({
    path: z.string().min(1),
    replacements: z.array(ReplacementSchema).min(1),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    let content = await readFile(target, 'utf8')

    for (const [index, replacement] of input.replacements.entries()) {
      if (!content.includes(replacement.search)) {
        return {
          ok: false,
          output: `Replacement ${index + 1} not found in ${input.path}`,
        }
      }
      content = replacement.replaceAll
        ? content.split(replacement.search).join(replacement.replace)
        : content.replace(replacement.search, replacement.replace)
    }

    return applyReviewedFileChange(context, input.path, target, content)
  },
}
