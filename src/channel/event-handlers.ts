/**
 * Event handlers for the Feishu WebSocket gateway.
 *
 * Each handler receives a context carrying the Lark client, dedup, and
 * the agent bridge. Adapted from openclaw-lark's event-handlers.ts.
 */

import type { LarkClient } from '../core/lark-client.ts'
import type { FeishuMessageEvent } from '../core/types.ts'
import { MessageDedup } from '../messaging/inbound/dedup.ts'
import { parseMessageEvent } from '../messaging/inbound/parse.ts'
import type { AgentBridge } from '../agent/bridge.ts'
import type { MessageContext } from '../core/types.ts'

export interface MonitorContext {
  accountId: string
  lark: LarkClient
  /** Route one parsed message to the bridge of its serving agent. */
  bridge: (message: MessageContext) => AgentBridge | undefined
  dedup: MessageDedup
  log: (msg: string) => void
  error: (msg: string) => void
}

/** Verify the event's app_id matches the account; discard otherwise. */
function isEventOwnershipValid(ctx: MonitorContext, data: unknown): boolean {
  const expectedAppId = ctx.lark.account.appId
  const eventAppId = (data as Record<string, unknown>).app_id
  if (eventAppId == null) return true
  if (eventAppId !== expectedAppId) {
    ctx.log(`app_id mismatch, discarding: expected ${expectedAppId}, got ${String(eventAppId)}`)
    return false
  }
  return true
}

/** Handle `im.message.receive_v1`. */
export async function handleMessageEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return
  const { accountId, lark, bridge, dedup, log } = ctx

  try {
    const event = data as FeishuMessageEvent
    const msgId = event.message?.message_id ?? 'unknown'

    // Self-echo hard filter — drop messages authored by this bot.
    const senderOpenId = event.sender?.sender_id?.open_id
    if (lark.botOpenId && senderOpenId && senderOpenId === lark.botOpenId) {
      log(`drop self-echo message ${msgId}`)
      return
    }

    // Dedup — skip duplicates from WebSocket reconnects.
    if (!dedup.tryRecord(msgId, accountId)) {
      log(`duplicate message ${msgId}, skipping`)
      return
    }

    // Expiry — discard stale messages from reconnect replay (older than 1h).
    const createTime = event.message?.create_time ? Number(event.message.create_time) : undefined
    if (createTime !== undefined && Date.now() - createTime > 60 * 60 * 1000) {
      log(`message ${msgId} expired, discarding`)
      return
    }

    const parsed = parseMessageEvent(event, lark.botOpenId)
    log(`message ${msgId} from chat ${parsed.chatId} (${parsed.chatType})`)

    const target = bridge(parsed)
    if (target === undefined) {
      log(`message ${msgId}: no agent serves chat ${parsed.chatId} (${parsed.chatType}), dropping`)
      return
    }
    await target.handleMessage(parsed)
  } catch (error) {
    ctx.error(`handleMessageEvent failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
