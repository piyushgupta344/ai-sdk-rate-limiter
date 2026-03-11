import type {
  RateLimiterConfig,
  Priority,
  ModelLimits,
  ScopeConfig,
  CostReport,
  LimiterStatus,
  ModelStatus,
  EventMap,
  EventHandler,
} from '../types.js'
import { BudgetExceededError, QueueTimeoutError } from '../errors.js'
import { RateLimitEngine } from './rate-limit-engine.js'
import { CostTracker } from './cost-tracker.js'
import { Emitter } from './emitter.js'
import {
  DEFAULT_RETRY_CONFIG,
  withRetry,
  type ResolvedRetryConfig,
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
// Scope helpers
// ---------------------------------------------------------------------------

function matchScope(pattern: string, scope: string): boolean {
  if (pattern === scope) return true
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    )
    return regex.test(scope)
  }
  return false
}

function mergeScopeLimits(base: ModelLimits, scope: ScopeConfig): ModelLimits {
  return {
    ...base,
    ...(scope.rpm !== undefined && { rpm: scope.rpm }),
    ...(scope.itpm !== undefined && { itpm: scope.itpm }),
    ...(scope.maxConcurrent !== undefined && { maxConcurrent: scope.maxConcurrent }),
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
  /** Stable mapping from engine key → parsed metadata for getStatus() */
  private readonly keyMeta = new Map<string, { modelId: string; provider: string; scope?: string }>()

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
  // Scope resolution helpers
  // -------------------------------------------------------------------------

  private resolveScopedLimits(modelId: string, provider: string, scope: string): ModelLimits {
    const base = this.resolveModelLimits(modelId, provider)
    if (!this.config.scopes) return base

    for (const [pattern, scopeConfig] of Object.entries(this.config.scopes)) {
      if (matchScope(pattern, scope)) {
        return mergeScopeLimits(base, scopeConfig)
      }
    }
    return base
  }

  /**
   * Execute an AI request through the full pipeline:
   *   budget check → acquire slot → retry wrapper
   *
   * Usage recording (completed event) is NOT emitted here. Callers must call
   * recordUsage() once they have actual token counts from the API response.
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
      /** Skip the budget pre-check — used when executing a fallback model. */
      skipBudgetCheck?: boolean
      /** Scope key for multi-tenant rate limiting */
      scope?: string
      /** AbortSignal — cancels a queued request if fired before it executes */
      signal?: AbortSignal
    },
  ): Promise<T> {
    const scope = opts.scope
    const limits = scope
      ? this.resolveScopedLimits(modelId, provider, scope)
      : this.resolveModelLimits(modelId, provider)
    const estimatedInput = estimateInputTokens(prompt)
    const key = scope ? `${scope}:${provider}:${modelId}` : `${provider}:${modelId}`

    // Track key → metadata for getStatus() — avoids fragile string parsing of scoped keys
    if (!this.keyMeta.has(key)) {
      this.keyMeta.set(key, { modelId, provider, ...(scope !== undefined && { scope }) })
    }

    let slotAcquired = false

    // -----------------------------------------------------------------------
    // 1. Budget pre-check
    // -----------------------------------------------------------------------
    if (this.config.cost?.budget && !opts.skipBudgetCheck) {
      const budget = this.config.cost.budget
      const onExceeded = this.config.cost.onExceeded ?? 'throw'
      const estimatedCost = this.costTracker.estimateCost(
        estimatedInput,
        500, // conservative output estimate for pre-check
        limits.inputPricePerMillion,
        limits.outputPricePerMillion,
      )

      if (onExceeded === 'queue') {
        // Hold the request until the rolling cost window clears enough capacity.
        // Uses the queue timeout as the maximum wait duration.
        const deadlineMs = Date.now() + opts.timeoutMs
        while (true) {
          try {
            // Re-use 'throw' mode internally to get the BudgetExceededError payload
            this.costTracker.checkBudget(modelId, estimatedCost, budget, 'throw')
            break // budget ok — proceed
          } catch (err) {
            if (!(err instanceof BudgetExceededError)) throw err

            this.emitter.emit('budgetHit', {
              model: err.model,
              provider,
              currentCostUsd: err.currentCostUsd,
              limitUsd: err.limitUsd,
              period: err.period,
              usingFallback: false,
            })

            const clearAtMs = this.costTracker.nextBudgetClearMs(budget, estimatedCost)
            const waitMs = Math.max(50, Math.min(clearAtMs - Date.now(), deadlineMs - Date.now()))

            if (Date.now() + waitMs > deadlineMs) {
              throw new QueueTimeoutError(modelId, opts.timeoutMs, 0)
            }

            await new Promise<void>(resolve => setTimeout(resolve, waitMs))
          }
        }
      } else {
        // 'throw' or 'fallback' — raise immediately on budget hit
        try {
          this.costTracker.checkBudget(modelId, estimatedCost, budget, onExceeded)
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
    }

    // -----------------------------------------------------------------------
    // 2. Acquire rate limit slot
    // -----------------------------------------------------------------------
    await this.engine.acquire(key, {
      limits,
      estimatedInputTokens: estimatedInput,
      priority: opts.priority,
      timeoutMs: opts.timeoutMs,
      ...(opts.signal !== undefined && { signal: opts.signal }),
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
    slotAcquired = true

    // -----------------------------------------------------------------------
    // 3. Execute with retry
    // -----------------------------------------------------------------------
    try {
      const result = await withRetry(fn, this.retryConfig, {
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
      return result
    } catch (error) {
      this.emitter.emit('dropped', {
        model: modelId,
        provider,
        reason: 'queue-timeout',
      })
      throw error
    } finally {
      // Release concurrency slot whether the request succeeded or failed
      if (slotAcquired) this.engine.release(key)
    }
  }

  /**
   * Record actual usage after a request resolves.
   * Called with real token counts from the API response. Emits the single
   * authoritative `completed` event for this request.
   */
  recordUsage(
    modelId: string,
    provider: string,
    scope: string | undefined,
    usage: TokenUsage,
    latencyMs: number,
    streaming: boolean,
  ): void {
    const key = scope ? `${scope}:${provider}:${modelId}` : `${provider}:${modelId}`
    const limits = scope
      ? this.resolveScopedLimits(modelId, provider, scope)
      : this.resolveModelLimits(modelId, provider)

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
    const models: ModelStatus[] = []
    let totalQueueDepth = 0

    for (const key of this.engine.knownKeys()) {
      // Use stored metadata to avoid fragile string-splitting of scoped keys.
      // Scoped keys look like "scope:provider:modelId" where scope itself may
      // contain colons (e.g. "user:free:123"), making indexOf-based parsing wrong.
      const meta = this.keyMeta.get(key)
      const provider = meta?.provider ?? key
      const modelId = meta?.modelId ?? key

      const snapshot = this.engine.windowSnapshot(key)
      const queueDepth = this.engine.queueDepth(key)
      const backoffUntil = this.engine.backoffUntil(key)

      totalQueueDepth += queueDepth
      models.push({
        modelId,
        provider,
        requestsInWindow: snapshot.requests,
        inputTokensInWindow: snapshot.inputTokens,
        outputTokensInWindow: snapshot.outputTokens,
        queueDepth,
        estimatedWaitMs: 0, // async — use limiter.estimatedWait() for an accurate value
        backoffUntil,
      })
    }

    return { models, totalQueueDepth }
  }

  async estimatedWait(
    modelId: string,
    provider: string,
    priority: Priority = 'normal',
    scope?: string,
  ): Promise<number> {
    // When provider is not known at the call site (public API passes ''),
    // scan stored keys to find the provider that has served this modelId.
    let resolvedProvider = provider
    if (!resolvedProvider) {
      for (const [key, meta] of this.keyMeta) {
        if (meta.modelId === modelId && !meta.scope) {
          resolvedProvider = meta.provider
          break
        }
      }
      if (!resolvedProvider) return 0 // no requests seen yet → no wait
    }

    const key = scope
      ? `${scope}:${resolvedProvider}:${modelId}`
      : `${resolvedProvider}:${modelId}`
    const limits = scope
      ? this.resolveScopedLimits(modelId, resolvedProvider, scope)
      : this.resolveModelLimits(modelId, resolvedProvider)
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
