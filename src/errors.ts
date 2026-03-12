/** Base class for all ai-sdk-rate-limiter errors */
export class RateLimiterError extends Error {
  // Declared as mutable string so subclasses can assign in constructors
  declare name: string

  constructor(message: string) {
    super(message)
    this.name = 'RateLimiterError'
    // Restore prototype chain (needed when extending built-ins in TS)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Thrown when a request cannot proceed because the rate limit was hit
 * and the request either timed out waiting in the queue or exhausted all retries.
 */
export class RateLimitExceededError extends RateLimiterError {
  constructor(
    public readonly model: string,
    public readonly limitType: 'rpm' | 'itpm' | 'otpm',
    public readonly limit: number,
    public readonly resetAt: number,
  ) {
    super(
      `Rate limit exceeded for model "${model}": ${limitType.toUpperCase()} limit of ${limit} hit. ` +
        `Resets at ${new Date(resetAt).toISOString()}.`,
    )
    this.name = 'RateLimitExceededError'
  }
}

/**
 * Thrown when a request has waited in the queue longer than the configured timeout.
 */
export class QueueTimeoutError extends RateLimiterError {
  constructor(
    public readonly model: string,
    public readonly waitedMs: number,
    public readonly queueDepth: number,
  ) {
    super(
      `Request for model "${model}" timed out after waiting ${waitedMs}ms in the queue ` +
        `(current queue depth: ${queueDepth}).`,
    )
    this.name = 'QueueTimeoutError'
  }
}

/**
 * Thrown when a new request arrives and the queue is at capacity.
 */
export class QueueFullError extends RateLimiterError {
  constructor(
    public readonly model: string,
    public readonly maxSize: number,
  ) {
    super(
      `Queue for model "${model}" is full (maxSize: ${maxSize}). ` +
        `Increase queue.maxSize or reduce request rate.`,
    )
    this.name = 'QueueFullError'
  }
}

/**
 * Thrown when a request would exceed the configured cost budget.
 */
export class BudgetExceededError extends RateLimiterError {
  constructor(
    public readonly model: string,
    public readonly currentCostUsd: number,
    public readonly limitUsd: number,
    public readonly period: 'hourly' | 'daily' | 'monthly',
  ) {
    super(
      `Cost budget exceeded for model "${model}": ` +
        `$${currentCostUsd.toFixed(4)} used of $${limitUsd.toFixed(2)} ${period} budget.`,
    )
    this.name = 'BudgetExceededError'
  }
}

/**
 * Thrown when a request is blocked because the circuit breaker is open.
 */
export class CircuitOpenError extends RateLimiterError {
  constructor(
    public readonly model: string,
    public readonly openUntilMs: number,
  ) {
    super(
      `Circuit breaker for model "${model}" is open due to repeated failures. ` +
        `Requests are blocked until ${new Date(openUntilMs).toISOString()}.`,
    )
    this.name = 'CircuitOpenError'
  }
}

/**
 * Thrown when a request arrives after shutdown() has been called.
 */
export class ShutdownError extends RateLimiterError {
  constructor() {
    super('Rate limiter is shutting down — new requests are not accepted.')
    this.name = 'ShutdownError'
  }
}

/**
 * Thrown when all retry attempts are exhausted.
 */
export class RetryExhaustedError extends RateLimiterError {
  constructor(
    public readonly model: string,
    public readonly attempts: number,
    public readonly cause: unknown,
  ) {
    super(
      `All ${attempts} retry attempts exhausted for model "${model}". ` +
        `Last error: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'RetryExhaustedError'
    if (cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`
    }
  }
}
