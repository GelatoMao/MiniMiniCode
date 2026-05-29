/**
 * load_skill — 动态加载 skill 文件内容
 *
 * [K-27] 运行时把 skill 的 Markdown 内容注入到对话上下文，
 * 让模型能遵循特定工作流指令（例如 TDD 流程、代码审查规范等）。
 *
 * 使用工厂函数而非直接导出对象，因为需要 cwd 来定位 skill 文件。
 * cwd 在工具注册时确定，不在每次调用时传入（简化工具接口）。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { loadSkill } from '../skills.js'

type Input = { name: string }

export function createLoadSkillTool(cwd: string): ToolDefinition<Input> {
  return {
    name: 'load_skill',
    description:
      'Load the full contents of a named SKILL.md file so you can follow that workflow accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (without .md extension)',
        },
      },
      required: ['name'],
    },
    schema: z.object({
      name: z.string().min(1),
    }),
    async run(input) {
      const skill = await loadSkill(cwd, input.name)
      if (!skill) {
        return { ok: false, output: `未知 skill: ${input.name}` }
      }
      return {
        ok: true,
        output: [
          `SKILL: ${skill.name}`,
          `SOURCE: ${skill.source}`,
          `PATH: ${skill.path}`,
          '',
          skill.content,
        ].join('\n'),
      }
    },
  }
}
