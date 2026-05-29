import { describe, it, expect } from 'vitest'
import { buildUnifiedDiff } from './file-review.js'

describe('buildUnifiedDiff', () => {
  it('内容相同时返回 no changes', () => {
    expect(buildUnifiedDiff('a.ts', 'hello', 'hello')).toContain('no changes')
  })

  it('内容不同时返回包含 +/- 的 diff 字符串', () => {
    const diff = buildUnifiedDiff('a.ts', 'hello', 'world')
    expect(diff).toContain('-hello')
    expect(diff).toContain('+world')
  })

  it('diff 包含文件路径', () => {
    const diff = buildUnifiedDiff('src/foo.ts', 'old', 'new')
    expect(diff).toContain('src/foo.ts')
  })
})
