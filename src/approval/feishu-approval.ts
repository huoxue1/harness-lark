/**
 * Feishu-channel approval answerer.
 *
 * A dsh agent on a non-web surface (a Feishu chat) still triggers the same
 * `approval/request` waterfall as a Web-session agent. The web profile's
 * answerer (dsh apiproxy) turns the request into a browser approval popup;
 * nobody clicks it from Feishu, so the turn hangs forever and every later
 * message queues behind it. This plugin registers its own answerer ahead of
 * the web one (waterfall `prepend`): Feishu-session asks are rendered as a
 * Feishu interactive card with 批准/拒绝 buttons, and the card action
 * callback settles the pending ask. Non-Feishu sessions delegate via
 * `next()` so the web approval popup keeps working unchanged.
 *
 * @module harness-lark/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import { sendCard, updateCard } from '../messaging/outbound/deliver.ts'
import type { FeishuSendResult } from '../core/types.ts'
import type { LarkClient } from '../core/lark-client.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision (dsh approval service). Return
     * an outcome to claim the request or call `next()` to delegate. Declared
     * here so this plugin can answer without depending on dsh-user-approval.
     * @param req - the pending decision.
     * @param next - delegate to the next answerer (the web approval popup).
     */
    'approval/request'(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  }
}

/** The approval outcome vocabulary dsh's approval service understands. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Structural face of dsh's `approval/request` payload. */
export interface ApprovalRequestLike {
  /** The agent asking (its session id carries the Feishu chat identity). */
  readonly agent: { session: { header: { id: string } } }
  /** The tool the ask is about. */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of why it is asking. */
  readonly reason?: string
  /** Aborting withdraws the question (settles 'cancelled'). */
  readonly signal?: AbortSignal
}

/** One pending Feishu approval, awaiting a card-button click. */
interface PendingApproval {
  /** Session id of the agent that asked (also the Map key). */
  sessionId: string
  /** The tool the ask is about (card body + settled outcome context). */
  toolName: string
  /** The reason text shown on the card. */
  reason?: string
  /** Chat the approval card was sent to. */
  chatId: string
  /** Message id of the approval card (to update it after the click). */
  cardMessageId?: string
  /** The answerer's settle function; called exactly once. */
  resolve: (outcome: ApprovalOutcome) => void
  /** Auto-deny timer; cleared once the ask settles. */
  timeout: NodeJS.Timeout
}

export interface FeishuApprovalOptions {
  /** The account's Lark client (sends and patches approval cards). */
  client: () => LarkClient
}

/** How long an unanswered approval card waits before auto-denying. */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/** Session-id prefix for Feishu-channel sessions. */
const FEISHU_SESSION_PREFIX = 'lark:'

/** Button values carried on the approval card. */
const CARD_ACTION_ALLOW = 'harness-lark:approval:allow'
const CARD_ACTION_DENY = 'harness-lark:approval:deny'

/**
 * Install the Feishu approval answerer on a context.
 * @param ctx - the host context (the plugin's apply ctx).
 * @param options - client resolution for card delivery.
 * @returns a handle with the card-action handler for the gateway and a disposer.
 */
export function installFeishuApproval(ctx: Context, options: FeishuApprovalOptions): {
  /** Route `card.action.trigger` events from the gateway here. */
  handleCardAction: (data: unknown) => Promise<void>
  /** Dispose pending approvals (auto-deny) and unregister the answerer. */
  dispose: () => void
} {
  const pendings = new Map<string, PendingApproval>()

  ctx.on('approval/request', (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => {
    const sessionId = req.agent.session.header.id
    if (!sessionId.startsWith(FEISHU_SESSION_PREFIX)) {
      // Not a Feishu-channel session: the web approval popup owns it.
      return next()
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const pending: PendingApproval = {
        sessionId,
        toolName: req.toolName,
        reason: req.reason,
        chatId: '',
        resolve,
        timeout: setTimeout(() => {
          pendings.delete(sessionId)
          resolve('rejected')
          void patchApprovalCard(options, pending, '⏰ 超时未处理，已自动拒绝')
        }, APPROVAL_TIMEOUT_MS),
      }
      pending.timeout.unref?.()
      pendings.set(sessionId, pending)
      // Await the card send so cardMessageId is set before the user can
      // click — a button click resolving the ask must be able to patch it.
      void sendApprovalCard(options, pending).then(() => {
        if (!pendings.has(sessionId)) return
        // Card delivered; the ask now waits for a button click.
      })
      // A cancelled ask (turn aborted) settles this promise without a click.
      req.signal?.addEventListener('abort', () => {
        const current = pendings.get(sessionId)
        if (current !== pending) return
        clearTimeout(pending.timeout)
        pendings.delete(sessionId)
        resolve('cancelled')
      }, { once: true })
    })
  }, { prepend: true })

  return {
    handleCardAction: async (data: unknown) => {
      await handleCardAction(data, pendings, options)
    },
    dispose: () => {
      for (const pending of pendings.values()) {
        clearTimeout(pending.timeout)
        pending.resolve('cancelled')
      }
      pendings.clear()
    },
  }
}

/** Parse a gateway card-action payload and settle the matching pending ask. */
async function handleCardAction(
  data: unknown,
  pendings: Map<string, PendingApproval>,
  options: FeishuApprovalOptions,
): Promise<void> {
  const action = (data as { action?: { value?: unknown; tag?: string } })?.action
  const value = action?.value as { sessionId?: string; action?: string } | undefined
  if (!value?.sessionId || !value.action) return
  const pending = pendings.get(value.sessionId)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendings.delete(value.sessionId)
  if (value.action === CARD_ACTION_ALLOW) {
    pending.resolve('allowed-once')
    await patchApprovalCard(options, pending, '✅ 已批准')
  } else if (value.action === CARD_ACTION_DENY) {
    pending.resolve('rejected')
    await patchApprovalCard(options, pending, '❌ 已拒绝')
  }
}

/** Send the approval card into the asker's chat and remember its message id. */
async function sendApprovalCard(options: FeishuApprovalOptions, pending: PendingApproval): Promise<void> {
  const sessionId = pending.sessionId
  // `lark:<accountId>:<chatId>[:generation]` or `...:thread:<threadId>...`.
  const parts = sessionId.split(':')
  const chatId = parts[2]
  if (!chatId) return
  pending.chatId = chatId
  const result = await sendCard({
    client: options.client().client,
    receiveId: chatId,
    receiveIdType: 'chat_id',
    card: buildApprovalCard(pending),
  })
  if (result.ok && result.messageId) pending.cardMessageId = result.messageId
}

/** Patch the approval card to its settled state, disabling the buttons. */
async function patchApprovalCard(
  options: FeishuApprovalOptions,
  pending: PendingApproval,
  verdict: string,
): Promise<void> {
  if (!pending.cardMessageId) return
  const card = buildApprovalCard(pending, { disabled: true })
  card.elements.push({ tag: 'hr' })
  card.elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${verdict}**` },
  })
  await updateCard({
    client: options.client().client,
    messageId: pending.cardMessageId,
    card,
  })
}

/** Build the approval card: tool, reason, and two action buttons. */
function buildApprovalCard(
  pending: PendingApproval,
  opts: { disabled?: boolean } = {},
): {
  config: { wide_screen_mode: boolean; update_multi?: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: Array<Record<string, unknown>>
} {
  const reason = pending.reason?.trim()
  const lines = [`**工具**: \`${pending.toolName}\``]
  if (reason) lines.push('', `**原因**: ${reason}`)
  // Disabled buttons keep the settled verdict visible without inviting a
  // second (ineffective) click: `disabled` is part of the Feishu card
  // button component (Card 2.0), accepted by the interactive card renderer.
  const disabled = opts.disabled === true
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '🔐 权限审批请求' }, template: 'orange' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 批准' },
            type: 'primary',
            value: { sessionId: pending.sessionId, action: CARD_ACTION_ALLOW },
            ...(disabled ? { disabled: true } : {}),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { sessionId: pending.sessionId, action: CARD_ACTION_DENY },
            ...(disabled ? { disabled: true } : {}),
          },
        ],
      },
    ],
  }
}

/** Silence unused-import lint when FeishuSendResult is only a doc reference. */
export type { FeishuSendResult }
