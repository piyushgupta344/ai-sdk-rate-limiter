/**
 * Prometheus metrics plugin for ai-sdk-rate-limiter.
 *
 * Maintains in-process counters and exposes a collect() method that renders
 * Prometheus exposition format. No hard dependency on a Prometheus client library.
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from 'ai-sdk-rate-limiter'
 * import { createPrometheusPlugin } from 'ai-sdk-rate-limiter/prometheus'
 *
 * const plugin = createPrometheusPlugin()
 * const limiter = createRateLimiter({ on: plugin })
 *
 * // In your /metrics HTTP handler:
 * app.get('/metrics', (req, res) => {
 *   res.set('Content-Type', 'text/plain; version=0.0.4')
 *   res.send(plugin.collect())
 * })
 * ```
 */

import type { EventHandlers } from './types.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface PrometheusPluginOptions {
  /** Metric name prefix. Default: 'ai' */
  prefix?: string
}

export interface PrometheusPlugin extends EventHandlers {
  /** Render all current metrics in Prometheus text exposition format. */
  collect(): string
  /** Reset all counters and histograms (useful between tests). */
  reset(): void
}

// ---------------------------------------------------------------------------
// Internal counter / gauge / histogram helpers
// ---------------------------------------------------------------------------

type Labels = Record<string, string>

interface Counter {
  inc(labels: Labels, value?: number): void
  collect(name: string, help: string): string
}

interface Gauge {
  set(labels: Labels, value: number): void
  collect(name: string, help: string): string
}

interface Histogram {
  observe(labels: Labels, value: number): void
  collect(name: string, help: string): string
}

function labelStr(labels: Labels): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',')
}

function makeCounter(): Counter {
  const data = new Map<string, { labels: Labels; value: number }>()

  return {
    inc(labels, value = 1) {
      const key = labelStr(labels)
      const existing = data.get(key)
      if (existing) existing.value += value
      else data.set(key, { labels, value })
    },
    collect(name, help) {
      if (data.size === 0) return ''
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`]
      for (const { labels, value } of data.values()) {
        lines.push(`${name}{${labelStr(labels)}} ${value}`)
      }
      return lines.join('\n')
    },
  }
}

function makeGauge(): Gauge {
  const data = new Map<string, { labels: Labels; value: number }>()

  return {
    set(labels, value) {
      data.set(labelStr(labels), { labels, value })
    },
    collect(name, help) {
      if (data.size === 0) return ''
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`]
      for (const { labels, value } of data.values()) {
        lines.push(`${name}{${labelStr(labels)}} ${value}`)
      }
      return lines.join('\n')
    },
  }
}

// Simple summary (count + sum) — no quantiles to keep zero-dependency
function makeHistogram(): Histogram {
  const data = new Map<string, { labels: Labels; count: number; sum: number }>()

  return {
    observe(labels, value) {
      const key = labelStr(labels)
      const existing = data.get(key)
      if (existing) { existing.count++; existing.sum += value }
      else data.set(key, { labels, count: 1, sum: value })
    },
    collect(name, help) {
      if (data.size === 0) return ''
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} summary`]
      for (const { labels, count, sum } of data.values()) {
        const l = labelStr(labels)
        lines.push(`${name}_count{${l}} ${count}`)
        lines.push(`${name}_sum{${l}} ${sum}`)
      }
      return lines.join('\n')
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createPrometheusPlugin(options: PrometheusPluginOptions = {}): PrometheusPlugin {
  const p = options.prefix ?? 'ai'

  let requests      = makeCounter()
  let tokensInput   = makeCounter()
  let tokensOutput  = makeCounter()
  let costUsd       = makeCounter()
  let latency       = makeHistogram()
  let retries       = makeCounter()
  let rateLimited   = makeCounter()
  let budgetExc     = makeCounter()
  let queueDepth    = makeGauge()

  const plugin: PrometheusPlugin = {
    completed(event) {
      const l = { model: event.model, provider: event.provider }
      requests.inc({ ...l, status: 'completed' })
      tokensInput.inc(l, event.inputTokens)
      tokensOutput.inc(l, event.outputTokens)
      costUsd.inc(l, event.costUsd)
      latency.observe(l, event.latencyMs)
    },

    dropped(event) {
      requests.inc({ model: event.model, provider: event.provider, status: 'dropped' })
    },

    retrying(event) {
      retries.inc({ model: event.model, provider: event.provider })
    },

    rateLimited(event) {
      rateLimited.inc({ model: event.model, provider: event.provider, source: event.source })
    },

    budgetHit(event) {
      budgetExc.inc({ model: event.model, provider: event.provider, period: event.period })
    },

    queued(event) {
      queueDepth.set({ model: event.model, provider: event.provider }, event.queueDepth)
    },

    dequeued(event) {
      // queue depth decrements — use 0 as a best-effort indicator
      queueDepth.set({ model: event.model, provider: event.provider }, 0)
    },

    collect() {
      return [
        requests.collect(`${p}_requests_total`, 'Total AI requests by model and status'),
        tokensInput.collect(`${p}_tokens_input_total`, 'Total input tokens consumed'),
        tokensOutput.collect(`${p}_tokens_output_total`, 'Total output tokens consumed'),
        costUsd.collect(`${p}_cost_usd_total`, 'Total cost in USD'),
        latency.collect(`${p}_request_duration_ms`, 'Request latency in milliseconds'),
        retries.collect(`${p}_retries_total`, 'Total retry attempts'),
        rateLimited.collect(`${p}_rate_limited_total`, 'Times rate limited (local or remote)'),
        budgetExc.collect(`${p}_budget_exceeded_total`, 'Times cost budget was exceeded'),
        queueDepth.collect(`${p}_queue_depth`, 'Current queue depth per model'),
      ]
        .filter(Boolean)
        .join('\n\n')
    },

    reset() {
      requests    = makeCounter()
      tokensInput  = makeCounter()
      tokensOutput = makeCounter()
      costUsd      = makeCounter()
      latency      = makeHistogram()
      retries      = makeCounter()
      rateLimited  = makeCounter()
      budgetExc    = makeCounter()
      queueDepth   = makeGauge()
    },
  }

  return plugin
}
