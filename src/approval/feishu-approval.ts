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
  /** Auto-deny an unanswered approval card after this many ms. Default 5 min. */
  timeoutMs?: number
}

/** Default auto-deny timeout for an unanswered approval card. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

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
      const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
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
        }, timeoutMs),
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
): Promise<{ toast: { type: 'success'; content: string }; card: Record<string, unknown> } | undefined> {
  const action = (data as { action?: { value?: unknown; tag?: string } })?.action
  const value = action?.value as { sessionId?: string; action?: string } | undefined
  if (!value?.sessionId || !value.action) return undefined
  const pending = pendings.get(value.sessionId)
  if (!pending) return undefined
  clearTimeout(pending.timeout)
  pendings.delete(value.sessionId)
  if (value.action === CARD_ACTION_ALLOW) {
    pending.resolve('allowed-once')
    settleApprovalCard(options, pending, '✅ 已批准')
    return approvalCardResponse(pending, '✅ 已批准')
  } else if (value.action === CARD_ACTION_DENY) {
    pending.resolve('rejected')
    settleApprovalCard(options, pending, '❌ 已拒绝')
    return approvalCardResponse(pending, '❌ 已拒绝')
  }
  return undefined
}

/**
 * Update the approval card for EVERY viewer via API. Deferred past the
 * callback return (openclaw-lark pattern): the callback-response card only
 * replaces it for the clicking user, and running the API update first would
 * race the response — the clicker sees the card flash back.
 */
function settleApprovalCard(
  options: FeishuApprovalOptions,
  pending: PendingApproval,
  verdict: string,
): void {
  setImmediate(() => {
    void patchApprovalCard(options, pending, verdict).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[harness-lark] approval card patch failed: ${message}`)
    })
  })
}

/** The callback response: toast + settled card with buttons removed. */
function approvalCardResponse(
  pending: PendingApproval,
  verdict: string,
): { toast: { type: 'success'; content: string }; card: Record<string, unknown> } {
  return {
    toast: { type: 'success', content: verdict },
    card: buildApprovalCard(pending, { settled: true, note: verdict }),
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

/** Patch the approval card to its settled state, removing the buttons. */
async function patchApprovalCard(
  options: FeishuApprovalOptions,
  pending: PendingApproval,
  verdict: string,
): Promise<void> {
  if (!pending.cardMessageId) return
  const card = buildApprovalCard(pending, { settled: true, note: verdict })
  await updateCard({
    client: options.client().client,
    messageId: pending.cardMessageId,
    card,
  })
}

/** Build the approval card: tool, reason, and (pending) two action buttons. */
/** Build the approval card (Feishu Card 2.0): tool, reason, two buttons. */
function buildApprovalCard(
  pending: PendingApproval,
  opts: { settled?: boolean; note?: string } = {},
): {
  schema: '2.0'
  config: { wide_screen_mode: boolean; update_multi?: boolean }
  header?: { title: { tag: 'plain_text'; content: string }; template: string }
  body: { elements: Array<Record<string, unknown>> }
} {
  const reason = pending.reason?.trim()
  const lines = [`**工具**: \`${pending.toolName}\``]
  if (reason) lines.push('', `**原因**: ${reason}`)
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: lines.join('\n') },
  ]
  // Settled cards drop the action buttons entirely (openclaw-lark pattern)
  // so a second click is impossible; Card 2.0 full-body replacement reliably
  // removes them for every viewer.
  if (!opts.settled) {
    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 批准' },
              type: 'primary',
              value: { sessionId: pending.sessionId, action: CARD_ACTION_ALLOW },
            },
          ],
        },
        {
          tag: 'column',
          width: 'weighted',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'danger',
              value: { sessionId: pending.sessionId, action: CARD_ACTION_DENY },
            },
          ],
        },
      ],
    })
  }
  if (opts.note) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `**${opts.note}**` })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '🔐 权限审批请求' }, template: 'orange' },
    body: { elements },
  }
}

/** Silence unused-import lint when FeishuSendResult is only a doc reference. */
export type { FeishuSendResult }
