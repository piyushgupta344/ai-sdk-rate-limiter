import { describe, it, expect, beforeEach } from 'vitest'
import { createOtelPlugin, SpanStatusCode, type OtelSpan, type OtelTracer } from './otel.js'

// ---------------------------------------------------------------------------
// Mock tracer & span
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string
  startTime: number | undefined
  endTime: number | undefined
  attributes: Record<string, string | number | boolean>
  status: { code: number; message?: string }
  ended: boolean
}

function makeMockTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []

  const tracer: OtelTracer = {
    startSpan(name, options) {
      const recorded: RecordedSpan = {
        name,
        startTime: options?.startTime,
        endTime: undefined,
        attributes: { ...(options?.attributes ?? {}) },
        status: { code: SpanStatusCode.UNSET },
        ended: false,
      }
      spans.push(recorded)

      const span: OtelSpan = {
        setAttribute(k, v) {
          recorded.attributes[k] = v
          return this
        },
        setAttributes(attrs) {
          Object.assign(recorded.attributes, attrs)
          return this
        },
        setStatus(s) {
          recorded.status = s
          return this
        },
        addEvent() {
          return this
        },
        end(t) {
          recorded.ended = true
          recorded.endTime = t
        },
      }
      return span
    },
  }

  return { tracer, spans }
}

// ---------------------------------------------------------------------------
// Helpers to build event payloads
// ---------------------------------------------------------------------------

const baseCompleted = {
  model: 'gpt-4o',
  provider: 'openai',
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.0015,
  latencyMs: 800,
  streaming: false,
}

const baseDropped = {
  model: 'gpt-4o',
  provider: 'openai',
  reason: 'queue-timeout' as const,
}

const baseBudgetHit = {
  model: 'gpt-4o',
  provider: 'openai',
  currentCostUsd: 10.5,
  limitUsd: 10,
  period: 'daily' as const,
  usingFallback: false,
}

const baseRetrying = {
  model: 'gpt-4o',
  provider: 'openai',
  attempt: 2,
  maxAttempts: 4,
  delayMs: 2000,
  error: new Error('rate limited'),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOtelPlugin', () => {
  let tracer: OtelTracer
  let spans: RecordedSpan[]

  beforeEach(() => {
    ;({ tracer, spans } = makeMockTracer())
  })

  describe('completed event', () => {
    it('creates a gen_ai.request span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.completed!(baseCompleted)
      expect(spans).toHaveLength(1)
      expect(spans[0]!.name).toBe('gen_ai.request')
    })

    it('sets gen_ai semantic convention attributes', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.completed!(baseCompleted)
      const attrs = spans[0]!.attributes
      expect(attrs['gen_ai.system']).toBe('openai')
      expect(attrs['gen_ai.request.model']).toBe('gpt-4o')
      expect(attrs['gen_ai.usage.input_tokens']).toBe(100)
      expect(attrs['gen_ai.usage.output_tokens']).toBe(50)
    })

    it('sets rate-limiter-specific attributes', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.completed!(baseCompleted)
      const attrs = spans[0]!.attributes
      expect(attrs['ai_rate_limiter.cost_usd']).toBe(0.0015)
      expect(attrs['ai_rate_limiter.streaming']).toBe(false)
      expect(attrs['ai_rate_limiter.latency_ms']).toBe(800)
    })

    it('reconstructs span duration from latencyMs', () => {
      const plugin = createOtelPlugin(tracer)
      const before = Date.now()
      plugin.completed!(baseCompleted)
      const after = Date.now()

      const span = spans[0]!
      // startTime should be approximately endTime - latencyMs
      expect(span.startTime).toBeDefined()
      expect(span.endTime).toBeDefined()
      const duration = span.endTime! - span.startTime!
      expect(duration).toBeCloseTo(baseCompleted.latencyMs, -1) // within ~10ms
      expect(span.endTime).toBeGreaterThanOrEqual(before)
      expect(span.endTime).toBeLessThanOrEqual(after + 10)
    })

    it('ends the span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.completed!(baseCompleted)
      expect(spans[0]!.ended).toBe(true)
    })

    it('marks streaming requests correctly', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.completed!({ ...baseCompleted, streaming: true })
      expect(spans[0]!.attributes['ai_rate_limiter.streaming']).toBe(true)
    })
  })

  describe('dropped event', () => {
    it('creates a gen_ai.request span with ERROR status', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.dropped!(baseDropped)
      expect(spans).toHaveLength(1)
      expect(spans[0]!.name).toBe('gen_ai.request')
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    })

    it('includes the drop reason in status message and attributes', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.dropped!(baseDropped)
      const span = spans[0]!
      expect(span.status.message).toBe('queue-timeout')
      expect(span.attributes['ai_rate_limiter.drop_reason']).toBe('queue-timeout')
    })

    it('ends the span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.dropped!(baseDropped)
      expect(spans[0]!.ended).toBe(true)
    })
  })

  describe('budgetHit event', () => {
    it('creates an ai_rate_limiter.budget_hit span with ERROR status', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.budgetHit!(baseBudgetHit)
      expect(spans).toHaveLength(1)
      expect(spans[0]!.name).toBe('ai_rate_limiter.budget_hit')
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    })

    it('includes budget attributes', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.budgetHit!(baseBudgetHit)
      const attrs = spans[0]!.attributes
      expect(attrs['ai_rate_limiter.current_cost_usd']).toBe(10.5)
      expect(attrs['ai_rate_limiter.budget_limit_usd']).toBe(10)
      expect(attrs['ai_rate_limiter.budget_period']).toBe('daily')
    })

    it('includes period in the status message', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.budgetHit!(baseBudgetHit)
      expect(spans[0]!.status.message).toContain('daily')
    })

    it('ends the span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.budgetHit!(baseBudgetHit)
      expect(spans[0]!.ended).toBe(true)
    })
  })

  describe('retrying event', () => {
    it('creates an ai_rate_limiter.retry span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.retrying!(baseRetrying)
      expect(spans).toHaveLength(1)
      expect(spans[0]!.name).toBe('ai_rate_limiter.retry')
    })

    it('includes attempt and delay attributes', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.retrying!(baseRetrying)
      const attrs = spans[0]!.attributes
      expect(attrs['ai_rate_limiter.attempt']).toBe(2)
      expect(attrs['ai_rate_limiter.max_attempts']).toBe(4)
      expect(attrs['ai_rate_limiter.delay_ms']).toBe(2000)
    })

    it('ends the span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.retrying!(baseRetrying)
      expect(spans[0]!.ended).toBe(true)
    })
  })

  describe('SpanStatusCode', () => {
    it('has the correct OTel-compatible values', () => {
      expect(SpanStatusCode.UNSET).toBe(0)
      expect(SpanStatusCode.OK).toBe(1)
      expect(SpanStatusCode.ERROR).toBe(2)
    })
  })

  describe('independent event handlers', () => {
    it('each event creates exactly one span', () => {
      const plugin = createOtelPlugin(tracer)
      plugin.completed!(baseCompleted)
      plugin.dropped!(baseDropped)
      plugin.budgetHit!(baseBudgetHit)
      plugin.retrying!(baseRetrying)
      expect(spans).toHaveLength(4)
    })
  })
})
