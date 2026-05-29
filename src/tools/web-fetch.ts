/**
 * web_fetch — 抓取网页可读文本
 *
 * [K-24] 委托给 utils/web.ts 的 fetchWebPage，
 * 将 HTML 转为纯文本后按 max_chars 截断，
 * 并在输出头部附加 URL/状态/标题元信息供模型参考。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { fetchWebPage } from '../utils/web.js'

type Input = { url: string; max_chars?: number }

export const webFetchTool: ToolDefinition<Input> = {
  name: 'web_fetch',
  description:
    'Fetch a web page and extract its readable text content. ' +
    'Use after web_search when you need the full content of a specific page.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters to return from page content (default: 12000)',
      },
    },
    required: ['url'],
  },
  schema: z.object({
    url: z.string().url(),
    max_chars: z.number().int().min(500).optional(),
  }),
  async run(input) {
    try {
      const result = await fetchWebPage({
        url: input.url,
        maxChars: input.max_chars ?? 12_000,
      })

      if (result.status >= 400) {
        return {
          ok: false,
          output: `HTTP ${result.status} ${result.statusText}: ${input.url}`,
        }
      }

      const lines = [
        `URL: ${result.finalUrl}`,
        `STATUS: ${result.status}`,
        `CONTENT_TYPE: ${result.contentType}`,
      ]
      if (result.title) lines.push(`TITLE: ${result.title}`)
      lines.push('', result.content)

      return { ok: true, output: lines.join('\n') }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
