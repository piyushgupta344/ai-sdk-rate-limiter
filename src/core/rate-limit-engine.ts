import type { ModelLimits, Priority } from '../types.js'
import { QueueTimeoutError, QueueFullError } from '../errors.js'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamp: number
  inputTokens: number
  outputTokens: number
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  priority: Priority
  enqueued: number
  estimatedInputTokens: number
  timeoutHandle: ReturnType<typeof setTimeout>
}

interface ModelState {
  /** Sliding window entries sorted by timestamp (oldest first) */
  window: WindowEntry[]
  /** Priority queue of blocked requests */
  waiters: Waiter[]
  /** Suppress new requests until this timestamp (set on remote 429) */
  backoffUntil: number
  /** Whether a drain is already scheduled */
  drainScheduled: boolean
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<Priority, number> = {
  high: 0,
  normal: 1,
  low: 2,
}

/**
 * Insert a waiter into the sorted waiters array.
 * Sort order: priority DESC (high first), then enqueue time ASC (FIFO within same priority).
 */
function insertWaiter(waiters: Waiter[], waiter: Waiter): void {
  let lo = 0
  let hi = waiters.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const candidate = waiters[mid]!
    const rankDiff = PRIORITY_RANK[waiter.priority] - PRIORITY_RANK[candidate.priority]

    if (rankDiff < 0 || (rankDiff === 0 && waiter.enqueued < candidate.enqueued)) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }

  waiters.splice(lo, 0, waiter)
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000 // 1 minute

export class RateLimitEngine {
  private readonly states = new Map<string, ModelState>()
  private readonly maxQueueSize: number

  constructor({ maxQueueSize = 500 }: { maxQueueSize?: number } = {}) {
    this.maxQueueSize = maxQueueSize
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire a slot for the given model.
   *
   * - If capacity is available: records the request in the sliding window and
   *   resolves immediately.
   * - If at capacity: enqueues the request (sorted by priority) and resolves
   *   when a slot opens.
   * - If the queue is full: throws QueueFullError immediately.
   * - If the request waits longer than `timeoutMs`: throws QueueTimeoutError.
   */
  async acquire(
    key: string,
    opts: {
      limits: ModelLimits
      estimatedInputTokens: number
      priority: Priority
      timeoutMs: number
      onQueued?: (queueDepth: number, estimatedWaitMs: number) => void
      onDequeued?: (waitedMs: number) => void
    },
  ): Promise<void> {
    const state = this.getOrCreate(key)

    if (this.canProceed(state, opts.limits, opts.estimatedInputTokens)) {
      this.record(state, opts.estimatedInputTokens, 0)
      return
    }

    // Queue is full — reject immediately
    if (state.waiters.length >= this.maxQueueSize) {
      throw new QueueFullError(key, this.maxQueueSize)
    }

    // Estimate wait and emit event before blocking
    const estimatedWaitMs = this.estimatedWaitMs(key, opts.limits, opts.estimatedInputTokens)
    opts.onQueued?.(state.waiters.length, estimatedWaitMs)

    return new Promise<void>((resolve, reject) => {
      const enqueuedAt = Date.now()

      const timeoutHandle = setTimeout(() => {
        const idx = state.waiters.indexOf(waiter)
        if (idx !== -1) state.waiters.splice(idx, 1)
        reject(new QueueTimeoutError(key, Date.now() - enqueuedAt, state.waiters.length))
      }, opts.timeoutMs)

      const waiter: Waiter = {
        resolve: () => {
          opts.onDequeued?.(Date.now() - enqueuedAt)
          resolve()
        },
        reject,
        priority: opts.priority,
        enqueued: enqueuedAt,
        estimatedInputTokens: opts.estimatedInputTokens,
        timeoutHandle,
      }

      insertWaiter(state.waiters, waiter)
      this.scheduleDrain(key, opts.limits)
    })
  }

  /**
   * Record actual token usage after a request completes.
   * Replaces the estimated token count with the real values.
   */
  recordActualUsage(key: string, inputTokens: number, outputTokens: number): void {
    const state = this.states.get(key)
    if (!state) return

    // Find the most recent window entry (the one we recorded during acquire)
    // and update it with actual token counts
    for (let i = state.window.length - 1; i >= 0; i--) {
      const entry = state.window[i]!
      if (entry.outputTokens === 0 && entry.inputTokens > 0) {
        entry.inputTokens = inputTokens
        entry.outputTokens = outputTokens
        break
      }
    }
  }

  /**
   * Apply a backoff delay to a model key.
   * While a backoff is active, no new requests will be allowed through — they
   * will queue and wait until backoffUntil, then drain in priority order.
   *
   * Called when a remote 429 comes back with a Retry-After header.
   */
  applyBackoff(key: string, delayMs: number): void {
    const state = this.getOrCreate(key)
    const newUntil = Date.now() + delayMs
    if (newUntil > state.backoffUntil) {
      state.backoffUntil = newUntil
    }
  }

  /**
   * Estimated time in ms before the next slot opens for this model/priority.
   * Returns 0 if a slot is available right now.
   */
  estimatedWaitMs(
    key: string,
    limits: ModelLimits,
    estimatedTokens = 0,
  ): number {
    const state = this.states.get(key)
    if (!state) return 0
    if (this.canProceed(state, limits, estimatedTokens)) return 0
    return this.nextSlotAt(state, limits, estimatedTokens) - Date.now()
  }

  /** Current queue depth for a model */
  queueDepth(key: string): number {
    return this.states.get(key)?.waiters.length ?? 0
  }

  /** Snapshot of the current window state for a model */
  windowSnapshot(key: string): { requests: number; inputTokens: number; outputTokens: number } {
    const state = this.states.get(key)
    if (!state) return { requests: 0, inputTokens: 0, outputTokens: 0 }
    this.evict(state)
    return {
      requests: state.window.length,
      inputTokens: state.window.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: state.window.reduce((s, e) => s + e.outputTokens, 0),
    }
  }

  backoffUntil(key: string): number | null {
    const state = this.states.get(key)
    if (!state || Date.now() >= state.backoffUntil) return null
    return state.backoffUntil
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getOrCreate(key: string): ModelState {
    let state = this.states.get(key)
    if (!state) {
      state = { window: [], waiters: [], backoffUntil: 0, drainScheduled: false }
      this.states.set(key, state)
    }
    return state
  }

  private evict(state: ModelState): void {
    const cutoff = Date.now() - WINDOW_MS
    // Window is sorted oldest-first, so we can slice from the left
    let i = 0
    while (i < state.window.length && (state.window[i]?.timestamp ?? 0) <= cutoff) i++
    if (i > 0) state.window.splice(0, i)
  }

  private canProceed(state: ModelState, limits: ModelLimits, estimatedInputTokens: number): boolean {
    const now = Date.now()

    // Backoff check — remote 429 is active
    if (now < state.backoffUntil) return false

    this.evict(state)

    // RPM check
    if (state.window.length >= limits.rpm) return false

    // ITPM check
    if (limits.itpm !== undefined) {
      const usedInput = state.window.reduce((s, e) => s + e.inputTokens, 0)
      if (usedInput + estimatedInputTokens > limits.itpm) return false
    }

    return true
  }

  private record(state: ModelState, inputTokens: number, outputTokens: number): void {
    state.window.push({ timestamp: Date.now(), inputTokens, outputTokens })
  }

  /**
   * Returns the timestamp (ms) at which the next slot will open.
   */
  private nextSlotAt(state: ModelState, limits: ModelLimits, estimatedInputTokens: number): number {
    const now = Date.now()

    // If backoff is active, that's the minimum wait
    if (now < state.backoffUntil) return state.backoffUntil

    this.evict(state)

    let nextSlot = now

    // RPM-driven slot: oldest entry in window expires at +WINDOW_MS
    if (state.window.length >= limits.rpm && state.window[0]) {
      nextSlot = Math.max(nextSlot, state.window[0].timestamp + WINDOW_MS + 1)
    }

    // ITPM-driven slot: find the oldest entry we need to evict to make room
    if (limits.itpm !== undefined) {
      let usedInput = state.window.reduce((s, e) => s + e.inputTokens, 0)
      if (usedInput + estimatedInputTokens > limits.itpm) {
        for (const entry of state.window) {
          usedInput -= entry.inputTokens
          if (usedInput + estimatedInputTokens <= limits.itpm) {
            nextSlot = Math.max(nextSlot, entry.timestamp + WINDOW_MS + 1)
            break
          }
        }
      }
    }

    return nextSlot
  }

  /**
   * Schedule a drain of the waiters queue for the given model.
   * Only one drain timer is active at a time per model.
   */
  private scheduleDrain(key: string, limits: ModelLimits): void {
    const state = this.states.get(key)
    if (!state || state.drainScheduled) return

    state.drainScheduled = true

    const delay = Math.max(0, this.nextSlotAt(state, limits, 0) - Date.now())

    setTimeout(() => {
      state.drainScheduled = false
      this.drain(key, limits)
    }, delay)
  }

  /**
   * Process as many waiters as possible. Reschedule if there are still waiters
   * but no capacity yet.
   */
  private drain(key: string, limits: ModelLimits): void {
    const state = this.states.get(key)
    if (!state || state.waiters.length === 0) return

    while (state.waiters.length > 0) {
      const next = state.waiters[0]!

      if (!this.canProceed(state, limits, next.estimatedInputTokens)) break

      state.waiters.shift()
      clearTimeout(next.timeoutHandle)
      this.record(state, next.estimatedInputTokens, 0)
      next.resolve()
    }

    // If there are still waiters, schedule the next drain
    if (state.waiters.length > 0) {
      this.scheduleDrain(key, limits)
    }
  }
}
