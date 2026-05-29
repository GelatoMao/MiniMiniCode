/**
 * 文件写入工具单元测试：write_file, edit_file, patch_file, modify_file
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterEach } from 'vitest'
import { writeFileTool } from './write-file.js'
import { editFileTool } from './edit-file.js'
import { patchFileTool } from './patch-file.js'
import { modifyFileTool } from './modify-file.js'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

async function setup() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'minicode-write-test-'))
  return { cwd: tmpDir }
}

describe('write_file', () => {
  it('写入新文件', async () => {
    const ctx = await setup()
    const result = await writeFileTool.run({ path: 'hello.txt', content: 'hello world' }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'hello.txt'), 'utf8')
    expect(content).toBe('hello world')
  })

  it('内容相同时幂等返回', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'a.txt', content: 'same' }, ctx)
    const result = await writeFileTool.run({ path: 'a.txt', content: 'same' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('No changes')
  })

  it('自动创建嵌套目录', async () => {
    const ctx = await setup()
    const result = await writeFileTool.run({ path: 'deep/nested/file.txt', content: 'ok' }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'deep/nested/file.txt'), 'utf8')
    expect(content).toBe('ok')
  })
})

describe('edit_file', () => {
  it('精确替换文本', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'a.txt', content: 'foo bar baz' }, ctx)
    const result = await editFileTool.run({ path: 'a.txt', search: 'bar', replace: 'qux' }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'a.txt'), 'utf8')
    expect(content).toBe('foo qux baz')
  })

  it('search 不存在时返回 ok: false', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'b.txt', content: 'hello' }, ctx)
    const result = await editFileTool.run({ path: 'b.txt', search: 'notexist', replace: 'x' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('not found')
  })

  it('replaceAll 替换所有出现', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'c.txt', content: 'a a a' }, ctx)
    const result = await editFileTool.run({
      path: 'c.txt', search: 'a', replace: 'b', replaceAll: true,
    }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'c.txt'), 'utf8')
    expect(content).toBe('b b b')
  })
})

describe('patch_file', () => {
  it('按顺序应用多个替换', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'p.txt', content: 'a b c' }, ctx)
    const result = await patchFileTool.run({
      path: 'p.txt',
      replacements: [
        { search: 'a', replace: '1' },
        { search: 'b', replace: '2' },
      ],
    }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'p.txt'), 'utf8')
    expect(content).toBe('1 2 c')
  })

  it('任一 search 不存在时整体失败', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'q.txt', content: 'hello' }, ctx)
    const result = await patchFileTool.run({
      path: 'q.txt',
      replacements: [
        { search: 'hello', replace: 'world' },
        { search: 'missing', replace: 'x' }, // 不存在
      ],
    }, ctx)
    expect(result.ok).toBe(false)
    // 文件不应被修改（原子性）
    const content = await readFile(path.join(tmpDir, 'q.txt'), 'utf8')
    expect(content).toBe('hello')
  })
})

describe('modify_file', () => {
  it('整体替换文件内容', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'm.txt', content: 'old content' }, ctx)
    const result = await modifyFileTool.run({ path: 'm.txt', content: 'new content' }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'm.txt'), 'utf8')
    expect(content).toBe('new content')
  })
})
