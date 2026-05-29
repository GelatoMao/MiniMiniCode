import { describe, it, expect } from 'vitest'
import { askUserTool } from './ask-user.js'

describe('ask_user', () => {
  it('返回 awaitUser: true 信号', async () => {
    const result = await askUserTool.run({ question: '你确定吗？' }, { cwd: '/' })
    expect(result.ok).toBe(true)
    expect(result.awaitUser).toBe(true)
    expect(result.output).toBe('你确定吗？')
  })

  it('自动 trim question 首尾空白', async () => {
    const result = await askUserTool.run({ question: '  需要确认？  ' }, { cwd: '/' })
    expect(result.output).toBe('需要确认？')
  })
})
