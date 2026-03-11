import type {
  RateLimiterConfig,
  RateLimiter,
  Priority,
  CostReport,
  LimiterStatus,
  EventMap,
  EventHandler,
} from './types.js'
import { Pipeline } from './core/pipeline.js'
import { createMiddleware, wrapModel, type WrappableModel, type Middleware } from './adapters/vercel-ai-sdk.js'
import { createRawProxy } from './adapters/raw-sdk-proxy.js'

/**
 * Create a rate limiter instance.
 *
 * @example
 * ```typescript
 * // Zero config — works with sensible defaults
 * const limiter = createRateLimiter()
 * const model = limiter.wrap(openai('gpt-4o'))
 *
 * // With options
 * const limiter = createRateLimiter({
 *   limits: {
 *     'gpt-4o': { rpm: 500, itpm: 30_000 }
 *   },
 *   retry: { maxAttempts: 5 },
 *   cost: { budget: { daily: 50 } },
 *   on: {
 *     rateLimited: ({ model, resetAt }) => console.warn(`${model} rate limited, resets at ${new Date(resetAt)}`)
 *   }
 * })
 * ```
 */
export function createRateLimiter(config: RateLimiterConfig = {}): RateLimiter {
  const pipeline = new Pipeline(config)
  const queueTimeout = config.queue?.timeout ?? 30_000
  const middleware = createMiddleware(pipeline, queueTimeout)

  return {
    wrap(
      model: WrappableModel,
      options?: { modelId?: string; providerId?: string; fallback?: WrappableModel; scope?: string },
    ): WrappableModel {
      return wrapModel(model, middleware, options)
    },

    get middleware(): Middleware {
      return middleware
    },

    getCostReport(): CostReport {
      return pipeline.getCostReport()
    },

    getStatus(): LimiterStatus {
      return pipeline.getStatus()
    },

    estimatedWait(modelId: string, priority: Priority = 'normal'): Promise<number> {
      // Provider is unknown here — use a generic lookup key
      // The engine uses provider:modelId as key; without provider we use the
      // modelId alone as a best-effort lookup
      return pipeline.estimatedWait(modelId, '', priority)
    },

    rawProxy<T extends object>(
      client: T,
      options?: { provider?: string; priority?: Priority },
    ): T {
      return createRawProxy(client, pipeline, queueTimeout, options)
    },

    on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
      pipeline.on(event, handler)
    },

    off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
      pipeline.off(event, handler)
    },
  }
}
