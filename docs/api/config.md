# RateLimiterConfig

Full TypeScript interface for `createRateLimiter()` config.

## Top-level fields

| Field | Type | Default | Description |
|---|---|---|---|
| `limits` | `Record<string, ModelLimitOverride>` | `{}` | Override built-in model limits |
| `cost` | `CostConfig` | — | Budget caps and cost store |
| `queue` | `QueueConfig` | — | Queue behavior |
| `retry` | `RetryConfig` | — | Retry behavior |
| `circuit` | `CircuitBreakerConfig` | — | Circuit breaker |
| `scopes` | `Record<string, ScopeConfig>` | `{}` | Per-scope rate limits |
| `store` | `RateLimitStore` | `InMemoryStore` | Rate limit window store |
| `on` | `EventHandlers` | — | Event handlers |
| `debug` | `boolean` | `false` | Debug console logging |

## ModelLimits

| Field | Type | Description |
|---|---|---|
| `rpm` | `number` | Max requests per minute |
| `itpm` | `number?` | Max input tokens per minute |
| `otpm` | `number?` | Max output tokens per minute |
| `rpd` | `number?` | Max requests per day |
| `maxConcurrent` | `number?` | Max in-flight requests |
| `inputPricePerMillion` | `number` | USD per million input tokens |
| `outputPricePerMillion` | `number` | USD per million output tokens |

## CostConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `budget` | `BudgetPeriod` | — | `{ hourly?, daily?, monthly? }` in USD |
| `onExceeded` | `'throw' \| 'queue' \| 'fallback'` | `'throw'` | Budget exceeded behavior |
| `store` | `CostStore` | — | Persistent cost store |

## QueueConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `maxSize` | `number` | `500` | Max queued requests |
| `timeout` | `number` | `30_000` | Queue wait timeout (ms) |
| `onFull` | `'throw' \| 'drop-low'` | `'throw'` | Behavior when queue is full |

## RetryConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `maxAttempts` | `number` | `4` | Max attempts including first |
| `backoff` | `'exponential' \| 'linear' \| 'fixed'` | `'exponential'` | Backoff strategy |
| `baseDelay` | `number` | `1_000` | Base delay (ms) |
| `maxDelay` | `number` | `60_000` | Max delay cap (ms) |
| `jitter` | `boolean` | `true` | Add random jitter |
| `parseRetryAfter` | `boolean` | `true` | Honor Retry-After headers |
| `retryOn` | `number[]` | `[429, 500, 502, 503, 504]` | Status codes to retry |
| `callTimeout` | `number?` | — | Per-call API timeout (ms) |

## CircuitBreakerConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `failureThreshold` | `number` | `5` | Consecutive failures before opening |
| `cooldownMs` | `number` | `60_000` | Time to stay open (ms) |
| `tripOn` | `number[]` | `[500, 502, 503, 504]` | Status codes that trip the circuit |

## ScopeConfig

| Field | Type | Description |
|---|---|---|
| `rpm` | `number?` | Max requests per minute for this scope |
| `itpm` | `number?` | Max input tokens per minute |
| `maxConcurrent` | `number?` | Max concurrent requests |
