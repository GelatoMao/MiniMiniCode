/**
 * tools/index.ts — 工具注册表组装
 *
 * [K-28] 集中注册所有内置工具，返回 ToolRegistry 实例。
 *
 * Phase 5 会扩展此模块：
 * - hydrateMcpTools：动态注入 MCP server 提供的工具
 * - 传入完整 skill 列表到 createLoadSkillTool
 */
import { ToolRegistry } from '../tool.js'
import { askUserTool } from './ask-user.js'
import { editFileTool } from './edit-file.js'
import { grepFilesTool } from './grep-files.js'
import { createLoadSkillTool } from './load-skill.js'
import { listFilesTool } from './list-files.js'
import { modifyFileTool } from './modify-file.js'
import { patchFileTool } from './patch-file.js'
import { readFileTool } from './read-file.js'
import { runCommandTool } from './run-command.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { writeFileTool } from './write-file.js'

/**
 * 创建包含所有 12 个内置工具的 ToolRegistry。
 *
 * @param args.cwd - 工作目录（load_skill 工具需要用来发现 skill 文件）
 */
export function createDefaultToolRegistry(args: { cwd: string }): ToolRegistry {
  return new ToolRegistry([
    askUserTool,
    listFilesTool,
    grepFilesTool,
    readFileTool,
    writeFileTool,
    modifyFileTool,
    editFileTool,
    patchFileTool,
    runCommandTool,
    createLoadSkillTool(args.cwd),
    webFetchTool,
    webSearchTool,
  ])
}
