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

**Smart retry** — Retries on 429, 500, 502, 503, 504 with exponential backoff + jitter. Honors the `Retry-After` header exactly — if the API says wait 3 seconds, waits 3 seconds, not 30.

**Cost tracking** — Records actual token usage from every response. Reports hourly, daily, and monthly spend per model. Optionally enforces budget caps.

**Built-in model registry** — Knows the RPM, ITPM, and per-token pricing for every major OpenAI, Anthropic, Google, Groq, Mistral, and Cohere model out of the box. Nothing to configure to get started.

**Raw SDK support** — Works with the native OpenAI, Anthropic, Groq, Mistral, and Cohere SDKs directly via a transparent JavaScript Proxy. No Vercel AI SDK required.

---

## Configuration

Everything has a sensible default. Override only what you need.

```typescript
const limiter = createRateLimiter({
  // Override or extend built-in model limits for your API tier
  limits: {
    'gpt-4o':          { rpm: 500, itpm: 30_000 },
    'claude-opus-4-6': { rpm: 50,  itpm: 30_000 },
    // Wildcard: apply to all models from a provider
    'openai/*':        { rpm: 1000 },
  },

  // Cost budgets and behavior when exceeded
  cost: {
    budget: {
      hourly:  5,     // USD
      daily:   50,
      monthly: 500,
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

  // Observability
  on: {
    rateLimited: ({ model, source, resetAt }) =>
      console.warn(`${model} rate limited (${source}), resets ${new Date(resetAt).toISOString()}`),
    retrying:    ({ model, attempt, delayMs }) =>
      console.log(`${model} retry ${attempt} in ${delayMs}ms`),
    budgetHit:   ({ model, currentCostUsd, limitUsd, period }) =>
      alerts.send(`${model} hit $${limitUsd} ${period} budget ($${currentCostUsd} spent)`),
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

// High-priority request — skips ahead of normal traffic in the queue
await generateText({
  model,
  prompt: 'Urgent user request...',
  providerOptions: {
    rateLimiter: {
      priority: 'high',    // 'high' | 'normal' | 'low'
      timeout:  10_000,    // override the default queue timeout for this request
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
```

This is the right way to colocate user requests and background jobs on the same model without background jobs starving users.

---

## Cost tracking

```typescript
// At any point — live snapshot
const report = limiter.getCostReport()

console.log(report)
// {
//   hour:  { requests: 42,   inputTokens: 84_000,  outputTokens: 21_000, costUsd: 0.29 },
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

When a budget limit is hit, you can transparently reroute to a cheaper model instead of throwing an error. Pass a `fallback` option to `wrap()`:

```typescript
const limiter = createRateLimiter({
  cost: {
    budget: { daily: 10 },
    onExceeded: 'fallback',  // reroute to fallback instead of throwing
  },
  on: {
    budgetHit: ({ model, currentCostUsd, limitUsd, period }) =>
      console.warn(`${model} ${period} budget hit ($${currentCostUsd} of $${limitUsd})`),
  },
})

const model = limiter.wrap(
  openai('gpt-4o'),                     // primary model
  { fallback: openai('gpt-4o-mini') },  // used when budget is exceeded
)

// Under budget  → uses gpt-4o normally
// Over $10/day  → silently switches to gpt-4o-mini, no code changes needed
const result = await generateText({ model, prompt })
```

**How it works:**
1. The budget is checked before every request against total rolling spend
2. When exceeded, `BudgetExceededError` is caught inside `wrap()` before it reaches your code
3. The request is re-executed against the fallback model, bypassing the budget pre-check
4. Fallback usage is tracked under the fallback model's ID in `getCostReport()`

**Behavior matrix:**

| `onExceeded` | `fallback` configured | Outcome |
|---|---|---|
| `'throw'` | any | Throws `BudgetExceededError` |
| `'fallback'` | yes | Transparently uses fallback model |
| `'fallback'` | no | Throws `BudgetExceededError` |
| `'queue'` | any | Queues until period resets |

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
const openai   = limiter.rawProxy(new OpenAI())
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

**Streaming works too** — the proxy wraps the returned `AsyncIterable` to capture the final usage chunk automatically:

```typescript
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Stream this' }],
  stream: true,
  stream_options: { include_usage: true },  // tells OpenAI to include usage in final chunk
})

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
// After the loop, usage is recorded in limiter.getCostReport()
```

**Zero-config standalone version** — if you don't need to share the limiter with other models:

```typescript
import { rateLimited } from 'ai-sdk-rate-limiter'

const openai = rateLimited(new OpenAI(), {
  config: { cost: { budget: { daily: 20 } } },
})
```

**Provider is auto-detected** from the client's constructor name (`OpenAI`, `Anthropic`, `Groq`, etc.). Override it explicitly if needed:

```typescript
const client = limiter.rawProxy(new OpenAI({ baseURL: 'https://api.groq.com/openai/v1' }), {
  provider: 'groq',  // use Groq's limits and pricing instead of OpenAI's
})
```

---

## Backpressure — know before you send

Check estimated wait time before committing to a request. Useful for showing loading states or shedding load gracefully.

```typescript
const waitMs = limiter.estimatedWait('gpt-4o')

if (waitMs > 5_000) {
  return res.status(503).json({ error: 'Model is busy, try again shortly', retryAfterMs: waitMs })
}

const result = await generateText({ model, prompt })
```

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
| `queued` | Request enters the queue | `model`, `priority`, `queueDepth`, `estimatedWaitMs` |
| `dequeued` | Request leaves the queue | `model`, `waitedMs`, `priority` |
| `retrying` | A failed request is about to retry | `model`, `attempt`, `maxAttempts`, `delayMs`, `error` |
| `rateLimited` | Limit hit (local or remote 429) | `model`, `source`, `limitType`, `resetAt` |
| `budgetHit` | Cost budget exceeded | `model`, `currentCostUsd`, `limitUsd`, `period`, `usingFallback` |
| `dropped` | Request rejected (queue full or timeout) | `model`, `reason` |
| `completed` | Request finished successfully | `model`, `inputTokens`, `outputTokens`, `costUsd`, `latencyMs` |

The `source` on `rateLimited` distinguishes between requests we blocked locally (`'local'`) vs. requests the API rejected with a 429 (`'remote'`). Local blocks are free; remote blocks mean your limits are misconfigured.

---

## Error handling

Every error is typed, structured, and tells you exactly what happened:

```typescript
import {
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
    // error.model, error.waitedMs, error.queueDepth
    console.error(`Timed out after ${error.waitedMs}ms (queue depth: ${error.queueDepth})`)
  } else if (error instanceof BudgetExceededError) {
    // error.model, error.currentCostUsd, error.limitUsd, error.period
    console.error(`Budget exceeded: $${error.currentCostUsd} of $${error.limitUsd} ${error.period}`)
  } else if (error instanceof RetryExhaustedError) {
    // error.model, error.attempts, error.cause
    console.error(`All ${error.attempts} retries exhausted`, error.cause)
  } else if (error instanceof QueueFullError) {
    // error.model, error.maxSize
    console.error(`Queue full at ${error.maxSize} requests`)
  }
}
```

All errors extend `RateLimiterError`, so a single `instanceof RateLimiterError` check separates rate-limiting failures from AI SDK errors.

---

## Advanced middleware usage

If you use `wrapLanguageModel` directly, the raw middleware is available:

```typescript
import { wrapLanguageModel } from 'ai'

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: limiter.middleware,
})
```

You can also compose it with other middleware:

```typescript
const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: [loggingMiddleware, limiter.middleware, cachingMiddleware],
})
```

---

## Multiple limiters

Run separate limiters for separate concerns — e.g., one per customer tier:

```typescript
const freeLimiter = createRateLimiter({
  limits:  { 'gpt-4o-mini': { rpm: 5 } },
  cost:    { budget: { daily: 0.10 }, onExceeded: 'throw' },
  queue:   { timeout: 5_000 },
})

const paidLimiter = createRateLimiter({
  limits:  { 'gpt-4o': { rpm: 100 } },
  cost:    { budget: { daily: 20 } },
  queue:   { timeout: 30_000 },
})

// Route to the right limiter per request
const model = req.user.plan === 'paid'
  ? paidLimiter.wrap(openai('gpt-4o'))
  : freeLimiter.wrap(openai('gpt-4o-mini'))
```

---

## Built-in model registry

Limits and pricing are built-in for every major model across 6 providers. Defaults are conservative (free/Tier 1) — override with your actual plan limits.

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

console.log(isKnownModel('llama-3.3-70b-versatile', 'groq'))
// true

console.log(isKnownModel('my-fine-tune', 'openai'))
// false → will use fallback limits
```

---

## How it works

**Rate limiting algorithm** — Sliding window counter. Each model tracks a list of `{timestamp, tokens}` entries for the past 60 seconds. On every request, stale entries are evicted and the window is checked against RPM and ITPM limits simultaneously.

**Queue** — A min-heap priority queue per model, sorted by `priority` then enqueue time (FIFO within same priority). A drain timer fires when the oldest window entry expires, processing as many waiters as possible before rescheduling.

**Retry-After propagation** — When a remote 429 arrives with a `Retry-After` header, the backoff is applied to the engine, not just the failing request. All requests queued behind it pause until the backoff clears. This prevents the common failure mode where you retry one request while 10 more immediately follow and all get 429s.

**Token estimation** — Before a request fires, tokens are estimated from the prompt text (~4 chars/token) and reserved in the window. After the response, actual usage from the API replaces the estimate. For streaming, actual counts come from the `finish` chunk.

**Zero dependencies** — The middleware interface is implemented structurally. `@ai-sdk/provider` types are referenced for type checking but not required at runtime. No `ioredis`, no `bottleneck`, no tokenizer libraries.

---

## Why not X?

| | ai-sdk-rate-limiter | bottleneck | p-limit | SDK built-in retry | LangChain |
|---|:---:|:---:|:---:|:---:|:---:|
| Vercel AI SDK `.wrap()` | yes | no | no | — | no |
| Raw SDK proxy | yes | no | no | — | no |
| Model-aware limits | yes | no | no | no | partial |
| ITPM / token tracking | yes | no | no | no | no |
| Priority queue | yes | yes | no | no | no |
| Cost tracking + budgets | yes | no | no | no | no |
| Retry-After header | yes | no | no | partial | partial |
| Backoff propagation | yes | no | no | no | no |
| Zero runtime deps | yes | no | yes | — | no |
| Provider-agnostic | yes | yes | yes | no | no |

**bottleneck** is excellent general-purpose rate limiting, but knows nothing about AI APIs — no model limits, no token counting, no cost tracking. You'd need to configure it per-model manually and rebuild the cost system yourself.

**p-limit** controls concurrency, not rate. It doesn't throttle to N requests per minute, it throttles to N concurrent requests. Useful but completely different problem.

**SDK built-in retry** retries on 429 with backoff. That's the floor, not the ceiling. It doesn't queue, doesn't prioritize, doesn't track cost, and doesn't propagate backoff to other in-flight requests.

---

## TypeScript

Fully typed. All configuration options, events, errors, and report shapes have precise TypeScript definitions.

```typescript
import type {
  RateLimiterConfig,
  CostReport,
  QueuedEvent,
  Priority,
} from 'ai-sdk-rate-limiter'

function handleQueuedRequest(event: QueuedEvent) {
  // event.model, event.priority, event.queueDepth, event.estimatedWaitMs
  // all typed, all autocompleted
}
```

---

## Requirements

- Node.js 18+ / Bun / Deno
- `ai` v4+ (Vercel AI SDK) — optional peer dep, only needed for `.wrap()`
- Zero required runtime dependencies

---

## License

MIT
