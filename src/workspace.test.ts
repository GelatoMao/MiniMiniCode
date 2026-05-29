import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveToolPath } from './workspace.js'

describe('resolveToolPath', () => {
  const cwd = '/home/user/project'

  it('解析相对路径为绝对路径', async () => {
    const result = await resolveToolPath({ cwd }, 'src/main.ts', 'read')
    expect(result).toBe('/home/user/project/src/main.ts')
  })

  it('路径逃出 workspace 时抛出错误', async () => {
    await expect(
      resolveToolPath({ cwd }, '../../etc/passwd', 'read'),
    ).rejects.toThrow('路径逃出 workspace')
  })

  it('有 permissions 时调用 ensurePathAccess', async () => {
    let called = false
    const fakePermissions = {
      ensurePathAccess: async () => { called = true },
      ensureCommand: async () => {},
      ensureEdit: async () => {},
      resetTurn: () => {},
    }
    await resolveToolPath({ cwd, permissions: fakePermissions }, 'src/main.ts', 'write')
    expect(called).toBe(true)
  })
})
