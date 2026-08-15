/**
 * Core types for harness-lark: Feishu event/message types and the resolved
 * account shape. Kept minimal — only what the dsh-side bridge and the
 * WebSocket gateway need.
 */

import type { HarnessLarkConfig } from './config-schema.ts'

/** A resolved account: config plus derived identity. */
export interface LarkAccount {
  accountId: string
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  brand: 'feishu' | 'lark'
  config: HarnessLarkConfig
  /** Bot open_id, populated after probe. */
  botOpenId?: string
}

/** Raw sender info from a Feishu message event. */
export interface RawSender {
  sender_id?: { open_id?: string; user_id?: string; union_id?: string }
  sender_type?: string
  tenant_key?: string
}

/** A mention inside a Feishu message. */
export interface RawMention {
  key: string
  id?: { open_id?: string; user_id?: string; union_id?: string }
  name?: string
  tenant_key?: string
}

/** Raw message payload from a Feishu message event. */
export interface RawMessage {
  message_id: string
  root_id?: string
  parent_id?: string
  thread_id?: string
  /** Schema 2.0 field name (SDK v1.65+). */
  message_type?: string
  /** Legacy field name (older envelopes). */
  msg_type?: string
  create_time?: string
  update_time?: string
  deleted?: boolean
  chat_id?: string
  chat_type?: string
  content?: string
  mentions?: RawMention[]
  upper_message_id?: string
}

/** The v2 `im.message.receive_v1` event envelope as delivered by the SDK. */
export interface FeishuMessageEvent {
  sender: RawSender
  message: RawMessage
  app_id?: string
  tenant_key?: string
  type?: string
}

/** Normalized mention info after parsing. */
export interface MentionInfo {
  key: string
  openId: string
  name?: string
  isBot: boolean
}

/** A parsed inbound message ready for the agent bridge. */
export interface MessageContext {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
  /** Topic root message id — replying to it keeps the reply inside the thread. */
  rootId?: string
  senderOpenId: string
  senderName?: string
  /** True when the bot is explicitly @mentioned. */
  mentionedBot: boolean
  /** True when @all was used. */
  mentionAll: boolean
  mentions: MentionInfo[]
  /** Extracted plain text of the message (mentions resolved to names). */
  text: string
  /** Original raw content string. */
  rawContent?: string
  createTime?: number
}

/** Result of sending a Feishu message. */
export interface FeishuSendResult {
  messageId?: string
  ok: boolean
  error?: string
}

/** Card action event payload (card.action.trigger). */
export interface FeishuCardActionEvent {
  action?: { value?: Record<string, unknown>; tag?: string }
  context?: { open_id?: string; chat_id?: string }
  operator?: { open_id?: string }
  open_message_id?: string
}

/** Reaction event payload (im.message.reaction.created_v1). */
export interface FeishuReactionEvent {
  message_id?: string
  operator_id?: { open_id?: string }
  reaction_type?: { emoji_type?: string }
  app_id?: string
}
