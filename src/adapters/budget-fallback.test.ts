import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter } from '../create-rate-limiter.js'
import { BudgetExceededError } from '../errors.js'
import type { LanguageModelV4, LanguageModelV4CallOptions } from './vercel-ai-sdk.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockModel(
  id: string,
  provider: string,
  overrides: Partial<LanguageModelV4> = {},
): LanguageModelV4 {
  return {
    modelId: id,
    provider,
    async doGenerate(_params: LanguageModelV4CallOptions) {
      return {
        usage: {
          inputTokens: { total: 100, noCache: 100 },
          outputTokens: { total: 50, text: 50 },
        },
        content: [{ type: 'text', text: `Response from ${id}` }],
        finishReason: 'stop',
        response: { headers: {} },
      }
    },
    async doStream(_params: LanguageModelV4CallOptions) {
      const chunks = [
        { type: 'text-delta', id: '1', delta: `stream:${id}` },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: { total: 100, noCache: 100 },
            outputTokens: { total: 10, text: 10 },
          },
        },
      ]
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
        rawResponse: { headers: {} },
        warnings: [],
      }
    },
    ...overrides,
  }
}

/**
 * A model that returns a very large token count to quickly exhaust a budget.
 * 2,000,000 input tokens at gpt-4o pricing ($2.50/M) = $5.00 — well over a $1.00 budget.
 */
function makeBigSpender(id: string, provider: string): LanguageModelV4 {
  return makeMockModel(id, provider, {
    async doGenerate(_params) {
      return {
        usage: {
          inputTokens: { total: 2_000_000, noCache: 2_000_000 },
          outputTokens: { total: 0 },
        },
        content: [],
        finishReason: 'stop',
        response: { headers: {} },
      }
    },
  })
}

const PARAMS = { prompt: [] } as unknown as LanguageModelV4CallOptions

// ---------------------------------------------------------------------------
// Budget exceeded — throw (no fallback)
// ---------------------------------------------------------------------------

describe('budget exceeded — onExceeded: throw', () => {
  it('throws BudgetExceededError when daily budget is exceeded', async () => {
    // Budget: $1.00/day. Spender records $5.00 (2M tokens × $2.50/M).
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'throw' },
    })

    // First call: current=$0, estimated≈$0. Passes. Records $5.00 of actual spend.
    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    // Second call: current=$5.00 > $1.00 daily budget → throws.
    await expect(
      limiter.wrap(makeMockModel('gpt-4o', 'openai')).doGenerate(PARAMS),
    ).rejects.toThrow(BudgetExceededError)
  })

  it('BudgetExceededError carries model, period, and limit details', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'throw' },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    let caught: BudgetExceededError | undefined
    try {
      await limiter.wrap(makeMockModel('gpt-4o', 'openai')).doGenerate(PARAMS)
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err
    }

    expect(caught).toBeDefined()
    expect(caught!.model).toBe('gpt-4o')
    expect(caught!.limitUsd).toBe(1.0)
    expect(caught!.period).toBe('daily')
    expect(caught!.currentCostUsd).toBeGreaterThan(1.0)
  })

  it('emits budgetHit event before throwing', async () => {
    const onBudgetHit = vi.fn()
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'throw' },
      on: { budgetHit: onBudgetHit },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    await expect(
      limiter.wrap(makeMockModel('gpt-4o', 'openai')).doGenerate(PARAMS),
    ).rejects.toThrow(BudgetExceededError)

    expect(onBudgetHit).toHaveBeenCalledOnce()
    const event = onBudgetHit.mock.calls[0]![0]
    expect(event.model).toBe('gpt-4o')
    expect(event.period).toBe('daily')
    expect(event.limitUsd).toBe(1.0)
    expect(event.usingFallback).toBe(false)
    expect(event.currentCostUsd).toBeGreaterThan(1.0)
  })

  it('does not throw when under budget', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 100.0 }, onExceeded: 'throw' },
    })

    // Small model — well within $100 budget
    const result = await limiter
      .wrap(makeMockModel('gpt-4o-mini', 'openai'))
      .doGenerate(PARAMS)

    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Budget exceeded — hourly and monthly periods
// ---------------------------------------------------------------------------

describe('budgetHit event — periods', () => {
  it('reports "hourly" period when hourly budget is hit', async () => {
    const onBudgetHit = vi.fn()
    const limiter = createRateLimiter({
      cost: { budget: { hourly: 1.0 }, onExceeded: 'throw' },
      on: { budgetHit: onBudgetHit },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    await expect(
      limiter.wrap(makeMockModel('gpt-4o', 'openai')).doGenerate(PARAMS),
    ).rejects.toThrow(BudgetExceededError)

    expect(onBudgetHit.mock.calls[0]![0].period).toBe('hourly')
  })

  it('reports "monthly" period when monthly budget is hit', async () => {
    const onBudgetHit = vi.fn()
    const limiter = createRateLimiter({
      cost: { budget: { monthly: 1.0 }, onExceeded: 'throw' },
      on: { budgetHit: onBudgetHit },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    await expect(
      limiter.wrap(makeMockModel('gpt-4o', 'openai')).doGenerate(PARAMS),
    ).rejects.toThrow(BudgetExceededError)

    expect(onBudgetHit.mock.calls[0]![0].period).toBe('monthly')
  })
})

// ---------------------------------------------------------------------------
// Budget exceeded — fallback model
// ---------------------------------------------------------------------------

describe('budget exceeded — onExceeded: fallback', () => {
  it('transparently retries with fallback model when budget is hit', async () => {
    const onBudgetHit = vi.fn()
    const primaryCalls: number[] = []
    const fallbackCalls: number[] = []

    const primaryModel = makeMockModel('gpt-4o', 'openai', {
      async doGenerate(_params) {
        primaryCalls.push(1)
        return {
          usage: { inputTokens: { total: 100 }, outputTokens: { total: 50 } },
          content: [{ type: 'text', text: 'primary' }],
          finishReason: 'stop',
          response: { headers: {} },
        }
      },
    })

    const fallbackModel = makeMockModel('gpt-4o-mini', 'openai', {
      async doGenerate(_params) {
        fallbackCalls.push(1)
        return {
          usage: { inputTokens: { total: 100 }, outputTokens: { total: 50 } },
          content: [{ type: 'text', text: 'fallback' }],
          finishReason: 'stop',
          response: { headers: {} },
        }
      },
    })

    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'fallback' },
      on: { budgetHit: onBudgetHit },
    })

    // Exhaust the $1.00 daily budget
    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    // Now wrap primary with fallback — should NOT throw, should use fallback
    const wrapped = limiter.wrap(primaryModel, { fallback: fallbackModel })
    const result = await wrapped.doGenerate(PARAMS)

    expect(result.content).toEqual([{ type: 'text', text: 'fallback' }])
    expect(primaryCalls).toHaveLength(0)
    expect(fallbackCalls).toHaveLength(1)
    expect(onBudgetHit).toHaveBeenCalledOnce()
    expect(onBudgetHit.mock.calls[0]![0].usingFallback).toBe(false)
  })

  it('uses fallback for doStream when budget is hit', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'fallback' },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    const wrapped = limiter.wrap(
      makeMockModel('gpt-4o', 'openai'),
      { fallback: makeMockModel('gpt-4o-mini', 'openai') },
    )

    const { stream } = await wrapped.doStream(PARAMS)
    const chunks: unknown[] = []
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    // First chunk delta should come from the fallback model's id
    expect(chunks[0]).toMatchObject({ type: 'text-delta', delta: 'stream:gpt-4o-mini' })
  })

  it('throws BudgetExceededError when budget hit and no fallback is configured', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'fallback' },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    // No fallback — error must propagate
    const wrapped = limiter.wrap(makeMockModel('gpt-4o', 'openai'))
    await expect(wrapped.doGenerate(PARAMS)).rejects.toThrow(BudgetExceededError)
  })

  it('does not recurse infinitely when fallback has same model id', async () => {
    // The budget is exhausted. Both primary and fallback have the same model ID.
    // The fallback bypasses the budget pre-check (that's the whole point of a fallback),
    // so it succeeds. Crucially, there is no infinite recursion — wrapModel catches
    // BudgetExceededError exactly once and delegates to the fallback directly.
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'fallback' },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    const wrapped = limiter.wrap(
      makeMockModel('gpt-4o', 'openai'),
      { fallback: makeMockModel('gpt-4o', 'openai') },
    )

    // Should resolve (fallback runs, bypassing budget check) — no stack overflow
    const result = await wrapped.doGenerate(PARAMS)
    expect(result).toBeDefined()
  })

  it('fallback cost is tracked under fallback model ID in getCostReport()', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'fallback' },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    const wrapped = limiter.wrap(
      makeMockModel('gpt-4o', 'openai'),
      { fallback: makeMockModel('gpt-4o-mini', 'openai') },
    )
    await wrapped.doGenerate(PARAMS)

    const report = limiter.getCostReport()
    expect(report.byModel['gpt-4o-mini']).toBeDefined()
    expect(report.byModel['gpt-4o-mini']!.requests).toBeGreaterThan(0)
  })

  it('primary model works normally when budget is NOT hit', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1000.0 }, onExceeded: 'fallback' },
    })

    const primaryCalled = vi.fn()
    const primary = makeMockModel('gpt-4o', 'openai', {
      async doGenerate(_params) {
        primaryCalled()
        return {
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          content: [{ type: 'text', text: 'primary' }],
          finishReason: 'stop',
          response: { headers: {} },
        }
      },
    })
    const fallback = makeMockModel('gpt-4o-mini', 'openai')

    const wrapped = limiter.wrap(primary, { fallback })
    const result = await wrapped.doGenerate(PARAMS)

    expect(result.content).toEqual([{ type: 'text', text: 'primary' }])
    expect(primaryCalled).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// CostTracker checkBudget — onExceeded: 'fallback' type parity
// ---------------------------------------------------------------------------

describe('checkBudget — fallback treated same as throw', () => {
  it('throws BudgetExceededError with onExceeded: fallback (same as throw)', async () => {
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'fallback' },
    })

    await limiter.wrap(makeBigSpender('gpt-4o', 'openai')).doGenerate(PARAMS)

    // Without a fallback on the wrapped model, it propagates as BudgetExceededError
    await expect(
      limiter.wrap(makeMockModel('gpt-4o', 'openai')).doGenerate(PARAMS),
    ).rejects.toThrow(BudgetExceededError)
  })
})
