/**
 * Circuit breaker per model key.
 *
 * State machine:
 *   CLOSED  → OPEN      (after failureThreshold consecutive failures)
 *   OPEN    → HALF_OPEN (after cooldownMs elapses)
 *   HALF_OPEN → CLOSED  (probe request succeeded)
 *   HALF_OPEN → OPEN    (probe request failed — back to cooldown)
 */

export interface CircuitBreakerConfig {
  /**
   * Consecutive failures before the circuit opens.
   * Only 5xx / network errors count; 429s and 4xx do not.
   * Default: 5
   */
  failureThreshold?: number
  /**
   * How long (ms) the circuit stays open before allowing a single probe.
   * Default: 60_000
   */
  cooldownMs?: number
  /**
   * HTTP status codes that count as failures toward the threshold.
   * Default: [500, 502, 503, 504]
   */
  tripOn?: number[]
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

const DEFAULTS = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  tripOn: [500, 502, 503, 504],
} satisfies Required<CircuitBreakerConfig>

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private failures = 0
  private openedAt = 0
  readonly tripOn: number[]

  private readonly threshold: number
  private readonly cooldown: number

  constructor(config: CircuitBreakerConfig = {}) {
    this.threshold = config.failureThreshold ?? DEFAULTS.failureThreshold
    this.cooldown  = config.cooldownMs       ?? DEFAULTS.cooldownMs
    this.tripOn    = config.tripOn           ?? DEFAULTS.tripOn
  }

  /**
   * Returns true if the circuit should block the request.
   * Automatically transitions OPEN → HALF_OPEN once cooldownMs elapses.
   */
  isOpen(now = Date.now()): boolean {
    if (this.state === 'CLOSED') return false
    if (this.state === 'OPEN') {
      if (now >= this.openedAt + this.cooldown) {
        this.state = 'HALF_OPEN'
        return false // allow one probe
      }
      return true
    }
    // HALF_OPEN: allow the probe through
    return false
  }

  /**
   * Record a successful call.
   * @returns true if the circuit was previously OPEN/HALF_OPEN and just closed.
   */
  recordSuccess(): boolean {
    const wasFailing = this.state !== 'CLOSED'
    this.state   = 'CLOSED'
    this.failures = 0
    return wasFailing
  }

  /**
   * Record a failed call.
   * @returns true if this failure caused the circuit to open.
   */
  recordFailure(now = Date.now()): boolean {
    if (this.state === 'HALF_OPEN') {
      // Probe failed — re-open
      this.state    = 'OPEN'
      this.openedAt = now
      return false // was already conceptually open
    }
    if (this.state === 'OPEN') return false

    this.failures++
    if (this.failures >= this.threshold) {
      this.state    = 'OPEN'
      this.openedAt = now
      this.failures = 0
      return true // just opened
    }
    return false
  }

  get currentState(): CircuitState { return this.state }
  /** Timestamp (ms) when the circuit will attempt to transition to HALF_OPEN. */
  get openUntilMs(): number { return this.openedAt + this.cooldown }
}
