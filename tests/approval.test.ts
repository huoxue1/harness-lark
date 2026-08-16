import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installFeishuApproval, type ApprovalOutcome, type ApprovalRequestLike } from '../src/approval/feishu-approval.ts'
import type { LarkClient } from '../src/core/lark-client.ts'

/** A LarkClient stub whose sendCard/updateCard record calls. */
function stubClient() {
  const sends: unknown[] = []
  const patches: unknown[] = []
  const client = {
    client: {
      im: {
        message: {
          create: async (args: unknown) => {
            sends.push(args)
            return { data: { message_id: 'msg_1' } }
          },
          reply: async (args: unknown) => {
            sends.push(args)
            return { data: { message_id: 'msg_1' } }
          },
          patch: async (args: unknown) => {
            patches.push(args)
            return { data: {} }
          },
        },
      },
    },
  }
  return { client: client as unknown as LarkClient, sends, patches }
}

/** Dispatch one approval/request waterfall through the installed answerer. */
function ask(ctx: Context, sessionId: string, opts: { toolName?: string; reason?: string } = {}): Promise<ApprovalOutcome> {
  const req: ApprovalRequestLike = {
    agent: { session: { header: { id: sessionId } } },
    toolName: opts.toolName ?? 'bash',
    ...opts.reason === undefined ? {} : { reason: opts.reason },
  }
  return ctx.waterfall('approval/request', req, () => Promise.resolve('unavailable'))
}

describe('feishu approval answerer', () => {
  it('renders a Feishu-session ask as a card and approves on button click', async () => {
    const ctx = new Context()
    const { client, sends, patches } = stubClient()
    const approval = installFeishuApproval(ctx, { client: () => client })
    const outcome = ask(ctx, 'lark:default:oc_chat1', { reason: 'escalate sandbox' })
    await vi.waitFor(() => expect(sends.length).toBe(1))
    // Flush the send chain so cardMessageId is written before the click.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const card = (sends[0] as { data: { content: string } }).data.content
    expect(card).toContain('权限审批请求')
    expect(card).toContain('bash')
    expect(card).toContain('escalate sandbox')
    expect(card).toContain('批准')
    expect(card).toContain('拒绝')

    await approval.handleCardAction({
      action: { value: { sessionId: 'lark:default:oc_chat1', action: 'harness-lark:approval:allow' }, tag: 'button' },
    })
    await expect(outcome).resolves.toBe('allowed-once')
    expect(patches.length).toBe(1)
    approval.dispose()
  })

  it('deny settles rejected and patches the card', async () => {
    const ctx = new Context()
    const { client, sends, patches } = stubClient()
    const approval = installFeishuApproval(ctx, { client: () => client })
    const outcome = ask(ctx, 'lark:default:oc_chat2')
    await vi.waitFor(() => expect(sends.length).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await approval.handleCardAction({
      action: { value: { sessionId: 'lark:default:oc_chat2', action: 'harness-lark:approval:deny' }, tag: 'button' },
    })
    await expect(outcome).resolves.toBe('rejected')
    expect(patches.length).toBe(1)
    approval.dispose()
  })

  it('delegates non-Feishu sessions to the next answerer', async () => {
    const ctx = new Context()
    const { client, sends } = stubClient()
    const approval = installFeishuApproval(ctx, { client: () => client })
    const outcome = ask(ctx, 'web-session-abc')
    await expect(outcome).resolves.toBe('unavailable')
    expect(sends.length).toBe(0)
    approval.dispose()
  })

  it('ignores card actions without a session id', async () => {
    const ctx = new Context()
    const { client, sends, patches } = stubClient()
    const approval = installFeishuApproval(ctx, { client: () => client })
    await approval.handleCardAction({ action: { value: { action: 'harness-lark:approval:allow' }, tag: 'button' } })
    expect(sends.length).toBe(0)
    expect(patches.length).toBe(0)
    approval.dispose()
  })

  it('auto-denies an unanswered ask after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const { client } = stubClient()
      const approval = installFeishuApproval(ctx, { client: () => client })
      const outcome = ask(ctx, 'lark:default:oc_chat4')
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
      await expect(outcome).resolves.toBe('rejected')
      approval.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
