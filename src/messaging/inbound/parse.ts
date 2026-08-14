/**
 * Inbound Feishu message parsing.
 *
 * Converts a raw `im.message.receive_v1` event into a normalized
 * MessageContext: mention bookkeeping plus plain-text extraction.
 * Adapted from openclaw-lark's parse.ts, simplified for harness-lark.
 */

import type {
  FeishuMessageEvent,
  MentionInfo,
  MessageContext,
  RawMention,
} from '../../core/types.ts'

/** True when a mention references @all. */
function isMentionAll(m: RawMention): boolean {
  return m.key === 'ALL' || m.key === 'all' || Boolean(m.name === '@all' || m.name === '@所有人')
}

/**
 * Parse a raw Feishu message event into a normalized MessageContext.
 * @param event - The raw event from the WebSocket gateway.
 * @param botOpenId - The bot's open_id, used to flag bot mentions.
 */
export function parseMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MessageContext {
  const message = event.message
  const msgId = message.message_id ?? 'unknown'
  const chatId = message.chat_id ?? ''

  // Build mention bookkeeping.
  const mentionList: MentionInfo[] = []
  let mentionAll = false
  for (const m of message.mentions ?? []) {
    if (isMentionAll(m)) {
      mentionAll = true
      continue
    }
    const openId = m.id?.open_id ?? ''
    if (!openId) continue
    mentionList.push({
      key: m.key,
      openId,
      name: m.name,
      isBot: Boolean(botOpenId && openId === botOpenId),
    })
  }

  const mentionedBot = mentionList.some((m) => m.isBot)

  const text = extractPlainText(event)
  const createTime = message.create_time ? Number(message.create_time) : undefined

  return {
    messageId: msgId,
    chatId,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    threadId: message.thread_id || message.root_id || undefined,
    senderOpenId: event.sender?.sender_id?.open_id ?? '',
    mentions: mentionList,
    mentionedBot,
    mentionAll,
    text,
    rawContent: message.content,
    createTime,
  }
}

/** Extract plain text from a message event across supported msg_types. */
function extractPlainText(event: FeishuMessageEvent): string {
  // SDK v1.65+ delivers schema 2.0 events where the type field is
  // `message_type`; older envelopes use `msg_type`. Accept both.
  const msgType = event.message.msg_type ?? event.message.message_type ?? ''
  const content = event.message.content
  if (!content) return ''

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    switch (msgType) {
      case 'text': {
        const raw = typeof parsed.text === 'string' ? parsed.text : ''
        return resolveMentions(raw, event.message.mentions ?? [])
      }
      case 'post': {
        const title = typeof parsed.title === 'string' ? parsed.title : ''
        const blocks = extractPostText(parsed)
        return title ? `${title}\n${blocks}` : blocks
      }
      case 'image':
        return '[图片]'
      case 'file':
        return `[文件: ${typeof parsed.file_name === 'string' ? parsed.file_name : ''}]`
      case 'audio':
        return '[语音]'
      case 'media':
        return '[视频]'
      case 'interactive':
        return '[卡片]'
      case 'system':
        return '[系统消息]'
      default:
        return `[未知消息类型: ${msgType}]`
    }
  } catch {
    // Not JSON — treat the raw content as text.
    return content
  }
}

/** Recursively collect text from a post-format content payload. */
function extractPostText(parsed: Record<string, unknown>): string {
  const body = parsed.body
  if (!Array.isArray(body)) return ''
  const parts: string[] = []
  for (const block of body as unknown[]) {
    if (!Array.isArray(block)) continue
    for (const elem of block as unknown[]) {
      if (typeof elem !== 'object' || elem === null) continue
      const e = elem as Record<string, unknown>
      if (e.tag === 'text' && typeof e.text === 'string') {
        parts.push(e.text)
      } else if (e.tag === 'a' && typeof e.text === 'string') {
        parts.push(e.text)
      } else if (e.tag === 'at' && typeof e.user_id === 'string') {
        parts.push(`@${e.user_id}`)
      }
    }
  }
  return parts.join('')
}

/**
 * Replace Feishu mention keys (`at_xxx`) in text with human-readable names.
 * A key may appear bare or already prefixed with `@`; both resolve to one
 * `@name` so the replacement never doubles the at-sign.
 * @param raw - Text containing mention keys.
 * @param mentions - The event's mention list.
 */
export function resolveMentions(raw: string, mentions: RawMention[]): string {
  let out = raw
  for (const m of mentions) {
    const name = m.name ?? m.id?.open_id ?? m.key
    // Replace `@key` first (longest, most specific), then bare `key`.
    out = out.split(`@${m.key}`).join(`@${name}`)
    out = out.split(m.key).join(`@${name}`)
  }
  return out
}
