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

// ---------------------------------------------------------------------------
// InMemoryStore — the default store, identical in behaviour to the original
// sliding-window logic that was embedded in RateLimitEngine.
// ---------------------------------------------------------------------------

export class InMemoryStore implements RateLimitStore {
  private readonly windows = new Map<string, WindowEntry[]>()
  private readonly backoffs = new Map<string, number>()

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

    const window = this.getOrCreate(key)
    this.evict(window, now)

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

    // Reserve
    window.push({ timestamp: now, inputTokens: estimatedInputTokens, outputTokens: 0 })
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
    this.evict(window, now)

    // Available now?
    if (window.length < limits.rpm) {
      if (limits.itpm === undefined || sumInput(window) + estimatedInputTokens <= limits.itpm) {
        return 0
      }
    }

    // Compute next slot
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

    return nextSlot
  }

  // -------------------------------------------------------------------------
  // Snapshot helpers (used by engine for status reporting)
  // -------------------------------------------------------------------------

  snapshot(key: string): { requests: number; inputTokens: number; outputTokens: number } {
    const window = this.windows.get(key) ?? []
    this.evict(window, Date.now())
    return {
      requests: window.length,
      inputTokens: sumInput(window),
      outputTokens: window.reduce((s, e) => s + e.outputTokens, 0),
    }
  }

  currentBackoff(key: string): number | null {
    const until = this.backoffs.get(key) ?? 0
    return Date.now() < until ? until : null
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreate(key: string): WindowEntry[] {
    let w = this.windows.get(key)
    if (!w) {
      w = []
      this.windows.set(key, w)
    }
    return w
  }

  private evict(window: WindowEntry[], now: number): void {
    const cutoff = now - WINDOW_MS
    let i = 0
    while (i < window.length && (window[i]?.timestamp ?? 0) <= cutoff) i++
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
}

function sumInput(window: WindowEntry[]): number {
  return window.reduce((s, e) => s + e.inputTokens, 0)
}
