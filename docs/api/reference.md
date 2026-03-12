# API Reference

## `createRateLimiter(config?)`

Creates and returns a `RateLimiter` instance.

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'

const limiter = createRateLimiter(config?)
```

See [Configuration](/guide/configuration) for all config options.

## RateLimiter methods

### `limiter.wrap(model, options?)`

Wraps a Vercel AI SDK language model with rate limiting.

```typescript
const model = limiter.wrap(openai('gpt-4o'), {
  modelId?: string        // override model ID
  providerId?: string     // override provider ID
  fallback?: model | model[]  // fallback model(s) for budget exceeded
  scope?: string          // static multi-tenant scope key
})
```

### `limiter.getCostReport()`

Returns a snapshot of cost usage across rolling periods.

```typescript
const report: CostReport = limiter.getCostReport()
// { hour, day, month, byModel, byScope }
```

### `limiter.getCostForecast()`

Projects end-of-period spend based on current hourly rate.

```typescript
const forecast: CostForecastReport = limiter.getCostForecast()
// { hour, day, month } each with { spentUsd, projectedUsd, ratePerHourUsd }
```

### `limiter.getStatus()`

Returns queue depths and rate limit window state per model.

```typescript
const status: LimiterStatus = limiter.getStatus()
// { models: ModelStatus[], totalQueueDepth: number }
```

### `limiter.estimatedWait(modelId, priority?)`

Returns estimated queue wait time in ms (0 = no wait).

```typescript
const ms = await limiter.estimatedWait('gpt-4o', 'normal')
```

### `limiter.rawProxy(client, options?)`

Wraps a raw SDK client (OpenAI, Anthropic, Groq, etc.) with rate limiting.

```typescript
const openai = limiter.rawProxy(new OpenAI(), {
  provider?: string   // provider name for metrics
  priority?: Priority // default request priority
})
```

### `limiter.on(event, handler)` / `limiter.off(event, handler)`

Register/remove event listeners. See [Events](/api/events).

### `limiter.shutdown(opts?)`

Gracefully stop the limiter.

```typescript
await limiter.shutdown({ drainMs?: number }) // default: 5000ms
```

### `limiter.warmUp()`

Pre-load historical cost data from the persistent cost store. Call once at startup when `cost.store` is configured.

```typescript
await limiter.warmUp()
```

### `limiter.middleware`

The raw Vercel AI SDK middleware — use with `wrapLanguageModel()` directly.

---

## `createModelPool(models, options?)`

Round-robin load balancer across multiple model instances.

```typescript
import { createModelPool } from 'ai-sdk-rate-limiter'

const pool = createModelPool(models: WrappableModel[], {
  strategy?: 'round-robin' | 'random'  // default: 'round-robin'
})
```

Returns a `WrappableModel` that distributes calls across the pool.

---

## `rateLimited(client, options?)`

Standalone proxy — wraps a raw SDK client without a limiter instance.

```typescript
import { rateLimited } from 'ai-sdk-rate-limiter'
import OpenAI from 'openai'

const client = rateLimited(new OpenAI(), options?)
```

---

## Per-request options

Passed via `providerOptions.rateLimiter`:

```typescript
providerOptions: {
  rateLimiter: {
    priority?: 'high' | 'normal' | 'low'   // default: 'normal'
    timeout?: number                         // queue timeout override (ms)
    scope?: string                           // multi-tenant scope key
    callTimeout?: number                     // API call timeout (ms)
    dedupKey?: string                        // deduplication key
    metadata?: Record<string, unknown>       // forwarded to dropped events
  }
}
```
