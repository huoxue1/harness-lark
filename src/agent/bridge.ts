/**
 * dsh agent bridge: maps Feishu chats to persistent dsh agents.
 *
 * Design (mirrors the ACP bridge pattern):
 * - Each Feishu conversation (accountId + chatId) maps to one stable
 *   dsh session id, so context survives across messages and restarts.
 * - Inbound Feishu messages are queued with `agent.followup()`.
 * - Committed assistant text is read from `session/event` and sent back
 *   to the originating chat. In streaming mode the reply is rendered as
 *   an interactive card patched from `assistant/chunk` deltas; in static
 *   mode it is one final post message.
 * - Turn completion is observed via `turn/end`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { HarnessLarkConfig } from '../core/config-schema.ts'
import type { MessageContext } from '../core/types.ts'
import { sendText, type SendMessageParams } from '../messaging/outbound/deliver.ts'
import type { LarkClient } from '../core/lark-client.ts'
import { StreamingCard } from '../card/streaming-card.ts'
import type { FooterSessionMetrics } from '../card/builder.ts'

/** Stable dsh session id derived from the Feishu conversation identity. */
export function sessionIdForChat(accountId: string, chatId: string): SessionId {
  return SessionId(`lark:${accountId}:${chatId}`)
}

/** Per-chat bridge state. */
interface ChatRecord {
  agent: Agent
  dispose: () => Promise<void>
  /** The chat id the agent replies into. */
  chatId: string
  chatType: 'p2p' | 'group'
  /** Active streaming card for the current turn, when in streaming mode. */
  streamingCard?: StreamingCard
  /** Message id anchor for static replies within one turn. */
  replyAnchor?: string
  /** Per-turn token metrics for the card footer. */
  metrics: {
    inputTokens: number
    outputTokens: number
    cacheRead: number
    cacheWrite: number
  }
}

export interface AgentBridgeOptions {
  config: HarnessLarkConfig
  accountId: string
  /** Resolve the Lark client used to send replies for this account. */
  client: () => LarkClient
  /** Reply mode override; falls back to config.replyMode. */
  replyMode?: 'static' | 'streaming'
}

/**
 * Bridge a Feishu chat to a persistent dsh agent.
 *
 * The first message for a chat creates the session; later messages resume
 * it. The returned promise settles when the message's turn is fully
 * committed (or rejected by admission).
 */
export class AgentBridge {
  private readonly records = new Map<string, ChatRecord>()
  private readonly sessions = new Map<SessionId, string>()
  private ctx: Context
  private opts: AgentBridgeOptions
  private closed = false

  constructor(ctx: Context, opts: AgentBridgeOptions) {
    this.ctx = ctx
    this.opts = opts
  }

  /** Handle one inbound Feishu message: route to the chat's agent. */
  async handleMessage(message: MessageContext): Promise<void> {
    if (this.closed) return
    const key = `${this.opts.accountId}:${message.chatId}`
    const sessionId = sessionIdForChat(this.opts.accountId, message.chatId)

    let record = this.records.get(key)
    if (!record) {
      record = await this.ensureAgent(sessionId, key, message)
    }

    // Streaming mode: open a thinking card before the turn runs.
    if (this.replyMode() === 'streaming' && record.streamingCard === undefined) {
      const card = new StreamingCard({
        client: this.opts.client(),
        chatId: message.chatId,
        title: 'DeepSeek Agent',
        footer: {
          status: true,
          elapsed: true,
          tokens: true,
        },
      })
      record.streamingCard = card
      void card.start()
    }

    const text = this.renderUserText(message)
    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    record.agent.followup(userMessage)
  }

  /** Create or resume the persistent agent for a chat. */
  private async ensureAgent(
    sessionId: SessionId,
    key: string,
    firstMessage: MessageContext,
  ): Promise<ChatRecord> {
    const agents = this.ctx.agents

    // Try resume first: a persisted session keeps context across restarts.
    let handle: { agent: Agent; dispose: () => Promise<void> } | undefined
    try {
      handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
      })
    } catch (error) {
      // Session not persisted or resume failed — create fresh.
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[harness-lark] resume failed for ${key}, creating: ${message}`)
      handle = undefined
    }

    if (!handle) {
      handle = await agents.create({
        sessionId,
        meta: {
          cwd: process.cwd(),
          origin: 'subagent',
        },
        agentOptions: this.agentOptions(),
      })
    }

    const record: ChatRecord = {
      agent: handle.agent,
      dispose: () => handle!.dispose(),
      chatId: firstMessage.chatId,
      chatType: firstMessage.chatType,
      metrics: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    }
    this.records.set(key, record)
    this.sessions.set(sessionId, key)

    // Observe the session feed: stream deltas into the card, send committed
    // text (static mode), and settle the card at turn end.
    this.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.header.id !== sessionId) return
      void this.onSessionEvent(key, record, sessionId, event)
    })

    return record
  }

  /** Handle a session event for a chat's agent. */
  private async onSessionEvent(
    key: string,
    record: ChatRecord,
    sessionId: SessionId,
    event: SessionEvent,
  ): Promise<void> {
    if (this.closed) return
    const client = this.opts.client()
    const streaming = this.replyMode() === 'streaming'

    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (streaming) {
        if (chunk.type === 'reasoning-delta') {
          record.streamingCard?.appendReasoning(chunk.text)
        } else if (chunk.type === 'text-delta') {
          record.streamingCard?.appendAnswer(chunk.text)
        } else if (chunk.type === 'usage') {
          record.metrics.inputTokens += chunk.usage.inputTokens
          record.metrics.outputTokens += chunk.usage.outputTokens
          record.metrics.cacheRead += chunk.usage.cacheReadTokens ?? 0
          record.metrics.cacheWrite += chunk.usage.cacheWriteTokens ?? 0
        }
      }
      return
    }

    if (event.type === 'assistant/message') {
      const text = extractAssistantText(event)
      if (!text) return
      if (streaming) {
        // The final committed text supersedes the streamed buffer.
        record.streamingCard?.appendAnswer(text)
        return
      }
      const sendParams: SendMessageParams = {
        client: client.client,
        receiveId: record.chatId,
        receiveIdType: 'chat_id',
        text,
        replyToMessageId: record.replyAnchor,
      }
      const result = await sendText(sendParams)
      if (result.messageId && !record.replyAnchor) {
        record.replyAnchor = result.messageId
      }
      if (!result.ok) {
        this.ctx.logger.warn(`[harness-lark] send failed to ${record.chatId}: ${result.error}`)
      }
      return
    }

    if (event.type === 'turn/end') {
      if (streaming && record.streamingCard) {
        const footerMetrics: FooterSessionMetrics = {
          inputTokens: record.metrics.inputTokens,
          outputTokens: record.metrics.outputTokens,
          cacheRead: record.metrics.cacheRead,
          cacheWrite: record.metrics.cacheWrite,
        }
        await record.streamingCard.finish({ footerMetrics })
        record.streamingCard = undefined
      }
      record.replyAnchor = undefined
      record.metrics = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }
      void this.sessions.get(sessionId)
    }
  }

  /** Compose the model-visible text for an inbound Feishu message. */
  private renderUserText(message: MessageContext): string {
    const sender = message.senderOpenId ? ` (from ${message.senderOpenId})` : ''
    const prefix = message.chatType === 'group' ? `[群聊${sender}] ` : ''
    return `${prefix}${message.text}`
  }

  private replyMode(): 'static' | 'streaming' {
    const mode = this.opts.replyMode ?? this.opts.config.replyMode
    if (mode === 'auto') return 'static'
    return mode
  }

  private agentOptions(): Record<string, unknown> | undefined {
    const opts: Record<string, unknown> = {}
    if (this.opts.config.provider) opts.provider = this.opts.config.provider
    if (this.opts.config.model) opts.model = this.opts.config.model
    return Object.keys(opts).length > 0 ? opts : undefined
  }

  /** Dispose all agents owned by this bridge. */
  async dispose(): Promise<void> {
    this.closed = true
    const disposers = [...this.records.values()].map((r) => r.dispose())
    this.records.clear()
    this.sessions.clear()
    await Promise.allSettled(disposers)
  }
}

/** Extract committed text blocks from an assistant/message event. */
function extractAssistantText(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  const parts: string[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('')
}
