/**
 * ai-sdk-rate-limiter
 *
 * Smart rate limiting, queuing, and cost tracking middleware for AI API calls.
 * Works across providers. Zero required dependencies.
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from 'ai-sdk-rate-limiter'
 * import { openai } from '@ai-sdk/openai'
 * import { generateText } from 'ai'
 *
 * const limiter = createRateLimiter()
 * const model = limiter.wrap(openai('gpt-4o'))
 *
 * const { text } = await generateText({ model, prompt: 'Hello!' })
 * ```
 */

export { createRateLimiter } from './create-rate-limiter.js'
export { rateLimited } from './adapters/raw-sdk-proxy.js'
export type { RawSdkProxyOptions } from './adapters/raw-sdk-proxy.js'
export { createModelPool } from './adapters/model-pool.js'
export type { ModelPoolOptions } from './adapters/model-pool.js'

// Errors
export {
  RateLimiterError,
  RateLimitExceededError,
  QueueTimeoutError,
  QueueFullError,
  BudgetExceededError,
  RetryExhaustedError,
  CircuitOpenError,
  ShutdownError,
} from './errors.js'

// Types
export type {
  // Config
  RateLimiterConfig,
  ModelLimits,
  ModelLimitOverride,
  ScopeConfig,
  CostConfig,
  BudgetPeriod,
  BudgetExceededAction,
  QueueConfig,
  RetryConfig,
  BackoffStrategy,
  Priority,

  // Per-request
  PerRequestOptions,

  // Circuit breaker
  CircuitBreakerConfig,

  // Events
  EventMap,
  EventHandler,
  EventHandlers,
  QueuedEvent,
  DequeuedEvent,
  RetryingEvent,
  RateLimitedEvent,
  BudgetHitEvent,
  DroppedEvent,
  CompletedEvent,
  CircuitOpenEvent,
  CircuitClosedEvent,
  LimitsDetectedEvent,

  // Reports
  CostReport,
  CostForecast,
  CostForecastReport,
  PeriodCostSummary,
  LimiterStatus,
  ModelStatus,

  // Main interface
  RateLimiter,
} from './types.js'

// Store interfaces (for custom store implementations)
export type { RateLimitStore } from './store/interface.js'
export type { CostStore, PersistedCostEntry } from './store/cost-store-interface.js'

// Registry utilities (useful for extending/inspecting the built-in model data)
export { resolveModelLimits, isKnownModel } from './registry/index.js'
export { OPENAI_MODELS } from './registry/openai.js'
export { ANTHROPIC_MODELS } from './registry/anthropic.js'
export { GOOGLE_MODELS } from './registry/google.js'
export { GROQ_MODELS } from './registry/groq.js'
export { MISTRAL_MODELS } from './registry/mistral.js'
export { COHERE_MODELS } from './registry/cohere.js'
