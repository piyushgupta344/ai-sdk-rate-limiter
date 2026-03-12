import type {
  RateLimiterConfig,
  Priority,
  ModelLimits,
  ModelLimitOverride,
  ScopeConfig,
  CostReport,
  LimiterStatus,
  ModelStatus,
  EventMap,
  EventHandler,
} from '../types.js'
import { BudgetExceededError, QueueTimeoutError, QueueFullError, CircuitOpenError, ShutdownError } from '../errors.js'
import { RateLimitEngine } from './rate-limit-engine.js'
import { CostTracker } from './cost-tracker.js'
import { Emitter } from './emitter.js'
import {
  DEFAULT_RETRY_CONFIG,
  withRetry,
  extractStatus,
  type ResolvedRetryConfig,
} from './retry-manager.js'
import { estimateInputTokens } from './token-estimator.js'
import { resolveModelLimits } from '../registry/index.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { DebugLogger } from './debug-logger.js'

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
  /** Circuit breakers per model key (only created if config.circuit is set) */
  private readonly circuits = new Map<string, CircuitBreaker>()
  /** Limits detected from provider response headers (lower priority than user config) */
  private readonly detectedLimits = new Map<string, ModelLimitOverride>()
  /** Set to true after shutdown() is called */
  private shutdownRequested = false
  private readonly log: DebugLogger

  constructor(config: RateLimiterConfig) {
    this.config = config
    this.log = new DebugLogger(config.debug === true)
    this.engine = new RateLimitEngine({
      maxQueueSize: config.queue?.maxSize ?? 500,
      ...(config.store !== undefined && { store: config.store }),
    })
    this.costTracker = new CostTracker({
      ...(config.cost?.store !== undefined && { store: config.cost.store }),
    })
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
      skipBudgetCheck?: boolean
      scope?: string
      signal?: AbortSignal
      /** Per-call AI API timeout in ms (overrides config.retry.callTimeout) */
      callTimeout?: number
      /** Request metadata forwarded to dropped events */
      metadata?: Record<string, unknown>
    },
  ): Promise<T> {
    this.log.log(modelId, 'execute', { provider, priority: opts.priority, ...(opts.scope !== undefined && { scope: opts.scope }) })

    // -----------------------------------------------------------------------
    // 0. Shutdown guard
    // -----------------------------------------------------------------------
    if (this.shutdownRequested) {
      this.emitter.emit('dropped', {
        model: modelId, provider, reason: 'shutdown',
        ...(opts.scope !== undefined && { scope: opts.scope }),
        ...(opts.metadata !== undefined && { metadata: opts.metadata }),
      })
      throw new ShutdownError()
    }

    const scope = opts.scope
    const limits = scope
      ? this.resolveScopedLimits(modelId, provider, scope)
      : this.resolveModelLimits(modelId, provider)
    const estimatedInput = estimateInputTokens(prompt)
    const key = scope ? `${scope}:${provider}:${modelId}` : `${provider}:${modelId}`

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
    // 2. Circuit breaker check (fast-fail if OPEN)
    // -----------------------------------------------------------------------
    const circuit = this.config.circuit ? this.getOrCreateCircuit(key) : undefined
    if (circuit?.isOpen()) {
      this.emitter.emit('dropped', {
        model: modelId, provider, reason: 'circuit-open',
        ...(scope !== undefined && { scope }),
        ...(opts.metadata !== undefined && { metadata: opts.metadata }),
      })
      throw new CircuitOpenError(modelId, circuit.openUntilMs)
    }

    // -----------------------------------------------------------------------
    // 3. Acquire rate limit slot
    // -----------------------------------------------------------------------
    try {
      await this.engine.acquire(key, {
        limits,
        estimatedInputTokens: estimatedInput,
        priority: opts.priority,
        timeoutMs: opts.timeoutMs,
        ...(opts.signal !== undefined && { signal: opts.signal }),
        onQueued: (queueDepth, estimatedWaitMs) => {
          this.log.log(modelId, 'queuing', { queueDepth, estimatedWaitMs, priority: opts.priority })
          this.emitter.emit('queued', { model: modelId, provider, priority: opts.priority, queueDepth, estimatedWaitMs })
          this.emitter.emit('rateLimited', { source: 'local', model: modelId, provider, limitType: 'rpm', resetAt: Date.now() + estimatedWaitMs })
        },
        onDequeued: (waitedMs) => {
          this.log.log(modelId, 'dequeued', { waitedMs, priority: opts.priority })
          this.emitter.emit('dequeued', { model: modelId, provider, waitedMs, priority: opts.priority })
        },
      })
    } catch (acquireErr) {
      if (acquireErr instanceof QueueFullError) {
        const maxSize = this.config.queue?.maxSize
        this.emitter.emit('dropped', {
          model: modelId, provider, reason: 'queue-full',
          ...(maxSize !== undefined && { queueDepth: maxSize }),
          ...(scope !== undefined && { scope }),
          ...(opts.metadata !== undefined && { metadata: opts.metadata }),
        })
      } else if (acquireErr instanceof QueueTimeoutError) {
        this.emitter.emit('dropped', {
          model: modelId, provider, reason: 'queue-timeout',
          waitedMs: acquireErr.waitedMs, queueDepth: acquireErr.queueDepth,
          ...(scope !== undefined && { scope }),
          ...(opts.metadata !== undefined && { metadata: opts.metadata }),
        })
      }
      throw acquireErr
    }
    slotAcquired = true

    // -----------------------------------------------------------------------
    // 4. Execute with retry (+ optional per-call timeout)
    // -----------------------------------------------------------------------
    const callTimeoutMs = opts.callTimeout ?? this.config.retry?.callTimeout
    const timedFn = callTimeoutMs
      ? (): Promise<T> =>
          Promise.race([
            fn(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(Object.assign(new Error(`AI call timed out after ${callTimeoutMs}ms`), { name: 'CallTimeoutError' })),
                callTimeoutMs,
              ),
            ),
          ])
      : fn

    try {
      const result = await withRetry(timedFn, this.retryConfig, {
        modelId,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          this.emitter.emit('retrying', { model: modelId, provider, attempt, maxAttempts, delayMs, error })
        },
        onRateLimited: (retryAfterMs) => {
          this.engine.applyBackoff(key, retryAfterMs)
          this.emitter.emit('rateLimited', { source: 'remote', model: modelId, provider, limitType: 'rpm', resetAt: Date.now() + retryAfterMs })
        },
      })

      if (circuit) {
        const justClosed = circuit.recordSuccess()
        if (justClosed) {
          this.log.log(modelId, 'circuit closed — upstream recovered')
          this.emitter.emit('circuitClosed', { model: modelId, provider })
        }
      }

      return result
    } catch (error) {
      if (circuit) {
        const status = extractStatus(error)
        const shouldTrip = status === null || circuit.tripOn.includes(status)
        if (shouldTrip) {
          const justOpened = circuit.recordFailure()
          if (justOpened) {
            this.log.log(modelId, 'circuit OPEN', { status, cooldownMs: this.config.circuit?.cooldownMs ?? 60_000 })
            this.emitter.emit('circuitOpen', {
              model: modelId, provider,
              failures: this.config.circuit?.failureThreshold ?? 5,
              cooldownMs: this.config.circuit?.cooldownMs ?? 60_000,
            })
          }
        }
      }
      throw error
    } finally {
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

    // Record in cost tracker (with scope for per-tenant attribution)
    const costUsd = this.costTracker.record(
      modelId,
      usage,
      limits.inputPricePerMillion,
      limits.outputPricePerMillion,
      scope,
    )

    this.log.log(modelId, 'completed', {
      tokens: `${usage.inputTokens}+${usage.outputTokens}`,
      costUsd: costUsd.toFixed(6),
      latencyMs,
      streaming,
      ...(scope !== undefined && { scope }),
    })
    this.emitter.emit('completed', {
      model: modelId,
      provider,
      ...(scope !== undefined && { scope }),
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
  // Shutdown / warmUp
  // -------------------------------------------------------------------------

  /**
   * Gracefully shut down the pipeline.
   * Rejects all queued requests, stops accepting new ones, and waits up to
   * drainMs for in-flight requests to complete.
   */
  async shutdown(opts?: { drainMs?: number }): Promise<void> {
    this.shutdownRequested = true
    this.engine.shutdown()
    const drainMs  = opts?.drainMs ?? 5_000
    const deadline = Date.now() + drainMs
    while (this.engine.totalActive() > 0 && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
  }

  /** Pre-load historical cost data from the persistent cost store. */
  async warmUp(): Promise<void> {
    if (this.config.cost?.store) {
      await this.costTracker.warmUp(this.config.cost.store)
    }
  }

  // -------------------------------------------------------------------------
  // Auto-detected limits
  // -------------------------------------------------------------------------

  /**
   * Update rate limit knowledge from provider response headers.
   * Auto-detected values are used only for fields the user hasn't explicitly configured.
   */
  updateDetectedLimits(modelId: string, provider: string, headers: Record<string, string>): void {
    const rawRpm  = headers['x-ratelimit-limit-requests']
    const rawItpm = headers['x-ratelimit-limit-tokens']
    const detectedRpm  = rawRpm  ? parseInt(rawRpm,  10) : NaN
    const detectedItpm = rawItpm ? parseInt(rawItpm, 10) : NaN

    if (isNaN(detectedRpm) && isNaN(detectedItpm)) return

    const mapKey  = `${provider}:${modelId}`
    const current = this.detectedLimits.get(mapKey) ?? {}
    const updated: ModelLimitOverride = { ...current }
    if (!isNaN(detectedRpm))  updated.rpm  = detectedRpm
    if (!isNaN(detectedItpm)) updated.itpm = detectedItpm
    this.detectedLimits.set(mapKey, updated)

    this.emitter.emit('limitsDetected', {
      model: modelId, provider,
      ...((!isNaN(detectedRpm))  && { detectedRpm }),
      ...((!isNaN(detectedItpm)) && { detectedItpm }),
    })
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateCircuit(key: string): CircuitBreaker {
    let cb = this.circuits.get(key)
    if (!cb) {
      cb = new CircuitBreaker(this.config.circuit ?? {})
      this.circuits.set(key, cb)
    }
    return cb
  }

  private resolveModelLimits(modelId: string, provider: string): ModelLimits {
    const base     = resolveModelLimits(modelId, provider, this.config.limits ?? {})
    const detected = this.detectedLimits.get(`${provider}:${modelId}`)
    if (!detected) return base

    // User config takes priority over auto-detected, which takes priority over registry
    const userOverride = this.config.limits?.[modelId] ?? {}
    return {
      ...base,
      ...(!('rpm'  in userOverride) && detected.rpm  !== undefined && { rpm:  detected.rpm }),
      ...(!('itpm' in userOverride) && detected.itpm !== undefined && { itpm: detected.itpm }),
    }
  }
}
