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
  /** Input price in USD per million tokens */
  inputPricePerMillion: number
  /** Output price in USD per million tokens */
  outputPricePerMillion: number
}

/** Partial overrides the user can provide for any model */
export type ModelLimitOverride = Partial<ModelLimits>

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
  /** Arbitrary metadata passed through to event handlers */
  metadata?: Record<string, unknown>
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
  reason: 'queue-full' | 'queue-timeout'
}

export interface CompletedEvent {
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  streaming: boolean
}

export interface EventMap {
  queued: QueuedEvent
  dequeued: DequeuedEvent
  retrying: RetryingEvent
  rateLimited: RateLimitedEvent
  budgetHit: BudgetHitEvent
  dropped: DroppedEvent
  completed: CompletedEvent
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
   */
  wrap(
    model: import('./adapters/vercel-ai-sdk.js').WrappableModel,
    options?: {
      modelId?: string
      providerId?: string
      /** Fallback model used when a budget cap is hit and onExceeded is 'fallback'. */
      fallback?: import('./adapters/vercel-ai-sdk.js').WrappableModel
    },
  ): import('./adapters/vercel-ai-sdk.js').WrappableModel

  /**
   * The raw Vercel AI SDK middleware — use this with wrapLanguageModel() directly.
   */
  readonly middleware: import('./adapters/vercel-ai-sdk.js').Middleware

  /** Get a snapshot of cost usage across periods and models */
  getCostReport(): CostReport

  /** Get current queue depth and window state per model */
  getStatus(): LimiterStatus

  /**
   * Estimated wait time in ms for a new request at this priority level.
   * Returns 0 if the model would proceed immediately.
   */
  estimatedWait(modelId: string, priority?: Priority): number

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
}
