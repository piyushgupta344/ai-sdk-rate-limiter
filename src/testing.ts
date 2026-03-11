/**
 * Testing utilities for ai-sdk-rate-limiter.
 *
 * Provides a lightweight test limiter that records calls and exposes helpers
 * for writing unit tests against rate-limited AI code.
 *
 * @example
 * ```typescript
 * import { createTestLimiter } from 'ai-sdk-rate-limiter/testing'
 *
 * const limiter = createTestLimiter()
 * const model = limiter.wrap(openai('gpt-4o'))
 *
 * // Run your code
 * await generateText({ model, prompt: 'Hello' })
 *
 * // Assert on calls
 * expect(limiter.getCalls()).toHaveLength(1)
 * expect(limiter.getCalls()[0].modelId).toBe('gpt-4o')
 *
 * // Reset between tests
 * limiter.reset()
 * ```
 */

import type { RateLimiterConfig, RateLimiter, EventMap, EventHandler, CompletedEvent } from './types.js'
import { createRateLimiter } from './create-rate-limiter.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallRecord {
  /** Model ID that was called */
  modelId: string
  /** Provider that was called */
  provider: string
  /** Token counts from the API response */
  inputTokens: number
  outputTokens: number
  /** Cost in USD for this call */
  costUsd: number
  /** Total latency in ms */
  latencyMs: number
  /** Whether this was a streaming call */
  streaming: boolean
  /** Unix timestamp (ms) when the call completed */
  timestamp: number
}

export interface TestRateLimiter extends RateLimiter {
  /** All recorded completed calls in chronological order */
  getCalls(): ReadonlyArray<CallRecord>
  /** Reset call history */
  reset(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a test rate limiter that records all completed calls.
 *
 * Accepts the same config as `createRateLimiter()`. Completed events are
 * captured automatically — you don't need to wire up `on.completed`.
 */
export function createTestLimiter(config: RateLimiterConfig = {}): TestRateLimiter {
  const calls: CallRecord[] = []

  const userCompleted = config.on?.completed

  const limiter = createRateLimiter({
    ...config,
    on: {
      ...config.on,
      completed: (event: CompletedEvent) => {
        calls.push({
          modelId: event.model,
          provider: event.provider,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
          latencyMs: event.latencyMs,
          streaming: event.streaming,
          timestamp: Date.now(),
        })
        userCompleted?.(event)
      },
    },
  })

  return Object.assign(limiter, {
    getCalls(): ReadonlyArray<CallRecord> {
      return calls
    },

    reset(): void {
      calls.length = 0
    },

    // Override on/off so they delegate to the underlying limiter
    on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
      limiter.on(event, handler)
    },

    off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
      limiter.off(event, handler)
    },
  })
}
