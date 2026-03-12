/**
 * StatsD / DogStatsD metrics plugin for ai-sdk-rate-limiter.
 *
 * Bridges the rate limiter event system to a StatsD client. Compatible with
 * any client that has increment(), gauge(), and timing() methods, including
 * hot-shots (DogStatsD), node-statsd, and statsd-client.
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from 'ai-sdk-rate-limiter'
 * import { createStatsDPlugin } from 'ai-sdk-rate-limiter/statsd'
 * import StatsD from 'hot-shots'
 *
 * const statsd = new StatsD({ prefix: 'myapp.' })
 * const limiter = createRateLimiter({
 *   on: createStatsDPlugin(statsd),
 * })
 * ```
 */

import type { EventHandlers } from './types.js'

// ---------------------------------------------------------------------------
// Minimal StatsD client interface — satisfied by hot-shots, node-statsd, etc.
// ---------------------------------------------------------------------------

export interface StatsDClient {
  /** Increment a counter metric. */
  increment(metric: string, value?: number, tags?: string[]): void
  /** Set a gauge metric to an absolute value. */
  gauge(metric: string, value: number, tags?: string[]): void
  /** Record a timing (duration) metric in milliseconds. */
  timing(metric: string, value: number, tags?: string[]): void
}

export interface StatsDPluginOptions {
  /**
   * Metric name prefix (without trailing dot).
   * Default: 'ai_sdk'
   * @example 'myapp.ai' → 'myapp.ai.requests'
   */
  prefix?: string
  /**
   * Additional static tags applied to every metric.
   * DogStatsD format: ['env:production', 'service:my-api']
   */
  globalTags?: string[]
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createStatsDPlugin(
  client: StatsDClient,
  options: StatsDPluginOptions = {},
): EventHandlers {
  const prefix     = options.prefix ?? 'ai_sdk'
  const globalTags = options.globalTags ?? []

  function tags(labels: Record<string, string>): string[] {
    return [...globalTags, ...Object.entries(labels).map(([k, v]) => `${k}:${v}`)]
  }

  function m(name: string) { return `${prefix}.${name}` }

  return {
    completed(event) {
      const t = tags({ model: event.model, provider: event.provider })
      client.increment(m('requests'), 1, [...t, 'status:completed'])
      client.increment(m('tokens.input'),  event.inputTokens,  t)
      client.increment(m('tokens.output'), event.outputTokens, t)
      // costUsd as gauge in millicents to avoid float precision issues
      client.gauge(m('cost_usd'), event.costUsd, t)
      client.timing(m('request_duration_ms'), event.latencyMs, t)
    },

    dropped(event) {
      client.increment(m('requests'), 1, [
        ...tags({ model: event.model, provider: event.provider }),
        'status:dropped',
        `reason:${event.reason}`,
      ])
    },

    retrying(event) {
      client.increment(m('retries'), 1,
        tags({ model: event.model, provider: event.provider }))
    },

    rateLimited(event) {
      client.increment(m('rate_limited'), 1, [
        ...tags({ model: event.model, provider: event.provider }),
        `source:${event.source}`,
      ])
    },

    budgetHit(event) {
      client.increment(m('budget_exceeded'), 1, [
        ...tags({ model: event.model, provider: event.provider }),
        `period:${event.period}`,
      ])
    },

    queued(event) {
      client.gauge(m('queue_depth'), event.queueDepth,
        tags({ model: event.model, provider: event.provider }))
    },

    dequeued(event) {
      client.timing(m('queue_wait_ms'), event.waitedMs,
        tags({ model: event.model, provider: event.provider }))
    },
  }
}
