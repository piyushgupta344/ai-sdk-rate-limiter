import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from '../../src/create-rate-limiter.js'

function makeModel(modelId: string, provider = 'custom-provider') {
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

const PARAMS = {
  inputFormat: 'prompt' as const,
  mode: { type: 'regular' as const },
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
}

describe('unknown model warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('emits a warning the first time an unknown model is used', async () => {
    const limiter = createRateLimiter()
    const model = limiter.wrap(makeModel('my-custom-llm') as never)

    await model.doGenerate(PARAMS)

    expect(warnSpy).toHaveBeenCalledOnce()
    const msg = warnSpy.mock.calls[0]![0] as string
    expect(msg).toContain("Unknown model 'my-custom-llm'")
    expect(msg).toContain('Cost tracking is disabled')
    expect(msg).toContain('inputPricePerMillion')
  })

  it('only warns once per unique model, not on every request', async () => {
    const limiter = createRateLimiter()
    const model = limiter.wrap(makeModel('my-custom-llm') as never)

    await model.doGenerate(PARAMS)
    await model.doGenerate(PARAMS)
    await model.doGenerate(PARAMS)

    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('does NOT warn for known registry models', async () => {
    const limiter = createRateLimiter()
    const model = limiter.wrap(makeModel('gpt-4o', 'openai') as never)

    await model.doGenerate(PARAMS)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does NOT warn when user provides pricing in config.limits', async () => {
    const limiter = createRateLimiter({
      limits: {
        'my-custom-llm': {
          rpm: 100,
          inputPricePerMillion: 1.0,
          outputPricePerMillion: 2.0,
        },
      },
    })
    const model = limiter.wrap(makeModel('my-custom-llm') as never)

    await model.doGenerate(PARAMS)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does NOT warn when user provides only inputPricePerMillion', async () => {
    const limiter = createRateLimiter({
      limits: {
        'my-custom-llm': { inputPricePerMillion: 0.5 },
      },
    })
    const model = limiter.wrap(makeModel('my-custom-llm') as never)

    await model.doGenerate(PARAMS)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns separately for two different unknown models', async () => {
    const limiter = createRateLimiter()
    const modelA = limiter.wrap(makeModel('custom-a') as never)
    const modelB = limiter.wrap(makeModel('custom-b') as never)

    await modelA.doGenerate(PARAMS)
    await modelB.doGenerate(PARAMS)

    expect(warnSpy).toHaveBeenCalledTimes(2)
    const msgA = warnSpy.mock.calls[0]![0] as string
    const msgB = warnSpy.mock.calls[1]![0] as string
    expect(msgA).toContain("'custom-a'")
    expect(msgB).toContain("'custom-b'")
  })

  it('reset() clears the warned-models set so warning fires again', async () => {
    const limiter = createRateLimiter()
    const model = limiter.wrap(makeModel('my-custom-llm') as never)

    await model.doGenerate(PARAMS)
    expect(warnSpy).toHaveBeenCalledOnce()

    limiter.reset()
    warnSpy.mockClear()

    await model.doGenerate(PARAMS)
    expect(warnSpy).toHaveBeenCalledOnce()
  })
})
