/**
 * Configuration schema for the harness-lark plugin.
 *
 * Adapted from openclaw-lark's zod schema to schemastery, the schema
 * library DeepSeek Harness uses for plugin config validation.
 */

import Schema from '@deepseek-ai/schemastery'

/** The Lark platform brand. `feishu` targets China-mainland, `lark` the international service. */
export type LarkBrand = 'feishu' | 'lark'

/** How the plugin connects to Feishu to receive events. */
export type FeishuConnectionMode = 'websocket' | 'webhook'

/** How the agent replies: stream into a card (streaming) or send one final message (static). */
export type ReplyModeValue = 'auto' | 'static' | 'streaming'

/** Per-chat access policy. */
export type ChatPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled'

/** Plugin configuration. */
export interface HarnessLarkConfig {
  /** Feishu app id. */
  appId: string
  /** Feishu app secret. */
  appSecret: string
  /** Event encryption key (empty for long-connection mode). */
  encryptKey?: string
  /** Event verification token (empty for long-connection mode). */
  verificationToken?: string
  /** Platform brand: feishu or lark. */
  brand: LarkBrand
  /** Connection mode: websocket (long connection) or webhook. */
  connectionMode: FeishuConnectionMode
  /** Provider route for agents created for Feishu chats. */
  provider?: string
  /** Model name for agents created for Feishu chats. */
  model?: string
  /** Reply mode: auto / static / streaming. */
  replyMode: ReplyModeValue
  /** DM policy: open / pairing / allowlist / disabled. */
  dmPolicy: ChatPolicy
  /** Group policy: open / allowlist / disabled. */
  groupPolicy: Exclude<ChatPolicy, 'pairing'>
  /** open_id allowlist for pairing/allowlist policies. */
  allowlist?: string[]
  /** Whether to accept messages that @mention the bot in groups. */
  requireMentionInGroups: boolean
  /** Dedup TTL for WebSocket redelivered messages, ms. */
  dedupTtlMs: number
}

export const Config: Schema<HarnessLarkConfig> = Schema.object({
  appId: Schema.string().description('Feishu app id'),
  appSecret: Schema.string().description('Feishu app secret'),
  encryptKey: Schema.string().description('Event encryption key (empty for long-connection mode)'),
  verificationToken: Schema.string().description('Event verification token (empty for long-connection mode)'),
  brand: Schema.union([
    Schema.const('feishu'),
    Schema.const('lark'),
  ]).default('feishu' as const),
  connectionMode: Schema.union([
    Schema.const('websocket'),
    Schema.const('webhook'),
  ]).default('websocket' as const),
  provider: Schema.string().description('Provider route for agents created for Feishu chats'),
  model: Schema.string().description('Model name for agents created for Feishu chats'),
  replyMode: Schema.union([
    Schema.const('auto'),
    Schema.const('static'),
    Schema.const('streaming'),
  ]).default('auto' as const),
  dmPolicy: Schema.union([
    Schema.const('open'),
    Schema.const('pairing'),
    Schema.const('allowlist'),
    Schema.const('disabled'),
  ]).default('open' as const),
  groupPolicy: Schema.union([
    Schema.const('open'),
    Schema.const('allowlist'),
    Schema.const('disabled'),
  ]).default('disabled' as const),
  allowlist: Schema.array(Schema.string()).description('open_id allowlist for pairing/allowlist policies'),
  requireMentionInGroups: Schema.boolean().default(true),
  dedupTtlMs: Schema.number().default(12 * 60 * 60 * 1000).description('Dedup TTL for redelivered messages, ms'),
})
