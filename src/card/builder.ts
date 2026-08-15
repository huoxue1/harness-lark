/**
 * Interactive card building for harness-lark.
 *
 * Builds Feishu Interactive Message Cards for agent response states:
 * thinking (reasoning stream), streaming (answer stream), complete (final
 * result with collapsible reasoning panel and footer metrics), and error.
 * Ported from openclaw-lark's builder.ts (MIT, ByteDance Ltd.), trimmed to
 * the states harness-lark drives and without the CardKit 2.0 tooling.
 */

import { optimizeMarkdownStyle } from './markdown-style.ts'
import { splitTextAndTables } from './markdown-table.ts'

/** Element id used for the streaming text area in cards. */
export const STREAMING_ELEMENT_ID = 'streaming_content'

export interface CardElement {
  tag: string
  [key: string]: unknown
}

export interface FeishuCard {
  config: {
    wide_screen_mode: boolean
    update_multi?: boolean
    locales?: string[]
    summary?: { content: string }
  }
  header?: {
    title: { tag: 'plain_text'; content: string }
    template: string
  }
  elements: CardElement[]
}

export type CardState = 'thinking' | 'streaming' | 'complete' | 'error'

/** Footer session metrics for the complete card. */
export interface FooterSessionMetrics {
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  contextTokens?: number
  totalTokens?: number
  totalTokensFresh?: boolean
}

// ---------------------------------------------------------------------------
// Reasoning text utilities
// ---------------------------------------------------------------------------

const REASONING_PREFIX = 'Reasoning:\n'

/** Split a payload text into optional `reasoningText` and `answerText`. */
export function splitReasoningText(text?: string): { reasoningText?: string; answerText?: string } {
  if (typeof text !== 'string' || !text.trim()) return {}

  const trimmed = text.trim()

  // Case 1: "Reasoning:\n..." prefix — the entire payload is reasoning.
  if (trimmed.startsWith(REASONING_PREFIX) && trimmed.length > REASONING_PREFIX.length) {
    return { reasoningText: cleanReasoningPrefix(trimmed) }
  }

  // Case 2: XML thinking tags — extract content and strip from answer.
  const taggedReasoning = extractThinkingContent(text)
  const strippedAnswer = stripReasoningTags(text)
  if (!taggedReasoning && strippedAnswer === text) {
    return { answerText: text }
  }
  return {
    reasoningText: taggedReasoning || undefined,
    answerText: strippedAnswer || undefined,
  }
}

/** Extract content from `<think>`/`<thinking>`/`<thought>` blocks, handling unclosed streaming tags. */
function extractThinkingContent(text: string): string {
  if (!text) return ''
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi
  let result = ''
  let lastIndex = 0
  let inThinking = false
  for (const match of text.matchAll(scanRe)) {
    const idx = match.index ?? 0
    if (inThinking) {
      result += text.slice(lastIndex, idx)
    }
    inThinking = match[1] !== '/'
    lastIndex = idx + match[0].length
  }
  if (inThinking) {
    result += text.slice(lastIndex)
  }
  return result.trim()
}

/** Strip reasoning blocks — XML tags with content and "Reasoning:\n" prefixes. */
export function stripReasoningTags(text: string): string {
  let result = text.replace(
    /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi,
    '',
  )
  result = result.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, '')
  result = result.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '')
  return result.trim()
}

/** Clean a "Reasoning:\n_italic_" message back to plain text. */
function cleanReasoningPrefix(text: string): string {
  let cleaned = text.replace(/^Reasoning:\s*/i, '')
  cleaned = cleaned
    .split('\n')
    .map((line) => line.replace(/^_(.+)_$/, '$1'))
    .join('\n')
  return cleaned.trim()
}

// ---------------------------------------------------------------------------
// Duration helpers
// ---------------------------------------------------------------------------

/** Format milliseconds into a human-readable duration. */
export function formatElapsed(ms: number): string {
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) {
    const m = value / 1_000_000
    return Math.abs(m) >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`
  }
  if (abs >= 1_000) {
    const k = value / 1_000
    return Math.abs(k) >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
  }
  return `${Math.round(value)}`
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

const HEADER_TEMPLATES: Record<CardState, string> = {
  thinking: 'blue',
  streaming: 'turquoise',
  complete: 'green',
  error: 'red',
}

const STATE_LABELS: Record<CardState, string> = {
  thinking: '💭 思考中',
  streaming: '✍️ 生成中',
  complete: '✅ 完成',
  error: '⚠️ 出错',
}

function buildFooter(zhText: string, enText: string, isError?: boolean): CardElement[] {
  const zhContent = isError ? `<font color='red'>${zhText}</font>` : zhText
  const enContent = isError ? `<font color='red'>${enText}</font>` : enText
  return [
    {
      tag: 'markdown',
      content: enContent,
      i18n_content: { zh_cn: zhContent, en_us: enContent },
      text_size: 'notation',
    },
  ]
}

/**
 * Build the thinking card: shown immediately after the user message.
 */
export function buildThinkingCard(title?: string): FeishuCard {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: 'Thinking...',
      i18n_content: { zh_cn: '思考中...', en_us: 'Thinking...' },
    },
  ]
  if (title) {
    elements.push({
      tag: 'markdown',
      content: `**${title}**`,
      text_size: 'notation',
    })
  }
  return {
    config: { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'] },
    header: {
      title: { tag: 'plain_text', content: STATE_LABELS.thinking },
      template: HEADER_TEMPLATES.thinking,
    },
    elements,
  }
}

/**
 * Build the streaming card: during generation, showing either the
 * reasoning stream (before the first answer text) or the answer stream.
 */
export function buildStreamingCard(
  partialText: string,
  params: { reasoningText?: string; title?: string } = {},
): FeishuCard {
  const { reasoningText, title } = params
  const elements: CardElement[] = []

  if (title) {
    elements.push({
      tag: 'markdown',
      content: `**${title}**`,
      text_size: 'notation',
    })
  }

  if (!partialText && reasoningText) {
    // Reasoning phase: show reasoning content in notation style.
    elements.push({
      tag: 'markdown',
      content: `💭 **Thinking...**\n\n${reasoningText}`,
      i18n_content: {
        zh_cn: `💭 **思考中...**\n\n${reasoningText}`,
        en_us: `💭 **Thinking...**\n\n${reasoningText}`,
      },
      text_size: 'notation',
      element_id: STREAMING_ELEMENT_ID,
    })
  } else if (partialText) {
    // Answer phase: show answer content only.
    elements.push({
      tag: 'markdown',
      content: optimizeMarkdownStyle(partialText),
      element_id: STREAMING_ELEMENT_ID,
    })
  } else {
    elements.push({
      tag: 'markdown',
      content: '…',
      element_id: STREAMING_ELEMENT_ID,
    })
  }

  return {
    config: { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'] },
    header: {
      title: { tag: 'plain_text', content: STATE_LABELS.streaming },
      template: HEADER_TEMPLATES.streaming,
    },
    elements,
  }
}

/**
 * Build the complete card: the final answer with a collapsible reasoning
 * panel (when reasoning was shown) and optional footer metrics.
 */
export function buildCompleteCard(params: {
  text: string
  reasoningText?: string
  reasoningElapsedMs?: number
  elapsedMs?: number
  isError?: boolean
  isAborted?: boolean
  footer?: {
    status?: boolean
    elapsed?: boolean
    tokens?: boolean
    cache?: boolean
    context?: boolean
    model?: boolean
  }
  footerMetrics?: FooterSessionMetrics
  title?: string
}): FeishuCard {
  const {
    text,
    reasoningText,
    reasoningElapsedMs,
    elapsedMs,
    isError,
    isAborted,
    footer,
    footerMetrics,
    title,
  } = params
  const elements: CardElement[] = []

  if (title) {
    elements.push({
      tag: 'markdown',
      content: `**${title}**`,
      text_size: 'notation',
    })
  }

  // Collapsible reasoning panel (before the main content).
  if (reasoningText) {
    const dur = reasoningElapsedMs != null ? formatElapsed(reasoningElapsedMs) : undefined
    const zhLabel = dur ? `💭 思考 · ${dur}` : '💭 思考'
    const enLabel = dur ? `💭 Thought · ${dur}` : '💭 Thought'
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: enLabel,
          i18n_content: {
            zh_cn: zhLabel,
            en_us: enLabel,
          },
        },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '16px 16px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: reasoningText,
          text_size: 'notation',
        },
      ],
    })
  }

  // Full answer text. Markdown tables are converted to native card `table`
  // components (the card markdown element renders them as raw text); each
  // remaining markdown segment is style-optimized individually.
  const answerSegments = splitTextAndTables(text).map((segment) =>
    segment.tag === 'table'
      ? segment
      : { ...segment, content: optimizeMarkdownStyle(String(segment.content)) },
  )
  elements.push(...answerSegments)

  // Footer meta-info: status · elapsed · model / tokens · cache · context.
  const fp = formatFooterRuntimeSegments({ footer, metrics: footerMetrics, elapsedMs, isError, isAborted })
  const footerZhLines: string[] = []
  const footerEnLines: string[] = []
  if (fp.primaryZh.length > 0) {
    footerZhLines.push(fp.primaryZh.join(' · '))
    footerEnLines.push(fp.primaryEn.join(' · '))
  }
  if (fp.detailZh.length > 0) {
    footerZhLines.push(fp.detailZh.join(' · '))
    footerEnLines.push(fp.detailEn.join(' · '))
  }
  if (footerZhLines.length > 0) {
    elements.push(...buildFooter(footerZhLines.join('\n'), footerEnLines.join('\n'), isError))
  }

  // Use the answer text as the feed preview summary.
  const summaryText = text.replace(/[*_`#>[\]()~]/g, '').trim()
  const summary = summaryText ? { content: summaryText.slice(0, 120) } : undefined

  return {
    config: { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'], summary },
    header: {
      title: {
        tag: 'plain_text',
        content: isError ? STATE_LABELS.error : isAborted ? '🛑 已停止' : STATE_LABELS.complete,
      },
      template: HEADER_TEMPLATES[isError || isAborted ? 'error' : 'complete'],
    },
    elements,
  }
}

/** Build the error card. */
export function buildErrorCard(message: string, title?: string): FeishuCard {
  return buildCompleteCard({
    text: `\`\`\`\n${message}\n\`\`\``,
    isError: true,
    title,
  })
}

// ---------------------------------------------------------------------------
// Footer metrics
// ---------------------------------------------------------------------------

function formatFooterRuntimeSegments(params: {
  footer?: {
    status?: boolean
    elapsed?: boolean
    tokens?: boolean
    cache?: boolean
    context?: boolean
    model?: boolean
  }
  metrics?: FooterSessionMetrics
  elapsedMs?: number
  isError?: boolean
  isAborted?: boolean
}): { primaryZh: string[]; primaryEn: string[]; detailZh: string[]; detailEn: string[] } {
  const { footer, metrics, elapsedMs, isError, isAborted } = params
  const primaryZh: string[] = []
  const primaryEn: string[] = []
  const detailZh: string[] = []
  const detailEn: string[] = []

  if (footer?.status) {
    if (isError) {
      primaryZh.push('出错')
      primaryEn.push('Error')
    } else if (isAborted) {
      primaryZh.push('已停止')
      primaryEn.push('Stopped')
    } else {
      primaryZh.push('已完成')
      primaryEn.push('Completed')
    }
  }

  if (footer?.elapsed && elapsedMs != null) {
    const d = formatElapsed(elapsedMs)
    primaryZh.push(`耗时 ${d}`)
    primaryEn.push(`Elapsed ${d}`)
  }

  if (footer?.model && metrics?.model) {
    const model = metrics.model.trim()
    if (model) {
      primaryZh.push(model)
      primaryEn.push(model)
    }
  }

  if (footer?.tokens && metrics) {
    const inTokens = typeof metrics.inputTokens === 'number' ? Math.max(0, metrics.inputTokens) : undefined
    const outTokens = typeof metrics.outputTokens === 'number' ? Math.max(0, metrics.outputTokens) : undefined
    if (inTokens != null && outTokens != null) {
      const inLabel = compactNumber(inTokens)
      const outLabel = compactNumber(outTokens)
      detailZh.push(`↑ ${inLabel} ↓ ${outLabel}`)
      detailEn.push(`↑ ${inLabel} ↓ ${outLabel}`)
    }
  }

  if (footer?.cache && metrics) {
    const read = typeof metrics.cacheRead === 'number' ? Math.max(0, metrics.cacheRead) : undefined
    const write = typeof metrics.cacheWrite === 'number' ? Math.max(0, metrics.cacheWrite) : undefined
    const inputVal = typeof metrics.inputTokens === 'number' ? Math.max(0, metrics.inputTokens) : undefined
    if (read != null && write != null && inputVal != null) {
      const total = read + write + inputVal
      const hit = total > 0 ? Math.round((read / total) * 100) : 0
      detailZh.push(`缓存 ${compactNumber(read)}/${compactNumber(write)} (${hit}%)`)
      detailEn.push(`Cache ${compactNumber(read)}/${compactNumber(write)} (${hit}%)`)
    }
  }

  if (footer?.context && metrics) {
    const freshTotal = metrics.totalTokensFresh === false ? undefined : metrics.totalTokens
    const total = typeof freshTotal === 'number' ? Math.max(0, freshTotal) : undefined
    const ctx = typeof metrics.contextTokens === 'number' ? Math.max(0, metrics.contextTokens) : undefined
    if (total != null && ctx != null) {
      const pct = ctx > 0 ? Math.round((total / ctx) * 100) : 0
      detailZh.push(`上下文 ${compactNumber(total)}/${compactNumber(ctx)} (${pct}%)`)
      detailEn.push(`Context ${compactNumber(total)}/${compactNumber(ctx)} (${pct}%)`)
    }
  }

  return { primaryZh, primaryEn, detailZh, detailEn }
}
