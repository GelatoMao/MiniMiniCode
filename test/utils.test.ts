import { describe, it, expect, afterEach } from 'vitest'
import { isEnoentError, getErrorCode } from '../src/utils/errors.js'
import { resolveMaxOutputTokens } from '../src/utils/context.js'
import { loadRuntimeConfig } from '../src/config.js'

describe('isEnoentError', () => {
  it('code=ENOENT 的 Error 对象返回 true', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    expect(isEnoentError(err)).toBe(true)
  })

  it('其他 code 返回 false', () => {
    const err = Object.assign(new Error('access denied'), { code: 'EACCES' })
    expect(isEnoentError(err)).toBe(false)
  })

  it('非 Error 对象返回 false', () => {
    expect(isEnoentError('string error')).toBe(false)
    expect(isEnoentError(null)).toBe(false)
  })
})

describe('resolveMaxOutputTokens', () => {
  it('已知模型返回对应默认值', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6')).toBe(64_000)
    expect(resolveMaxOutputTokens('claude-haiku-4-5-20251001')).toBe(64_000)
  })

  it('未知模型返回 32_000', () => {
    expect(resolveMaxOutputTokens('unknown-model-xyz')).toBe(32_000)
  })

  it('配置值在 upperLimit 内时生效', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', 10_000)).toBe(10_000)
  })

  it('配置值超过 upperLimit 时被截断', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', 999_999)).toBe(64_000)
  })

  it('配置值为 0 或负数时使用默认值', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', 0)).toBe(64_000)
    expect(resolveMaxOutputTokens('claude-sonnet-4-6', -1)).toBe(64_000)
  })
})

describe('loadRuntimeConfig', () => {
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    // 恢复环境变量
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('读取 ANTHROPIC_API_KEY 和 ANTHROPIC_MODEL', async () => {
    saved['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY']
    saved['ANTHROPIC_MODEL'] = process.env['ANTHROPIC_MODEL']
    saved['ANTHROPIC_BASE_URL'] = process.env['ANTHROPIC_BASE_URL']
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    process.env['ANTHROPIC_MODEL'] = 'claude-test'
    delete process.env['ANTHROPIC_BASE_URL']
    const cfg = await loadRuntimeConfig()
    expect(cfg.apiKey).toBe('test-key')
    expect(cfg.model).toBe('claude-test')
    expect(cfg.baseUrl).toBe('https://api.anthropic.com')
  })

  it('未设置任何 auth 时抛出错误', async () => {
    saved['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY']
    saved['ANTHROPIC_AUTH_TOKEN'] = process.env['ANTHROPIC_AUTH_TOKEN']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_AUTH_TOKEN']
    await expect(loadRuntimeConfig()).rejects.toThrow('ANTHROPIC_API_KEY')
  })
})
