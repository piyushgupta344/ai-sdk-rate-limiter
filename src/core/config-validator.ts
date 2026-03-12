/**
 * Configuration validator for ai-sdk-rate-limiter.
 *
 * Called once at createRateLimiter() time. Emits console.warn for common
 * misconfigurations rather than throwing, so misconfigured limiters still
 * work — they just tell you what might be wrong.
 */

import type { RateLimiterConfig } from '../types.js'

const PREFIX = '\x1b[33m⚠ ai-sdk-rate-limiter\x1b[0m'
const RESET  = '\x1b[0m'

export function validateConfig(config: RateLimiterConfig): void {
  const warnings: string[] = []

  // cost.store without a warmUp() reminder
  if (config.cost?.store !== undefined) {
    warnings.push(
      'cost.store is configured — call `await limiter.warmUp()` at startup.\n' +
      '  Without it, budget caps won\'t account for spend from previous process runs.',
    )
  }

  // Circuit breaker threshold so low it will trip constantly
  const threshold = config.circuit?.failureThreshold
  if (threshold !== undefined && threshold < 3) {
    warnings.push(
      `circuit.failureThreshold is ${threshold} — very low. ` +
      'The circuit will open after nearly every error. ' +
      'Consider a value of 5 or higher for typical production workloads.',
    )
  }

  // retryOn explicitly excludes 429
  if (
    config.retry?.retryOn !== undefined &&
    !config.retry.retryOn.includes(429)
  ) {
    warnings.push(
      'retry.retryOn does not include 429. ' +
      'Rate limit errors from the API will not be retried. ' +
      'Add 429 to retry.retryOn, or remove the override to use the default.',
    )
  }

  // Queue timeout too aggressive
  const queueTimeout = config.queue?.timeout
  if (queueTimeout !== undefined && queueTimeout < 3_000) {
    warnings.push(
      `queue.timeout is ${queueTimeout}ms — less than 3 seconds. ` +
      'Requests may time out before the rate limit window resets (typically 60s). ' +
      'Consider 30_000ms (30s) or higher.',
    )
  }

  // onExceeded: 'fallback' without any obvious fallback configured
  if (config.cost?.onExceeded === 'fallback') {
    warnings.push(
      "cost.onExceeded is 'fallback' but fallback models are configured per-model " +
      'in limiter.wrap(model, { fallback: cheaperModel }). ' +
      'If no fallback is set on a wrapped model, BudgetExceededError will still be thrown.',
    )
  }

  // budget configured without onExceeded — default is 'throw', which is fine,
  // but worth noting if someone forgot to set it
  if (config.cost?.budget !== undefined && config.cost.onExceeded === undefined) {
    warnings.push(
      "cost.budget is set but cost.onExceeded is not. " +
      "Defaulting to 'throw' — requests will throw BudgetExceededError when the cap is hit. " +
      "Set onExceeded: 'queue' or 'fallback' to change this behavior.",
    )
  }

  for (const warning of warnings) {
    // Indent continuation lines for readability
    const formatted = warning.replace(/\n/g, `\n  `)
    console.warn(`${PREFIX}: ${formatted}${RESET}`)
  }
}
