import type { ModelLimits } from '../types.js'
import type { RateLimitStore } from './interface.js'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamp: number
  inputTokens: number
  outputTokens: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

// ---------------------------------------------------------------------------
// InMemoryStore — the default store, identical in behaviour to the original
// sliding-window logic that was embedded in RateLimitEngine.
// ---------------------------------------------------------------------------

export class InMemoryStore implements RateLimitStore {
  private readonly windows = new Map<string, WindowEntry[]>()
  /** Timestamps of requests in the last 24 h — used for RPD enforcement */
  private readonly dailyWindows = new Map<string, number[]>()
  private readonly backoffs = new Map<string, number>()
  /** Call maybePrune() every N operations to evict stale scope entries */
  private pruneCounter = 0

  // -------------------------------------------------------------------------
  // RateLimitStore implementation
  // -------------------------------------------------------------------------

  async checkAndRecord(
    key: string,
    estimatedInputTokens: number,
    limits: ModelLimits,
  ): Promise<number> {
    const now = Date.now()

    // Backoff — server told us to wait
    const backoffUntil = this.backoffs.get(key) ?? 0
    if (now < backoffUntil) return backoffUntil

    const window = this.getOrCreateWindow(key)
    this.evictWindow(window, now)

    // RPM check
    if (window.length >= limits.rpm) {
      return (window[0]?.timestamp ?? now) + WINDOW_MS + 1
    }

    // ITPM check
    if (limits.itpm !== undefined) {
      const usedInput = sumInput(window)
      if (usedInput + estimatedInputTokens > limits.itpm) {
        return this.itpmNextSlot(window, limits.itpm, estimatedInputTokens, now)
      }
    }

    // RPD check — daily request limit
    if (limits.rpd !== undefined) {
      const daily = this.getOrCreateDaily(key)
      this.evictDaily(daily, now)
      if (daily.length >= limits.rpd) {
        return (daily[0] ?? now) + DAY_MS + 1
      }
    }

    // OTPM check — output tokens per minute (based on completed requests)
    if (limits.otpm !== undefined) {
      const usedOutput = sumOutput(window)
      if (usedOutput >= limits.otpm) {
        return this.otpmNextSlot(window, limits.otpm, now)
      }
    }

    // Reserve
    window.push({ timestamp: now, inputTokens: estimatedInputTokens, outputTokens: 0 })
    if (limits.rpd !== undefined) {
      this.getOrCreateDaily(key).push(now)
    }

    // Periodically evict stale scope state to prevent unbounded memory growth
    this.maybePrune(now)

    return 0
  }

  async reconcile(
    key: string,
    actualInputTokens: number,
    actualOutputTokens: number,
  ): Promise<void> {
    const window = this.windows.get(key)
    if (!window) return

    // Find the most-recent entry that was recorded with 0 output tokens (i.e.
    // the estimate placeholder) and update it with the real values.
    for (let i = window.length - 1; i >= 0; i--) {
      const entry = window[i]!
      if (entry.outputTokens === 0 && entry.inputTokens > 0) {
        entry.inputTokens = actualInputTokens
        entry.outputTokens = actualOutputTokens
        return
      }
    }
  }

  async setBackoff(key: string, untilMs: number): Promise<void> {
    const current = this.backoffs.get(key) ?? 0
    if (untilMs > current) this.backoffs.set(key, untilMs)
  }

  async getBackoff(key: string): Promise<number> {
    return this.backoffs.get(key) ?? 0
  }

  async nextSlotMs(
    key: string,
    limits: ModelLimits,
    estimatedInputTokens = 0,
  ): Promise<number> {
    const now = Date.now()

    const backoffUntil = this.backoffs.get(key) ?? 0
    if (now < backoffUntil) return backoffUntil

    const window = this.windows.get(key) ?? []
    this.evictWindow(window, now)

    // Check if immediately available (all limits)
    if (
      window.length < limits.rpm &&
      (limits.itpm === undefined || sumInput(window) + estimatedInputTokens <= limits.itpm)
    ) {
      // RPD check
      if (limits.rpd !== undefined) {
        const daily = this.dailyWindows.get(key) ?? []
        this.evictDaily(daily, now)
        if (daily.length >= limits.rpd) {
          return (daily[0] ?? now) + DAY_MS + 1
        }
      }
      // OTPM check
      if (limits.otpm !== undefined && sumOutput(window) >= limits.otpm) {
        return this.otpmNextSlot(window, limits.otpm, now)
      }
      return 0
    }

    let nextSlot = now

    if (window.length >= limits.rpm && window[0]) {
      nextSlot = Math.max(nextSlot, window[0].timestamp + WINDOW_MS + 1)
    }

    if (limits.itpm !== undefined) {
      let usedInput = sumInput(window)
      if (usedInput + estimatedInputTokens > limits.itpm) {
        for (const entry of window) {
          usedInput -= entry.inputTokens
          if (usedInput + estimatedInputTokens <= limits.itpm) {
            nextSlot = Math.max(nextSlot, entry.timestamp + WINDOW_MS + 1)
            break
          }
        }
      }
    }

    if (limits.rpd !== undefined) {
      const daily = this.dailyWindows.get(key) ?? []
      this.evictDaily(daily, now)
      if (daily.length >= limits.rpd && daily[0]) {
        nextSlot = Math.max(nextSlot, daily[0] + DAY_MS + 1)
      }
    }

    if (limits.otpm !== undefined) {
      const usedOutput = sumOutput(window)
      if (usedOutput >= limits.otpm) {
        nextSlot = Math.max(nextSlot, this.otpmNextSlot(window, limits.otpm, now))
      }
    }

    return nextSlot
  }

  // -------------------------------------------------------------------------
  // Snapshot helpers (used by engine for status reporting)
  // -------------------------------------------------------------------------

  snapshot(key: string): { requests: number; inputTokens: number; outputTokens: number } {
    const window = this.windows.get(key) ?? []
    this.evictWindow(window, Date.now())
    return {
      requests: window.length,
      inputTokens: sumInput(window),
      outputTokens: sumOutput(window),
    }
  }

  currentBackoff(key: string): number | null {
    const until = this.backoffs.get(key) ?? 0
    return Date.now() < until ? until : null
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateWindow(key: string): WindowEntry[] {
    let w = this.windows.get(key)
    if (!w) {
      w = []
      this.windows.set(key, w)
    }
    return w
  }

  private getOrCreateDaily(key: string): number[] {
    let w = this.dailyWindows.get(key)
    if (!w) {
      w = []
      this.dailyWindows.set(key, w)
    }
    return w
  }

  private evictWindow(window: WindowEntry[], now: number): void {
    const cutoff = now - WINDOW_MS
    let i = 0
    while (i < window.length && (window[i]?.timestamp ?? 0) <= cutoff) i++
    if (i > 0) window.splice(0, i)
  }

  private evictDaily(window: number[], now: number): void {
    const cutoff = now - DAY_MS
    let i = 0
    while (i < window.length && (window[i] ?? 0) <= cutoff) i++
    if (i > 0) window.splice(0, i)
  }

  private itpmNextSlot(
    window: WindowEntry[],
    itpmLimit: number,
    estimatedInputTokens: number,
    now: number,
  ): number {
    let usedInput = sumInput(window)
    for (const entry of window) {
      usedInput -= entry.inputTokens
      if (usedInput + estimatedInputTokens <= itpmLimit) {
        return entry.timestamp + WINDOW_MS + 1
      }
    }
    return now + WINDOW_MS + 1
  }

  private otpmNextSlot(window: WindowEntry[], otpmLimit: number, now: number): number {
    let usedOutput = sumOutput(window)
    for (const entry of window) {
      usedOutput -= entry.outputTokens
      if (usedOutput < otpmLimit) {
        return entry.timestamp + WINDOW_MS + 1
      }
    }
    return now + WINDOW_MS + 1
  }

  /**
   * Periodically sweep stale entries from the scope/model maps.
   * Runs every 200 checkAndRecord calls to avoid per-request overhead.
   * Prevents unbounded memory growth when thousands of unique scopes are used.
   */
  private maybePrune(now: number): void {
    if (++this.pruneCounter % 200 !== 0) return

    for (const [key, window] of this.windows) {
      this.evictWindow(window, now)
      if (window.length === 0 && (this.backoffs.get(key) ?? 0) < now) {
        this.windows.delete(key)
      }
    }

    for (const [key, daily] of this.dailyWindows) {
      this.evictDaily(daily, now)
      if (daily.length === 0) this.dailyWindows.delete(key)
    }

    for (const [key, until] of this.backoffs) {
      if (until < now) this.backoffs.delete(key)
    }
  }
}

function sumInput(window: WindowEntry[]): number {
  return window.reduce((s, e) => s + e.inputTokens, 0)
}

function sumOutput(window: WindowEntry[]): number {
  return window.reduce((s, e) => s + e.outputTokens, 0)
}
