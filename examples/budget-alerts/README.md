# Budget Alerts

Monitor AI spend in real time. Get a Slack alert the moment a budget threshold
is crossed — before the bill arrives. Works with any webhook (Slack, PagerDuty,
Discord, Teams, custom HTTP endpoint).

## What it demonstrates

- **Instant alerts on budget hit** — `budgetHit` event fires before the request is blocked
- **Soft warning at 80%** — warns before hitting the hard cap
- **Periodic spend summary** — push a spend digest to Slack every N minutes
- **Per-user cost breakdown** — `byScope` shows exactly who spent what
- **Per-model breakdown** — `byModel` shows which models are driving cost

## Run it

```bash
cd examples/budget-alerts
npm install

# Without Slack (logs to console)
OPENAI_API_KEY=sk-... npm start

# With Slack alerts
OPENAI_API_KEY=sk-... \
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
DAILY_BUDGET_USD=5 \
npm start
```

## Expected output

```
Budget alerts demo — $10 daily limit
Alerts → console (set SLACK_WEBHOOK_URL to send to Slack)

[alice] "What is the capital of France?..." → 42 tokens
  Day spend: $0.000008 / $10
  Response: The capital of France is Paris...

[bob] "Summarize the theory of relativity..." → 87 tokens
  Day spend: $0.000025 / $10
  ...

[alert] ℹ️ AI spend summary
  Daily: $0.0001 / $10 (0.0%)
  Hour requests: 8
  Top model: gpt-4o-mini ($0.0001)

--- Final spend report ---
Total requests : 8
Total spend    : $0.000148

By user (scope):
  user:alice: 2 requests, $0.000037
  user:bob:   2 requests, $0.000039
  ...
```

## Key patterns

### React to budget events in real time

```typescript
const limiter = createRateLimiter({
  cost: { budget: { daily: 10 }, onExceeded: 'throw' },
  on: {
    budgetHit: ({ model, currentCostUsd, limitUsd, period }) => {
      sendSlackAlert(`${model} hit $${limitUsd} ${period} budget`)
    },
  },
})
```

### Soft threshold warning (before the hard cap)

```typescript
on: {
  completed: () => {
    const report = limiter.getCostReport()
    const pct = (report.day.costUsd / DAILY_BUDGET) * 100
    if (pct >= 80) sendSlackAlert(`AI spend at ${pct.toFixed(0)}%`)
  },
},
```

### Per-user spend breakdown

```typescript
const report = limiter.getCostReport()
// { 'user:alice': { requests: 15, costUsd: 0.12 }, ... }
console.log(report.byScope)
```
