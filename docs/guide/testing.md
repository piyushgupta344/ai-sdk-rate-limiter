# Testing

`ai-sdk-rate-limiter/testing` provides a drop-in test limiter that records every completed call. Use it to assert on model usage, token counts, and costs without mocking internals.

## Basic usage

```typescript
import { createTestLimiter } from 'ai-sdk-rate-limiter/testing'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

const limiter = createTestLimiter()
const model = limiter.wrap(openai('gpt-4o'))

// Run your code under test
await generateText({ model, prompt: 'Hello!' })
await generateText({ model, prompt: 'Another request' })

// Assert on recorded calls
const calls = limiter.getCalls()
expect(calls).toHaveLength(2)
expect(calls[0].modelId).toBe('gpt-4o')
expect(calls[0].inputTokens).toBeGreaterThan(0)
expect(calls[0].costUsd).toBeGreaterThan(0)

// Reset between tests
limiter.reset()
```

## Testing with real config

`createTestLimiter()` accepts the same config as `createRateLimiter()`, so you can test budget enforcement, retry behavior, and circuit breaker logic:

```typescript
describe('budget enforcement', () => {
  it('throws when daily budget is exceeded', async () => {
    const limiter = createTestLimiter({
      cost: { budget: { daily: 0.001 }, onExceeded: 'throw' },
    })
    const model = limiter.wrap(openai('gpt-4o'))

    // Exhaust the budget with a big call
    await generateText({ model, prompt: 'big request' })

    // Next call should throw BudgetExceededError
    await expect(generateText({ model, prompt: 'another' }))
      .rejects.toThrow(BudgetExceededError)
  })
})
```

## Testing events

All `RateLimiter` methods work identically, including `on()`/`off()`:

```typescript
it('emits rateLimited event when queue fills', async () => {
  const limiter = createTestLimiter({
    limits: { 'gpt-4o': { rpm: 1 } },
  })

  const events: RateLimitedEvent[] = []
  limiter.on('rateLimited', e => events.push(e))

  // ... trigger rate limiting ...

  expect(events[0].source).toBe('local')
  expect(events[0].model).toBe('gpt-4o')
})
```

## `CallRecord` fields

| Field | Type | Description |
|---|---|---|
| `modelId` | `string` | Model that was called |
| `provider` | `string` | Provider name |
| `inputTokens` | `number` | Input tokens from API response |
| `outputTokens` | `number` | Output tokens from API response |
| `costUsd` | `number` | Cost in USD |
| `latencyMs` | `number` | Total latency in ms |
| `streaming` | `boolean` | Whether this was a streaming call |
| `timestamp` | `number` | Unix timestamp (ms) when completed |

## Vitest example (full test file)

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestLimiter } from 'ai-sdk-rate-limiter/testing'
import { BudgetExceededError } from 'ai-sdk-rate-limiter'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

describe('my AI service', () => {
  let limiter: ReturnType<typeof createTestLimiter>
  let model: ReturnType<typeof limiter.wrap>

  beforeEach(() => {
    limiter = createTestLimiter()
    model = limiter.wrap(openai('gpt-4o'))
  })

  it('records each call', async () => {
    await generateText({ model, prompt: 'Hello' })
    expect(limiter.getCalls()).toHaveLength(1)
    expect(limiter.getCalls()[0]?.modelId).toBe('gpt-4o')
  })

  it('reset() clears history', async () => {
    await generateText({ model, prompt: 'Hello' })
    limiter.reset()
    expect(limiter.getCalls()).toHaveLength(0)
  })
})
```
