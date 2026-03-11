import { openai } from '@ai-sdk/openai'
import { streamText } from 'ai'
import { BudgetExceededError, RateLimitExceededError } from 'ai-sdk-rate-limiter'
import { limiter } from '@/lib/limiter'

// The rate-limited model — wrap once, reuse across requests.
// The limiter tracks rate limits and cost per model, per period.
const model = limiter.wrap(openai('gpt-4o-mini'))

export async function POST(req: Request) {
  const { messages } = await req.json()

  try {
    const result = streamText({
      model,
      messages,
      // Per-request priority via providerOptions — high-priority requests
      // jump the queue ahead of normal/low ones when rate limits are hit.
      // providerOptions: { rateLimiter: { priority: 'high' } },
    })

    return result.toDataStreamResponse()
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json(
        { error: `Daily budget exceeded ($${err.limitUsd}). Try again tomorrow.` },
        { status: 429 },
      )
    }
    if (err instanceof RateLimitExceededError) {
      return Response.json(
        { error: 'Rate limit queue full. Please try again in a moment.' },
        { status: 429 },
      )
    }
    throw err
  }
}
