/**
 * Streaming card controller for harness-lark.
 *
 * Drives a single Feishu interactive card through the full reply
 * lifecycle: thinking -> (reasoning stream) -> (answer stream) -> complete
 * or error. Reasoning deltas render in a notation lane until the first
 * answer text arrives; answer deltas stream into the main lane. Updates
 * are throttled through FlushController and applied with `im.message.patch`.
 *
 * Ported from openclaw-lark's streaming-card-controller.ts (MIT, ByteDance
 * Ltd.), trimmed to the text lanes harness-lark drives.
 */

import type { LarkClient } from '../core/lark-client.ts'
import {
  buildCompleteCard,
  buildErrorCard,
  buildStreamingCard,
  buildThinkingCard,
  type FooterSessionMetrics,
} from './builder.ts'
import { FlushController } from './flush-controller.ts'
import { sendCard, updateCard } from '../messaging/outbound/deliver.ts'

/** Throttle window between streaming card patches, ms. */
const PATCH_THROTTLE_MS = 1200

export interface StreamingCardDeps {
  client: LarkClient
  /** Chat id the card is sent into. */
  chatId: string
  /** User message to reply to. */
  replyTargetId?: string
  /** Reply inside the topic thread when the inbound message has a thread_id. */
  replyInThread?: boolean
  /** Optional title for the card header. */
  title?: string
  /** Footer metric toggles for the complete card. */
  footer?: {
    status?: boolean
    elapsed?: boolean
    tokens?: boolean
    cache?: boolean
    context?: boolean
    model?: boolean
  }
}

type CardPhase = 'idle' | 'creating' | 'thinking' | 'streaming' | 'complete' | 'error'

/**
 * One streaming reply card. Call `start()`, feed `reasoning-delta` /
 * `text-delta` chunks via `appendReasoning()` / `appendAnswer()`, then
 * `finish()` or `fail()`.
 */
export class StreamingCard {
  private readonly deps: StreamingCardDeps
  private phase: CardPhase = 'idle'
  private messageId: string | undefined
  private reasoningBuffer = ''
  private answerBuffer = ''
  private reasoningStartedAt: number | undefined
  private startedAt: number | undefined
  private flush: FlushController
  private settled = false

  constructor(deps: StreamingCardDeps) {
    this.deps = deps
    this.flush = new FlushController(() => this.applyCard())
  }

  /** Send the initial thinking card. */
  async start(): Promise<void> {
    if (this.phase !== 'idle') return
    this.phase = 'creating'
    this.startedAt = Date.now()
    const card = buildThinkingCard(this.deps.title)
    const result = await sendCard({
      client: this.deps.client.client,
      receiveId: this.deps.chatId,
      receiveIdType: 'chat_id',
      card,
      replyToMessageId: this.deps.replyTargetId,
      replyInThread: this.deps.replyInThread ?? false,
    })
    if (result.ok && result.messageId) {
      this.messageId = result.messageId
      this.phase = 'thinking'
      this.flush.setCardMessageReady(true)
    } else {
      // Card creation failed — fall back to a static text reply later.
      this.phase = 'error'
    }
  }

  /** Feed a reasoning delta (before the first answer text). */
  appendReasoning(text: string): void {
    if (this.settled || this.phase === 'error') return
    if (this.phase === 'thinking' && this.reasoningStartedAt === undefined) {
      this.reasoningStartedAt = Date.now()
    }
    this.reasoningBuffer += text
    if (this.phase !== 'streaming') {
      this.phase = 'thinking'
    }
    void this.flush.throttledUpdate(PATCH_THROTTLE_MS)
  }

  /** Feed an answer text delta (streaming into the main lane). */
  appendAnswer(text: string): void {
    if (this.settled || this.phase === 'error') return
    if (this.phase !== 'streaming') {
      this.phase = 'streaming'
    }
    this.answerBuffer += text
    void this.flush.throttledUpdate(PATCH_THROTTLE_MS)
  }

  /**
   * Complete the card with the final text. When reasoning was streamed,
   * the complete card shows a collapsible reasoning panel plus the answer.
   */
  async finish(params?: {
    answerText?: string
    reasoningText?: string
    footerMetrics?: FooterSessionMetrics
    isAborted?: boolean
  }): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.flush.complete()
    this.flush.cancelPendingFlush()
    await this.flush.waitForFlush()

    if (!this.messageId) return
    const answer = params?.answerText ?? this.answerBuffer
    const reasoning = params?.reasoningText ?? this.reasoningBuffer
    const card = buildCompleteCard({
      text: answer || '…',
      reasoningText: reasoning || undefined,
      reasoningElapsedMs:
        this.reasoningStartedAt !== undefined ? Date.now() - this.reasoningStartedAt : undefined,
      elapsedMs: this.startedAt !== undefined ? Date.now() - this.startedAt : undefined,
      isAborted: params?.isAborted,
      footer: this.deps.footer,
      footerMetrics: params?.footerMetrics,
      title: this.deps.title,
    })
    this.phase = 'complete'
    await updateCard({ client: this.deps.client.client, messageId: this.messageId, card })
  }

  /** Mark the card as failed. */
  async fail(error: unknown): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.flush.complete()
    this.flush.cancelPendingFlush()
    await this.flush.waitForFlush()

    if (!this.messageId) return
    const message = error instanceof Error ? error.message : String(error)
    const card = buildErrorCard(message, this.deps.title)
    this.phase = 'error'
    await updateCard({ client: this.deps.client.client, messageId: this.messageId, card })
  }

  /** Whether the card has a message id (start succeeded). */
  get active(): boolean {
    return this.messageId !== undefined
  }

  /** Whether the card is in a terminal phase. */
  get done(): boolean {
    return this.settled
  }

  private async applyCard(): Promise<void> {
    if (!this.messageId || this.settled) return
    const card = buildStreamingCard(this.answerBuffer, {
      reasoningText: this.answerBuffer ? undefined : this.reasoningBuffer,
      title: this.deps.title,
    })
    await updateCard({ client: this.deps.client.client, messageId: this.messageId, card })
  }
}
