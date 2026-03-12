# Multi-tenant Express API

Shows how to rate-limit AI calls per-user in an Express API so one user's burst
can't starve everyone else. Free and Pro tiers get different limits — configured
once, enforced automatically on every request.

## What it demonstrates

- **Per-user isolation** — each user gets their own RPM window via `scope`
- **Tiered limits** — `user:free:*` → 5 RPM, `user:pro:*` → 60 RPM
- **Priority queuing** — Pro users skip ahead of Free users in the queue
- **Cost attribution** — `GET /cost/:userId` shows per-user spend
- **Circuit breaker + graceful shutdown** — production-safe error handling

## Run it

```bash
cd examples/multi-tenant-express
npm install
OPENAI_API_KEY=sk-... npm run dev
```

## Try it

```bash
# Free-tier user (5 RPM limit)
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: alice' \
  -H 'X-User-Plan: free' \
  -d '{"message": "What is 2+2?"}'

# Pro-tier user (60 RPM limit, skips queue)
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: bob' \
  -H 'X-User-Plan: pro' \
  -d '{"message": "Explain quantum entanglement"}'

# Global cost report
curl http://localhost:3000/cost

# Per-user cost
curl http://localhost:3000/cost/alice?plan=free

# Limiter status (queue depths, rate limit state)
curl http://localhost:3000/status
```

## Key pattern

```typescript
// In the route handler — scope drives per-user isolation
const scope = `user:${plan}:${userId}`   // e.g. 'user:pro:bob'

await generateText({
  model,
  providerOptions: {
    rateLimiter: {
      scope,
      priority: plan === 'free' ? 'low' : 'normal',
    },
  },
})
```

The scope string is matched against wildcard patterns in `createRateLimiter({ scopes: {...} })`.
Each matched scope gets its own independent sliding window — `user:free:alice` and
`user:free:bob` both get 5 RPM each, not 5 RPM shared.
