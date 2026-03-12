# Batch Processing

Classify, embed, or summarize hundreds of items without ever writing retry logic
or hitting a 429. Fire all items concurrently — the limiter queues and drains
them at the maximum sustainable rate automatically.

## What it demonstrates

- **Fire-and-forget concurrency** — enqueue all items at once; limiter handles pacing
- **Low-priority batch jobs** — won't starve interactive requests on the same limiter
- **Graceful shutdown** — Ctrl+C completes in-flight work before exiting
- **Live cost tracking** — see spend accumulate in real time
- **Automatic retry** — transient 429s and 5xx errors are retried with backoff

## Run it

```bash
cd examples/batch-processing
npm install
OPENAI_API_KEY=sk-... npm start
```

## Expected output

```
Processing 30 items via gpt-4o-mini...
Press Ctrl+C to stop gracefully (in-flight requests will complete).

  [30/30] $0.0042 spent this hour

Done in 18.3s

Cost report:
  Requests : 30
  Tokens   : 12450 in / 3210 out
  Cost     : $0.0042 (hour) / $0.0042 (day)

Results  : 30 succeeded, 0 failed

Sample results:
  item-1: [positive] Customer loved the product quality.
  item-2: [negative] Terrible experience, not recommended.
  ...
```

## Key pattern

```typescript
// Enqueue everything at once — limiter queues and paces automatically
const results = await Promise.all(
  items.map(item => generateText({
    model,
    prompt: buildPrompt(item),
    providerOptions: {
      rateLimiter: { priority: 'low' }, // yields to interactive traffic
    },
  }))
)
```

No manual batching, no sleep loops, no rate limit math. The limiter tracks the
sliding window and releases requests as capacity becomes available.

## Graceful shutdown

```bash
^C
[shutdown] Stopping — waiting up to 30s for in-flight requests...
[shutdown] Done.
```

SIGINT triggers `limiter.shutdown({ drainMs: 30_000 })`. The 4 requests that
were mid-flight complete before the process exits. No partial results, no
orphaned API calls.
