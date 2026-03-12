import { describe, it, expect, vi } from 'vitest'
import { createModelPool } from './model-pool.js'
import type { WrappableModel } from './vercel-ai-sdk.js'

function makeModel(id: string, provider = 'openai'): WrappableModel {
  return {
    modelId: id,
    provider,
    doGenerate: vi.fn().mockResolvedValue({ text: `from ${id}` }),
    doStream: vi.fn().mockResolvedValue({ stream: new ReadableStream() }),
  }
}

describe('createModelPool', () => {
  it('throws when given an empty array', () => {
    expect(() => createModelPool([])).toThrow('at least one model')
  })

  it('exposes the first model identity', () => {
    const pool = createModelPool([makeModel('gpt-4o'), makeModel('gpt-4o-mini')])
    expect(pool.modelId).toBe('gpt-4o')
    expect(pool.provider).toBe('openai')
  })

  it('single model — always delegates to that model', async () => {
    const m = makeModel('gpt-4o')
    const pool = createModelPool([m])
    await pool.doGenerate({ prompt: [] })
    await pool.doGenerate({ prompt: [] })
    expect(m.doGenerate).toHaveBeenCalledTimes(2)
  })

  it('round-robin distributes doGenerate calls across models', async () => {
    const a = makeModel('gpt-4o')
    const b = makeModel('gpt-4o-mini')
    const pool = createModelPool([a, b])

    await pool.doGenerate({ prompt: [] })
    await pool.doGenerate({ prompt: [] })
    await pool.doGenerate({ prompt: [] })

    expect(a.doGenerate).toHaveBeenCalledTimes(2)
    expect(b.doGenerate).toHaveBeenCalledTimes(1)
  })

  it('round-robin distributes doStream calls across models', async () => {
    const a = makeModel('gpt-4o')
    const b = makeModel('gpt-4o-mini')
    const pool = createModelPool([a, b])

    await pool.doStream({ prompt: [] })
    await pool.doStream({ prompt: [] })

    expect(a.doStream).toHaveBeenCalledTimes(1)
    expect(b.doStream).toHaveBeenCalledTimes(1)
  })

  it('random strategy picks from the pool', async () => {
    const models = [makeModel('a'), makeModel('b'), makeModel('c')]
    const pool = createModelPool(models, { strategy: 'random' })

    for (let i = 0; i < 30; i++) {
      await pool.doGenerate({ prompt: [] })
    }

    const total = models.reduce((n, m) => n + (m.doGenerate as ReturnType<typeof vi.fn>).mock.calls.length, 0)
    expect(total).toBe(30)
    // Each model should have been picked at least once in 30 calls (probabilistically safe)
    for (const m of models) {
      expect((m.doGenerate as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    }
  })

  it('round-robin wraps around correctly', async () => {
    const a = makeModel('a')
    const b = makeModel('b')
    const pool = createModelPool([a, b])

    for (let i = 0; i < 6; i++) {
      await pool.doGenerate({ prompt: [] })
    }

    expect(a.doGenerate).toHaveBeenCalledTimes(3)
    expect(b.doGenerate).toHaveBeenCalledTimes(3)
  })
})
