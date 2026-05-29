/**
 * file-review.ts — 文件写入 diff 审查
 *
 * [K-30] 所有写文件操作的统一入口：
 * 1. buildUnifiedDiff：用 diff 库生成 unified diff 字符串，供用户 review
 * 2. applyReviewedFileChange：diff → permissions.ensureEdit → 原子写入
 *
 * 设计原则：
 * - 写入前必须生成 diff（即使权限管理器不存在，diff 也会生成并记录）
 * - 内容相同时幂等返回，不写入文件
 * - mkdir recursive 确保目录存在，支持新建嵌套目录下的文件
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ToolContext, ToolResult } from './tool.js'
import { isEnoentError } from './utils/errors.js'

/**
 * 生成 unified diff 字符串，供用户 review 使用。
 * 内容相同时返回 "(no changes)" 提示。
 *
 * [K-30] createTwoFilesPatch 生成标准 unified diff 格式：
 *   --- a/path
 *   +++ b/path
 *   @@ -行号,行数 +行号,行数 @@
 *   -旧内容
 *   +新内容
 */
export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return `(no changes for ${filePath})`
  }

  const raw = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    before,
    after,
    '',
    '',
    { context: 3 },
  )

  // createTwoFilesPatch 首行可能是 "===" 分隔符，去掉保持输出紧凑
  const lines = raw.split('\n')
  if (lines[0]?.startsWith('===')) {
    return lines.slice(1).join('\n')
  }
  return raw
}

/**
 * 读取现有文件内容；文件不存在时返回空字符串（视为新建文件）。
 */
export async function loadExistingFile(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch (error) {
    if (isEnoentError(error)) {
      return ''
    }
    throw error
  }
}

/**
 * 执行有审查的文件写入：
 * 1. 读取旧内容（文件不存在视为空）
 * 2. 内容相同时提前返回（幂等操作）
 * 3. 生成 diff 并调用 permissions.ensureEdit 触发审查提示
 * 4. 确保目录存在后写入文件
 *
 * [K-17] 写入前先 mkdir recursive，支持新建嵌套路径下的文件。
 */
export async function applyReviewedFileChange(
  context: ToolContext,
  filePath: string,
  targetPath: string,
  nextContent: string,
): Promise<ToolResult> {
  const previousContent = await loadExistingFile(targetPath)

  if (previousContent === nextContent) {
    return { ok: true, output: `No changes needed for ${filePath}` }
  }

  const diff = buildUnifiedDiff(filePath, previousContent, nextContent)

  // [K-29] 有权限管理器时才触发 edit 审查提示
  await context.permissions?.ensureEdit(targetPath, diff)

  // [K-17] 确保目录存在（mkdir recursive 是幂等的），再写入文件
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, nextContent, 'utf8')

  return { ok: true, output: `Applied reviewed changes to ${filePath}` }
}
