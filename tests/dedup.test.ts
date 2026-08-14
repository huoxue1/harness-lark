import { describe, expect, it, vi } from 'vitest'
import { MessageDedup } from '../src/messaging/inbound/dedup.ts'

describe('MessageDedup', () => {
  it('accepts a first delivery and rejects a redelivery', () => {
    const dedup = new MessageDedup({ ttlMs: 1000 })
    expect(dedup.tryRecord('msg-1', 'acc')).toBe(true)
    expect(dedup.tryRecord('msg-1', 'acc')).toBe(false)
  })

  it('scopes keys per account', () => {
    const dedup = new MessageDedup({ ttlMs: 1000 })
    expect(dedup.tryRecord('msg-1', 'acc-a')).toBe(true)
    expect(dedup.tryRecord('msg-1', 'acc-b')).toBe(true)
  })

  it('re-accepts after TTL expiry', () => {
    vi.useFakeTimers()
    try {
      const dedup = new MessageDedup({ ttlMs: 100 })
      expect(dedup.tryRecord('msg-1', 'acc')).toBe(true)
      vi.advanceTimersByTime(101)
      expect(dedup.tryRecord('msg-1', 'acc')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes entries over the max budget', () => {
    const dedup = new MessageDedup({ ttlMs: 1000, maxEntries: 3 })
    for (let i = 0; i < 10; i++) {
      expect(dedup.tryRecord(`msg-${i}`, 'acc')).toBe(true)
    }
    expect(dedup.size).toBeLessThanOrEqual(3)
  })
})
