# Errors

All errors extend `RateLimiterError` and have a stable `name` property for reliable `instanceof` checks.

```typescript
import {
  RateLimiterError,
  RateLimitExceededError,
  QueueTimeoutError,
  QueueFullError,
  BudgetExceededError,
  RetryExhaustedError,
  CircuitOpenError,
  ShutdownError,
} from 'ai-sdk-rate-limiter'
```

## Error types

### `RateLimitExceededError`

The rate limit was exceeded and no slot could be acquired. Includes the model and provider.

### `QueueTimeoutError`

The request spent too long waiting in the queue. The `waitedMs` property shows how long it waited.

```typescript
if (err instanceof QueueTimeoutError) {
  console.log(`Waited ${err.waitedMs}ms`)
}
```

### `QueueFullError`

The queue is at `maxSize` and `onFull: 'throw'` is set.

### `BudgetExceededError`

A budget cap was hit. Has `model`, `currentCostUsd`, `limitUsd`, and `period` properties.

```typescript
if (err instanceof BudgetExceededError) {
  console.log(`${err.period} budget of $${err.limitUsd} exceeded`)
}
```

### `RetryExhaustedError`

All retry attempts failed. The original error is in `cause`.

```typescript
if (err instanceof RetryExhaustedError) {
  console.log('Underlying error:', err.cause)
}
```

### `CircuitOpenError`

The circuit breaker is open. The `model` and `provider` are available.

### `ShutdownError`

The limiter was shut down while the request was queued.

## Error hierarchy

```
RateLimiterError
├── RateLimitExceededError
├── QueueTimeoutError
├── QueueFullError
├── BudgetExceededError
├── RetryExhaustedError
├── CircuitOpenError
└── ShutdownError
```

## Handling errors

```typescript
import {
  BudgetExceededError,
  QueueTimeoutError,
  CircuitOpenError,
  RateLimiterError,
} from 'ai-sdk-rate-limiter'

try {
  const { text } = await generateText({ model, prompt })
} catch (err) {
  if (err instanceof BudgetExceededError) {
    return res.status(402).json({ error: 'Daily budget exceeded' })
  }
  if (err instanceof QueueTimeoutError) {
    return res.status(503).json({ error: 'Service busy. Try again shortly.' })
  }
  if (err instanceof CircuitOpenError) {
    return res.status(503).json({ error: 'AI service temporarily unavailable.' })
  }
  if (err instanceof RateLimiterError) {
    return res.status(429).json({ error: err.message })
  }
  throw err
}
```
