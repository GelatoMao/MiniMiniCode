/**
 * ask_user — 向用户提问并暂停 Agent Loop
 *
 * [K-26] awaitUser: true 信号机制：
 * Agent Loop 的 tool_calls 分支检测到此信号后，
 * 把 question 以 assistant 身份展示给用户，
 * 然后返回 messages（不继续循环），等待用户回复。
 * 用户回复后，外部调用方再次调用 runAgentTurn 继续任务。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'

type Input = { question: string }

export const askUserTool: ToolDefinition<Input> = {
  name: 'ask_user',
  description:
    'Ask the user a clarifying question and stop the current turn until the user replies.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
    },
    required: ['question'],
  },
  schema: z.object({
    question: z.string().min(1),
  }),
  async run(input) {
    return {
      ok: true,
      output: input.question.trim(),
      awaitUser: true, // [K-26] 触发 Agent Loop 暂停信号
    }
  },
}
