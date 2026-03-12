import { describe, it, expect, beforeEach } from 'vitest'
import { createPrometheusPlugin } from './prometheus.js'

let plugin = createPrometheusPlugin()

beforeEach(() => {
  plugin = createPrometheusPlugin()
})

describe('createPrometheusPlugin', () => {
  it('returns empty string when no events have fired', () => {
    expect(plugin.collect()).toBe('')
  })

  it('records a completed request', () => {
    plugin.completed!({
      model: 'gpt-4o', provider: 'openai',
      inputTokens: 100, outputTokens: 50, costUsd: 0.005, latencyMs: 300, streaming: false,
    })
    const out = plugin.collect()
    expect(out).toContain('ai_requests_total')
    expect(out).toContain('model="gpt-4o"')
    expect(out).toContain('status="completed"')
    expect(out).toContain('ai_tokens_input_total')
    expect(out).toContain('ai_cost_usd_total')
    expect(out).toContain('ai_request_duration_ms_count')
  })

  it('records a dropped request', () => {
    plugin.dropped!({ model: 'gpt-4o', provider: 'openai', reason: 'queue-timeout' })
    const out = plugin.collect()
    expect(out).toContain('status="dropped"')
  })

  it('records retries', () => {
    plugin.retrying!({ model: 'gpt-4o', provider: 'openai', attempt: 1, maxAttempts: 4, delayMs: 1000, error: new Error() })
    expect(plugin.collect()).toContain('ai_retries_total')
  })

  it('records rate limits', () => {
    plugin.rateLimited!({ model: 'gpt-4o', provider: 'openai', source: 'remote', limitType: 'rpm', resetAt: Date.now() + 1000 })
    expect(plugin.collect()).toContain('source="remote"')
  })

  it('records budget exceeded', () => {
    plugin.budgetHit!({ model: 'gpt-4o', provider: 'openai', currentCostUsd: 10, limitUsd: 10, period: 'daily', usingFallback: false })
    expect(plugin.collect()).toContain('ai_budget_exceeded_total')
    expect(plugin.collect()).toContain('period="daily"')
  })

  it('accumulates multiple events', () => {
    for (let i = 0; i < 3; i++) {
      plugin.completed!({ model: 'gpt-4o', provider: 'openai', inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 100, streaming: false })
    }
    const out = plugin.collect()
    // The counter line should show 3
    expect(out).toMatch(/ai_requests_total\{.*\} 3/)
  })

  it('reset() clears all metrics', () => {
    plugin.completed!({ model: 'gpt-4o', provider: 'openai', inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 100, streaming: false })
    plugin.reset()
    expect(plugin.collect()).toBe('')
  })

  it('uses custom prefix', () => {
    const custom = createPrometheusPlugin({ prefix: 'myapp' })
    custom.completed!({ model: 'gpt-4o', provider: 'openai', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 10, streaming: false })
    expect(custom.collect()).toContain('myapp_requests_total')
  })

  it('renders valid Prometheus exposition format', () => {
    plugin.completed!({ model: 'gpt-4o', provider: 'openai', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 10, streaming: false })
    const lines = plugin.collect().split('\n').filter(l => l && !l.startsWith('#'))
    for (const line of lines) {
      // Each metric line must be: name{labels} value
      expect(line).toMatch(/^\w+\{.*\} \S+$/)
    }
  })
})
