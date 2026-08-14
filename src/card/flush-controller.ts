/**
 * Generic throttled flush controller.
 *
 * A pure scheduling primitive managing timer-based throttling, mutex-guarded
 * flushing, and reflush-on-conflict. Ported from openclaw-lark's
 * flush-controller.ts (MIT, ByteDance Ltd.).
 */

/** Throttle tuning constants shared by the streaming card. */
export const THROTTLE_CONSTANTS = {
  /** Below this gap a flush fires immediately; above it we batch first. */
  LONG_GAP_THRESHOLD_MS: 3000,
  /** Batch delay after a long gap so the first visible update has content. */
  BATCH_AFTER_GAP_MS: 400,
} as const

export class FlushController {
  private flushInProgress = false
  private flushResolvers: Array<() => void> = []
  private needsReflush = false
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpdateTime = 0
  private isCompleted = false
  private _cardMessageReady = false

  constructor(private readonly doFlush: () => Promise<void>) {}

  /** Mark the controller as completed — no more flushes after the current one. */
  complete(): void {
    this.isCompleted = true
  }

  /** Cancel any pending deferred flush timer. */
  cancelPendingFlush(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = null
    }
  }

  /** Wait for any in-progress flush to finish. */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) return Promise.resolve()
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve))
  }

  /** Whether the flush target (a card message) is ready. */
  cardMessageReady(): boolean {
    return this._cardMessageReady
  }

  /** Mark the flush target ready; initializes the throttle clock. */
  setCardMessageReady(ready: boolean): void {
    this._cardMessageReady = ready
    if (ready) {
      this.lastUpdateTime = Date.now()
    }
  }

  /**
   * Execute a flush (mutex-guarded, with reflush on conflict). If a flush is
   * already in progress, marks needsReflush so a follow-up fires after.
   */
  async flush(): Promise<void> {
    if (!this.cardMessageReady() || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) this.needsReflush = true
      return
    }
    this.flushInProgress = true
    this.needsReflush = false
    this.lastUpdateTime = Date.now()
    try {
      await this.doFlush()
      this.lastUpdateTime = Date.now()
    } finally {
      this.flushInProgress = false
      const resolvers = this.flushResolvers
      this.flushResolvers = []
      for (const resolve of resolvers) resolve()
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, 0)
      }
    }
  }

  /**
   * Throttled update entry point.
   * @param throttleMs - Minimum interval between flushes.
   */
  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this.cardMessageReady()) return
    const now = Date.now()
    const elapsed = now - this.lastUpdateTime

    if (elapsed >= throttleMs) {
      this.cancelPendingFlush()
      if (elapsed > THROTTLE_CONSTANTS.LONG_GAP_THRESHOLD_MS) {
        // After a long gap, batch briefly so the first visible update
        // contains meaningful text rather than one or two characters.
        this.lastUpdateTime = now
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, THROTTLE_CONSTANTS.BATCH_AFTER_GAP_MS)
      } else {
        await this.flush()
      }
    } else if (!this.pendingFlushTimer) {
      // Inside the throttle window — schedule a deferred flush.
      const delay = throttleMs - elapsed
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null
        void this.flush()
      }, delay)
    }
  }
}
