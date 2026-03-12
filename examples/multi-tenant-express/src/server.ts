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
import { createRateLimiterMiddleware } from 'ai-sdk-rate-limiter/middleware'
import { limiter } from './limiter.js'

const app = express()
app.use(express.json())

// Attach req.rateLimiter (scope + priority) to every request.
// That's all the route handlers need — no per-route error handling or scope logic.
const { middleware, errorHandler } = createRateLimiterMiddleware(limiter, {
  scope: (req) => {
    const userId = req.headers['x-user-id']
    const plan   = req.headers['x-user-plan'] ?? 'free'
    if (!userId) return undefined
    return `user:${plan}:${userId}`  // matched against 'user:free:*' / 'user:pro:*'
  },
  priority: (req) => req.headers['x-user-plan'] === 'pro' ? 'normal' : 'low',
  injectHeaders: 'gpt-4o-mini',  // X-RateLimit-* on every response
})

app.use(middleware)

// Wrap the model once — scope flows in automatically via providerOptions
const model = limiter.wrap(openai('gpt-4o-mini'))

// ---------------------------------------------------------------------------
// POST /chat
//
// Body:    { message: string }
// Headers: X-User-Id   — user identifier
//          X-User-Plan — 'free' | 'pro' | 'org' (default: 'free')
// ---------------------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message } = req.body as { message?: string }

  if (!req.headers['x-user-id']) {
    res.status(400).json({ error: 'X-User-Id header is required' })
    return
  }
  if (!message) {
    res.status(400).json({ error: 'message is required' })
    return
  }

  const { text, usage } = await generateText({
    model,
    prompt: message,
    // req.rateLimiter already has scope + priority — just pass it through
    providerOptions: { rateLimiter: req.rateLimiter },
  })

  res.json({ text, usage, scope: req.rateLimiter?.scope })
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

// Rate limiter error handler — MUST be after routes
// Converts QueueTimeoutError → 503, BudgetExceededError → 402, etc.
app.use(errorHandler)

const PORT = process.env['PORT'] ?? 3000
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`)
  console.log('[server] Endpoints:')
  console.log('  POST /chat           — AI chat (X-User-Id, X-User-Plan headers)')
  console.log('  GET  /cost           — Global cost report')
  console.log('  GET  /cost/:userId   — Per-user cost (?plan=free|pro)')
  console.log('  GET  /status         — Limiter status')
})
