/**
 * Batch AI processing with priority queuing and graceful shutdown
 *
 * Demonstrates:
 * - Processing hundreds of items without ever hitting a 429
 * - Mixing low-priority batch jobs with high-priority interactive requests
 * - Ctrl+C drains in-flight work cleanly before exiting
 * - Live cost tracking as the job progresses
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npm start
 */

import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { createRateLimiter, QueueTimeoutError } from 'ai-sdk-rate-limiter'

// ---------------------------------------------------------------------------
// Sample dataset — replace with your real data (CSV rows, DB records, etc.)
// ---------------------------------------------------------------------------
const ITEMS: Array<{ id: string; text: string }> = Array.from({ length: 30 }, (_, i) => ({
  id: `item-${i + 1}`,
  text: `Customer review #${i + 1}: ${SAMPLE_REVIEWS[i % SAMPLE_REVIEWS.length]}`,
}))

// ---------------------------------------------------------------------------
// Limiter — tuned for batch work
// ---------------------------------------------------------------------------
const limiter = createRateLimiter({
  // Use your actual tier limits here. The defaults are conservative (Tier 1).
  // Run `npx ai-sdk-rate-limiter audit` to detect your real limits.
  limits: {
    'gpt-4o-mini': { rpm: 500, itpm: 200_000 },
  },

  cost: {
    // Fail the entire job if it would exceed this amount — safety net.
    budget: { daily: 5 },
    onExceeded: 'throw',
  },

  queue: {
    // Allow a deep queue so all items can be enqueued up front
    maxSize: 500,
    // Batch items can wait up to 5 minutes
    timeout: 5 * 60_000,
  },

  retry: {
    maxAttempts: 4,
    backoff: 'exponential',
    parseRetryAfter: true,
  },

  on: {
    rateLimited: ({ model, limitType, source }) =>
      process.stderr.write(`\r  [rate limited] ${model} ${limitType} (${source}) — queuing...\n`),

    retrying: ({ model, attempt, maxAttempts, delayMs }) =>
      process.stderr.write(`  [retry] ${model} attempt ${attempt}/${maxAttempts} in ${delayMs}ms\n`),
  },
})

const model = limiter.wrap(openai('gpt-4o-mini'))

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------
interface Result {
  id:         string
  sentiment:  'positive' | 'negative' | 'neutral'
  summary:    string
  error?:     string
}

// ---------------------------------------------------------------------------
// Process a single item
// ---------------------------------------------------------------------------
async function processItem(item: (typeof ITEMS)[number]): Promise<Result> {
  try {
    const { text } = await generateText({
      model,
      prompt: `Classify the sentiment of this review as positive, negative, or neutral.
Return JSON: {"sentiment": "positive"|"negative"|"neutral", "summary": "<one sentence>"}

Review: ${item.text}`,
      providerOptions: {
        rateLimiter: {
          // Batch work is low priority — interactive requests can jump ahead
          priority: 'low',
        },
      },
    })

    const parsed = JSON.parse(text.trim()) as { sentiment: Result['sentiment']; summary: string }
    return { id: item.id, ...parsed }
  } catch (err) {
    if (err instanceof QueueTimeoutError) {
      return { id: item.id, sentiment: 'neutral', summary: '', error: 'queue timeout' }
    }
    return { id: item.id, sentiment: 'neutral', summary: '', error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// Main — fire all items concurrently; the limiter handles the queuing
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Processing ${ITEMS.length} items via gpt-4o-mini...`)
  console.log('Press Ctrl+C to stop gracefully (in-flight requests will complete).\n')

  const startedAt = Date.now()
  let completed = 0

  // Kick off all items at once — the limiter queues and drains them
  // automatically at the maximum sustainable rate.
  const promises = ITEMS.map(async (item) => {
    const result = await processItem(item)
    completed++
    const report = limiter.getCostReport()
    process.stdout.write(
      `\r  [${completed}/${ITEMS.length}] $${report.hour.costUsd.toFixed(4)} spent this hour`,
    )
    return result
  })

  const results = await Promise.allSettled(promises)

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const report = limiter.getCostReport()

  console.log(`\n\nDone in ${elapsed}s`)
  console.log(`\nCost report:`)
  console.log(`  Requests : ${report.hour.requests}`)
  console.log(`  Tokens   : ${report.hour.inputTokens} in / ${report.hour.outputTokens} out`)
  console.log(`  Cost     : $${report.hour.costUsd.toFixed(4)} (hour) / $${report.day.costUsd.toFixed(4)} (day)`)

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed    = results.filter(r => r.status === 'rejected').length
  console.log(`\nResults  : ${succeeded} succeeded, ${failed} failed`)

  // Print a sample of results
  console.log('\nSample results:')
  for (const r of results.slice(0, 5)) {
    if (r.status === 'fulfilled') {
      const v = r.value
      console.log(`  ${v.id}: [${v.sentiment}] ${v.summary}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight requests on Ctrl+C
// ---------------------------------------------------------------------------
let shuttingDown = false
process.on('SIGINT', async () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n\n[shutdown] Stopping — waiting up to 30s for in-flight requests...')
  await limiter.shutdown({ drainMs: 30_000 })
  console.log('[shutdown] Done.')
  process.exit(0)
})

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------
const SAMPLE_REVIEWS = [
  'Absolutely loved it! The quality exceeded my expectations.',
  'Terrible experience. Would not recommend to anyone.',
  'It was okay. Nothing special but got the job done.',
  'Fast shipping, great packaging. Will buy again.',
  'Product stopped working after two weeks. Very disappointed.',
  'Exactly as described. Happy with the purchase.',
  'Customer service was unhelpful and rude.',
  'Amazing value for the price. Highly recommend!',
  'Average product. Does what it says.',
  'Best purchase I have made this year. Absolutely worth it.',
]
