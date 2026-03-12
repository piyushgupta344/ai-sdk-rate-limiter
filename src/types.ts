// ---------------------------------------------------------------------------
// Public TypeScript types for ai-sdk-rate-limiter
// ---------------------------------------------------------------------------

export type Priority = 'high' | 'normal' | 'low'

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

/** Rate and cost limits for a single model. All token counts are per-minute. */
export interface ModelLimits {
  /** Max requests per minute */
  rpm: number
  /** Max input tokens per minute */
  itpm?: number
  /** Max output tokens per minute */
  otpm?: number
  /** Max requests per day */
  rpd?: number
  /** Max requests executing concurrently (in-flight at the same time). Default: unlimited */
  maxConcurrent?: number
  /** Input price in USD per million tokens */
  inputPricePerMillion: number
  /** Output price in USD per million tokens */
  outputPricePerMillion: number
}

/** Partial overrides the user can provide for any model */
export type ModelLimitOverride = Partial<ModelLimits>

// ---------------------------------------------------------------------------
// Multi-tenant scopes
// ---------------------------------------------------------------------------

/**
 * Rate limit overrides for a named scope (e.g. per-user or per-org).
 *
 * Scope keys in `RateLimiterConfig.scopes` support `*` wildcards:
 *   `'user:free:*'`  matches  `'user:free:123'`, `'user:free:456'`
 *
 * When a scoped request is processed, the matching scope config replaces
 * the model's global limits — giving each scope its own independent window.
 */
export interface ScopeConfig {
  /** Max requests per minute for this scope */
  rpm?: number
  /** Max input tokens per minute for this scope */
  itpm?: number
  /** Max concurrent in-flight requests for this scope */
  maxConcurrent?: number
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BudgetPeriod {
  hourly?: number
  daily?: number
  monthly?: number
}

export type BudgetExceededAction = 'throw' | 'queue' | 'fallback'

export interface CostConfig {
  /** Budget caps in USD. Requests exceeding the cap will follow onExceeded behavior. */
  budget?: BudgetPeriod
  /**
   * What to do when a budget cap is hit. Default: 'throw'
   *
   * - 'throw'    — throw BudgetExceededError immediately
   * - 'queue'    — hold the request until the period resets
   * - 'fallback' — transparently retry with the fallback model configured on
   *                limiter.wrap(model, { fallback: cheaperModel })
   */
  onExceeded?: BudgetExceededAction
  /**
   * Model ID to document which model is the intended fallback.
   * Informational only — the actual fallback model is passed to limiter.wrap().
   */
  fallbackModel?: string
  /**
   * Pluggable persistent cost store.
   *
   * Persists cost entries so budget caps survive process restarts.
   * Call `limiter.warmUp()` at startup to pre-load historical data.
   *
   * @example
   * ```typescript
   * import { RedisCostStore } from 'ai-sdk-rate-limiter/redis'
   * const limiter = createRateLimiter({
   *   cost: { budget: { daily: 50 }, store: new RedisCostStore(redis) },
   * })
   * await limiter.warmUp()
   * ```
   */
  store?: import('./store/cost-store-interface.js').CostStore
}

export interface QueueConfig {
  /** Max number of requests that can sit waiting in the queue. Default: 500 */
  maxSize?: number
  /** How long (ms) a request can wait in the queue before timing out. Default: 30_000 */
  timeout?: number
  /** Assign request priority from providerOptions. Default reads providerOptions.rateLimiter.priority */
  priority?: (providerOptions: Record<string, unknown> | undefined) => Priority
  /** What to do when queue is at maxSize. Default: 'throw' */
  onFull?: 'throw' | 'drop-low'
}

export type BackoffStrategy = 'exponential' | 'linear' | 'fixed'

export interface RetryConfig {
  /** Maximum number of attempts (including the first). Default: 4 */
  maxAttempts?: number
  /** Backoff strategy. Default: 'exponential' */
  backoff?: BackoffStrategy
  /** Base delay in ms. Default: 1_000 */
  baseDelay?: number
  /** Maximum delay cap in ms. Default: 60_000 */
  maxDelay?: number
  /** Add random jitter to prevent thundering-herd. Default: true */
  jitter?: boolean
  /** Honor Retry-After header from 429 responses. Default: true */
  parseRetryAfter?: boolean
  /** HTTP status codes that should trigger a retry. Default: [429, 500, 502, 503, 504] */
  retryOn?: number[]
  /**
   * Per-call timeout in ms. If the AI API call takes longer than this,
   * it's abandoned and (if retries remain) retried. Default: none (no timeout).
   */
  callTimeout?: number
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  /**
   * Consecutive failures before the circuit opens.
   * Only 5xx/network errors count; 429s do not.
   * Default: 5
   */
  failureThreshold?: number
  /**
   * How long (ms) the circuit stays open before allowing a single probe request.
   * Default: 60_000
   */
  cooldownMs?: number
  /**
   * HTTP status codes that trip the circuit. Default: [500, 502, 503, 504]
   */
  tripOn?: number[]
}

// ---------------------------------------------------------------------------
// Per-request options (passed via providerOptions.rateLimiter)
// ---------------------------------------------------------------------------

/** Options that can be passed per-request via providerOptions.rateLimiter */
export interface PerRequestOptions {
  /** Request priority in the queue. Default: 'normal' */
  priority?: Priority
  /** Override queue timeout for this specific request (ms) */
  timeout?: number
  /**
   * Scope key for multi-tenant rate limiting. Requests with the same scope
   * share an isolated rate limit window independent of other scopes.
   *
   * Per-request scope overrides the static scope set in `limiter.wrap(model, { scope })`.
   */
  scope?: string
  /** Arbitrary metadata passed through to event handlers */
  metadata?: Record<string, unknown>
  /**
   * Per-call AI API timeout in ms. Overrides config.retry.callTimeout for
   * this request. If the API call hangs beyond this, it is abandoned and
   * retried (if attempts remain).
   */
  callTimeout?: number
  /**
   * Deduplication key. When two concurrent requests share the same key,
   * only one API call is made and both callers receive the same result.
   *
   * Useful for server-side caching of identical prompts fired simultaneously
   * (e.g. two users asking the same question at the same time).
   *
   * @example
   * providerOptions: { rateLimiter: { dedupKey: `faq:${questionId}` } }
   */
  dedupKey?: string
}

// ---------------------------------------------------------------------------
// Cost forecast
// ---------------------------------------------------------------------------

export interface CostForecast {
  /** USD spent in the current rolling window */
  spentUsd: number
  /** Projected total USD spend over the full period, extrapolated from hourly rate */
  projectedUsd: number
  /** Current spend rate in USD per hour */
  ratePerHourUsd: number
}

export interface CostForecastReport {
  hour: CostForecast
  day: CostForecast
  month: CostForecast
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface QueuedEvent {
  model: string
  provider: string
  priority: Priority
  queueDepth: number
  estimatedWaitMs: number
}

export interface DequeuedEvent {
  model: string
  provider: string
  waitedMs: number
  priority: Priority
}

export interface RetryingEvent {
  model: string
  provider: string
  attempt: number
  maxAttempts: number
  delayMs: number
  error: unknown
}

export interface RateLimitedEvent {
  /** 'local' = our engine blocked it, 'remote' = API returned 429 */
  source: 'local' | 'remote'
  model: string
  provider: string
  limitType: 'rpm' | 'itpm' | 'otpm' | 'backoff'
  resetAt: number
}

export interface BudgetHitEvent {
  model: string
  provider: string
  currentCostUsd: number
  limitUsd: number
  period: 'hourly' | 'daily' | 'monthly'
  /** True when the request was transparently retried with a fallback model. */
  usingFallback: boolean
}

export interface DroppedEvent {
  model: string
  provider: string
  reason: 'queue-full' | 'queue-timeout' | 'circuit-open' | 'shutdown'
  /** ms the request waited in queue before being dropped (queue-timeout only) */
  waitedMs?: number
  /** Queue depth at drop time */
  queueDepth?: number
  /** Scope key if this was a scoped request */
  scope?: string
  /** Request metadata from providerOptions.rateLimiter.metadata */
  metadata?: Record<string, unknown>
}

export interface CompletedEvent {
  model: string
  provider: string
  /** Scope key if this was a scoped request */
  scope?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  streaming: boolean
}

export interface CircuitOpenEvent {
  model: string
  provider: string
  /** Number of consecutive failures that tripped the circuit */
  failures: number
  /** ms until the circuit will attempt to re-close */
  cooldownMs: number
}

export interface CircuitClosedEvent {
  model: string
  provider: string
}

export interface LimitsDetectedEvent {
  model: string
  provider: string
  /** RPM detected from x-ratelimit-limit-requests header */
  detectedRpm?: number
  /** ITPM detected from x-ratelimit-limit-tokens header */
  detectedItpm?: number
}

export interface EventMap {
  queued: QueuedEvent
  dequeued: DequeuedEvent
  retrying: RetryingEvent
  rateLimited: RateLimitedEvent
  budgetHit: BudgetHitEvent
  dropped: DroppedEvent
  completed: CompletedEvent
  circuitOpen: CircuitOpenEvent
  circuitClosed: CircuitClosedEvent
  limitsDetected: LimitsDetectedEvent
}

export type EventHandler<K extends keyof EventMap> = (event: EventMap[K]) => void

export type EventHandlers = {
  [K in keyof EventMap]?: EventHandler<K>
}

// ---------------------------------------------------------------------------
// Cost report
// ---------------------------------------------------------------------------

export interface PeriodCostSummary {
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface CostReport {
  hour: PeriodCostSummary
  day: PeriodCostSummary
  month: PeriodCostSummary
  byModel: Record<string, PeriodCostSummary>
  /** Cost breakdown by scope (user, org, tenant). Only populated when requests use scopes. */
  byScope: Record<string, PeriodCostSummary>
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ModelStatus {
  modelId: string
  provider: string
  /** Requests sent in the last 60 seconds */
  requestsInWindow: number
  /** Input tokens sent in the last 60 seconds */
  inputTokensInWindow: number
  /** Output tokens sent in the last 60 seconds */
  outputTokensInWindow: number
  /** Current queue depth for this model */
  queueDepth: number
  /** ms until the next slot opens (0 if available now) */
  estimatedWaitMs: number
  /** If a backoff is active, when it expires */
  backoffUntil: number | null
}

export interface LimiterStatus {
  models: ModelStatus[]
  totalQueueDepth: number
}

// ---------------------------------------------------------------------------
// Main configuration
// ---------------------------------------------------------------------------

export interface RateLimiterConfig {
  /**
   * Override or extend built-in model limits.
   * Keys are model IDs (e.g. 'gpt-4o', 'claude-opus-4-6').
   */
  limits?: Record<string, ModelLimitOverride>
  cost?: CostConfig
  queue?: QueueConfig
  retry?: RetryConfig
  on?: EventHandlers
  /**
   * Per-scope rate limit overrides for multi-tenant use cases.
   *
   * Scope keys support `*` wildcards. When a request carries a scope, the
   * first matching pattern's limits replace the global model limits for that
   * request. Each scope gets its own independent rate limit window.
   *
   * @example
   * ```typescript
   * scopes: {
   *   'user:free:*':  { rpm: 5,   itpm: 10_000 },
   *   'user:pro:*':   { rpm: 60,  itpm: 200_000 },
   *   'org:*':        { rpm: 300, maxConcurrent: 20 },
   * }
   * ```
   */
  scopes?: Record<string, ScopeConfig>
  /**
   * Circuit breaker configuration.
   *
   * Automatically fast-fails requests when a model is consistently returning
   * 5xx errors, rather than waiting for retries to exhaust.
   */
  circuit?: CircuitBreakerConfig
  /**
   * Pluggable rate-limit window store.
   *
   * Defaults to InMemoryStore (per-process sliding window).
   * Use RedisStore from 'ai-sdk-rate-limiter/redis' to share rate limit
   * state across multiple instances:
   *
   * @example
   * ```typescript
   * import { RedisStore } from 'ai-sdk-rate-limiter/redis'
   * import Redis from 'ioredis'
   *
   * const limiter = createRateLimiter({
   *   store: new RedisStore(new Redis(process.env.REDIS_URL)),
   * })
   * ```
   */
  store?: import('./store/interface.js').RateLimitStore

  /**
   * Enable debug logging to console.
   *
   * Logs every rate-limit decision, queue entry/exit, slot acquisition,
   * circuit breaker state change, and cost recording.
   * Useful for understanding why requests are being held or dropped.
   *
   * @default false
   *
   * @example
   * ```typescript
   * const limiter = createRateLimiter({ debug: true })
   * // [ai-sdk-rate-limiter] gpt-4o: queuing (rpm=500/500, estimatedWait=1200ms)
   * // [ai-sdk-rate-limiter] gpt-4o: slot acquired (waited=1187ms, priority="normal")
   * // [ai-sdk-rate-limiter] gpt-4o: completed (tokens=342+87, cost=$0.000021, latency=1343ms)
   * ```
   */
  debug?: boolean
}

// ---------------------------------------------------------------------------
// The public limiter object
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /**
   * Wrap a Vercel AI SDK language model with rate limiting.
   *
   * @example
   * const model = limiter.wrap(openai('gpt-4o'))
   *
   * // With budget fallback — when the primary model's budget is hit, the
   * // request is transparently retried with the cheaper fallback model.
   * const model = limiter.wrap(openai('gpt-4o'), {
   *   fallback: openai('gpt-4o-mini'),
   * })
   *
   * // Multi-tenant: each user gets their own isolated rate limit window.
   * const model = limiter.wrap(openai('gpt-4o'), { scope: `user:${userId}` })
   */
  wrap(
    model: import('./adapters/vercel-ai-sdk.js').WrappableModel,
    options?: {
      modelId?: string
      providerId?: string
      /**
       * Fallback model (or ordered chain of models) used when the primary
       * model's budget cap is hit and onExceeded is 'fallback'.
       *
       * Pass an array for a fallback chain: if the first fallback's budget is
       * also exceeded, the next one is tried, and so on.
       */
      fallback?: import('./adapters/vercel-ai-sdk.js').WrappableModel | import('./adapters/vercel-ai-sdk.js').WrappableModel[]
      /**
       * Scope key for multi-tenant rate limiting. Each unique scope value gets
       * its own independent rate limit window. Supports wildcard patterns
       * defined in `config.scopes` (e.g. `'user:free:*'`).
       */
      scope?: string
    },
  ): import('./adapters/vercel-ai-sdk.js').WrappableModel

  /**
   * The raw Vercel AI SDK middleware — use this with wrapLanguageModel() directly.
   */
  readonly middleware: import('./adapters/vercel-ai-sdk.js').Middleware

  /** Get a snapshot of cost usage across periods and models */
  getCostReport(): CostReport

  /**
   * Get a cost forecast based on the current hourly spend rate.
   *
   * Projects total spend for the day and month if current rate holds.
   * Useful for alerting before a budget cap is hit.
   *
   * @example
   * const forecast = limiter.getCostForecast()
   * if (forecast.day.projectedUsd > 40) {
   *   alert(`On track to spend $${forecast.day.projectedUsd.toFixed(2)} today`)
   * }
   */
  getCostForecast(): CostForecastReport

  /** Get current queue depth and window state per model */
  getStatus(): LimiterStatus

  /**
   * Estimated wait time in ms for a new request at this priority level.
   * Returns 0 if the model would proceed immediately.
   * With RedisStore this is an async operation (Redis round-trip).
   */
  estimatedWait(modelId: string, priority?: Priority): Promise<number>

  /**
   * Wrap a raw AI SDK client (OpenAI, Anthropic, Groq, Mistral, Cohere) with
   * rate limiting using the same pipeline as this limiter instance.
   *
   * Budget tracking, events, and rate limit state are shared with models
   * wrapped via limiter.wrap().
   *
   * @example
   * ```typescript
   * const limiter = createRateLimiter({ cost: { budget: { daily: 50 } } })
   *
   * const openai = limiter.rawProxy(new OpenAI())
   * const anthropic = limiter.rawProxy(new Anthropic())
   *
   * // Use exactly as before
   * await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] })
   * ```
   */
  rawProxy<T extends object>(
    client: T,
    options?: { provider?: string; priority?: Priority },
  ): T

  /** Register an event listener */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void

  /** Remove an event listener */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void

  /**
   * Gracefully stop the rate limiter.
   *
   * - Immediately rejects all queued requests with `ShutdownError`.
   * - Stops accepting new requests.
   * - Waits up to `drainMs` (default: 5000) for in-flight requests to complete.
   * - Resolves once all active requests finish or the drain window expires.
   */
  shutdown(opts?: { drainMs?: number }): Promise<void>

  /**
   * Pre-load historical cost data from the persistent cost store.
   *
   * Call once at startup when `config.cost.store` is configured. Loads up to
   * 30 days of historical entries so budget caps are accurate from the first
   * request, even after a restart.
   *
   * No-op if no cost store is configured.
   */
  warmUp(): Promise<void>

  /**
   * Clear all rate-limit, queue, cost, and circuit-breaker state.
   *
   * Any currently queued requests are rejected with `ShutdownError`.
   * After reset, the limiter is fully operational again — no need to
   * recreate it. Unlike `shutdown()`, reset does not lock the instance.
   *
   * Primarily useful in tests to reset between test cases without
   * constructing a new limiter on each run.
   *
   * @example
   * ```typescript
   * beforeEach(() => limiter.reset())
   * ```
   */
  reset(): void
}
