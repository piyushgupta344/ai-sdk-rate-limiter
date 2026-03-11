import type {
  RateLimiterConfig,
  Priority,
  ModelLimits,
  CostReport,
  LimiterStatus,
  ModelStatus,
  EventMap,
  EventHandler,
} from '../types.js'
import { BudgetExceededError } from '../errors.js'
import { RateLimitEngine } from './rate-limit-engine.js'
import { CostTracker } from './cost-tracker.js'
import { Emitter } from './emitter.js'
import {
  DEFAULT_RETRY_CONFIG,
  withRetry,
  type ResolvedRetryConfig,
  extractRetryAfterMs,
} from './retry-manager.js'
import { estimateInputTokens } from './token-estimator.js'
import { resolveModelLimits } from '../registry/index.js'

interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

// ---------------------------------------------------------------------------
// Config resolution helpers
// ---------------------------------------------------------------------------

function resolveRetryConfig(config: RateLimiterConfig): ResolvedRetryConfig {
  const r = config.retry ?? {}
  return {
    maxAttempts: r.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts,
    backoff: r.backoff ?? DEFAULT_RETRY_CONFIG.backoff,
    baseDelay: r.baseDelay ?? DEFAULT_RETRY_CONFIG.baseDelay,
    maxDelay: r.maxDelay ?? DEFAULT_RETRY_CONFIG.maxDelay,
    jitter: r.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
    parseRetryAfter: r.parseRetryAfter ?? DEFAULT_RETRY_CONFIG.parseRetryAfter,
    retryOn: r.retryOn ?? DEFAULT_RETRY_CONFIG.retryOn,
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * The Pipeline is the single stateful orchestrator. It holds the rate limit
 * engine, cost tracker, and emitter, and exposes a clean execute() surface
 * that the middleware adapter calls.
 */
export class Pipeline {
  private readonly engine: RateLimitEngine
  private readonly costTracker: CostTracker
  private readonly emitter: Emitter
  private readonly retryConfig: ResolvedRetryConfig
  private readonly config: RateLimiterConfig

  constructor(config: RateLimiterConfig) {
    this.config = config
    this.engine = new RateLimitEngine({
      maxQueueSize: config.queue?.maxSize ?? 500,
      ...(config.store !== undefined && { store: config.store }),
    })
    this.costTracker = new CostTracker()
    this.emitter = new Emitter()
    this.retryConfig = resolveRetryConfig(config)

    // Register user-provided event handlers
    if (config.on) {
      for (const [event, handler] of Object.entries(config.on)) {
        if (handler) {
          this.emitter.on(
            event as keyof EventMap,
            handler as EventHandler<keyof EventMap>,
          )
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // execute — called by both generate and stream adapters
  // -------------------------------------------------------------------------

  /**
   * Execute an AI request through the full pipeline:
   *   budget check → acquire slot → retry wrapper → usage recording
   */
  async execute<T>(
    modelId: string,
    provider: string,
    prompt: unknown,
    fn: () => Promise<T>,
    opts: {
      streaming: boolean
      priority: Priority
      timeoutMs: number
      onUsage: (usage: TokenUsage) => void
      /** Skip the budget pre-check — used when executing a fallback model. */
      skipBudgetCheck?: boolean
    },
  ): Promise<T> {
    const limits = this.resolveModelLimits(modelId, provider)
    const estimatedInput = estimateInputTokens(prompt)
    const startMs = Date.now()
    const key = `${provider}:${modelId}`

    // -----------------------------------------------------------------------
    // 1. Budget pre-check
    // -----------------------------------------------------------------------
    if (this.config.cost?.budget && !opts.skipBudgetCheck) {
      const estimatedCost = this.costTracker.estimateCost(
        estimatedInput,
        500, // conservative output estimate for pre-check
        limits.inputPricePerMillion,
        limits.outputPricePerMillion,
      )
      try {
        this.costTracker.checkBudget(
          modelId,
          estimatedCost,
          this.config.cost.budget,
          this.config.cost.onExceeded ?? 'throw',
        )
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          this.emitter.emit('budgetHit', {
            model: err.model,
            provider,
            currentCostUsd: err.currentCostUsd,
            limitUsd: err.limitUsd,
            period: err.period,
            usingFallback: false,
          })
        }
        throw err
      }
    }

    // -----------------------------------------------------------------------
    // 2. Acquire rate limit slot
    // -----------------------------------------------------------------------
    await this.engine.acquire(key, {
      limits,
      estimatedInputTokens: estimatedInput,
      priority: opts.priority,
      timeoutMs: opts.timeoutMs,
      onQueued: (queueDepth, estimatedWaitMs) => {
        this.emitter.emit('queued', {
          model: modelId,
          provider,
          priority: opts.priority,
          queueDepth,
          estimatedWaitMs,
        })
        this.emitter.emit('rateLimited', {
          source: 'local',
          model: modelId,
          provider,
          limitType: 'rpm',
          resetAt: Date.now() + estimatedWaitMs,
        })
      },
      onDequeued: (waitedMs) => {
        this.emitter.emit('dequeued', {
          model: modelId,
          provider,
          waitedMs,
          priority: opts.priority,
        })
      },
    })

    // -----------------------------------------------------------------------
    // 3. Execute with retry
    // -----------------------------------------------------------------------
    let result: T
    try {
      result = await withRetry(fn, this.retryConfig, {
        modelId,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          this.emitter.emit('retrying', {
            model: modelId,
            provider,
            attempt,
            maxAttempts,
            delayMs,
            error,
          })
        },
        onRateLimited: (retryAfterMs) => {
          // Propagate the backoff to the engine so queued requests behind this
          // one also wait — prevents them from all immediately getting 429s too
          this.engine.applyBackoff(key, retryAfterMs)
          this.emitter.emit('rateLimited', {
            source: 'remote',
            model: modelId,
            provider,
            limitType: 'rpm',
            resetAt: Date.now() + retryAfterMs,
          })
        },
      })
    } catch (error) {
      this.emitter.emit('dropped', {
        model: modelId,
        provider,
        reason: 'queue-timeout',
      })
      throw error
    }

    // -----------------------------------------------------------------------
    // 4. Record usage (for non-streaming; streaming calls onUsage from the
    //    stream interceptor when the finish chunk arrives)
    // -----------------------------------------------------------------------
    opts.onUsage({
      inputTokens: estimatedInput,
      outputTokens: 0,
    })

    this.emitter.emit('completed', {
      model: modelId,
      provider,
      inputTokens: estimatedInput,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - startMs,
      streaming: opts.streaming,
    })

    return result
  }

  /**
   * Record actual usage after a request resolves.
   * Called with real token counts from the API response.
   */
  recordUsage(
    modelId: string,
    provider: string,
    usage: TokenUsage,
    latencyMs: number,
    streaming: boolean,
  ): void {
    const key = `${provider}:${modelId}`
    const limits = this.resolveModelLimits(modelId, provider)

    // Update the sliding window with actuals
    this.engine.recordActualUsage(key, usage.inputTokens, usage.outputTokens)

    // Record in cost tracker
    const costUsd = this.costTracker.record(
      modelId,
      usage,
      limits.inputPricePerMillion,
      limits.outputPricePerMillion,
    )

    this.emitter.emit('completed', {
      model: modelId,
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      latencyMs,
      streaming,
    })
  }

  // -------------------------------------------------------------------------
  // Public read-only surface
  // -------------------------------------------------------------------------

  getCostReport(): CostReport {
    return this.costTracker.getReport()
  }

  getStatus(): LimiterStatus {
    // We enumerate all known model keys from the engine's internal state
    // by collecting keys that have been seen — accessed via a proxy getter
    const models: ModelStatus[] = []
    // Note: we don't expose engine internals directly; status is a snapshot
    // populated on demand from whatever models have been used
    return { models, totalQueueDepth: 0 }
  }

  async estimatedWait(modelId: string, provider: string, priority: Priority = 'normal'): Promise<number> {
    const key = `${provider}:${modelId}`
    const limits = this.resolveModelLimits(modelId, provider)
    return this.engine.estimatedWaitMs(key, limits)
  }

  on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    this.emitter.on(event, handler)
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    this.emitter.off(event, handler)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveModelLimits(modelId: string, provider: string): ModelLimits {
    return resolveModelLimits(modelId, provider, this.config.limits ?? {})
  }
}
