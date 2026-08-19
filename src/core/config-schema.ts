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

/** A chat matcher: an exact `oc_...` chat id, or the `p2p`/`group` type tag. */
export type AgentChatRule = string

/** One Feishu agent: a chat-routed partition of one Feishu app. */
export interface HarnessLarkAgent {
  /** Stable agent id (used in session ids and settings). */
  id: string
  /** Feishu app id (may be shared by several agents). */
  appId: string
  /** Feishu app secret. */
  appSecret: string
  /** Event encryption key (empty for long-connection mode). */
  encryptKey?: string
  /** Event verification token (empty for long-connection mode). */
  verificationToken?: string
  /** Default working directory for sessions created by this agent. */
  cwd?: string
  /** Workspace instructions written to `<cwd>/AGENTS.md` for this agent. */
  agentsMd?: string
  /**
   * Chats this agent serves: exact `oc_...` chat ids and/or the `p2p`/`group`
   * type tags. A message matches when its chat id is listed or its chat type
   * tag is listed. Absent = serve every chat (only valid for one agent per app).
   */
  chats?: AgentChatRule[]
  /** Marks this agent as the default route for chats matching no other agent. */
  default?: boolean
}

/** Plugin configuration. */
export interface HarnessLarkConfig {
  /** Feishu app id (legacy single-agent; superseded by `agents`). */
  appId: string
  /** Feishu app secret (legacy single-agent; superseded by `agents`). */
  appSecret: string
  /** Event encryption key (empty for long-connection mode). */
  encryptKey?: string
  /** Event verification token (empty for long-connection mode). */
  verificationToken?: string
  /** Multi-agent configuration: one entry per Feishu app. */
  agents?: HarnessLarkAgent[]
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
  /**
   * Whether an @all mention in a group satisfies the mention requirement when
   * `requireMentionInGroups` is true. Defaults to false (must @ the bot).
   */
  respondToMentionAll: boolean
  /**
   * Whether topic-group (话题群) messages get their own session per thread.
   * When true, a message carrying a `thread_id` maps to a session id that
   * includes the thread id, so each topic keeps an independent context.
   * When false (default), all messages in a chat share one session.
   */
  topicSeparateSession: boolean
  /** Dedup TTL for WebSocket redelivered messages, ms. */
  dedupTtlMs: number
  /** How long an ask_user_question card waits before auto-cancelling, ms. Default 5 min. */
  askTimeoutMs?: number
  /** How long an approval card waits before auto-denying, ms. Default 5 min. */
  approvalTimeoutMs?: number
}

export const Config: Schema<HarnessLarkConfig> = Schema.object({
  appId: Schema.string().description('Feishu app id (legacy single-agent; use `agents` for multiple)'),
  appSecret: Schema.string().description('Feishu app secret (legacy single-agent; use `agents` for multiple)'),
  encryptKey: Schema.string().description('Event encryption key (empty for long-connection mode)'),
  verificationToken: Schema.string().description('Event verification token (empty for long-connection mode)'),
  agents: Schema.array(Schema.object({
    id: Schema.string().required().description('Stable agent id (used in session ids and settings)'),
    appId: Schema.string().required().description('Feishu app id (may be shared by several agents)'),
    appSecret: Schema.string().required().description('Feishu app secret'),
    encryptKey: Schema.string().description('Event encryption key (empty for long-connection mode)'),
    verificationToken: Schema.string().description('Event verification token (empty for long-connection mode)'),
    cwd: Schema.string().description('Default working directory for sessions created by this agent'),
    agentsMd: Schema.string().description('Workspace instructions written to <cwd>/AGENTS.md for this agent'),
    chats: Schema.array(Schema.string()).description('Chats this agent serves: exact oc_... ids and/or p2p/group tags'),
    default: Schema.boolean().description('Default route for chats matching no other agent'),
  })).description('Multi-agent configuration: one entry per chat-routed agent'),
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
  respondToMentionAll: Schema.boolean().default(false).description('An @all mention satisfies the group mention requirement'),
  topicSeparateSession: Schema.boolean().default(false).description('Topic-group messages get their own session per thread'),
  dedupTtlMs: Schema.number().default(12 * 60 * 60 * 1000).description('Dedup TTL for redelivered messages, ms'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('ask_user_question card auto-cancel timeout, ms'),
  approvalTimeoutMs: Schema.number().default(5 * 60 * 1000).description('approval card auto-deny timeout, ms'),
})
