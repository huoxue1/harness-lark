import { describe, expect, it } from 'vitest'
import { Config, type HarnessLarkConfig } from '../src/core/config-schema.ts'

describe('config schema', () => {
  const base: HarnessLarkConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    brand: 'feishu',
    connectionMode: 'websocket',
    replyMode: 'auto',
    dmPolicy: 'open',
    groupPolicy: 'disabled',
    requireMentionInGroups: true,
    topicSeparateSession: false,
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
    // appId is optional in the schema but typed required in HarnessLarkConfig;
    // the test passes a partial config to exercise the optional-schema path.
    const value = Config(rest as HarnessLarkConfig)
    expect(value.appId).toBeUndefined()
    expect(value.brand).toBe('feishu')
  })

  it('rejects an invalid brand', () => {
    expect(() => Config({ ...base, brand: 'wechat' as never })).toThrow()
  })

  it('rejects an invalid connection mode', () => {
    expect(() => Config({ ...base, connectionMode: 'carrier-pigeon' as never })).toThrow()
  })

  it('accepts lark brand and streaming reply mode', () => {
    const value = Config({ ...base, brand: 'lark', replyMode: 'streaming' })
    expect(value.brand).toBe('lark')
    expect(value.replyMode).toBe('streaming')
  })
})
