# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **`limiter.reset()`** — clear all rate-limit, queue, cost, and circuit-breaker state without recreating the instance. Queued requests are rejected with `ShutdownError`. Primarily useful in tests to reset between cases with a shared limiter instance.
- **`queue.onFull: 'drop-low'`** fully implemented — when the queue is at capacity and a `high` or `normal` priority request arrives, the tail `low`-priority waiter is evicted (rejected with `QueueFullError`) to make room. Useful for mixed workloads where background batch jobs should never block user-facing requests.

### Changed
- Unknown models with zero pricing now emit a one-time `console.warn` on first use, pointing at the exact `config.limits` fix needed to enable cost tracking. Known registry models and models with user-supplied pricing are silent.

---

## [0.12.0] - 2026-03-12

### Added
- **`getCostForecast()`** — project end-of-period spend based on the current hourly rate. Returns `{ hour, day, month }` each with `spentUsd`, `projectedUsd`, and `ratePerHourUsd`. Useful for alerting before a budget cap is hit.
- **`createModelPool(models, options?)`** — round-robin (or random) load balancer across multiple wrapped model instances. Distributes calls evenly across API keys or model variants. Import from `ai-sdk-rate-limiter`.
- **Request deduplication** — pass `dedupKey` in `providerOptions.rateLimiter` to make concurrent identical requests share a single API call. All callers receive the same result; the dedup entry is cleared on completion so the next request always makes a fresh call.

---

## [0.11.0] - 2026-03-12

### Added
- **Debug mode** — set `debug: true` on `createRateLimiter()` to enable structured console logging for every rate-limit decision, queue entry/exit, slot acquisition, circuit breaker state change, and cost recording. Zero overhead when disabled.
- **Config validation** — `createRateLimiter()` now validates your config at construction time and emits `console.warn` for common misconfigurations:
  - `cost.store` set without calling `warmUp()` reminder
  - `circuit.failureThreshold < 3` (too sensitive, risks false trips)
  - `retry.retryOn` explicitly excludes 429 (defeats rate-limit retry)
  - `queue.timeout < 3000ms` (too short, requests will time out before serving)
  - `cost.budget` set without `onExceeded` (uses silent default `'throw'`)
  - `cost.onExceeded: 'fallback'` reminder to configure fallback model
- GitHub Actions CI workflow (Node 18 / 20 / 22 matrix)
- `CHANGELOG.md` with retroactive entries from v0.1.0

### Fixed
- `DebugLogger` details serialization: empty objects no longer emit trailing `()`

---

## [0.10.0] - 2026-03-12

### Added
- `ai-sdk-rate-limiter/middleware` entry point
  - `createRateLimiterMiddleware(limiter, opts)` — returns `{ middleware, errorHandler }` for Express
  - `createRateLimiterErrorHandler(opts)` — standalone 4-arg Express error handler
  - `createHonoMiddleware(limiter, opts)` — Hono middleware with `c.var.rateLimiter`
  - `mapErrorToResponse(err)` — utility for Fastify and custom frameworks
  - `RateLimiterRequestContext` type + `http.IncomingMessage` augmentation for `req.rateLimiter`
  - Automatic error → HTTP mapping: `QueueTimeoutError` → 503, `BudgetExceededError` → 402, etc.
  - `injectHeaders` option: adds `X-RateLimit-*` informational headers to responses

### Added (examples)
- `examples/multi-tenant-express/` — Express API with per-user scoped rate limits (free/pro tiers)
- `examples/batch-processing/` — Concurrent batch jobs with priority queuing + graceful shutdown
- `examples/budget-alerts/` — Slack/webhook budget alerts with per-scope spend breakdown

---

## [0.9.0] - 2026-03-12

### Added
- **Circuit breaker** — auto-opens on repeated 5xx failures, half-open probe, configurable thresholds
  - `CircuitBreakerConfig` in `RateLimiterConfig.circuit`
  - `CircuitOpenError` thrown when circuit is open
  - `circuitOpen` / `circuitClosed` events
- **Graceful shutdown** — `limiter.shutdown({ drainMs })`, `ShutdownError`
- **Persistent cost tracking** — `CostStore` interface + `RedisCostStore` in `ai-sdk-rate-limiter/redis`
  - `limiter.warmUp()` pre-loads historical spend on startup
- **Per-scope cost attribution** — `getCostReport().byScope` breakdown per user/org/tenant
- **Fallback chains** — `fallback` accepts `WrappableModel[]`, walked in order on `BudgetExceededError`
- **Call timeout** — `callTimeout` in retry config and per-request options (uses `Promise.race`)
- **Auto-detected limits** — parses `x-ratelimit-limit-*` response headers, user config wins
  - `limitsDetected` event
- **Prometheus metrics** — `createPrometheusPlugin()` in `ai-sdk-rate-limiter/prometheus`
- **StatsD / DogStatsD** — `createStatsDPlugin(client)` in `ai-sdk-rate-limiter/statsd`
- **Drop hooks** — `DroppedEvent` now includes `reason`, `waitedMs`, `queueDepth`, `scope`, `metadata`

---

## [0.8.0] - 2026-03-11

### Added
- Redis store for multi-instance rate limiting (`ai-sdk-rate-limiter/redis`)
  - `RedisStore` — Lua-script-based atomic sliding window shared across instances
  - Fail-open on Redis errors (enforcement suspended, never blocks requests)
  - Compatible with ioredis, node-redis, Upstash Redis
- `rpd` (requests per day) limit support — rolling 24-hour window
- `otpm` (output tokens per minute) limit support — based on completed request actuals

---

## [0.7.1] - 2026-03-10

### Fixed
- `Retry-After` header parsing: correctly handles duration strings like `"6m30s"` (previously parsed as 6s)

---

## [0.7.0] - 2026-03-10

### Added
- Raw SDK proxy — `limiter.rawProxy(client)` wraps native OpenAI/Anthropic/Groq/Mistral/Cohere clients
  - Transparent `Proxy`-based drop-in with no API changes
  - Streaming support via `AsyncIterable` wrapping for usage chunk capture
  - `rateLimited(client, opts)` standalone factory
- Budget fallback routing — `onExceeded: 'fallback'` transparently reroutes to a cheaper model
  - `limiter.wrap(model, { fallback: cheaperModel })`
  - `usingFallback` field on `budgetHit` event

---

## [0.6.0] - 2026-03-09

### Added
- OpenTelemetry plugin (`ai-sdk-rate-limiter/otel`)
  - `createOtelPlugin(tracer)` — emits GenAI-spec spans for every request
  - No hard dependency on `@opentelemetry/api` (structural typing)
  - Span duration reconstructed from `latencyMs` for accurate wall-clock timing
- Testing utilities (`ai-sdk-rate-limiter/testing`)
  - `createTestLimiter()` — records all completed calls for assertions
  - `limiter.getCalls()` / `limiter.reset()`

---

## [0.5.0] - 2026-03-08

### Added
- Concurrency limits — `maxConcurrent` per model, enforced as a semaphore
- Multi-tenant scoped limits — `config.scopes` with `*` wildcard patterns
  - Each scope gets its own independent sliding window
  - Per-request scope via `providerOptions.rateLimiter.scope`
- `queue.onFull: 'drop-low'` — evict lowest-priority requests before throwing `QueueFullError`
- `AbortSignal` propagation through both rate-limit and concurrency queues

---

## [0.4.0] - 2026-03-07

### Added
- Priority queue — `high` / `normal` / `low` priorities; FIFO within same priority
- Per-request options via `providerOptions.rateLimiter` (priority, timeout, scope)
- `limiter.estimatedWait(modelId)` — returns ms until next available slot
- `QueueFullError` when queue is at `maxSize` capacity

---

## [0.3.0] - 2026-03-06

### Added
- Cost tracking — records actual token usage per request
  - `getCostReport()` with hourly / daily / monthly rolling windows
  - `byModel` breakdown in cost report
- Budget caps — `cost.budget` with `hourly`, `daily`, `monthly` limits
  - `onExceeded: 'throw' | 'queue'` behavior
  - `BudgetExceededError` with period, current spend, and limit
- `nextBudgetClearMs()` used internally for queue-mode budget holds

---

## [0.2.0] - 2026-03-05

### Added
- Model registry expanded to include Groq, Mistral, and Cohere
  - `GROQ_MODELS`, `MISTRAL_MODELS`, `COHERE_MODELS`
  - `isKnownModel(modelId, provider)` utility

---

## [0.1.0] - 2026-03-04

### Added
- Initial release
- Sliding window rate limiting (RPM + ITPM) for OpenAI, Anthropic, Google Gemini models
- Priority queue with drain timer (`scheduleDrain` per model)
- Exponential backoff retry with jitter, `Retry-After` header support
- Vercel AI SDK `.wrap()` adapter via `LanguageModelV4Middleware`
- In-memory store (default, zero config)
- `createRateLimiter()` factory
- `limiter.getStatus()` — queue depths and window state per model
- Event system: `queued`, `dequeued`, `retrying`, `rateLimited`, `budgetHit`, `dropped`, `completed`
- `RateLimiterError` hierarchy: `RateLimitExceededError`, `QueueTimeoutError`, `RetryExhaustedError`
- Built-in model registry for OpenAI and Anthropic with pricing data
