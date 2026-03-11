# ai-sdk-rate-limiter — Next.js example

Streaming chat app built with Next.js 15 App Router demonstrating:

- Streaming responses via `streamText` + `limiter.wrap()`
- Shared singleton limiter across all API routes
- Live cost panel (polls `GET /api/cost` every 5 seconds)
- Typed error handling for `BudgetExceededError` and `RateLimitExceededError`
- Console event logging (rate limited, retrying, budget hit, completed)

---

## Setup

```bash
cd examples/nextjs
npm install
```

Create a `.env.local` file:

```
OPENAI_API_KEY=sk-...
```

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

---

## File structure

```
lib/
  limiter.ts          Singleton rate limiter — shared across all routes.
                      Configured with a $10/day budget cap and console event logging.

app/
  page.tsx            Streaming chat UI with live cost panel.
  api/
    chat/route.ts     POST — accepts messages, streams response via streamText.
                      Catches BudgetExceededError and RateLimitExceededError and
                      returns structured 429 responses.
    cost/route.ts     GET — returns limiter.getCostReport() as JSON.
```

---

## How the rate limiter is shared

The limiter instance lives in `lib/limiter.ts` as a module-level singleton. Next.js (Node.js) shares module state within a single process, so all concurrent API requests share the same rate limit counters, cost tracker, and event emitter.

For multi-instance deployments (multiple Vercel replicas, multiple pods), add a Redis store to share the rate limit window counters across instances:

```typescript
// lib/limiter.ts
import { RedisStore } from 'ai-sdk-rate-limiter/redis'
import Redis from 'ioredis'

export const limiter = createRateLimiter({
  store: new RedisStore(new Redis(process.env.REDIS_URL!)),
  // ... rest of config
})
```

---

## Priority queuing example

Mark user-facing requests as `high` priority and background jobs as `low` so background work never delays users:

```typescript
// app/api/chat/route.ts — user request
const result = streamText({
  model,
  messages,
  providerOptions: { rateLimiter: { priority: 'high' } },
})

// app/api/summarize/route.ts — background job
const result = await generateText({
  model,
  prompt: summarizePrompt,
  providerOptions: { rateLimiter: { priority: 'low' } },
})
```

---

## Adding OpenTelemetry

```typescript
// lib/limiter.ts
import { trace } from '@opentelemetry/api'
import { createOtelPlugin } from 'ai-sdk-rate-limiter/otel'

export const limiter = createRateLimiter({
  on: {
    ...createOtelPlugin(trace.getTracer('my-nextjs-app')),
  },
})
```

Every AI request will appear in your tracing dashboard as a `gen_ai.request` span with token counts, cost, and latency.
