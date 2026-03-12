# Getting started

## Installation

```bash
npm install ai-sdk-rate-limiter
```

### Optional peer dependencies

| Feature | Package |
|---|---|
| Redis multi-instance store | `ioredis` |
| OpenTelemetry tracing | `@opentelemetry/api` |
| Vercel AI SDK models | `@ai-sdk/openai` etc. |

## Basic usage

### Vercel AI SDK

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

const limiter = createRateLimiter()
const model = limiter.wrap(openai('gpt-4o'))

const { text } = await generateText({ model, prompt: 'Hello!' })
```

`limiter.wrap()` returns a model that behaves identically to the unwrapped one — just pass it anywhere you'd use a regular model.

### With options

```typescript
const limiter = createRateLimiter({
  limits: {
    'gpt-4o': { rpm: 500, itpm: 30_000 },
  },
  retry: { maxAttempts: 5 },
  cost: {
    budget: { daily: 50 },
    onExceeded: 'queue',
  },
  on: {
    rateLimited: ({ model, resetAt }) =>
      console.warn(`${model} rate limited until ${new Date(resetAt)}`),
  },
})
```

### Raw SDK clients

Use `limiter.rawProxy()` to rate-limit native OpenAI, Anthropic, Groq, or Mistral clients:

```typescript
import OpenAI from 'openai'

const limiter = createRateLimiter({ cost: { budget: { daily: 50 } } })
const openai = limiter.rawProxy(new OpenAI())

// Identical API — rate limiting happens transparently
await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
})
```

### Standalone proxy (no limiter instance needed)

```typescript
import { rateLimited } from 'ai-sdk-rate-limiter'
import Anthropic from '@anthropic-ai/sdk'

const client = rateLimited(new Anthropic())
await client.messages.create({ model: 'claude-opus-4-6', max_tokens: 1024, messages: [...] })
```

## Priority requests

Pass `priority` per-request to jump the queue:

```typescript
const { text } = await generateText({
  model,
  prompt: 'Urgent!',
  providerOptions: {
    rateLimiter: { priority: 'high' },
  },
})
```

Priorities: `'high'` | `'normal'` (default) | `'low'`

## Per-request timeout

Override the queue timeout for a specific request:

```typescript
providerOptions: {
  rateLimiter: { timeout: 5_000 }, // give up after 5 seconds in queue
}
```

## Request deduplication

When multiple concurrent requests share a `dedupKey`, only one API call is made:

```typescript
// 50 users asking the same FAQ → 1 API call
await generateText({
  model,
  prompt: faqText,
  providerOptions: {
    rateLimiter: { dedupKey: `faq:${questionId}` },
  },
})
```

## What happens by default

- **Rate limiting**: Built-in RPM/ITPM limits from the model registry
- **Retry**: Up to 4 attempts with exponential backoff + jitter. Honors `Retry-After` headers.
- **Queue**: Up to 500 waiting requests, 30-second timeout per request
- **Cost tracking**: Tracks actual token usage per model and period
- **No budget cap** (opt-in via `cost.budget`)
- **No circuit breaker** (opt-in via `circuit`)

→ [Full configuration reference](/guide/configuration)
