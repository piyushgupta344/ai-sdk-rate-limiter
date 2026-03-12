# Multi-tenant scopes

Scopes give each user, org, or tenant their own isolated rate limit window — independent of all others.

## Static scope on the model

```typescript
const userModel = limiter.wrap(openai('gpt-4o'), {
  scope: `user:${userId}`,
})
```

All requests through this model share the `user:${userId}` window.

## Per-request scope

```typescript
await generateText({
  model,
  prompt: req.body.message,
  providerOptions: {
    rateLimiter: { scope: `user:${req.user.id}` },
  },
})
```

Per-request scope overrides any static scope set on `limiter.wrap()`.

## Scope limit patterns

Define different limits for different scope patterns using wildcards:

```typescript
const limiter = createRateLimiter({
  scopes: {
    'user:free:*':  { rpm: 5,   itpm: 10_000 },
    'user:pro:*':   { rpm: 60,  itpm: 200_000 },
    'org:*':        { rpm: 300, maxConcurrent: 20 },
  },
})
```

The `*` wildcard matches any suffix. When a request has scope `user:free:123`, the first matching pattern wins.

## Cost attribution by scope

When requests carry a scope, `getCostReport().byScope` is populated:

```typescript
const report = limiter.getCostReport()
console.log(report.byScope)
// {
//   'user:free:alice': { requests: 8,  costUsd: 0.04 },
//   'user:pro:bob':    { requests: 45, costUsd: 0.38 },
//   'org:acme':        { requests: 120, costUsd: 1.12 },
// }
```

## Express example

```typescript
const limiter = createRateLimiter({
  scopes: {
    'user:free:*': { rpm: 5 },
    'user:pro:*':  { rpm: 100 },
  },
})
const model = limiter.wrap(openai('gpt-4o'))

app.post('/chat', async (req, res) => {
  const scope = `user:${req.user.plan}:${req.user.id}`

  const { text } = await generateText({
    model,
    prompt: req.body.message,
    providerOptions: {
      rateLimiter: { scope },
    },
  })

  res.json({ text })
})
```
