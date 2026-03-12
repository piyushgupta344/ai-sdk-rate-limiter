# Circuit breaker

The circuit breaker fast-fails requests when a model is consistently returning 5xx errors, rather than waiting for retries to exhaust.

## How it works

1. **Closed** — normal operation. Each 5xx increments a failure counter.
2. **Open** — after `failureThreshold` consecutive failures, the circuit opens. All requests immediately throw `CircuitOpenError` without hitting the API.
3. **Half-open** — after `cooldownMs`, one probe request is allowed through. If it succeeds, the circuit closes. If it fails, the cooldown resets.

429s do **not** trip the circuit — those are handled by the rate limiter and retry logic.

## Configuration

```typescript
const limiter = createRateLimiter({
  circuit: {
    failureThreshold: 5,     // consecutive 5xx before opening
    cooldownMs: 60_000,      // how long to stay open
    tripOn: [500, 502, 503, 504],
  },
})
```

## Events

```typescript
limiter.on('circuitOpen', ({ model, failures, cooldownMs }) => {
  console.error(`Circuit open for ${model} after ${failures} failures. Cooldown: ${cooldownMs}ms`)
  pagerduty.alert(model)
})

limiter.on('circuitClosed', ({ model }) => {
  console.log(`Circuit closed for ${model} — upstream recovered`)
})
```

## CircuitOpenError

```typescript
import { CircuitOpenError } from 'ai-sdk-rate-limiter'

try {
  await generateText({ model, prompt })
} catch (err) {
  if (err instanceof CircuitOpenError) {
    return { error: 'Service temporarily unavailable. Please try again shortly.' }
  }
}
```

## Testing

In tests, you can disable the circuit breaker to avoid flaky behavior:

```typescript
const limiter = createRateLimiter({
  // Don't set circuit — disabled by default
})
```
