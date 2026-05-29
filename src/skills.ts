/**
 * skills.ts — Skill 文件发现与加载（Phase 4 最小实现）
 *
 * [K-27] Phase 4 只扫描 <cwd>/.mini-code/skills/ 目录下的 .md 文件。
 * Phase 5 会扩展为：全层级目录向上发现、兼容 .claude/skills、
 * 支持全局 ~/.mini-code/skills 目录等。
 */
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

export type SkillFile = {
  name: string
  path: string
  source: string
  content: string
}

/**
 * 扫描 <cwd>/.mini-code/skills/ 目录下的所有 .md 文件。
 * 目录不存在时返回空数组（不报错），便于首次使用体验。
 */
export async function discoverSkills(cwd: string): Promise<SkillFile[]> {
  const skillsDir = path.join(cwd, '.mini-code', 'skills')

  let entries: Dirent[]
  try {
    entries = await readdir(skillsDir, { withFileTypes: true }) as Dirent[]
  } catch (error) {
    if (isEnoentError(error)) return []
    throw error
  }

  const skills: SkillFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = path.join(skillsDir, entry.name)
    try {
      const content = await readFile(filePath, 'utf8')
      const name = entry.name.replace(/\.md$/i, '')
      skills.push({ name, path: filePath, source: 'local', content })
    } catch {
      // 跳过无法读取的文件（权限问题、临时文件等）
    }
  }
  return skills
}

/**
 * 按名称查找 skill（大小写不敏感）。
 * 未找到时返回 null。
 */
export async function loadSkill(
  cwd: string,
  name: string,
): Promise<SkillFile | null> {
  const skills = await discoverSkills(cwd)
  const normalized = name.trim().toLowerCase()
  return skills.find(s => s.name.toLowerCase() === normalized) ?? null
}
