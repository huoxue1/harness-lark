/**
 * Feishu-channel ask-user answerer.
 *
 * dsh exposes `ask_user_question` (via the dsh-tool-ask-user preset row) to
 * let an agent pause and collect a human decision. On a Web session the
 * apiproxy answers it; a Feishu chat has no popup, so the ask hangs the turn
 * forever and every later message queues behind it. This plugin registers a
 * same-name `ask_user_question` tool on each Feishu agent scope (shadowing the
 * preset's copy) that renders the question as an interactive Feishu card with
 * one button per option, and settles the tool call when a button is clicked.
 * A question without options adds a "✏️ 自定义输入" button that switches the
 * pending ask to message mode, where the user's next chat message supplies the
 * answer.
 *
 * @module harness-lark/interaction/ask-user
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sendCard, updateCard } from '../messaging/outbound/deliver.ts'
import type { LarkClient } from '../core/lark-client.ts'

/** One question as received by the tool (structural face of dsh's type). */
export interface AskQuestionItem {
  id: string
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** One answer item returned to the model. */
interface AnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** One pending ask awaiting a card-button click (or a message answer). */
interface PendingAsk {
  /** Stable pending id; also the card-button value + Map key. */
  id: string
  /** Session id of the asking agent (resolves the chat for card delivery). */
  sessionId: string
  /** Chat the card was sent to. */
  chatId: string
  /** Question items pending an answer. */
  questions: AskQuestionItem[]
  /** Settle the tool call with the collected answer. */
  resolve: (answer: { answers: AnswerItem[] }) => void
  /** Settle the tool call with an error (cancelled/aborted). */
  reject: (error: unknown) => void
  /** Set when the next chat message is read as the custom answer. */
  awaitingMessage: boolean
  /** Card message id for patching after the answer. */
  cardMessageId?: string
  /** Expiry timer; auto-cancels an unanswered ask. */
  timeout: NodeJS.Timeout
}

/** Card button action markers. */
const ASK_CUSTOM = 'harness-lark:ask:custom'

/** Default auto-cancel timeout for an unanswered ask card. */
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000

export interface FeishuAskUserOptions {
  client: () => LarkClient
  /** Resolve the chat id from a session id (`lark:<account>:<chatId>[...]`). */
  chatIdOf: (sessionId: string) => string | undefined
  /** Auto-cancel an unanswered ask after this many ms. Default 5 min. */
  timeoutMs?: number
}

/**
 * Install the Feishu ask-user answerer on a context.
 * @param ctx - host context (plugin apply ctx).
 * @param options - client + chat resolution for card delivery.
 * @returns the pending registry handle with card-action/message routing and
 *   a tool-registration factory for agent setups.
 */
export function installFeishuAskUser(ctx: Context, options: FeishuAskUserOptions): {
  /** Route `card.action.trigger` events from the gateway here. The return is
   *  the callback response (`{toast, card}`) used to replace the clicker's card. */
  handleCardAction: (data: unknown) => Promise<{ toast: { type: 'success'; content: string }; card: Record<string, unknown> } | undefined>
  /** Register the Feishu `ask_user_question` tool on one agent scope. */
  registerTool: (agentCtx: Context) => void
  /** Answer a message-mode ask with the user's next chat message. */
  handleChatMessage: (sessionId: string, text: string) => void
  /** Dispose pending asks (reject) and unregister the tool factory's asks. */
  dispose: () => void
} {
  const pendings = new Map<string, PendingAsk>()

  const registerTool = (agentCtx: Context): void => {
    agentCtx.tools.register(defineTool({
      name: 'ask_user_question',
      description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
        + 'Renders an interactive card with one button per option; the chosen option returns immediately. '
        + 'If you need free-form input, omit options and the user answers with a chat message.',
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true },
              question: { type: 'string', required: true },
              header: { type: 'string', description: 'Optional short heading.' },
              options: {
                type: 'array',
                description: 'Optional choices; omit for a free-form chat answer.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true },
                    description: { type: 'string' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: 'Allow more than one option. Defaults to false.' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec: { agent?: { session: { header: { id: string } } }; signal?: AbortSignal }) {
        const sessionId = exec.agent?.session.header.id
        const chatId = sessionId === undefined ? undefined : options.chatIdOf(sessionId)
        if (chatId === undefined || sessionId === undefined) {
          throw new Error('ask_user_question requires a Feishu chat-backed agent session')
        }
        const questions = Array.isArray(args.questions) ? args.questions as AskQuestionItem[] : []
        if (questions.length === 0) {
          throw new Error('ask_user_question requires at least one question')
        }
        const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
        const id = `ask_${Math.random().toString(36).slice(2, 10)}`
        const pending: PendingAsk = {
          id,
          sessionId,
          chatId,
          questions,
          resolve: () => {},
          reject: () => {},
          awaitingMessage: false,
          timeout: setTimeout(() => {
            pendings.delete(id)
            // Auto-cancel: settle the tool call so the turn does not hang.
            pending.resolve({ answers: [] })
            void patchAskCard(options, pending, '⏰ 等待超时，已取消本次提问。')
          }, timeoutMs),
        }
        pending.timeout.unref?.()
        pendings.set(id, pending)
        exec.signal?.addEventListener('abort', () => {
          const current = pendings.get(id)
          if (!current) return
          clearTimeout(current.timeout)
          pendings.delete(id)
          current.resolve({ answers: [] })
        }, { once: true })

        // The settle rune is installed when the promise is created, so a slow
        // card send cannot race the user's click on an already-settled ask.
        const answerPromise = new Promise<{ answers: AnswerItem[] }>((resolve, reject) => {
          pending.resolve = resolve
          pending.reject = reject
        })

        const result = await sendCard({
          client: options.client().client,
          receiveId: chatId,
          receiveIdType: 'chat_id',
          card: buildAskCard(pending),
        })
        if (result.ok && result.messageId) {
          pending.cardMessageId = result.messageId
        } else {
          clearTimeout(pending.timeout)
          pendings.delete(id)
          return Promise.reject(new Error(`ask_user_question card send failed: ${result.error ?? 'unknown'}`))
        }

        return await answerPromise
      },
    }))
  }

  /** Route a card button click to its pending ask. */
  const handleCardAction = async (
    data: unknown,
  ): Promise<{ toast: { type: 'success'; content: string }; card: Record<string, unknown> } | undefined> => {
    const action = (data as { action?: { value?: unknown; tag?: string } })?.action
    const value = action?.value as { askId?: string; option?: string } | undefined
    if (!value?.askId) return undefined
    const pending = pendings.get(value.askId)
    if (!pending) return undefined
    // Custom-input button: switch to message mode and tell the user.
    if (value.option === ASK_CUSTOM) {
      pending.awaitingMessage = true
      settleAskCard(options, pending, '请直接回复消息输入你的答案。')
      return {
        toast: { type: 'success', content: '请直接回复消息输入你的答案。' },
        card: buildAskCard(pending, { note: '请直接回复消息输入你的答案。' }),
      }
    }
    clearTimeout(pending.timeout)
    pendings.delete(pending.id)
    const option = value.option ?? ''
    pending.resolve({
      answers: [{ id: pending.questions[0]?.id ?? '', selected: option ? [option] : [] }],
    })
    settleAskCard(options, pending, `✅ 已选择: ${option}`)
    return {
      toast: { type: 'success', content: `✅ 已选择: ${option}` },
      card: buildAskCard(pending, { settled: true, note: `✅ 已选择: ${option}` }),
    }
  }

  /** Answer a message-mode ask with the user's next chat message. */
  const handleChatMessage = (sessionId: string, text: string): void => {
    // Find the newest message-mode ask for this session (dashboard switch).
    let target: PendingAsk | undefined
    for (const pending of pendings.values()) {
      if (pending.sessionId === sessionId && pending.awaitingMessage) target = pending
    }
    if (!target) return
    clearTimeout(target.timeout)
    pendings.delete(target.id)
    target.resolve({
      answers: target.questions.map(q => ({
        id: q.id,
        selected: [],
        custom: text,
      })),
    })
    settleAskCard(options, target, `✏️ 已收到你的回答: ${text}`)
  }

  return {
    handleCardAction,
    registerTool,
    handleChatMessage,
    dispose: () => {
      for (const pending of pendings.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('feishu ask-user registry shut down'))
      }
      pendings.clear()
    },
  }
}

/** Build the ask card (Feishu Card 2.0): question + one button per option. */
function buildAskCard(pending: PendingAsk, opts: { settled?: boolean; note?: string } = {}): {
  schema: '2.0'
  config: { wide_screen_mode: boolean; update_multi?: boolean }
  header?: { title: { tag: 'plain_text'; content: string }; template: string }
  body: { elements: Array<Record<string, unknown>> }
} {
  const q = pending.questions[0]
  const lines = [`**${q?.question ?? '请回答'}**`]
  if (q?.header) lines.unshift(`**${q.header}**`)
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: lines.join('\n') }]
  // Settled cards drop the buttons so a second click is impossible.
  if (!opts.settled) {
    const buttons: Array<Record<string, unknown>> = []
    for (const option of q?.options ?? []) {
      buttons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: option.label.slice(0, 100) },
        type: 'default',
        value: { askId: pending.id, option: option.label },
      })
    }
    if (!q?.options || q.options.length === 0) {
      buttons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '✏️ 自定义输入' },
        type: 'primary',
        value: { askId: pending.id, option: ASK_CUSTOM },
      })
      lines.push('', '点击按钮后，直接回复消息输入你的答案。')
      elements[0] = { tag: 'markdown', content: lines.join('\n') }
    }
    if (buttons.length === 1) {
      elements.push(buttons[0]!)
    } else if (buttons.length > 1) {
      // Two+ options: one weighted column per button so they sit side by side.
      elements.push({
        tag: 'column_set',
        columns: buttons.map((button) => ({
          tag: 'column',
          width: 'weighted',
          elements: [button],
        })),
      })
    }
  }
  if (opts.note) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `**${opts.note}**` })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '❓ 需要你确认' }, template: 'blue' },
    body: { elements },
  }
}

/**
 * Update the ask card for EVERY viewer via API, deferred past the callback
 * return (openclaw-lark pattern): the callback-response card only replaces it
 * for the clicker; running the API update first would race the response.
 */
function settleAskCard(
  options: FeishuAskUserOptions,
  pending: PendingAsk,
  note: string,
): void {
  setImmediate(() => {
    void patchAskCard(options, pending, note).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[harness-lark] ask-user card patch failed: ${message}`)
    })
  })
}

/** Patch the ask card after an answer arrives, removing the buttons. */
async function patchAskCard(
  options: FeishuAskUserOptions,
  pending: PendingAsk,
  note: string,
): Promise<void> {
  if (!pending.cardMessageId) return
  const card = buildAskCard(pending, { settled: true, note })
  await updateCard({
    client: options.client().client,
    messageId: pending.cardMessageId,
    card,
  })
}