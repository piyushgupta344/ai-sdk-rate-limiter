/**
 * Multi-tenant Express API — per-user AI rate limiting
 *
 * Each user gets their own isolated rate limit window. One user's traffic
 * spike doesn't consume quota for other users. Free vs. Pro tiers get
 * different limits — configured once in limiter.ts, enforced automatically.
 *
 * Endpoints:
 *   POST /chat            — AI chat with per-user rate limiting
 *   GET  /cost            — Global cost report (admin)
 *   GET  /cost/:userId    — Per-user cost breakdown
 *   GET  /status          — Limiter queue and rate limit status
 */

import express from 'express'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'
import {
  BudgetExceededError,
  QueueTimeoutError,
  QueueFullError,
  CircuitOpenError,
  RateLimiterError,
} from 'ai-sdk-rate-limiter'
import { limiter } from './limiter.js'

const app = express()
app.use(express.json())

// Wrap the model once — the scope is injected per-request below.
const model = limiter.wrap(openai('gpt-4o-mini'))

// ---------------------------------------------------------------------------
// POST /chat
//
// Body:    { message: string }
// Headers: X-User-Id   — user identifier
//          X-User-Plan — 'free' | 'pro' | 'org' (default: 'free')
// ---------------------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const userId = req.headers['x-user-id'] as string | undefined
  const plan   = (req.headers['x-user-plan'] as string | undefined) ?? 'free'
  const { message } = req.body as { message?: string }

  if (!userId) {
    res.status(400).json({ error: 'X-User-Id header is required' })
    return
  }
  if (!message) {
    res.status(400).json({ error: 'message is required' })
    return
  }

  // Build the scope key — matched against 'user:free:*' / 'user:pro:*' in limiter config.
  // Each scope gets its own isolated RPM window.
  const scope = `user:${plan}:${userId}`

  try {
    const { text, usage } = await generateText({
      model,
      prompt: message,
      providerOptions: {
        rateLimiter: {
          scope,
          // Free-tier requests get lower priority so Pro users skip the queue
          priority: plan === 'free' ? 'low' : 'normal',
        },
      },
    })

    res.json({
      text,
      usage,
      scope,
    })
  } catch (err) {
    handleRateLimiterError(err, res)
  }
})

// ---------------------------------------------------------------------------
// GET /cost
// Global cost report — intended for internal dashboards / admin use
// ---------------------------------------------------------------------------
app.get('/cost', (_req, res) => {
  const report = limiter.getCostReport()
  res.json(report)
})

// ---------------------------------------------------------------------------
// GET /cost/:userId?plan=free
// Per-user cost for the rolling 30-day window, derived from byScope
// ---------------------------------------------------------------------------
app.get('/cost/:userId', (req, res) => {
  const { userId } = req.params
  const plan = (req.query['plan'] as string | undefined) ?? 'free'
  const scope = `user:${plan}:${userId}`

  const report = limiter.getCostReport()
  const userCost = report.byScope[scope]

  if (!userCost) {
    res.json({ scope, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })
    return
  }

  res.json({ scope, ...userCost })
})

// ---------------------------------------------------------------------------
// GET /status
// Queue depths and rate limit state per model — useful for dashboards
// ---------------------------------------------------------------------------
app.get('/status', (_req, res) => {
  res.json(limiter.getStatus())
})

// ---------------------------------------------------------------------------
// Graceful shutdown on SIGTERM (e.g. container orchestration)
// ---------------------------------------------------------------------------
process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received — draining in-flight requests...')
  await limiter.shutdown({ drainMs: 15_000 })
  console.log('[server] Drained. Exiting.')
  process.exit(0)
})

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
function handleRateLimiterError(err: unknown, res: express.Response): void {
  if (err instanceof QueueTimeoutError) {
    res.status(503).json({
      error: 'Request queued too long. Try again shortly.',
      retryAfterMs: 5_000,
    })
    return
  }
  if (err instanceof QueueFullError) {
    res.status(503).json({
      error: 'Server busy. Try again in a moment.',
    })
    return
  }
  if (err instanceof BudgetExceededError) {
    res.status(402).json({
      error: `Daily AI budget exceeded ($${err.limitUsd}). Resets tomorrow.`,
    })
    return
  }
  if (err instanceof CircuitOpenError) {
    const retryAfterSec = Math.ceil((err.openUntilMs - Date.now()) / 1000)
    res.status(503).json({
      error: 'AI provider temporarily unavailable.',
      retryAfter: retryAfterSec,
    })
    return
  }
  if (err instanceof RateLimiterError) {
    res.status(429).json({ error: err.message })
    return
  }

  console.error('[server] Unexpected error:', err)
  res.status(500).json({ error: 'Internal server error' })
}

const PORT = process.env['PORT'] ?? 3000
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`)
  console.log('[server] Endpoints:')
  console.log('  POST /chat           — AI chat (X-User-Id, X-User-Plan headers)')
  console.log('  GET  /cost           — Global cost report')
  console.log('  GET  /cost/:userId   — Per-user cost (?plan=free|pro)')
  console.log('  GET  /status         — Limiter status')
})
