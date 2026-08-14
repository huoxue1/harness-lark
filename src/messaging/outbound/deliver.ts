/**
 * Outbound Feishu message delivery.
 *
 * Sends text and interactive-card messages through the Lark SDK, either as
 * a reply to an existing message or as a new message in a chat.
 * Adapted from openclaw-lark's deliver.ts, simplified for harness-lark.
 */

import type * as Lark from '@larksuiteoapi/node-sdk'
import type { FeishuSendResult } from '../../core/types.ts'

/** Build the post-format content envelope that renders Markdown in Feishu. */
function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  })
}

/** Build an interactive card content envelope: the card JSON itself. */
function buildCardContent(card: unknown): string {
  const value = card as Record<string, unknown>
  // The card object must carry its own config; ensure wide-screen defaults
  // are present so Feishu accepts the payload.
  if (value && typeof value === 'object' && !value.config) {
    return JSON.stringify({ ...value, config: { wide_screen_mode: true } })
  }
  return JSON.stringify(card)
}

export interface SendMessageParams {
  client: Lark.Client
  /** Receive id: `oc_xxx` chat id or `ou_xxx` user open_id. */
  receiveId: string
  /** receive_id_type matching `receiveId`: 'chat_id' | 'open_id'. */
  receiveIdType: 'chat_id' | 'open_id'
  text?: string
  card?: unknown
  /** Reply to a specific message id. */
  replyToMessageId?: string
  /** Reply in thread when set (used with replyToMessageId). */
  replyInThread?: boolean
  /** Optional UUID to deduplicate sends. */
  uuid?: string
}

/**
 * Send a text (post/Markdown) message.
 * @returns The sent message id when available.
 */
export async function sendText(params: SendMessageParams): Promise<FeishuSendResult> {
  if (!params.text) return { ok: false, error: 'text is required' }
  const content = buildPostContent(params.text)
  return sendImMessage(params, content, 'post')
}

/** Send an interactive card message. */
export async function sendCard(params: SendMessageParams): Promise<FeishuSendResult> {
  if (params.card === undefined) return { ok: false, error: 'card is required' }
  const content = buildCardContent(params.card)
  return sendImMessage(params, content, 'interactive')
}

async function sendImMessage(
  params: SendMessageParams,
  content: string,
  msgType: 'post' | 'interactive',
): Promise<FeishuSendResult> {
  const { client, receiveId, receiveIdType, replyToMessageId, replyInThread, uuid } = params

  try {
    if (replyToMessageId) {
      const response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: msgType,
          content,
          reply_in_thread: replyInThread ?? false,
          uuid,
        } as never,
      })
      const messageId = (response.data as { message_id?: string } | undefined)?.message_id
      return { ok: true, messageId }
    }

    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content,
        uuid,
      } as never,
    })
    const messageId = (response.data as { message_id?: string } | undefined)?.message_id
    return { ok: true, messageId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

/**
 * Update (PATCH) the content of an existing interactive card message.
 * Only messages originally sent by the bot can be updated; the card must
 * have been created with `"update_multi": true` in its config for all
 * recipients to see the update.
 */
export async function updateCard(params: {
  client: Lark.Client
  messageId: string
  card: unknown
}): Promise<FeishuSendResult> {
  const { client, messageId, card } = params
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) } as never,
    })
    return { ok: true, messageId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
