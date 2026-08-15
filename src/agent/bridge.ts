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
import {
  installModelSelection,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { HarnessLarkConfig } from '../core/config-schema.ts'
import type { MessageContext } from '../core/types.ts'
import { sendText, type SendMessageParams } from '../messaging/outbound/deliver.ts'
import { addReaction, removeReaction, removeReactionByEmoji } from '../messaging/outbound/reactions.ts'
import type { LarkClient } from '../core/lark-client.ts'
import { StreamingCard } from '../card/streaming-card.ts'
import type { FooterSessionMetrics } from '../card/builder.ts'
import { runCommand } from './commands.ts'

/** Reaction emoji: in-progress and done. */
const PROCESSING_EMOJI = 'Get'
const DONE_EMOJI = 'DONE'

/** Bridge diagnostics go to stdout so they surface in container logs. */
function blog(level: 'info' | 'warn' | 'error', msg: string): void {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[harness-lark] ${msg}`)
}

/** Stable dsh session id derived from the Feishu conversation identity. */
export function sessionIdForChat(accountId: string, chatId: string, generation = 0): SessionId {
  // Generation 0 keeps the original id for backward compatibility with
  // already-persisted sessions; a /new bumps it to mint a fresh session.
  return generation === 0
    ? SessionId(`lark:${accountId}:${chatId}`)
    : SessionId(`lark:${accountId}:${chatId}:${generation}`)
}

/** Session id for a topic-thread message (thread-scoped context). */
export function sessionIdForThread(accountId: string, chatId: string, threadId: string, generation = 0): SessionId {
  return SessionId(`lark:${accountId}:${chatId}:thread:${threadId}${generation === 0 ? '' : `:${generation}`}`)
}

/** Per-chat bridge state. */
interface ChatRecord {
  agent: Agent
  dispose: () => Promise<void>
  /** The chat id the agent replies into. */
  chatId: string
  chatType: 'p2p' | 'group'
  /** The live agent/session id (generation-suffixed after /new). */
  sessionId: SessionId
  /** Context generation: bumped by /new to mint a fresh session. */
  generation: number
  /** Active streaming card for the current turn, when in streaming mode. */
  streamingCard?: StreamingCard
  /** Message id anchor for static replies within one turn. */
  replyAnchor?: string
  /** The user message to reply to — threads under it when in a topic thread. */
  replyTargetId?: string
  /** Whether the current message is inside a topic thread (thread_id present). */
  inThread?: boolean
  /** Per-turn token metrics for the card footer. */
  metrics: {
    inputTokens: number
    outputTokens: number
    cacheRead: number
    cacheWrite: number
  }
  /** Mutable model selection (switched by /model). */
  selectionRef: ModelSelectionRef
  /** Working directory for this chat (switched by /cd). */
  cwd: string
  /** The message id currently being processed (for reaction swap). */
  processingMessageId?: string
  /** Reaction id of the in-progress "Get" emoji. */
  processingReactionId?: string
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

  /** Handle one inbound Feishu message: mention gate, then commands or agent. */
  async handleMessage(message: MessageContext): Promise<void> {
    if (this.closed) return
    const threadScoped = this.opts.config.topicSeparateSession && message.threadId !== undefined
    const key = threadScoped
      ? `${this.opts.accountId}:${message.chatId}:thread:${message.threadId}`
      : `${this.opts.accountId}:${message.chatId}`
    const sessionId = this.sessionIdFor(message, 0)

    // ── Mention gate: group messages (commands included) need @bot unless
    //    allowed. Apply before any agent creation or command handling. ─────
    if (!this.shouldRespond(message)) {
      blog('info', `message ${message.messageId} ignored (group mention gate)`)
      return
    }

    let record = this.records.get(key)
    if (!record) {
      blog('info', `creating agent for ${key}...`)
      record = await this.ensureAgent(sessionId, key, message, process.cwd(), 0)
      blog('info', `agent ready for ${key}`)
    }
    // Track the message to reply to + whether it is inside a topic thread.
    record.replyTargetId = message.messageId
    record.inThread = message.threadId !== undefined

    // ── Slash commands: handled locally, no model turn, no card ──────────
    const text = this.renderUserText(message)
    const cwdHolder = { value: record.cwd }
    const commandResult = await runCommand(message.text, {
      agent: record.agent,
      selection: record.selectionRef,
      cwd: cwdHolder,
      availableModels: await this.availableModels(),
    })
    if (commandResult.handled) {
      await this.replyText(record, commandResult.reply)
      // /new: dispose the current agent and mint a fresh session, keeping cwd
      // and model selection. The generation bump ensures a new session id, so
      // resume cannot reload the old context.
      if (commandResult.resetContext) {
        blog('info', `/new requested for ${key}, resetting context (generation ${record.generation} -> ${record.generation + 1})`)
        const nextGeneration = record.generation + 1
        const newSessionId = this.sessionIdFor(message, nextGeneration)
        const keepCwd = record.cwd
        await record.dispose()
        this.records.delete(key)
        this.sessions.delete(record.sessionId)
        record = await this.ensureAgent(newSessionId, key, message, keepCwd, nextGeneration)
        this.records.set(key, record)
        return
      }
      // /cd changed the working directory: rebuild the agent so the next
      // turn (and shell/fs tools) run in the new directory.
      if (cwdHolder.value !== record.cwd) {
        record.cwd = cwdHolder.value
        blog('info', `cwd changed -> ${record.cwd}, rebuilding agent for ${key}`)
        await record.dispose()
        this.records.delete(key)
        record = await this.ensureAgent(this.sessionIdFor(message, record.generation), key, message, record.cwd, record.generation)
        this.records.set(key, record)
      }
      return
    }

    // ── Streaming mode: open a thinking card before the turn runs ────────
    if (this.replyMode() === 'streaming' && record.streamingCard === undefined) {
      const card = new StreamingCard({
        client: this.opts.client(),
        chatId: message.chatId,
        replyTargetId: message.messageId,
        replyInThread: message.threadId !== undefined,
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

    // ── Reaction feedback: mark the user's message "Get" while processing ──
    void this.markProcessing(record, message)

    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    blog('info', `followup to ${key}: ${text.slice(0, 60)}`)
    record.agent.followup(userMessage)
  }

  /** Send a plain-text reply into the chat (for commands). */
  private async replyText(record: ChatRecord, text: string): Promise<void> {
    const result = await sendText({
      client: this.opts.client().client,
      receiveId: record.chatId,
      receiveIdType: 'chat_id',
      text,
      replyToMessageId: record.replyTargetId,
      replyInThread: record.inThread ?? false,
    })
    if (!result.ok) {
      blog('warn', `command reply failed to ${record.chatId}: ${result.error}`)
    }
  }

  /** Add the in-progress "Get" reaction to the user's message. */
  private async markProcessing(record: ChatRecord, message: MessageContext): Promise<void> {
    try {
      const { reactionId } = await addReaction(this.opts.client().client, message.messageId, PROCESSING_EMOJI)
      record.processingMessageId = message.messageId
      record.processingReactionId = reactionId
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      blog('warn', `addReaction failed on ${message.messageId}: ${msg}`)
    }
  }

  /** Swap the "Get" reaction to "DONE" once the turn completes. */
  private async markDone(record: ChatRecord): Promise<void> {
    if (!record.processingMessageId) return
    const client = this.opts.client().client
    const messageId = record.processingMessageId
    try {
      if (record.processingReactionId) {
        await removeReaction(client, messageId, record.processingReactionId)
      } else {
        await removeReactionByEmoji(client, messageId, PROCESSING_EMOJI)
      }
      await addReaction(client, messageId, DONE_EMOJI)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      blog('warn', `markDone failed on ${messageId}: ${msg}`)
    } finally {
      record.processingMessageId = undefined
      record.processingReactionId = undefined
    }
  }

  /** Create or resume the persistent agent for a chat. */
  private async ensureAgent(
    sessionId: SessionId,
    key: string,
    firstMessage: MessageContext,
    cwd: string,
    generation: number,
  ): Promise<ChatRecord> {
    const agents = this.ctx.agents

    // Resolve the model selection: explicit config wins, else the composed
    // default model (agentDefaultModel). Mirror dsh-headless: the selection
    // must be installed on the agent's scoped context via setup, otherwise
    // the loop has no provider/model route and followup() produces nothing.
    const selection = this.modelSelection()
    const agentOptions = selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
    // Mutable ref shared with the command layer: /model rewrites `current`,
    // which the loop snapshots on the next step.
    const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
    const setup = selection === undefined ? undefined : (agentCtx: Context) => {
      installModelSelection(agentCtx, selectionRef)
    }

    // Try resume first: a persisted session keeps context across restarts.
    let handle: { agent: Agent; dispose: () => Promise<void> } | undefined
    try {
      handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
    } catch (error) {
      // Session not persisted or resume failed — create fresh.
      const message = error instanceof Error ? error.message : String(error)
      blog('warn', `resume failed for ${key}, creating: ${message}`)
      handle = undefined
    }

    if (!handle) {
      try {
        handle = await agents.create({
          sessionId,
          meta: {
            cwd,
            origin: 'subagent',
          },
          agentOptions,
          setup,
        })
        blog('info', `agent created for ${key} (model=${selection?.provider ?? 'default'}/${selection?.model ?? 'default'})`)
      } catch (createError) {
        const message = createError instanceof Error ? createError.message : String(createError)
        blog('error', `agent create failed for ${key}: ${message}`)
        throw createError
      }
    }

    const record: ChatRecord = {
      agent: handle.agent,
      dispose: () => handle!.dispose(),
      chatId: firstMessage.chatId,
      chatType: firstMessage.chatType,
      sessionId,
      generation,
      metrics: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
      selectionRef,
      cwd,
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
        replyToMessageId: record.replyAnchor ?? record.replyTargetId,
        replyInThread: record.replyAnchor === undefined && (record.inThread ?? false),
      }
      const result = await sendText(sendParams)
      if (result.messageId && !record.replyAnchor) {
        record.replyAnchor = result.messageId
      }
      if (!result.ok) {
        blog('warn', `send failed to ${record.chatId}: ${result.error}`)
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
      // Swap the in-progress reaction to done.
      void this.markDone(record)
    }
  }

  /** Compose the model-visible text for an inbound Feishu message. */
  private renderUserText(message: MessageContext): string {
    const sender = message.senderOpenId ? ` (from ${message.senderOpenId})` : ''
    const prefix = message.chatType === 'group' ? `[群聊${sender}] ` : ''
    // Attach attachment keys so the model can download via the download tool.
    let attachmentHint = ''
    if (message.fileKey) {
      attachmentHint += `\n[附件] file_key=${message.fileKey} message_id=${message.messageId}（可用 feishu_download_file 获取内容）`
    }
    if (message.imageKey) {
      attachmentHint += `\n[图片] image_key=${message.imageKey} message_id=${message.messageId}（可用 feishu_download_file 获取内容）`
    }
    return `${prefix}${message.text}${attachmentHint}`
  }

  /**
   * Whether the bot should respond to this message. Group messages must
   * @-mention the bot when `requireMentionInGroups` is on, unless the message
   * is an @all and `respondToMentionAll` allows it. DMs always respond.
   */
  private shouldRespond(message: MessageContext): boolean {
    if (message.chatType !== 'group') return true
    if (!this.opts.config.requireMentionInGroups) return true
    if (message.mentionedBot) return true
    if (message.mentionAll && this.opts.config.respondToMentionAll) return true
    return false
  }

  /** Session id for a message, thread-scoped when the toggle is on and a thread is present. */
  private sessionIdFor(message: MessageContext, generation: number): SessionId {
    const threadScoped = this.opts.config.topicSeparateSession && message.threadId !== undefined
    return threadScoped
      ? sessionIdForThread(this.opts.accountId, message.chatId, message.threadId!, generation)
      : sessionIdForChat(this.opts.accountId, message.chatId, generation)
  }

  private replyMode(): 'static' | 'streaming' {
    const mode = this.opts.replyMode ?? this.opts.config.replyMode
    if (mode === 'auto') return 'static'
    return mode
  }

  /** Resolve the model selection: explicit config wins, else the default. */
  private modelSelection(): ModelSelection | undefined {
    if (this.opts.config.provider && this.opts.config.model) {
      return { provider: this.opts.config.provider, model: this.opts.config.model }
    }
    const defaultModel = this.ctx.get('agentDefaultModel') as
      | { currentSelection(): ModelSelection }
      | undefined
    if (defaultModel) {
      return defaultModel.currentSelection()
    }
    return undefined
  }

  /** List provider/model pairs registered in the llm runtime. */
  private async availableModels(): Promise<Array<{ provider: string; model: string }>> {
    const llm = this.ctx.get('llm') as
      | { listProviders(): Array<{ id: string }>; listModels(provider: string): Promise<Array<{ id: string }>> }
      | undefined
    if (!llm) return []
    const result: Array<{ provider: string; model: string }> = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        for (const m of models) {
          result.push({ provider: provider.id, model: m.id })
        }
      } catch {
        // Provider model listing failed — skip, still list the route itself.
        result.push({ provider: provider.id, model: '*' })
      }
    }
    return result
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
