# ai-sdk-rate-limiter — Product & Architecture Plan

## The Problem

Every developer building with LLMs hits the same wall:

- OpenAI returns `429 Too Many Requests` mid-production traffic
- Rate limits differ per model, per tier, per provider — none documented uniformly
- Naively retrying burns budget and quota simultaneously
- Cost spirals: no per-model, per-user, or per-day spending guards
- Multi-instance Node.js deployments race against the same quota
- Vercel AI SDK, raw OpenAI SDK, Anthropic SDK all need separate solutions

Existing tools patch one dimension. None cover all of them.

---

## Why Everything Else Falls Short

| Tool | Provider-agnostic | Model-aware limits | Cost tracking | Priority queue | Vercel AI SDK | Zero-config |
|---|---|---|---|---|---|---|
| `bottleneck` | Yes | No | No | No | No | No |
| `p-limit` / `p-throttle` | Yes | No | No | No | No | No |
| `openai-rate-limit` (npm) | No (OAI only) | No | No | No | No | No |
| LangChain rate limiting | No (LC only) | Partial | No | No | No | No |
| SDK built-in retry | No | No | No | No | — | Yes |
| **ai-sdk-rate-limiter** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

The gap is a single package that is: model-aware, cost-aware, queue-aware, provider-agnostic, and framework-compatible — with a one-line setup.

---

## Design Philosophy

1. **Zero-config start.** Works out of the box with built-in defaults for every major model. No required configuration.
2. **Progressive complexity.** Simple use-case = simple code. Advanced use-case = composable options. Nothing forced.
3. **No lock-in.** Wraps your existing client. Does not replace it. You keep full SDK access.
4. **Transparent.** Every decision (queued, retried, cost-exceeded, dropped) emits observable events.
5. **Minimal footprint.** Zero required runtime dependencies. Redis is optional and additive.

---

## Developer API — Surface Design

### 1. Vercel AI SDK middleware (primary path)

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { openai } from '@ai-sdk/openai'

const limiter = createRateLimiter()

// Wrap any Vercel AI SDK model — that's it
const model = limiter.wrap(openai('gpt-4o'))

const result = await generateText({ model, prompt: '...' })
```

### 2. Raw SDK proxy (OpenAI / Anthropic / Cohere / etc.)

```typescript
import { rateLimited } from 'ai-sdk-rate-limiter'
import OpenAI from 'openai'

const openai = rateLimited(new OpenAI())

// Identical to normal OpenAI SDK usage
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: '...' }],
})
```

### 3. Explicit middleware (fetch-level, provider-agnostic)

```typescript
import { RateLimiterMiddleware } from 'ai-sdk-rate-limiter'

const middleware = new RateLimiterMiddleware({
  provider: 'anthropic',
  model: 'claude-opus-4-6',
})

// Pass as fetch middleware to any HTTP client
```

### 4. Full configuration (power users)

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'

const limiter = createRateLimiter({
  // Override or extend built-in model limits
  limits: {
    'gpt-4o': {
      rpm: 500,         // requests per minute
      tpm: 30_000,      // tokens per minute
      rpd: 10_000,      // requests per day
      tpd: 1_000_000,   // tokens per day
    },
    'claude-opus-4-6': {
      rpm: 50,
      tpm: 20_000,
    },
  },

  cost: {
    // Hard budget caps
    budget: {
      hourly: 5,        // USD
      daily: 50,
      monthly: 500,
    },
    // What to do when budget is hit
    onExceeded: 'queue',  // 'queue' | 'throw' | 'fallback'
    fallbackModel: 'gpt-4o-mini',
  },

  queue: {
    maxSize: 500,           // max requests waiting in queue
    defaultTimeout: 30_000, // ms before a queued request fails
    // Assign priority based on request metadata
    priority: (req) => req.metadata?.priority ?? 'normal', // 'high' | 'normal' | 'low'
    onFull: 'drop-low',     // 'drop-low' | 'throw' | 'block'
  },

  retry: {
    maxAttempts: 4,
    backoff: 'exponential',  // 'exponential' | 'linear' | 'fixed'
    baseDelay: 1_000,        // ms
    maxDelay: 60_000,
    jitter: true,
    // Automatically parse Retry-After header from 429 responses
    parseRetryAfter: true,
    // Which HTTP status codes to retry
    retryOn: [429, 500, 502, 503, 504],
  },

  // Optional: shared state across Node.js instances
  store: redisStore({ url: process.env.REDIS_URL }),

  // Observability hooks
  on: {
    queued:      (req) => logger.info('queued', req),
    retrying:    (req, attempt) => logger.warn('retrying', { req, attempt }),
    rateLimited: (req, resetAt) => metrics.increment('rate_limited'),
    budgetHit:   (current, limit) => alerts.send('budget exceeded'),
    dropped:     (req) => logger.error('request dropped', req),
  },
})
```

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Public API Layer                    │
│    rateLimited()   createRateLimiter()   .wrap()         │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    Request Pipeline                      │
│                                                         │
│   Incoming Request                                       │
│        │                                                 │
│        ▼                                                 │
│   [1] Model Resolver        detect model from request    │
│        │                                                 │
│        ▼                                                 │
│   [2] Cost Pre-check        estimate tokens, check budget│
│        │                                                 │
│        ▼                                                 │
│   [3] Rate Limit Check      token bucket + sliding window│
│        │                                                 │
│        ├── PASS ──────────────────────────────────────┐  │
│        │                                              │  │
│        └── LIMIT HIT ──► [4] Queue Manager           │  │
│                               │                      │  │
│                               ▼                      │  │
│                          Priority Queue               │  │
│                          (min-heap by priority)       │  │
│                               │ (slot opens)          │  │
│                               └──────────────────────┘  │
│                                                         │
│        ▼ (request executes)                              │
│   [5] Executor              actual HTTP call             │
│        │                                                 │
│        ├── SUCCESS ──► [6] Cost Tracker  record actuals  │
│        │                                                 │
│        └── ERROR ───► [7] Retry Manager                  │
│                            │                             │
│                            ├── retryable ──► back to [3] │
│                            └── terminal ──► throw        │
└─────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    State Layer                           │
│                                                         │
│   In-Memory (default)    Redis (optional, multi-node)   │
│   - Token buckets        - Shared counters              │
│   - Sliding windows      - Distributed locks            │
│   - Cost accumulators    - Cross-instance queue sync    │
└─────────────────────────────────────────────────────────┘
```

---

## Component Deep Dives

### [1] Model Resolver

Inspects the outgoing request to extract the model name without any config from the user. Works across:
- Vercel AI SDK `model` parameter
- OpenAI SDK `model` field in body
- Anthropic SDK `model` field
- Raw fetch requests (parses body JSON)

Once the model is resolved, it looks up the limit profile from the built-in registry, then merges any user overrides.

**Built-in registry covers (day-one):**
- OpenAI: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo, o1, o3, o4-mini
- Anthropic: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
- Google: gemini-2.0-flash, gemini-1.5-pro
- Cohere: command-r-plus, command-r
- Mistral: mistral-large, mistral-small
- Groq: llama-3, mixtral (special high-RPM limits)

Registry is versioned and community-contributable via PRs.

### [2] Cost Pre-check

Before the request fires, estimate token cost using:
- Prompt text → tiktoken (for OpenAI) or approximation (200 chars ≈ 50 tokens)
- Known price-per-token from the model registry
- Compare against remaining daily/hourly/monthly budget

If over budget: queue the request (waits until next period resets), throw immediately, or reroute to the configured fallback model.

After the response returns, record actual token counts from the API response headers/body and reconcile.

### [3] Rate Limit Engine

Two algorithms, both running simultaneously:

**Token Bucket** (burst control)
- Each model gets a bucket of capacity `rpm`
- Tokens refill at `rpm / 60` per second
- Requests consume 1 token; if empty, they wait or queue

**Sliding Window** (sustained accuracy)
- Tracks request timestamps in a circular buffer
- Window = 60 seconds
- Count of requests in window must be < `rpm`
- Also tracks token counts in window for `tpm`

The stricter of the two governs whether a request passes.

For TPM limits, the token pre-estimate from [2] is used before dispatch, reconciled after.

### [4] Queue Manager

A min-heap priority queue with three priority lanes: `high`, `normal`, `low`.

- Requests block on a Promise that resolves when they reach the front of the queue and a rate limit slot opens
- Each queued request has a configurable timeout; expired requests reject with `QueueTimeoutError`
- Queue capacity is configurable; when full, behavior is `drop-low` (evict lowest-priority) or `throw`
- Queue drain is cooperative: the rate limit engine signals the queue manager when a slot opens

Backpressure signal: the limiter exposes `limiter.queueDepth()` and `limiter.estimatedWait(priority)` so callers can make informed decisions (show a loading state, reject early, etc.).

### [5] Executor

A thin wrapper around the original request. Does not transform the request in any way — it passes through unchanged. This ensures 100% compatibility with every SDK feature.

Supports streaming responses: the rate limit token is consumed at request-start, not response-complete. Streaming is transparent.

### [6] Cost Tracker

After each successful response:
- Read actual `prompt_tokens` + `completion_tokens` from response
- Multiply by per-token price from registry
- Accumulate into sliding cost windows (hourly, daily, monthly)
- Emit events for observability

Exposes `limiter.getCostReport()`:
```typescript
{
  hour:  { tokens: 12400, usd: 0.43 },
  day:   { tokens: 84200, usd: 2.91 },
  month: { tokens: 640000, usd: 22.10 },
  byModel: {
    'gpt-4o':      { tokens: 40000, usd: 1.20 },
    'gpt-4o-mini': { tokens: 600000, usd: 0.91 },
  }
}
```

### [7] Retry Manager

On error:
1. Check if the status code is in `retryOn` list
2. If `429` with a `Retry-After` header, wait exactly that duration (not exponential backoff — honor what the API says)
3. If `429` without `Retry-After`, use exponential backoff with jitter: `min(baseDelay * 2^attempt + random(0, 1000), maxDelay)`
4. If 5xx, use the same backoff
5. If `maxAttempts` exceeded, throw `RateLimitExhaustedError` with full context

Retry attempts do NOT re-enter the queue — they bypass and go straight to the executor when the wait period is over, to avoid priority inversion.

---

## State Stores

### In-Memory (default, single process)
- Zero dependencies
- Uses `Map` + `Float64Array` for token bucket state
- Suitable for: single-server deployments, serverless (per-instance), local dev

### Redis Store (optional, multi-process)
```typescript
import { redisStore } from 'ai-sdk-rate-limiter/redis'
const limiter = createRateLimiter({ store: redisStore({ url: '...' }) })
```
- Uses Redis sorted sets for sliding window
- Uses `INCR` + `EXPIRE` for counters
- Uses Lua scripts for atomic token bucket operations
- Suitable for: multi-instance Node.js, Kubernetes, high-traffic deployments

Store interface is public — custom stores (DynamoDB, Postgres, etc.) are trivially implementable.

---

## Package Structure

```
ai-sdk-rate-limiter/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── core/
│   │   ├── pipeline.ts           # Request pipeline orchestration
│   │   ├── model-resolver.ts     # Model name extraction logic
│   │   ├── rate-limit-engine.ts  # Token bucket + sliding window
│   │   ├── queue-manager.ts      # Priority queue implementation
│   │   ├── retry-manager.ts      # Backoff + Retry-After logic
│   │   └── cost-tracker.ts       # Token cost accumulation
│   ├── adapters/
│   │   ├── vercel-ai-sdk.ts      # .wrap() for Vercel AI SDK models
│   │   ├── openai.ts             # Proxy for OpenAI SDK client
│   │   ├── anthropic.ts          # Proxy for Anthropic SDK client
│   │   └── fetch.ts              # Generic fetch-level middleware
│   ├── registry/
│   │   ├── index.ts              # Model registry lookup
│   │   ├── openai.ts             # OpenAI model limits + pricing
│   │   ├── anthropic.ts          # Anthropic model limits + pricing
│   │   ├── google.ts             # Google model limits + pricing
│   │   └── ...
│   ├── stores/
│   │   ├── memory.ts             # Default in-memory store
│   │   └── interface.ts          # Store interface definition
│   └── errors.ts                 # Typed error classes
├── redis/
│   └── index.ts                  # Optional Redis store (separate entry point)
├── package.json
└── tsconfig.json
```

---

## Error Types

All errors extend a base `RateLimiterError` and carry structured context:

```typescript
RateLimiterError           // base
  ├── RateLimitExceededError   // hit limit, not retried (queue full / max attempts)
  │     .model, .limit, .resetAt, .queueDepth
  ├── BudgetExceededError      // cost budget hit
  │     .model, .currentCost, .budgetLimit, .period
  ├── QueueTimeoutError        // request sat in queue too long
  │     .model, .waitedMs, .queueDepth
  └── QueueFullError           // queue at capacity, request dropped
        .model, .queueSize, .dropped
```

No ambiguous generic errors. Every error tells you exactly what happened and what to do about it.

---

## Observability

Every key event is emittable via the `on` config:

| Event | Payload |
|---|---|
| `queued` | model, estimatedWaitMs, queueDepth |
| `dequeued` | model, waitedMs |
| `retrying` | model, attempt, delayMs, error |
| `rateLimited` | model, limitType (rpm/tpm/rpd), resetAt |
| `budgetHit` | model, currentCost, limit, period |
| `dropped` | model, reason |
| `completed` | model, tokens, costUsd, latencyMs |
| `costReport` | full cost snapshot (hourly/daily/monthly) |

Works with any logger, metrics system, or alerting tool. No opinions on how you record them.

---

## Streaming Support

Streaming responses are first-class:
- Rate limit slot consumed at request start
- Response tokens counted from stream chunks as they arrive (reads `usage` chunk at end of stream if present, otherwise estimates)
- Cost reconciled after stream closes
- Fully transparent — the stream object returned is the unmodified SDK stream

---

## Multi-tenant Support

For SaaS products limiting per-user or per-org:

```typescript
const limiter = createRateLimiter({ ... })

// Per-request scoping — any string key
const result = await generateText({
  model: limiter.wrap(openai('gpt-4o'), { scope: `user:${userId}` }),
  prompt: '...',
})

// Or apply limits per scope
const limiter = createRateLimiter({
  scopes: {
    'user:*': { rpm: 10, budget: { daily: 1 } },   // free tier
    'org:*':  { rpm: 100, budget: { daily: 20 } },  // paid tier
  }
})
```

Scoped limits are additive: a request counts against both the global model limit and the scope limit.

---

## Versioning & Registry Updates

The model registry (limits + pricing) is a versioned JSON file updated via semver patch releases when providers change their limits or pricing. Users can pin to a registry version or override any entry locally.

---

## Distribution

- **Package name:** `ai-sdk-rate-limiter`
- **TypeScript-first:** Ships as ESM + CJS dual package with full `.d.ts` types
- **Tree-shakeable:** Each adapter is a separate import path
- **Zero required deps:** Core has no runtime dependencies
- **Optional peer deps:** `@ai-sdk/core` for Vercel adapter, `ioredis` for Redis store
- **Node.js 18+, Bun, Deno compatible**

---

## Implementation Phases

### Phase 1 — Core (MVP)
- [ ] Token bucket + sliding window rate limit engine
- [ ] In-memory store
- [ ] Priority queue with timeout
- [ ] Exponential backoff retry with `Retry-After` parsing
- [ ] Model registry: OpenAI + Anthropic
- [ ] Vercel AI SDK adapter (`.wrap()`)
- [ ] Typed error classes
- [ ] Basic observability events

### Phase 2 — Cost & Multi-provider
- [ ] Cost pre-check and post-reconciliation
- [ ] Budget limits (hourly/daily/monthly)
- [ ] Fallback model routing
- [ ] Extend registry: Google, Cohere, Mistral, Groq
- [ ] Raw OpenAI SDK proxy (`rateLimited()`)
- [ ] `getCostReport()` API

### Phase 3 — Scale & Multi-tenant
- [ ] Redis store
- [ ] Multi-tenant scoped limits
- [ ] `limiter.estimatedWait()` backpressure API
- [ ] Anthropic SDK proxy
- [ ] Generic fetch middleware

### Phase 4 — Ecosystem
- [ ] Next.js example
- [ ] CLI tool: `npx ai-sdk-rate-limiter audit` — inspect current limits vs. your tier
- [ ] Dashboard-compatible: emit OpenTelemetry spans
- [ ] Community model registry contributions
