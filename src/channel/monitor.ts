/**
 * WebSocket gateway for the Lark/Feishu channel.
 *
 * Manages the per-account LarkClient connection and routes inbound Feishu
 * events (messages, card actions, reactions) to their handlers.
 * Adapted from openclaw-lark's monitor.ts.
 */

import type { AgentBridge } from '../agent/bridge.ts'
import type { LarkClient } from '../core/lark-client.ts'
import type { HarnessLarkConfig } from '../core/config-schema.ts'
import { MessageDedup } from '../messaging/inbound/dedup.ts'
import { handleMessageEvent, type MonitorContext } from './event-handlers.ts'

export interface MonitorOptions {
  config: HarnessLarkConfig
  accountId?: string
  bridge: AgentBridge
  /** The shared LarkClient — probe/WS must use the SAME instance the bridge
   *  exposes to commands/tools so bot identity and connection state agree. */
  lark: LarkClient
  abortSignal?: AbortSignal
  /** Card-action handlers (approval buttons, ask-user cards); run in order.
   *  The first non-undefined return becomes the callback response, which the
   *  Feishu WebSocket uses to replace the card for the clicking user
   *  immediately (openclaw-lark pattern). */
  onCardAction?: Array<(data: unknown) => Promise<unknown>>
}

/**
 * Start the WebSocket gateway for the configured Feishu account.
 * Resolves when `abortSignal` fires.
 */
export async function monitorFeishuProvider(opts: MonitorOptions): Promise<void> {
  const { config, accountId = 'default', bridge, lark, abortSignal, onCardAction } = opts

  const dedup = new MessageDedup({ ttlMs: config.dedupTtlMs })

  const log = (msg: string) => console.log(`[harness-lark] ${msg}`)
  const error = (msg: string) => console.error(`[harness-lark] ${msg}`)

  const ctx: MonitorContext = {
    accountId,
    lark,
    bridge,
    dedup,
    log,
    error,
  }

  log(`starting WebSocket gateway (brand=${config.brand})`)

  await lark.startWS({
    handlers: {
      'im.message.receive_v1': (data) => handleMessageEvent(ctx, data),
      // No-op handlers for events expected in normal usage but not acted on,
      // to avoid SDK warnings about missing handlers.
      'im.message.message_read_v1': async () => {},
      'im.message.reaction.created_v1': async () => {},
      'im.message.reaction.deleted_v1': async () => {},
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {},
      'im.chat.member.bot.added_v1': async () => {},
      'im.chat.member.bot.deleted_v1': async () => {},
      // Card actions are patched to "event" type in LarkClient and routed here.
      // The handler's return value becomes the WS callback response (which
      // Feishu uses to replace the card for the clicker); SDK types only
      // allow void, so the object response rides through `as never`.
      'card.action.trigger': (data: unknown) => handleCardAction(ctx, data, onCardAction) as never,
    },
    abortSignal,
  })

  log(`bot open_id: ${lark.botOpenId ?? 'unknown'}`)
  log('WebSocket gateway started')
}

/** Handle card action callbacks (approval buttons, ask-user cards). */
async function handleCardAction(
  ctx: MonitorContext,
  data: unknown,
  onCardAction: Array<(data: unknown) => Promise<unknown>> | undefined,
): Promise<unknown> {
  try {
    if (onCardAction && onCardAction.length > 0) {
      // Run in order; the first non-undefined return becomes the response the
      // Feishu WebSocket uses to replace the card for the clicker.
      for (const handler of onCardAction) {
        const result = await handler(data)
        if (result !== undefined) return result
      }
    } else {
      ctx.log(`card action received: ${JSON.stringify(data).slice(0, 200)}`)
    }
  } catch (error) {
    ctx.error(`card action failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}
