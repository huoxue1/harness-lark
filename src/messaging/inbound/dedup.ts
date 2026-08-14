/**
 * Message dedup for WebSocket redelivery.
 *
 * Feishu WebSocket connections may redeliver messages after a reconnect.
 * This module keeps a bounded TTL map of seen message ids per account.
 */

export class MessageDedup {
  private seen = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? 12 * 60 * 60 * 1000
    this.maxEntries = opts?.maxEntries ?? 5000
  }

  /** Record a message id; returns false when it was already seen recently. */
  tryRecord(messageId: string, scope = 'default'): boolean {
    const key = `${scope}:${messageId}`
    const now = Date.now()
    const last = this.seen.get(key)
    if (last !== undefined && now - last < this.ttlMs) {
      // Refresh the timestamp on re-delivery so a long-lived conversation
      // does not wrap around and re-accept an old id.
      this.seen.set(key, now)
      return false
    }
    this.seen.set(key, now)
    this.prune(now)
    return true
  }

  get size(): number {
    return this.seen.size
  }

  dispose(): void {
    this.seen.clear()
  }

  private prune(now: number): void {
    if (this.seen.size <= this.maxEntries) return
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.ttlMs) this.seen.delete(key)
    }
    // If still over budget after TTL expiry, drop oldest entries.
    while (this.seen.size > this.maxEntries) {
      let oldestKey: string | undefined
      let oldestTs = Infinity
      for (const [key, ts] of this.seen) {
        if (ts < oldestTs) {
          oldestTs = ts
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.seen.delete(oldestKey)
    }
  }
}
