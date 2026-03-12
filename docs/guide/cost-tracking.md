# Cost tracking

## Cost report

```typescript
const report = limiter.getCostReport()
// {
//   hour:  { requests: 42,   inputTokens: 84_000,  outputTokens: 21_000,  costUsd: 0.29 },
//   day:   { requests: 318,  inputTokens: 620_000, outputTokens: 155_000, costUsd: 2.11 },
//   month: { requests: 4821, inputTokens: 9_100_000, outputTokens: 2_200_000, costUsd: 34.80 },
//   byModel: {
//     'gpt-4o':      { requests: 120, costUsd: 1.20, ... },
//     'gpt-4o-mini': { requests: 198, costUsd: 0.91, ... },
//   },
//   byScope: {
//     'user:alice': { requests: 15, costUsd: 0.15, ... },
//   },
// }
```

Costs are based on **actual token counts** from API responses. The report uses rolling windows (hour = last 60 minutes).

## Cost forecasting

```typescript
const forecast = limiter.getCostForecast()
// {
//   hour:  { spentUsd: 1.20, projectedUsd: 1.20,  ratePerHourUsd: 1.20 },
//   day:   { spentUsd: 3.50, projectedUsd: 28.80, ratePerHourUsd: 1.20 },
//   month: { spentUsd: 8.10, projectedUsd: 864,   ratePerHourUsd: 1.20 },
// }

if (forecast.day.projectedUsd > 40) {
  console.warn(`On track to spend $${forecast.day.projectedUsd.toFixed(2)} today`)
}
```

`projectedUsd` = current hourly rate × hours in the period. Responds quickly to usage spikes because it's based on the **last 60 minutes** of spend.

## Budget caps

```typescript
const limiter = createRateLimiter({
  cost: {
    budget: { hourly: 5, daily: 50, monthly: 500 },
    onExceeded: 'throw', // 'throw' | 'queue' | 'fallback'
  },
})
```

When any cap is hit, `onExceeded` determines what happens to the request:

- **`throw`** — Throws `BudgetExceededError` immediately
- **`queue`** — Holds the request until the rolling window clears enough headroom
- **`fallback`** — Transparently retries with a cheaper model (see below)

## Budget fallback

```typescript
const limiter = createRateLimiter({
  cost: {
    budget: { daily: 50 },
    onExceeded: 'fallback',
  },
})

// Configure fallback on the model, not on the limiter
const model = limiter.wrap(openai('gpt-4o'), {
  fallback: openai('gpt-4o-mini'),
})
```

When `gpt-4o`'s daily budget is hit, requests transparently retry with `gpt-4o-mini`. A `budgetHit` event fires with `usingFallback: true`.

**Fallback chains** — pass an array to try multiple fallbacks in order:

```typescript
const model = limiter.wrap(openai('gpt-4o'), {
  fallback: [openai('gpt-4o-mini'), openai('gpt-3.5-turbo')],
})
```

## Persistent cost tracking

By default, cost history lives in-memory and is lost on restart. Add a persistent store so budget caps survive restarts:

```typescript
import { RedisCostStore } from 'ai-sdk-rate-limiter/redis'
import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL)

const limiter = createRateLimiter({
  cost: {
    budget: { daily: 50 },
    store: new RedisCostStore(redis),
  },
})

// Call once at startup to pre-load history
await limiter.warmUp()
```

`warmUp()` loads up to 30 days of historical entries so budget caps are accurate from the first request.
