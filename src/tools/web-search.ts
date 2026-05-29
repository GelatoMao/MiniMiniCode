/**
 * web_search — 网页搜索
 *
 * [K-25] 封装 searchDuckDuckGoLite（DuckDuckGo Lite + Sogou 双后备）。
 * 返回结构化搜索结果，模型可通过 web_fetch 读取感兴趣的完整页面。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { searchDuckDuckGoLite } from '../utils/web.js'

type Input = { query: string; max_results?: number }

export const webSearchTool: ToolDefinition<Input> = {
  name: 'web_search',
  description:
    'Search the web for information. Returns titles, URLs, and snippets. ' +
    'Use web_fetch to read the full content of specific pages.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: {
        type: 'number',
        description: 'Maximum number of results (1-10, default: 5)',
      },
    },
    required: ['query'],
  },
  schema: z.object({
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(10).optional(),
  }),
  async run(input) {
    try {
      const result = await searchDuckDuckGoLite({
        query: input.query,
        maxResults: input.max_results ?? 5,
      })

      if (result.organic.length === 0) {
        return { ok: true, output: '(no results)' }
      }

      const lines = result.organic.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.link}\n    ${r.snippet}`,
      )
      return { ok: true, output: lines.join('\n\n') }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
