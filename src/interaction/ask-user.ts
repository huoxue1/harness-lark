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

/** How long an unanswered ask card waits before cancelling. */
const ASK_TIMEOUT_MS = 10 * 60 * 1000

export interface FeishuAskUserOptions {
  client: () => LarkClient
  /** Resolve the chat id from a session id (`lark:<account>:<chatId>[...]`). */
  chatIdOf: (sessionId: string) => string | undefined
}

/**
 * Install the Feishu ask-user answerer on a context.
 * @param ctx - host context (plugin apply ctx).
 * @param options - client + chat resolution for card delivery.
 * @returns the pending registry handle with card-action/message routing and
 *   a tool-registration factory for agent setups.
 */
export function installFeishuAskUser(ctx: Context, options: FeishuAskUserOptions): {
  /** Route `card.action.trigger` events from the gateway here. */
  handleCardAction: (data: unknown) => Promise<void>
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
            pending.reject(new Error('ask_user_question timed out waiting for an answer'))
          }, ASK_TIMEOUT_MS),
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
  const handleCardAction = async (data: unknown): Promise<void> => {
    const action = (data as { action?: { value?: unknown; tag?: string } })?.action
    const value = action?.value as { askId?: string; option?: string } | undefined
    if (!value?.askId) return
    const pending = pendings.get(value.askId)
    if (!pending) return
    // Custom-input button: switch to message mode and tell the user.
    if (value.option === ASK_CUSTOM) {
      pending.awaitingMessage = true
      await patchAskCard(options, pending, '请直接回复消息输入你的答案。')
      return
    }
    clearTimeout(pending.timeout)
    pendings.delete(pending.id)
    const option = value.option ?? ''
    pending.resolve({
      answers: [{ id: pending.questions[0]?.id ?? '', selected: option ? [option] : [] }],
    })
    await patchAskCard(options, pending, `✅ 已选择: ${option}`)
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
    void patchAskCard(options, target, `✏️ 已收到你的回答: ${text}`)
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

/** Build the ask card: question text + one button per option (+ custom). */
function buildAskCard(pending: PendingAsk): {
  config: { wide_screen_mode: boolean; update_multi?: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: Array<Record<string, unknown>>
} {
  const q = pending.questions[0]
  const lines = [`**${q?.question ?? '请回答'}**`]
  if (q?.header) lines.unshift(`**${q.header}**`)
  const actions: Array<Record<string, unknown>> = []
  for (const option of q?.options ?? []) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: option.label.slice(0, 100) },
      type: 'default',
      value: { askId: pending.id, option: option.label },
    })
  }
  if (!q?.options || q.options.length === 0) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✏️ 自定义输入' },
      type: 'primary',
      value: { askId: pending.id, option: ASK_CUSTOM },
    })
    lines.push('', '点击按钮后，直接回复消息输入你的答案。')
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '❓ 需要你确认' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'action', actions },
    ],
  }
}

/** Patch the ask card after an answer arrives. */
async function patchAskCard(
  options: FeishuAskUserOptions,
  pending: PendingAsk,
  note: string,
): Promise<void> {
  if (!pending.cardMessageId) return
  const card = buildAskCard(pending)
  card.elements.push({ tag: 'hr' })
  card.elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${note}**` } })
  await updateCard({
    client: options.client().client,
    messageId: pending.cardMessageId,
    card,
  })
}