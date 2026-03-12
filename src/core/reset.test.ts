import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from '../../src/create-rate-limiter.js'

// Minimal WrappableModel stub that records calls
function makeModel(modelId = 'gpt-4o', provider = 'openai') {
  return {
    modelId,
    provider,
    doGenerate: vi.fn().mockResolvedValue({
      text: 'ok',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5 },
      rawCall: { rawPrompt: '', rawSettings: {} },
      response: { headers: {} },
    }),
    doStream: vi.fn(),
  }
}

describe('limiter.reset()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('clears cost report to zero', async () => {
    const limiter = createRateLimiter({
      limits: { 'gpt-4o': { rpm: 100, inputPricePerMillion: 2.5, outputPricePerMillion: 10 } },
    })
    const model = limiter.wrap(makeModel() as never)

    // Simulate a completed request by recording usage directly through the
    // public getCostReport() — we drive it via the pipeline internals.
    // Use the wrapped model to record something: call doGenerate via the middleware
    const params = {
      inputFormat: 'prompt' as const,
      mode: { type: 'regular' as const },
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    }

    await model.doGenerate(params)

    const before = limiter.getCostReport()
    expect(before.hour.requests).toBe(1)

    limiter.reset()

    const after = limiter.getCostReport()
    expect(after.hour.requests).toBe(0)
    expect(after.hour.costUsd).toBe(0)
  })

  it('clears status (queue depth and window state)', async () => {
    const limiter = createRateLimiter({
      limits: { 'gpt-4o': { rpm: 100, inputPricePerMillion: 2.5, outputPricePerMillion: 10 } },
    })
    const model = limiter.wrap(makeModel() as never)

    const params = {
      inputFormat: 'prompt' as const,
      mode: { type: 'regular' as const },
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    }

    await model.doGenerate(params)

    const before = limiter.getStatus()
    // At least one model should appear in status after a request
    expect(before.models.length).toBeGreaterThanOrEqual(1)

    limiter.reset()

    const after = limiter.getStatus()
    expect(after.models).toHaveLength(0)
    expect(after.totalQueueDepth).toBe(0)
  })

  it('allows new requests after reset following a shutdown', async () => {
    const limiter = createRateLimiter({
      limits: { 'gpt-4o': { rpm: 100, inputPricePerMillion: 2.5, outputPricePerMillion: 10 } },
    })
    const stub = makeModel()
    const model = limiter.wrap(stub as never)

    const params = {
      inputFormat: 'prompt' as const,
      mode: { type: 'regular' as const },
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    }

    await limiter.shutdown()
    limiter.reset()

    // After reset the limiter should accept requests again
    await expect(model.doGenerate(params)).resolves.not.toThrow()
    expect(stub.doGenerate).toHaveBeenCalledTimes(1)
  })

  it('is fully operational for new requests after reset', async () => {
    const limiter = createRateLimiter({
      limits: { 'gpt-4o': { rpm: 100, inputPricePerMillion: 2.5, outputPricePerMillion: 10 } },
    })
    const stub = makeModel()
    const model = limiter.wrap(stub as never)

    const params = {
      inputFormat: 'prompt' as const,
      mode: { type: 'regular' as const },
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    }

    await model.doGenerate(params)
    expect(limiter.getCostReport().hour.requests).toBe(1)

    limiter.reset()

    // After reset, state is cleared
    expect(limiter.getCostReport().hour.requests).toBe(0)
    expect(limiter.getStatus().models).toHaveLength(0)

    // And new requests succeed normally
    await model.doGenerate(params)
    expect(limiter.getCostReport().hour.requests).toBe(1)
    expect(stub.doGenerate).toHaveBeenCalledTimes(2)
  })
})
