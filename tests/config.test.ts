import { describe, expect, it } from 'vitest'
import { Config, type HarnessLarkConfig } from '../src/core/config-schema.ts'

describe('config schema', () => {
  const base: HarnessLarkConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    brand: 'feishu',
    connectionMode: 'websocket',
    dmPolicy: 'open',
    groupPolicy: 'disabled',
    requireMentionInGroups: true,
    dedupTtlMs: 1000,
  }

  it('accepts a minimal valid config', () => {
    const value = Config(base)
    expect(value.appId).toBe('cli_test')
    expect(value.brand).toBe('feishu')
    expect(value.replyMode).toBe('auto')
  })

  it('accepts a config without appId (gateway stays offline)', () => {
    const { appId: _ignored, ...rest } = base
    const value = Config(rest)
    expect(value.appId).toBeUndefined()
    expect(value.brand).toBe('feishu')
  })

  it('rejects an invalid brand', () => {
    expect(() => Config({ ...base, brand: 'wechat' })).toThrow()
  })

  it('rejects an invalid connection mode', () => {
    expect(() => Config({ ...base, connectionMode: 'carrier-pigeon' })).toThrow()
  })

  it('accepts lark brand and streaming reply mode', () => {
    const value = Config({ ...base, brand: 'lark', replyMode: 'streaming' })
    expect(value.brand).toBe('lark')
    expect(value.replyMode).toBe('streaming')
  })
})
