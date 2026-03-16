---
layout: home

hero:
  name: "ai-sdk-rate-limiter"
  text: "Production-grade rate limiting for AI APIs"
  tagline: Smart queuing, cost tracking, and budget enforcement for Vercel AI SDK and raw OpenAI/Anthropic clients. Zero required dependencies.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/piyushgupta344/ai-sdk-rate-limiter

features:
  - icon: 🚦
    title: Zero-config start
    details: Works out of the box with built-in limits for OpenAI, Anthropic, Google, Groq, Mistral, and Cohere models. No setup required.

  - icon: 📊
    title: Cost tracking & forecasting
    details: Tracks spend per model, per scope, and per period. Set hard budget caps with throw, queue, or fallback behavior. Forecast end-of-day costs from current rate.

  - icon: ⚡
    title: Smart queuing
    details: Priority queue with high/normal/low lanes. Per-request timeouts. Exponential backoff with jitter. Honors Retry-After headers from APIs.

  - icon: 🔀
    title: Multi-tenant scopes
    details: Isolate rate limits per user, org, or tenant with wildcard patterns. Each scope gets its own independent sliding window.

  - icon: 🔌
    title: Redis for multi-instance
    details: Drop-in RedisStore to share rate limit state and cost history across multiple server instances. Survives restarts.

  - icon: 🧰
    title: Observability built in
    details: Structured events, Prometheus metrics, StatsD support, and OpenTelemetry spans. Debug mode logs every decision to the console.
---

## Installation

::: code-group

```bash [npm]
npm install ai-sdk-rate-limiter
```

```bash [pnpm]
pnpm add ai-sdk-rate-limiter
```

```bash [yarn]
yarn add ai-sdk-rate-limiter
```

```bash [JSR (Deno / Node)]
# Deno
deno add jsr:@piyushgupta344/ai-sdk-rate-limiter

# Node.js via npx
npx jsr add @piyushgupta344/ai-sdk-rate-limiter
```

:::

## Quickstart

```typescript
import { createRateLimiter } from 'ai-sdk-rate-limiter'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

const limiter = createRateLimiter()
const model = limiter.wrap(openai('gpt-4o'))

const { text } = await generateText({ model, prompt: 'Hello!' })
```

That's it. The limiter automatically applies the built-in rate limits for `gpt-4o`, queues requests when the limit is reached, retries on 429s, and tracks cost.

→ [Full guide](/guide/getting-started)
