/**
 * WebSocket gateway for the Lark/Feishu channel.
 *
 * Manages the per-account LarkClient connection and routes inbound Feishu
 * events (messages, card actions, reactions) to their handlers.
 * Adapted from openclaw-lark's monitor.ts.
 */

import type { AgentBridge } from '../agent/bridge.ts'
import { LarkClient } from '../core/lark-client.ts'
import type { HarnessLarkConfig } from '../core/config-schema.ts'
import { MessageDedup } from '../messaging/inbound/dedup.ts'
import { handleMessageEvent, type MonitorContext } from './event-handlers.ts'

export interface MonitorOptions {
  config: HarnessLarkConfig
  accountId?: string
  bridge: AgentBridge
  abortSignal?: AbortSignal
}

/**
 * Start the WebSocket gateway for the configured Feishu account.
 * Resolves when `abortSignal` fires.
 */
export async function monitorFeishuProvider(opts: MonitorOptions): Promise<void> {
  const { config, accountId = 'default', bridge, abortSignal } = opts

  const lark = new LarkClient({
    accountId,
    appId: config.appId,
    appSecret: config.appSecret,
    encryptKey: config.encryptKey ?? '',
    verificationToken: config.verificationToken ?? '',
    brand: config.brand,
    config,
  })

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
      'card.action.trigger': (data: unknown) => handleCardAction(ctx, data),
    },
    abortSignal,
  })

  log(`bot open_id: ${lark.botOpenId ?? 'unknown'}`)
  log('WebSocket gateway started')
}

/** Handle card action callbacks. Reserved for interactive cards. */
async function handleCardAction(ctx: MonitorContext, data: unknown): Promise<void> {
  ctx.log(`card action received: ${JSON.stringify(data).slice(0, 200)}`)
}
