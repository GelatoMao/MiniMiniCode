import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompt.js'

describe('buildSystemPrompt [K-15]', () => {
  it('包含 cwd 路径', async () => {
    const prompt = await buildSystemPrompt('/home/user/project')
    expect(prompt).toContain('/home/user/project')
  })

  it('包含结构化响应协议说明', async () => {
    const prompt = await buildSystemPrompt('/tmp')
    expect(prompt).toContain('<progress>')
    expect(prompt).toContain('<final>')
  })

  it('包含 mini-code 角色定义', async () => {
    const prompt = await buildSystemPrompt('/tmp')
    expect(prompt).toContain('mini-code')
  })

  it('返回字符串，不为空', async () => {
    const prompt = await buildSystemPrompt('/tmp')
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(100)
  })
})
