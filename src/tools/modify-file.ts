/**
 * modify_file — 带 diff 审查的全文件替换
 *
 * [K-20] 功能与 write_file 相同，语义上强调"修改已有文件"。
 * 适合模型在已读取文件后整体改写的场景：
 * - write_file：创建或覆盖写入
 * - modify_file：明确表达"我修改了你读到的文件"
 */
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = { path: string; content: string }

export const modifyFileTool: ToolDefinition<Input> = {
  name: 'modify_file',
  description: 'Replace a file with reviewed content so the user can approve the diff first.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to cwd' },
      content: { type: 'string', description: 'New full content for the file' },
    },
    required: ['path', 'content'],
  },
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    return applyReviewedFileChange(context, input.path, target, input.content)
  },
}
