# Metrics & observability

## Events

Every significant lifecycle event is emitted. Subscribe with `limiter.on()`:

```typescript
const limiter = createRateLimiter({
  on: {
    queued:       ({ model, priority, queueDepth, estimatedWaitMs }) => {},
    dequeued:     ({ model, waitedMs }) => {},
    rateLimited:  ({ model, source, limitType, resetAt }) => {},
    retrying:     ({ model, attempt, maxAttempts, delayMs }) => {},
    completed:    ({ model, costUsd, inputTokens, outputTokens, latencyMs }) => {},
    dropped:      ({ model, reason, waitedMs }) => {},
    budgetHit:    ({ model, period, limitUsd, usingFallback }) => {},
    circuitOpen:  ({ model, failures, cooldownMs }) => {},
    circuitClosed:({ model }) => {},
    limitsDetected: ({ model, detectedRpm, detectedItpm }) => {},
  },
})
```

You can also add/remove listeners after construction:

```typescript
const handler = (event) => console.log(event)
limiter.on('completed', handler)
limiter.off('completed', handler)
```

## Prometheus metrics

```typescript
import { createPrometheusPlugin } from 'ai-sdk-rate-limiter/prometheus'

const plugin = createPrometheusPlugin({ prefix: 'ai_' })
const limiter = createRateLimiter({ on: plugin.handlers })

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', plugin.registry.contentType)
  res.end(await plugin.registry.metrics())
})
```

Exposes:
- `ai_requests_total` — counter by model, status
- `ai_request_duration_seconds` — histogram by model
- `ai_queue_depth` — gauge by model
- `ai_cost_usd_total` — counter by model
- `ai_budget_exceeded_total` — counter by model, period
- `ai_circuit_open` — gauge by model (1 = open)

## StatsD metrics

```typescript
import { createStatsdPlugin } from 'ai-sdk-rate-limiter/statsd'
import StatsD from 'hot-shots'

const plugin = createStatsdPlugin(new StatsD({ prefix: 'ai.' }))
const limiter = createRateLimiter({ on: plugin.handlers })
```

## OpenTelemetry tracing

```typescript
import { createOtelPlugin } from 'ai-sdk-rate-limiter/otel'
import { trace } from '@opentelemetry/api'

const plugin = createOtelPlugin(trace.getTracer('my-service'))
const limiter = createRateLimiter({ on: plugin.handlers })
```

Creates a span per completed request with attributes:
- `ai.model.id`, `ai.provider`
- `ai.usage.input_tokens`, `ai.usage.output_tokens`
- `ai.cost.usd`, `ai.latency.ms`

## Debug mode

```typescript
const limiter = createRateLimiter({ debug: true })
```

Logs every decision to the console:

```
[ai-sdk-rate-limiter] gpt-4o: execute (provider="openai" priority="normal")
[ai-sdk-rate-limiter] gpt-4o: queuing (queueDepth=3 estimatedWaitMs=1200 priority="normal")
[ai-sdk-rate-limiter] gpt-4o: dequeued (waitedMs=1187 priority="normal")
[ai-sdk-rate-limiter] gpt-4o: completed (tokens=342+87 costUsd=0.000021 latencyMs=1343 streaming=false)
```

Zero overhead when disabled.

## Express / Hono middleware

```typescript
import { createRateLimiterMiddleware } from 'ai-sdk-rate-limiter/middleware'

const { middleware, errorHandler } = createRateLimiterMiddleware(limiter, {
  onRateLimited: (req, res, next, err) => {
    res.status(429).json({ error: 'Rate limit exceeded', retryAfter: 30 })
  },
})

app.use(middleware)
app.use(errorHandler)
```
