import type { ModelLimits } from '../types.js'

/**
 * Pluggable rate-limit window store.
 *
 * Controls how the sliding window state (request counts, token sums, backoff)
 * is stored and checked. Swap the default InMemoryStore for RedisStore to share
 * state across multiple instances (serverless functions, pods, workers).
 *
 * All methods are async so Redis implementations work naturally. In-memory
 * implementations return immediately-resolved promises at negligible cost.
 */
export interface RateLimitStore {
  /**
   * Atomic check-and-reserve.
   *
   * Check whether the request fits within the limits. If it does, atomically
   * record it in the window and return `0` (or any value ≤ `Date.now()`).
   * If it doesn't fit, do NOT record it and return the timestamp (ms) at which
   * the next slot will open.
   */
  checkAndRecord(
    key: string,
    estimatedInputTokens: number,
    limits: ModelLimits,
  ): Promise<number>

  /**
   * Best-effort reconciliation of estimated tokens with actual usage.
   * Called after a request completes with real token counts from the API.
   * Fire-and-forget: callers do not await this.
   */
  reconcile(
    key: string,
    actualInputTokens: number,
    actualOutputTokens: number,
  ): Promise<void>

  /**
   * Store a server-specified backoff (from a Retry-After header).
   * While active, all requests for this key are blocked.
   */
  setBackoff(key: string, untilMs: number): Promise<void>

  /**
   * Return the current backoff expiry timestamp (ms), or 0 if none active.
   */
  getBackoff(key: string): Promise<number>

  /**
   * Read-only estimate of the next available slot timestamp.
   * Does NOT reserve a slot. Returns 0 if a slot is available right now.
   *
   * Optional: if not implemented, the engine falls back to returning 0
   * (i.e. "unknown wait") for the estimatedWait() public API.
   */
  nextSlotMs?(
    key: string,
    limits: ModelLimits,
    estimatedInputTokens?: number,
  ): Promise<number>
}
