/**
 * read_file 工具集成测试
 *
 * 覆盖点：
 * - 成功读取文件
 * - 分页读取（offset/limit）
 * - 文件不存在时返回 ok=false
 * - Zod 验证：path 为空字符串时失败
 */
import { describe, it, expect } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ToolRegistry } from '../src/tool.js'
import { readFileTool } from '../src/tools/read-file.js'

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await import('node:fs/promises').then(() =>
    import('node:os').then(m => m.default.tmpdir()),
  )
  const tmp = path.join(dir, `my-agent-test-${Date.now()}`)
  await mkdir(tmp, { recursive: true })
  try {
    await fn(tmp)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

describe('read_file 工具', () => {
  it('成功读取文件，返回正确内容', async () => {
    await withTmpDir(async (cwd) => {
      await writeFile(path.join(cwd, 'hello.txt'), 'hello world', 'utf8')
      const reg = new ToolRegistry([readFileTool])
      const result = await reg.execute('read_file', { path: 'hello.txt' }, { cwd })
      expect(result.ok).toBe(true)
      expect(result.output).toContain('hello world')
      expect(result.output).toContain('TRUNCATED: no')
    })
  })

  it('分页读取：offset 和 limit 正确截取内容', async () => {
    await withTmpDir(async (cwd) => {
      await writeFile(path.join(cwd, 'nums.txt'), '0123456789', 'utf8')
      const reg = new ToolRegistry([readFileTool])
      // 读取第 3 到 6 个字符
      const result = await reg.execute('read_file', { path: 'nums.txt', offset: 3, limit: 3 }, { cwd })
      expect(result.ok).toBe(true)
      expect(result.output).toContain('345')
    })
  })

  it('超过文件长度时标记 TRUNCATED: yes', async () => {
    await withTmpDir(async (cwd) => {
      // 写一个 100 字符的文件，limit 设为 10
      await writeFile(path.join(cwd, 'long.txt'), 'a'.repeat(100), 'utf8')
      const reg = new ToolRegistry([readFileTool])
      const result = await reg.execute('read_file', { path: 'long.txt', limit: 10 }, { cwd })
      expect(result.ok).toBe(true)
      expect(result.output).toContain('TRUNCATED: yes')
    })
  })

  it('文件不存在时返回 ok=false', async () => {
    await withTmpDir(async (cwd) => {
      const reg = new ToolRegistry([readFileTool])
      const result = await reg.execute('read_file', { path: 'not_exist.txt' }, { cwd })
      expect(result.ok).toBe(false)
      expect(result.output).toContain('读取文件失败')
    })
  })

  it('Zod 验证：path 为空字符串时失败', async () => {
    const reg = new ToolRegistry([readFileTool])
    const result = await reg.execute('read_file', { path: '' }, { cwd: '/tmp' })
    expect(result.ok).toBe(false)
  })
})
