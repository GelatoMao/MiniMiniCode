/**
 * workspace.ts — 工具路径解析
 *
 * [K-05] 所有工具的路径入口：
 * 1. 无 permissions → 只允许 workspace 内路径（简单边界检查）
 * 2. 有 permissions → 委托给 PermissionManager.ensurePathAccess
 */
import path from 'node:path'
import type { ToolContext } from './tool.js'

/**
 * 解析工具请求的相对路径为绝对路径，并进行权限/边界检查。
 *
 * @param context   - 工具运行上下文（含 cwd 和可选 permissions）
 * @param targetPath - LLM 请求的路径（相对于 cwd）
 * @param intent    - 操作意图（影响权限粒度）
 * @returns 绝对路径
 * @throws 路径逃出 workspace 时抛出错误
 */
export async function resolveToolPath(
  context: ToolContext,
  targetPath: string,
  intent: 'read' | 'write' | 'list' | 'search',
): Promise<string> {
  const resolved = path.resolve(context.cwd, targetPath)

  if (!context.permissions) {
    // 无权限管理器时：只允许 cwd 范围内路径
    const workspaceRoot = path.resolve(context.cwd)
    const relative = path.relative(workspaceRoot, resolved)

    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`路径逃出 workspace: ${targetPath}`)
    }

    return resolved
  }

  // 有权限管理器时：委托权限检查
  await context.permissions.ensurePathAccess(resolved, intent)
  return resolved
}
