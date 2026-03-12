/**
 * Lightweight debug logger for ai-sdk-rate-limiter.
 *
 * Zero overhead when disabled — every call is a single boolean check.
 * Enable with createRateLimiter({ debug: true }).
 */

const PREFIX = '[ai-sdk-rate-limiter]'

export class DebugLogger {
  private readonly enabled: boolean

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  log(model: string, message: string, details?: Record<string, unknown>): void {
    if (!this.enabled) return
    if (details && Object.keys(details).length > 0) {
      const parts = Object.entries(details)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
      console.log(`${PREFIX} ${model}: ${message} (${parts})`)
    } else {
      console.log(`${PREFIX} ${model}: ${message}`)
    }
  }
}
