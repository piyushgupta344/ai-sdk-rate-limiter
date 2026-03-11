import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from '../create-rate-limiter.js'
import type { LanguageModelV4, LanguageModelV4CallOptions } from './vercel-ai-sdk.js'

// ---------------------------------------------------------------------------
// Minimal mock model factory
// ---------------------------------------------------------------------------

function makeMockModel(overrides: Partial<LanguageModelV4> = {}): LanguageModelV4 {
  return {
    modelId: 'gpt-4o',
    provider: 'openai.chat',
    async doGenerate(_params: LanguageModelV4CallOptions) {
      return {
        usage: {
          inputTokens: { total: 100, noCache: 100 },
          outputTokens: { total: 50, text: 50 },
        },
        content: [{ type: 'text', text: 'Hello!' }],
        finishReason: 'stop',
        response: { headers: {} },
      }
    },
    async doStream(_params: LanguageModelV4CallOptions) {
      const chunks = [
        { type: 'text-delta', id: '1', delta: 'Hello' },
        { type: 'text-delta', id: '1', delta: '!' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: { total: 100, noCache: 100 },
            outputTokens: { total: 2, text: 2 },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRateLimiter().wrap()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns a model with the same modelId and provider', () => {
    const limiter = createRateLimiter()
    const model = makeMockModel()
    const wrapped = limiter.wrap(model)

    expect(wrapped.modelId).toBe('gpt-4o')
    expect(wrapped.provider).toBe('openai.chat')
  })

  it('allows custom modelId/providerId overrides', () => {
    const limiter = createRateLimiter()
    const model = makeMockModel()
    const wrapped = limiter.wrap(model, { modelId: 'my-gpt-4o', providerId: 'my-provider' })

    expect(wrapped.modelId).toBe('my-gpt-4o')
    expect(wrapped.provider).toBe('my-provider')
  })

  it('passes through doGenerate result unchanged', async () => {
    const limiter = createRateLimiter()
    const model = makeMockModel()
    const wrapped = limiter.wrap(model)

    const result = await wrapped.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    } as LanguageModelV4CallOptions)

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('passes through doStream result with all chunks', async () => {
    const limiter = createRateLimiter()
    const model = makeMockModel()
    const wrapped = limiter.wrap(model)

    const { stream } = await wrapped.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    } as LanguageModelV4CallOptions)

    const chunks: unknown[] = []
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ type: 'text-delta', delta: 'Hello' })
    expect(chunks[2]).toMatchObject({ type: 'finish' })
  })

  it('emits completed event with cost after doGenerate', async () => {
    const onCompleted = vi.fn()
    const limiter = createRateLimiter({
      on: { completed: onCompleted },
    })
    const wrapped = limiter.wrap(makeMockModel())

    await wrapped.doGenerate({
      prompt: [],
    } as unknown as LanguageModelV4CallOptions)

    // completed is emitted twice: once from pipeline (estimate) and once from
    // the actual usage reconciliation — the second has real tokens
    expect(onCompleted).toHaveBeenCalled()
  })

  it('rate limits: queues the 2nd request when rpm=1', async () => {
    const limiter = createRateLimiter({
      limits: { 'gpt-4o': { rpm: 1 } },
      queue: { timeout: 65_000 },
    })
    const wrapped = limiter.wrap(makeMockModel())
    const params = { prompt: [] } as unknown as LanguageModelV4CallOptions

    // First call should proceed immediately
    const p1 = wrapped.doGenerate(params)
    // Second call must queue (rpm=1)
    let secondStarted = false
    const p2 = wrapped.doGenerate(params).then((r) => {
      secondStarted = true
      return r
    })

    await p1
    expect(secondStarted).toBe(false)

    await vi.advanceTimersByTimeAsync(61_000)
    await p2

    expect(secondStarted).toBe(true)
  })

  it('queues by priority — high priority resolves before normal', async () => {
    const limiter = createRateLimiter({
      limits: { 'gpt-4o': { rpm: 1 } },
      queue: { timeout: 200_000 },
    })
    const model = makeMockModel()
    const wrapped = limiter.wrap(model)

    const resolved: string[] = []

    // Fill the slot
    wrapped.doGenerate({ prompt: [] } as unknown as LanguageModelV4CallOptions)

    // Queue: normal first, then high — high should win
    wrapped.doGenerate({
      prompt: [],
      providerOptions: { rateLimiter: { priority: 'normal' } },
    } as unknown as LanguageModelV4CallOptions).then(() => resolved.push('normal'))

    wrapped.doGenerate({
      prompt: [],
      providerOptions: { rateLimiter: { priority: 'high' } },
    } as unknown as LanguageModelV4CallOptions).then(() => resolved.push('high'))

    await vi.advanceTimersByTimeAsync(61_000)
    await vi.advanceTimersByTimeAsync(61_000)

    expect(resolved).toEqual(['high', 'normal'])
  })

  it('getCostReport() returns zeros before any requests', () => {
    const limiter = createRateLimiter()
    const report = limiter.getCostReport()
    expect(report.hour.costUsd).toBe(0)
    expect(report.day.costUsd).toBe(0)
    expect(report.month.costUsd).toBe(0)
  })

  it('retries on 429 and returns result', async () => {
    const error429 = { status: 429, headers: { 'retry-after': '1' } }
    let calls = 0
    const model = makeMockModel({
      async doGenerate(params) {
        calls++
        if (calls === 1) throw error429
        return {
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          content: [{ type: 'text', text: 'Retried!' }],
          finishReason: 'stop',
        }
      },
    })

    const limiter = createRateLimiter()
    const wrapped = limiter.wrap(model)

    const promise = wrapped.doGenerate({ prompt: [] } as unknown as LanguageModelV4CallOptions)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(calls).toBe(2)
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('Retried!')
  })
})
