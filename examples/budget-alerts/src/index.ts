/**
 * Budget monitoring with Slack / webhook alerts
 *
 * Demonstrates:
 * - Instant alert when any budget threshold is crossed (budgetHit event)
 * - Periodic spend summary pushed to Slack (or any webhook)
 * - Per-model and per-scope cost breakdown in the alert payload
 * - Tiered thresholds (warn at 50%, alert at 80%, hard-stop at 100%)
 *
 * Set environment variables:
 *   OPENAI_API_KEY      — your OpenAI key
 *   SLACK_WEBHOOK_URL   — Slack incoming webhook URL (optional, logs to console if absent)
 *   DAILY_BUDGET_USD    — daily budget cap in USD (default: 10)
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npm start
 */

import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { createRateLimiter, BudgetExceededError } from 'ai-sdk-rate-limiter'

const DAILY_BUDGET  = Number(process.env['DAILY_BUDGET_USD'] ?? 10)
const SLACK_WEBHOOK = process.env['SLACK_WEBHOOK_URL']

// ---------------------------------------------------------------------------
// Slack / webhook notification
// ---------------------------------------------------------------------------
async function notify(payload: {
  level:   'info' | 'warn' | 'error'
  title:   string
  message: string
  fields?: Record<string, string>
}): Promise<void> {
  const prefix = { info: 'ℹ️', warn: '⚠️', error: '🚨' }[payload.level]
  const text = [
    `${prefix} *${payload.title}*`,
    payload.message,
    ...(payload.fields
      ? Object.entries(payload.fields).map(([k, v]) => `• *${k}*: ${v}`)
      : []),
  ].join('\n')

  if (SLACK_WEBHOOK) {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } else {
    // No webhook configured — log to console instead
    console.log(`\n[alert] ${text.replace(/\*/g, '')}\n`)
  }
}

// ---------------------------------------------------------------------------
// Limiter — budget configured with soft-warn via events
// ---------------------------------------------------------------------------
const limiter = createRateLimiter({
  cost: {
    budget: { daily: DAILY_BUDGET },
    // 'throw' so we can catch it and handle gracefully
    onExceeded: 'throw',
  },

  on: {
    // Hard budget hit — the request was blocked
    budgetHit: ({ model, currentCostUsd, limitUsd, period }) => {
      void notify({
        level:   'error',
        title:   `Daily AI budget exceeded`,
        message: `Requests to ${model} are now blocked for the rest of the ${period}.`,
        fields: {
          'Spent'  : `$${currentCostUsd.toFixed(4)}`,
          'Limit'  : `$${limitUsd.toFixed(2)}`,
          'Period' : period,
          'Model'  : model,
        },
      })
    },

    // Log every completed request for a running total
    completed: ({ model, inputTokens, outputTokens, costUsd }) => {
      const report = limiter.getCostReport()
      const pct = (report.day.costUsd / DAILY_BUDGET) * 100

      // Soft warning at 80% of daily budget
      if (pct >= 80 && pct < 100) {
        void notify({
          level:   'warn',
          title:   `AI spend at ${pct.toFixed(0)}% of daily budget`,
          message: `$${report.day.costUsd.toFixed(4)} of $${DAILY_BUDGET} spent today.`,
          fields: {
            'Last request' : `${model} — ${inputTokens}+${outputTokens} tokens ($${costUsd.toFixed(6)})`,
          },
        })
      }
    },
  },
})

const model = limiter.wrap(openai('gpt-4o-mini'))

// ---------------------------------------------------------------------------
// Periodic spend summary (every 60 seconds in production; 10s here for demo)
// ---------------------------------------------------------------------------
const SUMMARY_INTERVAL_MS = 10_000

function scheduleSpendSummary(): NodeJS.Timeout {
  return setInterval(() => {
    const report = limiter.getCostReport()
    const pct = (report.day.costUsd / DAILY_BUDGET) * 100

    void notify({
      level:   'info',
      title:   `AI spend summary`,
      message: `Daily: $${report.day.costUsd.toFixed(4)} / $${DAILY_BUDGET} (${pct.toFixed(1)}%)`,
      fields: {
        'Hour requests' : String(report.hour.requests),
        'Day requests'  : String(report.day.requests),
        'Hour spend'    : `$${report.hour.costUsd.toFixed(4)}`,
        'Day spend'     : `$${report.day.costUsd.toFixed(4)}`,
        'Top model'     : topModel(report.byModel),
      },
    })
  }, SUMMARY_INTERVAL_MS)
}

function topModel(byModel: Record<string, { costUsd: number }>): string {
  const entries = Object.entries(byModel).sort(([, a], [, b]) => b.costUsd - a.costUsd)
  if (entries.length === 0) return 'none'
  const [name, stats] = entries[0]!
  return `${name} ($${stats.costUsd.toFixed(4)})`
}

// ---------------------------------------------------------------------------
// Demo — simulate requests from multiple users
// ---------------------------------------------------------------------------
async function simulateTraffic(): Promise<void> {
  const users = ['alice', 'bob', 'carol', 'dave']
  const prompts = [
    'What is the capital of France?',
    'Summarize the theory of relativity in one sentence.',
    'What are three tips for writing clean code?',
    'Explain what a REST API is in simple terms.',
  ]

  console.log(`Budget alerts demo — $${DAILY_BUDGET} daily limit`)
  console.log(SLACK_WEBHOOK
    ? `Alerts → Slack webhook`
    : `Alerts → console (set SLACK_WEBHOOK_URL to send to Slack)`)
  console.log()

  const timer = scheduleSpendSummary()

  // Run 8 requests spread across users
  for (let i = 0; i < 8; i++) {
    const user   = users[i % users.length]!
    const prompt = prompts[i % prompts.length]!

    try {
      const { text, usage } = await generateText({
        model,
        prompt,
        providerOptions: {
          rateLimiter: { scope: `user:${user}` },
        },
      })

      const report = limiter.getCostReport()
      console.log(`[${user}] "${prompt.slice(0, 40)}..." → ${usage?.totalTokens ?? 0} tokens`)
      console.log(`  Day spend: $${report.day.costUsd.toFixed(6)} / $${DAILY_BUDGET}`)
      console.log(`  Response: ${text.slice(0, 80)}...`)
      console.log()
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.error(`[${user}] Budget exceeded — $${err.currentCostUsd.toFixed(4)} of $${err.limitUsd}`)
      } else {
        throw err
      }
    }

    // Small delay between requests to make the output readable
    await new Promise(r => setTimeout(r, 500))
  }

  clearInterval(timer)

  // Final report
  const report = limiter.getCostReport()
  console.log('\n--- Final spend report ---')
  console.log(`Total requests : ${report.day.requests}`)
  console.log(`Total spend    : $${report.day.costUsd.toFixed(6)}`)
  console.log('\nBy model:')
  for (const [name, stats] of Object.entries(report.byModel)) {
    console.log(`  ${name}: ${stats.requests} requests, $${stats.costUsd.toFixed(6)}`)
  }
  console.log('\nBy user (scope):')
  for (const [scope, stats] of Object.entries(report.byScope)) {
    console.log(`  ${scope}: ${stats.requests} requests, $${stats.costUsd.toFixed(6)}`)
  }
}

simulateTraffic().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
