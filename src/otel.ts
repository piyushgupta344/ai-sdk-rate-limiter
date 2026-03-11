/**
 * OpenTelemetry plugin for ai-sdk-rate-limiter.
 *
 * Bridges the rate limiter event system to OTel spans so every AI request
 * shows up in your tracing dashboard with full metadata.
 *
 * No hard dependency on @opentelemetry/api — pass any tracer that implements
 * the OtelTracer interface (structurally compatible with the real OTel tracer).
 *
 * @example
 * ```typescript
 * import { trace } from '@opentelemetry/api'
 * import { createRateLimiter } from 'ai-sdk-rate-limiter'
 * import { createOtelPlugin } from 'ai-sdk-rate-limiter/otel'
 *
 * const limiter = createRateLimiter({
 *   on: createOtelPlugin(trace.getTracer('my-service')),
 * })
 * ```
 */

import type { EventHandlers } from './types.js'

// ---------------------------------------------------------------------------
// Minimal OTel interfaces — structurally compatible with @opentelemetry/api.
// Define them here so callers don't need @opentelemetry/api as a compile dep.
// ---------------------------------------------------------------------------

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): this
  setAttributes(attributes: Record<string, string | number | boolean>): this
  setStatus(status: { code: number; message?: string }): this
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this
  end(endTime?: number): void
}

export interface OtelTracer {
  startSpan(
    name: string,
    options?: {
      startTime?: number
      attributes?: Record<string, string | number | boolean>
    },
  ): OtelSpan
}

/**
 * OTel span status codes — matches @opentelemetry/api SpanStatusCode values.
 * Defined here so we don't need @opentelemetry/api as a compile-time dep.
 */
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Create an EventHandlers plugin that emits OpenTelemetry spans for every
 * AI request processed by the rate limiter.
 *
 * Span semantics:
 * - `gen_ai.request` — one span per completed request, with the full latency
 *    as the span duration (start time reconstructed from latencyMs).
 *    Attributes follow OTel GenAI semantic conventions.
 * - `gen_ai.request` (ERROR) — one span per dropped request.
 * - `ai_rate_limiter.retry` — one span per retry attempt.
 * - `ai_rate_limiter.budget_hit` — one ERROR span per budget breach.
 */
export function createOtelPlugin(tracer: OtelTracer): EventHandlers {
  return {
    completed(event) {
      // Reconstruct the span duration from latencyMs so the span covers the
      // full wall-clock time of the request (including any queue wait).
      const endTime = Date.now()
      const startTime = endTime - event.latencyMs

      const span = tracer.startSpan('gen_ai.request', {
        startTime,
        attributes: {
          // OTel GenAI semantic conventions
          'gen_ai.system': event.provider,
          'gen_ai.request.model': event.model,
          'gen_ai.usage.input_tokens': event.inputTokens,
          'gen_ai.usage.output_tokens': event.outputTokens,
          // Rate limiter specifics
          'ai_rate_limiter.cost_usd': event.costUsd,
          'ai_rate_limiter.streaming': event.streaming,
          'ai_rate_limiter.latency_ms': event.latencyMs,
        },
      })
      span.end(endTime)
    },

    dropped(event) {
      const span = tracer.startSpan('gen_ai.request', {
        attributes: {
          'gen_ai.system': event.provider,
          'gen_ai.request.model': event.model,
          'ai_rate_limiter.drop_reason': event.reason,
        },
      })
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.reason })
      span.end()
    },

    budgetHit(event) {
      const span = tracer.startSpan('ai_rate_limiter.budget_hit', {
        attributes: {
          'gen_ai.system': event.provider,
          'gen_ai.request.model': event.model,
          'ai_rate_limiter.current_cost_usd': event.currentCostUsd,
          'ai_rate_limiter.budget_limit_usd': event.limitUsd,
          'ai_rate_limiter.budget_period': event.period,
        },
      })
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `Budget exceeded (${event.period}): $${event.currentCostUsd.toFixed(4)} / $${event.limitUsd}`,
      })
      span.end()
    },

    retrying(event) {
      const span = tracer.startSpan('ai_rate_limiter.retry', {
        attributes: {
          'gen_ai.system': event.provider,
          'gen_ai.request.model': event.model,
          'ai_rate_limiter.attempt': event.attempt,
          'ai_rate_limiter.max_attempts': event.maxAttempts,
          'ai_rate_limiter.delay_ms': event.delayMs,
        },
      })
      span.end()
    },
  }
}
