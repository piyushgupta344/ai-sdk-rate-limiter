import type { ModelLimits, Priority } from '../types.js'
import type { RateLimitStore } from '../store/interface.js'
import { InMemoryStore } from '../store/in-memory-store.js'
import { QueueTimeoutError, QueueFullError } from '../errors.js'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  priority: Priority
  enqueued: number
  estimatedInputTokens: number
  timeoutHandle: ReturnType<typeof setTimeout>
}

/** Per-model state that always lives in-memory (local queue only). */
interface LocalState {
  /** Priority-sorted queue of waiting requests */
  waiters: Waiter[]
  /** True while a drain is running or a drain timer is active */
  drainScheduled: boolean
  /** Number of requests currently executing (for maxConcurrent enforcement) */
  activeCount: number
  /** Waiters blocked on the concurrency limit (not the rate limit window) */
  concurrencyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }>
}

function makeAbortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<Priority, number> = {
  high: 0,
  normal: 1,
  low: 2,
}

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
// RateLimitEngine
// ---------------------------------------------------------------------------

export class RateLimitEngine {
  private readonly store: RateLimitStore
  private readonly localStates = new Map<string, LocalState>()
  private readonly maxQueueSize: number

  constructor({
    maxQueueSize = 500,
    store,
  }: {
    maxQueueSize?: number
    /** Pluggable window store. Defaults to InMemoryStore (same behaviour as before). */
    store?: RateLimitStore
  } = {}) {
    this.maxQueueSize = maxQueueSize
    this.store = store ?? new InMemoryStore()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire a slot for the given model.
   *
   * - If capacity is available: records the request in the window and resolves.
   * - If at capacity: enqueues (sorted by priority) and resolves when a slot opens.
   * - If queue is full: throws QueueFullError immediately.
   * - If waiting exceeds timeoutMs: throws QueueTimeoutError.
   * - If signal is aborted while queued: throws an AbortError.
   */
  async acquire(
    key: string,
    opts: {
      limits: ModelLimits
      estimatedInputTokens: number
      priority: Priority
      timeoutMs: number
      signal?: AbortSignal
      onQueued?: (queueDepth: number, estimatedWaitMs: number) => void
      onDequeued?: (waitedMs: number) => void
    },
  ): Promise<void> {
    // Fail fast if already aborted before we even try
    if (opts.signal?.aborted) throw makeAbortError()

    const local = this.getOrCreate(key)

    const nextSlotAtMs = await this.store.checkAndRecord(
      key,
      opts.estimatedInputTokens,
      opts.limits,
    )

    if (nextSlotAtMs > Date.now()) {
      // Rate limited — queue the request
      if (local.waiters.length >= this.maxQueueSize) {
        throw new QueueFullError(key, this.maxQueueSize)
      }

      const estimatedWaitMs = Math.max(0, nextSlotAtMs - Date.now())
      opts.onQueued?.(local.waiters.length, estimatedWaitMs)

      await new Promise<void>((resolve, reject) => {
        const enqueuedAt = Date.now()

        const timeoutHandle = setTimeout(() => {
          const idx = local.waiters.indexOf(waiter)
          if (idx !== -1) local.waiters.splice(idx, 1)
          cleanup()
          reject(new QueueTimeoutError(key, Date.now() - enqueuedAt, local.waiters.length))
        }, opts.timeoutMs)

        const onAbort = () => {
          const idx = local.waiters.indexOf(waiter)
          if (idx !== -1) local.waiters.splice(idx, 1)
          clearTimeout(timeoutHandle)
          cleanup()
          reject(makeAbortError())
        }

        const cleanup = () => opts.signal?.removeEventListener('abort', onAbort)
        opts.signal?.addEventListener('abort', onAbort, { once: true })

        const waiter: Waiter = {
          resolve: () => {
            clearTimeout(timeoutHandle)
            cleanup()
            opts.onDequeued?.(Date.now() - enqueuedAt)
            resolve()
          },
          reject: (err) => {
            clearTimeout(timeoutHandle)
            cleanup()
            reject(err)
          },
          priority: opts.priority,
          enqueued: enqueuedAt,
          estimatedInputTokens: opts.estimatedInputTokens,
          timeoutHandle,
        }

        insertWaiter(local.waiters, waiter)
        this.scheduleDrain(key, opts.limits, nextSlotAtMs)
      })
    }

    // Rate limit slot acquired — now check concurrency limit
    const maxConcurrent = opts.limits.maxConcurrent
    if (maxConcurrent !== undefined && local.activeCount >= maxConcurrent) {
      if (opts.signal?.aborted) throw makeAbortError()

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const idx = local.concurrencyWaiters.findIndex(w => w.resolve === resolveWrapped)
          if (idx !== -1) local.concurrencyWaiters.splice(idx, 1)
          cleanup()
          reject(makeAbortError())
        }

        const resolveWrapped = () => { cleanup(); resolve() }
        const rejectWrapped = (e: Error) => { cleanup(); reject(e) }
        const cleanup = () => opts.signal?.removeEventListener('abort', onAbort)

        opts.signal?.addEventListener('abort', onAbort, { once: true })
        local.concurrencyWaiters.push({ resolve: resolveWrapped, reject: rejectWrapped })
      })
    }

    if (maxConcurrent !== undefined) local.activeCount++
  }

  /**
   * Record actual token usage after a request completes.
   * Best-effort reconciliation with the estimate recorded during acquire().
   */
  recordActualUsage(key: string, inputTokens: number, outputTokens: number): void {
    void this.store.reconcile(key, inputTokens, outputTokens)
  }

  /**
   * Apply a backoff delay from a Retry-After header.
   * Propagated to the store so all instances respect it (Redis) or
   * queued requests on this instance wait (in-memory).
   */
  applyBackoff(key: string, delayMs: number): void {
    void this.store.setBackoff(key, Date.now() + delayMs)
  }

  /**
   * Estimated wait time in ms before the next slot opens.
   * Returns 0 if immediately available. With RedisStore this is async
   * so we return a Promise; callers that need the value should await it.
   */
  async estimatedWaitMs(key: string, limits: ModelLimits, estimatedTokens = 0): Promise<number> {
    if (!this.store.nextSlotMs) return 0
    const nextSlot = await this.store.nextSlotMs(key, limits, estimatedTokens)
    return Math.max(0, nextSlot - Date.now())
  }

  /** Current queue depth for a model */
  queueDepth(key: string): number {
    return this.localStates.get(key)?.waiters.length ?? 0
  }

  /** Snapshot of the current window (delegates to store where supported) */
  windowSnapshot(key: string): { requests: number; inputTokens: number; outputTokens: number } {
    if (this.store instanceof InMemoryStore) {
      return this.store.snapshot(key)
    }
    return { requests: 0, inputTokens: 0, outputTokens: 0 }
  }

  backoffUntil(key: string): number | null {
    if (this.store instanceof InMemoryStore) {
      return this.store.currentBackoff(key)
    }
    return null
  }

  /** All model keys that have been seen by this engine instance. */
  knownKeys(): string[] {
    return Array.from(this.localStates.keys())
  }

  /**
   * Signal that a request has completed, decrementing the concurrency counter
   * and unblocking the next concurrency waiter if one is queued.
   *
   * Must be called after every acquire() that succeeded (even on error).
   * Only has an effect when maxConcurrent is configured for the model.
   */
  release(key: string): void {
    const local = this.localStates.get(key)
    if (!local || local.activeCount === 0) return
    local.activeCount--
    const next = local.concurrencyWaiters.shift()
    if (next) next.resolve()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreate(key: string): LocalState {
    let state = this.localStates.get(key)
    if (!state) {
      state = { waiters: [], drainScheduled: false, activeCount: 0, concurrencyWaiters: [] }
      this.localStates.set(key, state)
    }
    return state
  }

  private scheduleDrain(key: string, limits: ModelLimits, nextSlotAtMs: number): void {
    const local = this.localStates.get(key)
    if (!local || local.drainScheduled) return

    local.drainScheduled = true
    const delay = Math.max(0, nextSlotAtMs - Date.now())

    setTimeout(() => {
      local.drainScheduled = false
      void this.drain(key, limits)
    }, delay)
  }

  private async drain(key: string, limits: ModelLimits): Promise<void> {
    const local = this.localStates.get(key)
    if (!local) return

    while (local.waiters.length > 0) {
      const waiter = local.waiters[0]!
      const nextSlotAtMs = await this.store.checkAndRecord(
        key,
        waiter.estimatedInputTokens,
        limits,
      )

      if (nextSlotAtMs > Date.now()) {
        // Still rate-limited — reschedule
        this.scheduleDrain(key, limits, nextSlotAtMs)
        return
      }

      // Slot acquired — confirm waiter is still at front (may have timed out
      // during the async await above)
      if (local.waiters[0] !== waiter) {
        // Waiter timed out; slot was consumed in the store but the request
        // is gone. The slot will expire naturally with the window.
        continue
      }

      local.waiters.shift()
      clearTimeout(waiter.timeoutHandle)
      waiter.resolve()
    }
    // All waiters processed
  }
}
