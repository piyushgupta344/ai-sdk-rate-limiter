# ai-sdk-rate-limiter

Smart rate limiting, queuing, and cost tracking for AI API calls. Works across providers. Zero required dependencies.

```
npm install ai-sdk-rate-limiter
```

---

## The problem

Every developer building with LLMs hits this eventually:

- `429 Too Many Requests` crashes a production request mid-flight
- You retry immediately and burn through your remaining quota
- Rate limits differ per model, per tier, per provider — none documented uniformly
- Your Node.js server runs 4 instances. They race against the same API quota
- A bulk job spends $300 overnight and nobody notices until the bill arrives
- You have no idea which model is responsible for the cost spike
- In a multi-tenant app, one user's burst shouldn't block everyone else

Every existing tool solves one of these. This solves all of them.

---

## Quick start

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { openai } from '@ai-sdk/openai'
import { generateText, streamText } from 'ai'

const limiter = createRateLimiter()

// Wrap any Vercel AI SDK model — that's it
const model = limiter.wrap(openai('gpt-4o'))

const { text } = await generateText({ model, prompt: 'Hello!' })
```

The wrapped model is a drop-in replacement. Every Vercel AI SDK feature — streaming, tool calls, structured output — works exactly as before.

---

## What it does

**Rate limiting** — Tracks requests and tokens in a 60-second sliding window per model. When a limit is reached, requests queue automatically rather than crashing.

**Priority queuing** — Queued requests drain in priority order (`high` before `normal` before `low`), FIFO within the same priority. Your user-facing requests skip ahead of background jobs.

**Concurrency limits** — Optional `maxConcurrent` cap per model enforced as a semaphore. Requests queue behind in-flight ones, then release slots as they complete.

**Smart retry** — Retries on 429, 500, 502, 503, 504 with exponential backoff + jitter. Honors the `Retry-After` header exactly — if the API says wait 3 seconds, waits 3 seconds, not 30.

**Cost tracking** — Records actual token usage from every response. Reports hourly, daily, and monthly spend per model. Optionally enforces budget caps.

**Multi-tenant scoped limits** — Give each user or org its own isolated rate limit window without running separate limiter instances. Wildcard patterns match user tiers.

**AbortSignal propagation** — Cancelling a request (e.g. user navigates away) immediately removes it from the queue. No wasted API calls for abandoned requests.

**Built-in model registry** — Knows the RPM, ITPM, and per-token pricing for every major OpenAI, Anthropic, Google, Groq, Mistral, and Cohere model out of the box. Nothing to configure to get started.

**Raw SDK support** — Works with the native OpenAI, Anthropic, Groq, Mistral, and Cohere SDKs directly via a transparent JavaScript Proxy. No Vercel AI SDK required.

**OpenTelemetry** — Drop-in OTel plugin that emits GenAI-spec spans for every request. Works with any OTel-compatible tracer.

**Testing utilities** — `createTestLimiter()` records every completed call so you can assert on model usage, token counts, and costs in unit tests.

**CLI audit** — `npx ai-sdk-rate-limiter audit` probes your API keys to detect your actual tier limits and generates a ready-to-paste config override.

---

## Contents

- [Vercel AI SDK usage](#vercel-ai-sdk-usage)
- [Raw SDK proxy](#raw-sdk-proxy)
- [Configuration reference](#configuration-reference)
- [Per-request options](#per-request-options)
- [Multi-tenant scoped limits](#multi-tenant-scoped-limits)
- [Concurrency limits](#concurrency-limits)
- [AbortSignal support](#abortsignal-support)
- [Cost tracking](#cost-tracking)
- [Budget fallback routing](#budget-fallback-routing)
- [Multi-instance Redis store](#multi-instance-redis-store)
- [Events](#events)
- [Backpressure](#backpressure)
- [Error handling](#error-handling)
- [OpenTelemetry](#opentelemetry)
- [Testing utilities](#testing-utilities)
- [CLI audit](#cli-audit)
- [Model registry](#model-registry)
- [Advanced usage](#advanced-usage)
- [How it works](#how-it-works)
- [Comparison](#comparison)
- [TypeScript](#typescript)
- [Requirements](#requirements)

---

## Vercel AI SDK usage

### Basic wrap

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { openai } from '@ai-sdk/openai'
import { generateText, streamText } from 'ai'

const limiter = createRateLimiter()
const model = limiter.wrap(openai('gpt-4o'))

// generateText
const { text } = await generateText({ model, prompt: 'Summarize this...' })

// streamText — streaming is first-class, rate limit slot consumed at request start
const result = streamText({ model, messages })
for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}
```

### Using the raw middleware

If you use `wrapLanguageModel` directly or need to compose middleware:

```typescript
import { wrapLanguageModel } from 'ai'

// Single middleware
const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: limiter.middleware,
})

// Composed with other middleware
const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: [loggingMiddleware, limiter.middleware, cachingMiddleware],
})
```

---

## Raw SDK proxy

If you're using the OpenAI, Anthropic, Groq, Mistral, or Cohere SDK directly — without the Vercel AI SDK — use `limiter.rawProxy()` to add rate limiting as a transparent drop-in:

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

const limiter = createRateLimiter({
  cost: { budget: { daily: 50 }, onExceeded: 'throw' },
  on: { rateLimited: ({ model }) => console.warn(`${model} rate limited`) },
})

// Every API call goes through the same rate limiter and cost tracker
const openai    = limiter.rawProxy(new OpenAI())
const anthropic = limiter.rawProxy(new Anthropic())

// Use exactly as before — no other changes needed
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
})

const message = await anthropic.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
})

// Cost from both clients tracked together
const report = limiter.getCostReport()
```

**Streaming** — the proxy wraps the returned `AsyncIterable` to capture the final usage chunk automatically:

```typescript
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Stream this' }],
  stream: true,
  stream_options: { include_usage: true }, // OpenAI: include usage in final chunk
})

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
// After the loop, tokens are recorded in limiter.getCostReport()
```

**Standalone — no shared limiter needed:**

```typescript
import { rateLimited } from 'ai-sdk-rate-limiter'

const openai = rateLimited(new OpenAI(), {
  config: { cost: { budget: { daily: 20 } } },
})
```

**Override auto-detected provider** — useful for OpenAI-compatible endpoints:

```typescript
const client = limiter.rawProxy(new OpenAI({ baseURL: 'https://api.groq.com/openai/v1' }), {
  provider: 'groq', // use Groq's limits and pricing instead of OpenAI's
})
```

Provider is auto-detected from the client's constructor name (`OpenAI` → `openai`, `Anthropic` → `anthropic`, `Groq` → `groq`, etc.).

---

## Configuration reference

Everything has a sensible default. Override only what you need.

```typescript
const limiter = createRateLimiter({
  // Override or extend built-in model limits for your API tier
  limits: {
    'gpt-4o':          { rpm: 500, itpm: 30_000, maxConcurrent: 20 },
    'claude-opus-4-6': { rpm: 50,  itpm: 20_000 },
  },

  // Cost budgets and behavior when exceeded
  cost: {
    budget: {
      hourly:  5,     // USD — hard cap per hour
      daily:   50,    // USD — hard cap per day
      monthly: 500,   // USD — hard cap per month
    },
    onExceeded: 'throw', // 'throw' | 'queue' | 'fallback'
  },

  // Queue behavior
  queue: {
    maxSize: 500,     // max requests waiting; throws QueueFullError when full
    timeout: 30_000,  // ms before a queued request times out with QueueTimeoutError
    onFull: 'throw',  // or 'drop-low' — evict lowest-priority requests first
  },

  // Retry behavior
  retry: {
    maxAttempts:     4,              // total attempts including the first
    backoff:         'exponential',  // 'exponential' | 'linear' | 'fixed'
    baseDelay:       1_000,          // ms
    maxDelay:        60_000,         // ms cap
    jitter:          true,           // ±30% randomness (prevents thundering herd)
    parseRetryAfter: true,           // honor Retry-After header from 429 responses
    retryOn:         [429, 500, 502, 503, 504],
  },

  // Per-scope rate limit overrides for multi-tenant use cases
  scopes: {
    'user:free:*':  { rpm: 5,   itpm: 10_000 },
    'user:pro:*':   { rpm: 60,  itpm: 200_000 },
    'org:*':        { rpm: 300, maxConcurrent: 20 },
  },

  // Observability — see Events section for all available events
  on: {
    rateLimited: ({ model, source, resetAt }) =>
      console.warn(`${model} rate limited (${source}), resets ${new Date(resetAt).toISOString()}`),
    retrying:    ({ model, attempt, delayMs }) =>
      console.log(`${model} retry ${attempt} in ${delayMs}ms`),
    budgetHit:   ({ model, currentCostUsd, limitUsd, period }) =>
      alerts.send(`${model} hit $${limitUsd} ${period} budget`),
    completed:   ({ model, inputTokens, outputTokens, costUsd, latencyMs }) =>
      metrics.record({ model, inputTokens, outputTokens, costUsd, latencyMs }),
  },
})
```

---

## Per-request options

Pass options to individual requests via `providerOptions.rateLimiter`:

```typescript
import { generateText } from 'ai'

// High-priority — skips ahead of normal traffic in the queue
await generateText({
  model,
  prompt: 'Urgent user request...',
  providerOptions: {
    rateLimiter: {
      priority: 'high',   // 'high' | 'normal' | 'low'
      timeout:  10_000,   // override the default queue timeout for this request
    },
  },
})

// Background job — yields to user-facing traffic
await generateText({
  model,
  prompt: 'Nightly batch summary...',
  providerOptions: {
    rateLimiter: { priority: 'low' },
  },
})

// Per-request scope (overrides any static scope set in limiter.wrap())
await generateText({
  model,
  prompt: 'User message...',
  providerOptions: {
    rateLimiter: { scope: `user:${userId}` },
  },
})
```

This is the recommended way to colocate user requests and background jobs on the same model without background jobs starving users.

---

## Multi-tenant scoped limits

Scoped limits give each user, org, or tenant its own isolated rate limit window. A burst from one user doesn't consume quota for anyone else.

### Static scope on the model

```typescript
// Each user gets their own model with an isolated window
function getModelForUser(userId: string) {
  return limiter.wrap(openai('gpt-4o'), { scope: `user:${userId}` })
}

// user:alice has its own RPM/ITPM window independent of user:bob
const aliceModel = getModelForUser('alice')
const bobModel   = getModelForUser('bob')
```

### Per-request scope

```typescript
// Same wrapped model, different scope per call
await generateText({
  model,
  prompt: req.body.message,
  providerOptions: {
    rateLimiter: { scope: `user:${req.user.id}` },
  },
})
```

Per-request scope takes precedence over any static scope set in `limiter.wrap()`.

### Defining scope-level limits

Use `config.scopes` to define separate rate limits for each scope tier. Keys support `*` wildcards:

```typescript
const limiter = createRateLimiter({
  scopes: {
    'user:free:*':  { rpm: 5,   itpm: 10_000  },  // free tier: 5 rpm each
    'user:pro:*':   { rpm: 60,  itpm: 200_000 },  // pro tier: 60 rpm each
    'org:*':        { rpm: 300, maxConcurrent: 20 },
  },
})

// Each scope gets its own isolated window under the matched limits
await generateText({
  model,
  providerOptions: {
    rateLimiter: { scope: 'user:free:alice' }, // matches 'user:free:*' → 5 rpm
  },
})
```

**Scope fields:**

| Field | Description |
|---|---|
| `rpm` | Max requests per minute for this scope |
| `itpm` | Max input tokens per minute for this scope |
| `maxConcurrent` | Max concurrent in-flight requests for this scope |

When a scope matches, its limits replace the model's global limits for that request. Each scope gets a fully independent sliding window — `user:alice` and `user:bob` don't share quota.

If no `scopes` config is defined, the model's global limits apply to all scoped requests.

---

## Concurrency limits

Limit how many requests to a model can be in-flight simultaneously. Useful for:
- Preventing connection pool exhaustion
- Controlling cost burn rate during spikes
- Enforcing per-scope parallelism

```typescript
const limiter = createRateLimiter({
  limits: {
    'gpt-4o': {
      rpm: 500,
      maxConcurrent: 10, // at most 10 requests executing at once
    },
  },
})
```

Once `maxConcurrent` slots are occupied, new requests queue behind them. Each slot is released when its request completes (success or failure). Concurrency is checked after the rate limit slot is acquired — both limits apply independently.

Concurrency limits also work in scoped contexts:

```typescript
const limiter = createRateLimiter({
  scopes: {
    'org:*': { rpm: 300, maxConcurrent: 20 },
  },
})
```

---

## AbortSignal support

Pass an `AbortSignal` to cancel a request that's waiting in the queue. If the signal fires before the request starts executing, it's removed from the queue immediately and the promise rejects with an `AbortError`.

```typescript
const controller = new AbortController()

// User closes the browser tab — cancel pending AI requests
window.addEventListener('beforeunload', () => controller.abort())

const result = await generateText({
  model,
  prompt: 'Long running task...',
  abortSignal: controller.signal,
})
```

```typescript
// With timeout
const signal = AbortSignal.timeout(5_000)

try {
  const result = await generateText({ model, prompt, abortSignal: signal })
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('Request cancelled (timed out or aborted)')
  }
}
```

The signal threads through both the rate-limit queue and the concurrency queue. A request that's already executing is not affected — only queued requests can be aborted this way.

---

## Cost tracking

```typescript
// At any point — live snapshot
const report = limiter.getCostReport()

console.log(report)
// {
//   hour:  { requests: 42,   inputTokens: 84_000,  outputTokens: 21_000,  costUsd: 0.29 },
//   day:   { requests: 318,  inputTokens: 620_000, outputTokens: 155_000, costUsd: 2.11 },
//   month: { requests: 4821, inputTokens: 9_100_000, outputTokens: 2_200_000, costUsd: 34.80 },
//   byModel: {
//     'gpt-4o':      { requests: 120, inputTokens: 240_000, outputTokens: 60_000, costUsd: 1.20 },
//     'gpt-4o-mini': { requests: 198, inputTokens: 380_000, outputTokens: 95_000, costUsd: 0.91 },
//   }
// }
```

Costs are based on **actual token counts** from API responses — not estimates. The report uses rolling windows, so `hour` always means "the last 60 minutes."

---

## Budget fallback routing

When a budget limit is hit, you can transparently reroute to a cheaper model instead of throwing an error:

```typescript
const limiter = createRateLimiter({
  cost: {
    budget: { daily: 10 },
    onExceeded: 'fallback', // reroute to fallback instead of throwing
  },
  on: {
    budgetHit: ({ model, usingFallback }) =>
      console.warn(`${model} budget hit — ${usingFallback ? 'using fallback' : 'throwing'}`),
  },
})

const model = limiter.wrap(
  openai('gpt-4o'),                     // primary model
  { fallback: openai('gpt-4o-mini') },  // used when budget is exceeded
)

// Under budget → uses gpt-4o normally
// Over $10/day → silently switches to gpt-4o-mini, no code changes needed
const result = await generateText({ model, prompt })
```

**Behavior matrix:**

| `onExceeded` | `fallback` configured | Outcome |
|---|---|---|
| `'throw'` | any | Throws `BudgetExceededError` |
| `'fallback'` | yes | Transparently uses fallback model |
| `'fallback'` | no | Throws `BudgetExceededError` |
| `'queue'` | any | Queues until period resets |

Fallback usage is tracked under the fallback model's ID in `getCostReport()`.

---

## Multi-instance Redis store

By default, rate limit state is in-memory (per-process). For multi-instance deployments — multiple pods, serverless replicas, workers — each instance has its own counters. Install the Redis store to share state:

```
npm install ioredis
```

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { RedisStore } from 'ai-sdk-rate-limiter/redis'
import Redis from 'ioredis'

const limiter = createRateLimiter({
  store: new RedisStore(new Redis(process.env.REDIS_URL)),
  // ... rest of your config unchanged
})
```

That's the entire change. All APIs — `wrap()`, `rawProxy()`, events, cost reports — work identically. The Redis store enforces rate limits collectively so no two instances can jointly exceed the API limits.

**Options:**

```typescript
new RedisStore(redis, {
  keyPrefix: 'rl:myapp:', // namespace if multiple apps share one Redis instance
  windowMs:  60_000,      // window size in ms; match your provider's limit window
})
```

**How it works internally:**

Each request runs a Lua script atomically that: removes stale entries from a sorted set, counts requests and tokens in the current window, checks against RPM and ITPM limits, and either reserves the slot or returns when the next slot opens. The local queue (priority ordering, drain timer, timeout handling) stays in-memory per instance — only the window counters are shared via Redis.

**Compatible clients** — any client with `eval()`, `get()`, and `set()` works: `ioredis`, `node-redis`, Upstash Redis.

Use the default `InMemoryStore` for single-instance deployments — it's more accurate (true sliding window, no network round-trips) and zero-config. Only switch to `RedisStore` when you actually need cross-instance coordination.

---

## Events

All events are typed. Register handlers at creation time or dynamically:

```typescript
// At creation time
const limiter = createRateLimiter({
  on: { rateLimited: handler },
})

// Dynamically
limiter.on('queued', ({ model, queueDepth, estimatedWaitMs }) => {
  console.log(`${model} queued (depth: ${queueDepth}, ~${estimatedWaitMs}ms wait)`)
})

limiter.off('queued', handler)
```

| Event | When | Key fields |
|---|---|---|
| `queued` | Request enters the queue | `model`, `provider`, `priority`, `queueDepth`, `estimatedWaitMs` |
| `dequeued` | Request leaves the queue | `model`, `provider`, `waitedMs`, `priority` |
| `retrying` | A failed request is about to retry | `model`, `provider`, `attempt`, `maxAttempts`, `delayMs`, `error` |
| `rateLimited` | Limit hit (local or remote 429) | `model`, `provider`, `source`, `limitType`, `resetAt` |
| `budgetHit` | Cost budget exceeded | `model`, `provider`, `currentCostUsd`, `limitUsd`, `period`, `usingFallback` |
| `dropped` | Request rejected (queue full or timeout) | `model`, `provider`, `reason` |
| `completed` | Request finished successfully | `model`, `provider`, `inputTokens`, `outputTokens`, `costUsd`, `latencyMs`, `streaming` |

The `source` on `rateLimited` distinguishes between requests we blocked locally (`'local'`) vs. requests the API rejected with a 429 (`'remote'`). Local blocks are expected and free. Frequent remote blocks mean your configured limits are too high for your tier — run `npx ai-sdk-rate-limiter audit` to get accurate numbers.

---

## Backpressure

Check estimated wait time before committing to a request. Useful for showing loading states or shedding load gracefully:

```typescript
const waitMs = await limiter.estimatedWait('gpt-4o')

if (waitMs > 5_000) {
  return res.status(503).json({
    error: 'Model busy, try again shortly',
    retryAfterMs: waitMs,
  })
}

const result = await generateText({ model, prompt })
```

Returns `0` if the model would proceed immediately.

---

## Error handling

Every error is typed and carries structured context:

```typescript
import {
  RateLimitExceededError,
  QueueTimeoutError,
  QueueFullError,
  BudgetExceededError,
  RetryExhaustedError,
  RateLimiterError,
} from 'ai-sdk-rate-limiter'

try {
  const result = await generateText({ model, prompt })
} catch (error) {
  if (error instanceof QueueTimeoutError) {
    // Request waited in queue longer than queue.timeout
    console.error(`Timed out after ${error.waitedMs}ms (queue depth: ${error.queueDepth})`)
  } else if (error instanceof BudgetExceededError) {
    // Cost budget hit and onExceeded is 'throw' or no fallback configured
    console.error(`Budget exceeded: $${error.currentCostUsd} of $${error.limitUsd} ${error.period}`)
  } else if (error instanceof RetryExhaustedError) {
    // All retry attempts failed
    console.error(`All ${error.attempts} retries exhausted`, error.cause)
  } else if (error instanceof QueueFullError) {
    // Queue at capacity and onFull is 'throw'
    console.error(`Queue full at ${error.maxSize} requests for ${error.model}`)
  } else if (error instanceof RateLimitExceededError) {
    // Rate limit hit and the request could not be queued
    console.error(`${error.model} ${error.limitType} limit of ${error.limit} exceeded`)
  } else if (error.name === 'AbortError') {
    // Request was cancelled via AbortSignal before it started executing
    console.log('Request cancelled')
  }
}
```

All errors extend `RateLimiterError`, so a single `instanceof RateLimiterError` check separates rate-limiter failures from AI API errors.

**Error fields:**

| Error | Fields |
|---|---|
| `QueueTimeoutError` | `model`, `waitedMs`, `queueDepth` |
| `BudgetExceededError` | `model`, `currentCostUsd`, `limitUsd`, `period` |
| `RetryExhaustedError` | `model`, `attempts`, `cause` |
| `QueueFullError` | `model`, `maxSize` |
| `RateLimitExceededError` | `model`, `limitType`, `limit`, `resetAt` |

---

## OpenTelemetry

The `ai-sdk-rate-limiter/otel` entry point provides a plugin that emits OpenTelemetry spans for every AI request. No hard dependency on `@opentelemetry/api` — the plugin accepts any OTel-compatible tracer via structural typing.

```typescript
import { trace } from '@opentelemetry/api'
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { createOtelPlugin } from 'ai-sdk-rate-limiter/otel'

const limiter = createRateLimiter({
  on: createOtelPlugin(trace.getTracer('my-service')),
})
```

**Spans emitted:**

| Span name | When | Status |
|---|---|---|
| `gen_ai.request` | Every completed request | OK |
| `gen_ai.request` | Every dropped request | ERROR |
| `ai_rate_limiter.retry` | Each retry attempt | OK |
| `ai_rate_limiter.budget_hit` | Budget exceeded | ERROR |

**Attributes on `gen_ai.request` (completed):**

| Attribute | Value |
|---|---|
| `gen_ai.system` | Provider name (e.g. `openai`, `anthropic`) |
| `gen_ai.request.model` | Model ID |
| `gen_ai.usage.input_tokens` | Actual input tokens from API response |
| `gen_ai.usage.output_tokens` | Actual output tokens from API response |
| `ai_rate_limiter.cost_usd` | Cost in USD for this request |
| `ai_rate_limiter.latency_ms` | Total latency including queue wait |
| `ai_rate_limiter.streaming` | Whether the request used streaming |

Attribute names follow the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). The `gen_ai.request` span duration is reconstructed from `latencyMs` so it reflects the full wall-clock time of the request, including any queue wait.

**Custom tracer interface** — if you don't want to install `@opentelemetry/api`, implement the `OtelTracer` interface directly:

```typescript
import { createOtelPlugin, type OtelTracer } from 'ai-sdk-rate-limiter/otel'

const tracer: OtelTracer = {
  startSpan(name, options) {
    // return any object that implements OtelSpan
  },
}

const limiter = createRateLimiter({
  on: createOtelPlugin(tracer),
})
```

---

## Testing utilities

The `ai-sdk-rate-limiter/testing` entry point provides a test-friendly limiter that records every completed call. Use it to assert on model usage, token counts, and costs in unit tests without mocking internals.

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

`createTestLimiter()` accepts the same config as `createRateLimiter()`, so you can test budget enforcement, retry behavior, and other scenarios with real config:

```typescript
const limiter = createTestLimiter({
  cost: { budget: { daily: 0.01 }, onExceeded: 'throw' },
})

// Test that your code handles budget errors gracefully
```

**`CallRecord` fields:**

| Field | Type | Description |
|---|---|---|
| `modelId` | `string` | Model that was called |
| `provider` | `string` | Provider name |
| `inputTokens` | `number` | Input tokens from the API response |
| `outputTokens` | `number` | Output tokens from the API response |
| `costUsd` | `number` | Cost in USD for this call |
| `latencyMs` | `number` | Total latency in ms |
| `streaming` | `boolean` | Whether this was a streaming call |
| `timestamp` | `number` | Unix timestamp (ms) when the call completed |

**Methods:**

| Method | Description |
|---|---|
| `getCalls()` | Returns all completed calls in chronological order |
| `reset()` | Clears call history |

All other `RateLimiter` methods (`wrap`, `rawProxy`, `getCostReport`, `getStatus`, `on`, `off`) work identically.

---

## CLI audit

Probe your API keys to discover your actual rate limit tier and generate a ready-to-paste config override:

```
npx ai-sdk-rate-limiter audit
```

```
────────────────────────────────────────────────────────────────────────────────
  ai-sdk-rate-limiter audit
────────────────────────────────────────────────────────────────────────────────

  OPENAI  (OPENAI_API_KEY)
  Model                            RPM        TPM            Registry
  ──────────────────────────────────────────────────────────────────────────────
  gpt-4o                           10000      2,000,000      (registry: 500 RPM / 30,000 TPM)
  gpt-4o-mini                      10000      10,000,000 ≠   (registry: 500 RPM / 200,000 TPM)

────────────────────────────────────────────────────────────────────────────────
  1 model(s) differ from registry defaults.
  Paste the config below into createRateLimiter():

  const limiter = createRateLimiter({
    limits: {
      'gpt-4o-mini': { rpm: 10000, itpm: 10,000,000 },
    },
  })

────────────────────────────────────────────────────────────────────────────────
```

**How it works** — Makes a minimal (5-token) request per model and reads the `x-ratelimit-limit-*` headers that every provider returns on each response. These headers reflect your account's actual tier, not the published defaults.

**Options:**

```
npx ai-sdk-rate-limiter audit [options]

  --provider, -p <name>   Audit a single provider: openai, anthropic, groq, mistral, cohere
  --json                  Machine-readable JSON output
  --help, -h              Show help
  --version, -v           Print version

Environment variables required:
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  GROQ_API_KEY
  MISTRAL_API_KEY
  COHERE_API_KEY
```

**Examples:**

```bash
# Audit all configured providers
npx ai-sdk-rate-limiter audit

# Audit only OpenAI
npx ai-sdk-rate-limiter audit --provider openai

# Machine-readable output for CI / scripts
npx ai-sdk-rate-limiter audit --json | jq '.providers[0].models'
```

---

## Model registry

Limits and pricing are built-in for every major model across 6 providers. Defaults are conservative (free/Tier 1) — override with your actual plan limits via the `limits` config option or by running `audit`.

**OpenAI**

| Model | RPM | ITPM | Input $/M | Output $/M |
|---|---|---|---|---|
| gpt-4o | 500 | 30,000 | $2.50 | $10.00 |
| gpt-4o-mini | 500 | 200,000 | $0.15 | $0.60 |
| o1 | 500 | 30,000 | $15.00 | $60.00 |
| o3-mini / o4-mini | 500 | 200,000 | $1.10 | $4.40 |
| gpt-3.5-turbo | 3,500 | 90,000 | $0.50 | $1.50 |

**Anthropic**

| Model | RPM | ITPM | Input $/M | Output $/M |
|---|---|---|---|---|
| claude-opus-4-6 | 50 | 30,000 | $15.00 | $75.00 |
| claude-sonnet-4-6 | 50 | 30,000 | $3.00 | $15.00 |
| claude-haiku-4-5 | 50 | 50,000 | $0.80 | $4.00 |

**Google**

| Model | RPM | ITPM | Input $/M | Output $/M |
|---|---|---|---|---|
| gemini-2.0-flash | 15 | 1,000,000 | $0.10 | $0.40 |
| gemini-1.5-pro | 2 | 32,000 | $1.25 | $5.00 |
| gemini-1.5-flash | 15 | 1,000,000 | $0.075 | $0.30 |

**Groq** (free tier defaults — on-demand tier is 6,000 RPM / 200k TPM)

| Model | RPM | ITPM | Input $/M | Output $/M |
|---|---|---|---|---|
| llama-3.3-70b-versatile | 30 | 6,000 | $0.59 | $0.79 |
| llama-3.1-8b-instant | 30 | 20,000 | $0.05 | $0.08 |
| mixtral-8x7b-32768 | 30 | 5,000 | $0.24 | $0.24 |
| gemma2-9b-it | 30 | 15,000 | $0.20 | $0.20 |
| deepseek-r1-distill-llama-70b | 30 | 6,000 | $0.75 | $0.99 |

**Mistral**

| Model | RPM | ITPM | Input $/M | Output $/M |
|---|---|---|---|---|
| mistral-large-latest | 500 | 100,000 | $2.00 | $6.00 |
| mistral-small-latest | 500 | 100,000 | $0.10 | $0.30 |
| codestral-latest | 500 | 100,000 | $0.30 | $0.90 |
| open-mistral-nemo | 500 | 100,000 | $0.15 | $0.15 |
| pixtral-large-latest | 500 | 100,000 | $2.00 | $6.00 |

**Cohere** (trial tier defaults — production tier is 10,000+ RPM)

| Model | RPM | ITPM | Input $/M | Output $/M |
|---|---|---|---|---|
| command-r-plus | 20 | 100,000 | $2.50 | $10.00 |
| command-r | 20 | 100,000 | $0.15 | $0.60 |
| command | 20 | 100,000 | $0.50 | $1.50 |
| command-light | 20 | 100,000 | $0.15 | $0.60 |

Unknown models fall back to 60 RPM / 100k ITPM with no cost tracking. You can inspect or extend the registry:

```typescript
import {
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
  GROQ_MODELS,
  MISTRAL_MODELS,
  COHERE_MODELS,
  resolveModelLimits,
  isKnownModel,
} from 'ai-sdk-rate-limiter'

console.log(GROQ_MODELS['llama-3.3-70b-versatile'])
// { rpm: 30, itpm: 6000, rpd: 1000, inputPricePerMillion: 0.59, ... }

console.log(isKnownModel('llama-3.3-70b-versatile', 'groq')) // true
console.log(isKnownModel('my-fine-tune', 'openai'))           // false → fallback limits

// Resolve the effective limits for a model (registry defaults merged with user overrides)
const limits = resolveModelLimits('gpt-4o', 'openai', { 'gpt-4o': { rpm: 1000 } })
```

---

## Advanced usage

### Multiple limiters per tier

```typescript
const freeLimiter = createRateLimiter({
  limits: { 'gpt-4o-mini': { rpm: 5 } },
  cost:   { budget: { daily: 0.10 }, onExceeded: 'throw' },
  queue:  { timeout: 5_000 },
})

const paidLimiter = createRateLimiter({
  limits: { 'gpt-4o': { rpm: 100 } },
  cost:   { budget: { daily: 20 } },
  queue:  { timeout: 30_000 },
})

// Route per request based on user plan
const model = req.user.plan === 'paid'
  ? paidLimiter.wrap(openai('gpt-4o'))
  : freeLimiter.wrap(openai('gpt-4o-mini'))
```

### Per-user limits with a single limiter

For large numbers of users, scoped limits are more efficient than one limiter per user:

```typescript
const limiter = createRateLimiter({
  scopes: {
    'user:free:*': { rpm: 5,  itpm: 10_000 },
    'user:pro:*':  { rpm: 60, itpm: 200_000 },
  },
})

const model = limiter.wrap(openai('gpt-4o'))

// Each request is tracked in an isolated window per user
await generateText({
  model,
  prompt: req.body.message,
  providerOptions: {
    rateLimiter: { scope: `user:${req.user.plan}:${req.user.id}` },
  },
})
```

### Combine OTel tracing with event logging

```typescript
import { createOtelPlugin } from 'ai-sdk-rate-limiter/otel'

const limiter = createRateLimiter({
  on: {
    // OTel spans for every request
    ...createOtelPlugin(trace.getTracer('my-service')),
    // Plus any additional handlers
    budgetHit: ({ model, limitUsd, period }) =>
      alerts.send(`Budget alert: ${model} hit $${limitUsd} ${period} cap`),
  },
})
```

### Custom rate limit store

Implement `RateLimitStore` to use any backend (DynamoDB, Postgres, etc.):

```typescript
import type { RateLimitStore } from 'ai-sdk-rate-limiter'

class MyStore implements RateLimitStore {
  async checkAndReserve(key, tokens, limits) { /* ... */ }
  async applyBackoff(key, untilMs) { /* ... */ }
  async getBackoff(key) { /* ... */ }
}

const limiter = createRateLimiter({ store: new MyStore() })
```

---

## How it works

**Rate limiting** — Sliding window counter per model. Each model tracks a list of `{timestamp, tokens}` entries for the past 60 seconds. On every request, stale entries are evicted and the window is checked against RPM and ITPM limits simultaneously.

**Queue** — A sorted priority queue per model, ordered by `priority` then enqueue time (FIFO within same priority). A drain timer fires when the oldest window entry expires, processing as many waiters as possible before rescheduling.

**Concurrency** — A semaphore (`activeCount` + `concurrencyWaiters`) per model key, checked after the rate limit slot is acquired. `release()` decrements the count and unblocks the next waiter.

**Scoped limits** — Each scoped request uses a key in the form `scope:provider:modelId`. That key gets its own independent sliding window. Wildcard patterns in `config.scopes` are matched with `*` → `.*` regex expansion.

**AbortSignal** — The signal is registered as an event listener on both the rate-limit queue and the concurrency queue. If it fires, the request is spliced out of whichever queue it's in and the promise rejects with an `AbortError`.

**Retry-After propagation** — When a remote 429 arrives with a `Retry-After` header, the backoff is applied to the entire model key in the engine, not just the failing request. All requests queued behind it pause until the backoff clears. This prevents the common thundering-herd failure where you retry one request while 10 others immediately follow and all get 429s.

**Token estimation** — Before a request fires, tokens are estimated from the prompt text (~4 chars/token) and reserved in the window. After the response, actual usage from the API replaces the estimate. For streaming, actual counts come from the `finish` chunk (Vercel AI SDK) or the final usage chunk (raw proxy).

**Zero dependencies** — The Vercel AI SDK middleware interface is implemented structurally — `@ai-sdk/provider` types are used for type checking only and not required at runtime. No `ioredis`, no `bottleneck`, no tokenizer libraries in the core.

---

## Comparison

| | ai-sdk-rate-limiter | bottleneck | p-limit | SDK built-in retry | LangChain |
|---|:---:|:---:|:---:|:---:|:---:|
| Vercel AI SDK `.wrap()` | yes | no | no | — | no |
| Raw SDK proxy | yes | no | no | — | no |
| Model-aware limits | yes | no | no | no | partial |
| ITPM / token tracking | yes | no | no | no | no |
| Priority queue | yes | yes | no | no | no |
| Concurrency limits | yes | yes | yes | no | no |
| Cost tracking + budgets | yes | no | no | no | no |
| Multi-tenant scoped limits | yes | no | no | no | no |
| AbortSignal propagation | yes | no | no | no | no |
| Retry-After header | yes | no | no | partial | partial |
| Backoff propagation | yes | no | no | no | no |
| OpenTelemetry | yes | no | no | no | partial |
| Testing utilities | yes | no | no | no | no |
| CLI audit | yes | no | no | no | no |
| Zero runtime deps | yes | no | yes | — | no |
| Provider-agnostic | yes | yes | yes | no | no |

**bottleneck** — Excellent general-purpose rate limiting, but knows nothing about AI APIs. No model limits, no token counting, no cost tracking. You'd need to configure it per-model manually and rebuild the cost system yourself.

**p-limit** — Controls concurrency, not rate. Limits to N concurrent requests, not N requests per minute. A different problem.

**SDK built-in retry** — Retries on 429 with backoff. That's the floor, not the ceiling. No queuing, no priority, no cost tracking, no backoff propagation to other in-flight requests.

---

## TypeScript

Fully typed. All configuration options, events, errors, and report shapes have precise TypeScript definitions exported from the main entry point.

```typescript
import type {
  RateLimiterConfig,
  ModelLimits,
  ScopeConfig,
  CostReport,
  EventMap,
  QueuedEvent,
  Priority,
} from 'ai-sdk-rate-limiter'

import type { CallRecord } from 'ai-sdk-rate-limiter/testing'
```

---

## Examples

A full Next.js 15 App Router example is included at [`examples/nextjs/`](./examples/nextjs/). It demonstrates streaming chat with rate limiting, live cost display, and proper error handling for budget and rate limit errors.

---

## Requirements

- Node.js 18+ / Bun / Deno
- `ai` v4+ (Vercel AI SDK) — optional peer dep, only needed for `.wrap()`
- Zero required runtime dependencies

---

## License

MIT
