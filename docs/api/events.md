# Events

All events are typed. Subscribe with `limiter.on(event, handler)`.

## `queued`

Fired when a request enters the queue.

```typescript
limiter.on('queued', ({ model, provider, priority, queueDepth, estimatedWaitMs }) => {})
```

## `dequeued`

Fired when a request leaves the queue and is about to execute.

```typescript
limiter.on('dequeued', ({ model, provider, waitedMs, priority }) => {})
```

## `rateLimited`

Fired when a request is rate limited, either locally (queued) or remotely (429 from API).

```typescript
limiter.on('rateLimited', ({
  source,     // 'local' | 'remote'
  model,
  provider,
  limitType,  // 'rpm' | 'itpm' | 'otpm' | 'backoff'
  resetAt,    // timestamp (ms) when the limit resets
}) => {})
```

## `retrying`

Fired before each retry attempt.

```typescript
limiter.on('retrying', ({ model, provider, attempt, maxAttempts, delayMs, error }) => {})
```

## `completed`

Fired after a successful request.

```typescript
limiter.on('completed', ({
  model,
  provider,
  scope,          // set if request was scoped
  inputTokens,
  outputTokens,
  costUsd,
  latencyMs,
  streaming,
}) => {})
```

## `dropped`

Fired when a request is rejected without completing.

```typescript
limiter.on('dropped', ({
  model,
  provider,
  reason,       // 'queue-full' | 'queue-timeout' | 'circuit-open' | 'shutdown'
  waitedMs,     // ms in queue (queue-timeout only)
  queueDepth,
  scope,
  metadata,
}) => {})
```

## `budgetHit`

Fired when a budget cap is exceeded.

```typescript
limiter.on('budgetHit', ({
  model,
  provider,
  currentCostUsd,
  limitUsd,
  period,           // 'hourly' | 'daily' | 'monthly'
  usingFallback,    // true if transparently retried with fallback model
}) => {})
```

## `circuitOpen`

Fired when the circuit breaker opens.

```typescript
limiter.on('circuitOpen', ({ model, provider, failures, cooldownMs }) => {})
```

## `circuitClosed`

Fired when the circuit breaker closes (probe request succeeded).

```typescript
limiter.on('circuitClosed', ({ model, provider }) => {})
```

## `limitsDetected`

Fired when rate limit caps are auto-detected from API response headers.

```typescript
limiter.on('limitsDetected', ({ model, provider, detectedRpm, detectedItpm }) => {})
```
