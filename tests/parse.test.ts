import { describe, expect, it } from 'vitest'
import { parseMessageEvent, resolveMentions } from '../src/messaging/inbound/parse.ts'
import type { FeishuMessageEvent } from '../src/core/types.ts'

function textEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      msg_type: 'text',
      create_time: String(Date.now()),
      content: JSON.stringify({ text: 'hello @at_x' }),
      mentions: [{ key: 'at_x', id: { open_id: 'ou_other' }, name: 'Alice' }],
    },
    ...overrides,
  }
}

describe('parseMessageEvent', () => {
  it('extracts text and resolves mentions to names', () => {
    const ctx = parseMessageEvent(textEvent())
    expect(ctx.messageId).toBe('om_1')
    expect(ctx.chatId).toBe('oc_chat_1')
    expect(ctx.chatType).toBe('p2p')
    expect(ctx.senderOpenId).toBe('ou_user_1')
    expect(ctx.text).toBe('hello @Alice')
    expect(ctx.mentions).toHaveLength(1)
    expect(ctx.mentions[0]).toMatchObject({ openId: 'ou_other', isBot: false })
  })

  it('flags a bot mention when the mention open_id matches the bot', () => {
    const ctx = parseMessageEvent(textEvent(), 'ou_bot')
    expect(ctx.mentions[0]?.isBot).toBe(false)
    const botMention = textEvent({
      message: {
        ...textEvent().message!,
        mentions: [{ key: 'at_bot', id: { open_id: 'ou_bot' }, name: 'Bot' }],
        content: JSON.stringify({ text: 'hi @at_bot' }),
      },
    })
    const botCtx = parseMessageEvent(botMention, 'ou_bot')
    expect(botCtx.mentionedBot).toBe(true)
    expect(botCtx.mentions[0]?.isBot).toBe(true)
  })

  it('detects @all mentions', () => {
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        mentions: [{ key: 'ALL', name: '@all' }],
        content: JSON.stringify({ text: 'everyone' }),
      },
    })
    const ctx = parseMessageEvent(ev)
    expect(ctx.mentionAll).toBe(true)
  })

  it('derives thread id from thread_id or root_id', () => {
    const ev = textEvent({
      message: { ...textEvent().message!, thread_id: 'om_thread' },
    })
    expect(parseMessageEvent(ev).threadId).toBe('om_thread')
  })

  it('maps post messages to text', () => {
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'post',
        content: JSON.stringify({
          title: 'Title',
          body: [[{ tag: 'text', text: 'line one' }, { tag: 'text', text: 'line two' }]],
        }),
      },
    })
    expect(parseMessageEvent(ev).text).toContain('line one')
    expect(parseMessageEvent(ev).text).toContain('line two')
  })

  it('returns a placeholder for media types', () => {
    const ev = textEvent({
      message: { ...textEvent().message!, msg_type: 'image', content: '{}' },
    })
    expect(parseMessageEvent(ev).text).toBe('[图片]')
  })
})

describe('resolveMentions', () => {
  it('replaces mention keys with names', () => {
    const out = resolveMentions('see @at_x', [{ key: 'at_x', id: { open_id: 'ou' }, name: 'Bob' }])
    expect(out).toBe('see @Bob')
  })
})
