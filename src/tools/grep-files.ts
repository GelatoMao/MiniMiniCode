/**
 * grep_files — 跨文件正则搜索
 *
 * [K-22] 依赖 ripgrep (rg) 实现高性能搜索。
 * 无 rg 时返回有用的安装提示，而非静默失败。
 *
 * 注意：rg 无匹配时以非零状态码退出，这不是工具错误；
 * 有 stdout 输出时返回结果，无输出时返回 "(no matches)"。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

type Input = { pattern: string; path?: string }

export const grepFilesTool: ToolDefinition<Input> = {
  name: 'grep_files',
  description: 'Search for text in files using ripgrep (rg).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: {
        type: 'string',
        description: 'Directory or file to search in (default: workspace root)',
      },
    },
    required: ['pattern'],
  },
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
  }),
  async run(input, context) {
    const args = ['-n', '--no-heading', input.pattern]
    if (input.path) {
      args.push(await resolveToolPath(context, input.path, 'search'))
    } else {
      args.push('.')
    }

    try {
      const result = await execFileAsync('rg', args, {
        cwd: context.cwd,
        maxBuffer: 1024 * 1024, // 1MB 输出上限
      })
      return {
        ok: true,
        output: (result.stdout || result.stderr || '').trim() || '(no matches)',
      }
    } catch (error) {
      // rg 无匹配时以 exit code 1 退出，error 对象里仍有 stdout
      if (error && typeof error === 'object') {
        const stderr = ((error as { stderr?: unknown }).stderr as string | undefined ?? '').trim()
        // rg 未安装时 stderr 包含 "not found"
        if (stderr.includes('command not found') || stderr.includes('not found')) {
          return {
            ok: false,
            output: 'ripgrep (rg) 未安装。请运行: brew install ripgrep',
          }
        }
        const stdout = ((error as { stdout?: unknown }).stdout as string | undefined ?? '').trim()
        return { ok: true, output: stdout || '(no matches)' }
      }
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
