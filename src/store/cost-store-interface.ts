/**
 * Pluggable persistent cost store.
 *
 * Persists cost data so budget caps survive process restarts.
 * Use RedisCostStore from 'ai-sdk-rate-limiter/redis' for a production-ready
 * implementation backed by a Redis sorted set.
 */

export interface PersistedCostEntry {
  timestamp: number
  model: string
  scope?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface CostStore {
  /**
   * Append a completed request entry.
   * Implementations should be fire-and-forget — swallow errors rather than
   * propagating them; cost persistence is best-effort.
   */
  append(entry: PersistedCostEntry): Promise<void>
  /**
   * Load all entries since the given timestamp (ms).
   * Called once at startup via limiter.warmUp() to restore history.
   */
  load(sinceMs: number): Promise<PersistedCostEntry[]>
}
