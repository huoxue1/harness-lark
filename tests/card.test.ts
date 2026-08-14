import { describe, expect, it, vi } from 'vitest'
import {
  buildCard,
  buildCompleteCard,
  buildErrorCard,
  buildStreamingCard,
  buildThinkingCard,
  splitReasoningText,
  stripReasoningTags,
  formatElapsed,
  compactNumber,
} from '../src/card/builder.ts'
import { FlushController } from '../src/card/flush-controller.ts'

describe('card builder', () => {
  it('builds a thinking card with the streaming element', () => {
    const card = buildThinkingCard('Test Agent')
    expect(card.header?.template).toBe('blue')
    expect(card.elements.length).toBeGreaterThan(0)
  })

  it('shows reasoning lane before answer text arrives', () => {
    const card = buildStreamingCard('', { reasoningText: 'step one' })
    const md = JSON.stringify(card)
    expect(md).toContain('step one')
    expect(md).toContain('Thinking')
  })

  it('shows answer text once it arrives', () => {
    const card = buildStreamingCard('answer text', { reasoningText: 'step one' })
    const md = JSON.stringify(card)
    expect(md).toContain('answer text')
    expect(md).not.toContain('step one')
  })

  it('builds a complete card with collapsible reasoning panel', () => {
    const card = buildCompleteCard({
      text: 'final answer',
      reasoningText: 'thoughts',
      elapsedMs: 1500,
      footer: { status: true, elapsed: true },
      footerMetrics: { inputTokens: 100, outputTokens: 50 },
    })
    const md = JSON.stringify(card)
    expect(md).toContain('final answer')
    expect(md).toContain('collapsible_panel')
    expect(md).toContain('thoughts')
    expect(md).toContain('1.5s')
  })

  it('builds an error card', () => {
    const card = buildErrorCard('boom')
    expect(card.header?.template).toBe('red')
    expect(JSON.stringify(card)).toContain('boom')
  })
})

describe('reasoning text splitting', () => {
  it('splits XML thinking tags', () => {
    const { reasoningText, answerText } = splitReasoningText('<think>inner</think>answer')
    expect(reasoningText).toBe('inner')
    expect(answerText).toBe('answer')
  })

  it('handles unclosed streaming tags', () => {
    const { reasoningText } = splitReasoningText('<think>partial')
    expect(reasoningText).toBe('partial')
  })

  it('strips reasoning tags from plain text', () => {
    expect(stripReasoningTags('<thinking>secret</thinking>visible')).toBe('visible')
  })
})

describe('format helpers', () => {
  it('formats elapsed durations', () => {
    expect(formatElapsed(1500)).toBe('1.5s')
    expect(formatElapsed(90_000)).toBe('1m 30s')
  })

  it('compacts large numbers', () => {
    expect(compactNumber(1234)).toBe('1.2k')
    expect(compactNumber(1_500_000)).toBe('1.5m')
    expect(compactNumber(42)).toBe('42')
  })
})

describe('FlushController', () => {
  it('runs the flush callback with mutex guarding', async () => {
    const calls: number[] = []
    const controller = new FlushController(async () => {
      calls.push(1)
    })
    controller.setCardMessageReady(true)
    await controller.flush()
    await controller.flush()
    expect(calls.length).toBe(2)
  })

  it('skips flushes when the card is not ready', async () => {
    const calls: number[] = []
    const controller = new FlushController(async () => {
      calls.push(1)
    })
    await controller.flush()
    expect(calls.length).toBe(0)
  })

  it('stops flushing after complete()', async () => {
    const calls: number[] = []
    const controller = new FlushController(async () => {
      calls.push(1)
    })
    controller.setCardMessageReady(true)
    controller.complete()
    await controller.flush()
    expect(calls.length).toBe(0)
  })

  it('throttles updates inside the window', async () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const controller = new FlushController(async () => {
        calls.push(1)
      })
      controller.setCardMessageReady(true)
      // First update: inside the initial clock (just set), so it defers.
      void controller.throttledUpdate(1000)
      expect(calls.length).toBe(0)
      // Second update inside the window stays deferred (one timer).
      void controller.throttledUpdate(1000)
      expect(calls.length).toBe(0)
      // Advance past the throttle window; the deferred flush fires.
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls.length).toBe(1)
      // A later update outside the window flushes immediately.
      await vi.advanceTimersByTimeAsync(2000)
      await controller.throttledUpdate(1000)
      expect(calls.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
