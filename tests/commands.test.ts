import { describe, expect, it } from 'vitest'
import { runCommand, type CommandContext } from '../src/agent/commands.ts'

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    agent: {
      session: { header: { id: 's1', cwd: '/work' } },
    } as unknown as CommandContext['agent'],
    selection: { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    cwd: { value: '/work' },
    availableModels: [
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    ],
    client: {
      account: {
        appId: 'cli_test',
        appSecret: 'secret',
        brand: 'feishu',
        config: { connectionMode: 'websocket' },
      },
      botOpenId: undefined,
      botName: undefined,
      wsConnected: false,
    } as unknown as CommandContext['client'],
    senderOpenId: 'ou_test',
    ...overrides,
  }
}

describe('slash commands', () => {
  it('returns handled=false for non-command text', async () => {
    const r = await runCommand('hello world', makeCtx())
    expect(r.handled).toBe(false)
  })

  it('/status reports model and cwd', async () => {
    const r = await runCommand('/status', makeCtx())
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('deepseek-official/deepseek-v4-flash')
    expect(r.reply).toContain('/work')
  })

  it('/model lists available models and marks current', async () => {
    const r = await runCommand('/model', makeCtx())
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('deepseek-v4-flash')
    expect(r.reply).toContain('deepseek-v4-pro')
  })

  it('/model switches to a different model', async () => {
    const ctx = makeCtx()
    const r = await runCommand('/model deepseek-official/deepseek-v4-pro', ctx)
    expect(r.handled).toBe(true)
    expect(ctx.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('/model with model-only arg matches by model', async () => {
    const ctx = makeCtx()
    const r = await runCommand('/model deepseek-v4-pro', ctx)
    expect(r.handled).toBe(true)
    expect(ctx.selection.current?.model).toBe('deepseek-v4-pro')
  })

  it('/model rejects unknown model', async () => {
    const r = await runCommand('/model nope', makeCtx())
    expect(r.reply).toContain('未找到模型')
  })

  it('/cd reports current dir', async () => {
    const r = await runCommand('/cd', makeCtx())
    expect(r.reply).toContain('/work')
  })

  it('/cd switches cwd in chat state', async () => {
    const ctx = makeCtx()
    const r = await runCommand('/cd /tmp/foo', ctx)
    expect(r.handled).toBe(true)
    expect(ctx.cwd.value).toBe('/tmp/foo')
    expect(r.reply).toContain('/tmp/foo')
  })

  it('/cd rejects relative path', async () => {
    const r = await runCommand('/cd relative/path', makeCtx())
    expect(r.reply).toContain('绝对路径')
  })

  it('/new resets context', async () => {
    const r = await runCommand('/new', makeCtx())
    expect(r.handled).toBe(true)
    expect(r.resetContext).toBe(true)
    expect(r.reply).toContain('新建上下文')
  })

  it('/reset is an alias for /new', async () => {
    const r = await runCommand('/reset', makeCtx())
    expect(r.resetContext).toBe(true)
  })

  it('/help lists commands', async () => {
    const r = await runCommand('/help', makeCtx())
    expect(r.reply).toContain('/status')
    expect(r.reply).toContain('/model')
    expect(r.reply).toContain('/cd')
    expect(r.reply).toContain('/feishu')
  })

  it('/feishu doctor returns diagnostics', async () => {
    const r = await runCommand('/feishu doctor', makeCtx())
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('诊断')
    expect(r.reply).toContain('app_id')
  })

  it('/feishu unknown subcommand returns a hint', async () => {
    const r = await runCommand('/feishu bogus', makeCtx())
    expect(r.reply).toContain('未知的 /feishu 子命令')
  })

  it('unknown command returns a hint', async () => {
    const r = await runCommand('/bogus', makeCtx())
    expect(r.reply).toContain('未知命令')
  })
})
