import { describe, it, expect, vi } from 'vitest'
import { Pipeline } from './pipeline.js'

function makePipeline() {
  return new Pipeline({})
}

describe('request deduplication', () => {
  it('two concurrent requests with the same dedupKey share one API call', async () => {
    const pipeline = makePipeline()
    let callCount = 0

    const fn = vi.fn(async () => {
      callCount++
      await new Promise(r => setTimeout(r, 20))
      return { value: 'result' }
    })

    const opts = {
      streaming: false as const,
      priority: 'normal' as const,
      timeoutMs: 5_000,
      dedupKey: 'test-key-1',
    }

    const [r1, r2] = await Promise.all([
      pipeline.execute('gpt-4o', 'openai', [], fn, opts),
      pipeline.execute('gpt-4o', 'openai', [], fn, opts),
    ])

    expect(callCount).toBe(1)
    expect(r1).toEqual(r2)
  })

  it('requests with different dedupKeys make separate API calls', async () => {
    const pipeline = makePipeline()
    const fn = vi.fn().mockResolvedValue({ value: 'result' })

    await Promise.all([
      pipeline.execute('gpt-4o', 'openai', [], fn, {
        streaming: false, priority: 'normal', timeoutMs: 5_000, dedupKey: 'key-a',
      }),
      pipeline.execute('gpt-4o', 'openai', [], fn, {
        streaming: false, priority: 'normal', timeoutMs: 5_000, dedupKey: 'key-b',
      }),
    ])

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('dedup entry is removed after completion — next request makes a fresh call', async () => {
    const pipeline = makePipeline()
    const fn = vi.fn().mockResolvedValue({ value: 'done' })

    await pipeline.execute('gpt-4o', 'openai', [], fn, {
      streaming: false, priority: 'normal', timeoutMs: 5_000, dedupKey: 'reuse-key',
    })
    await pipeline.execute('gpt-4o', 'openai', [], fn, {
      streaming: false, priority: 'normal', timeoutMs: 5_000, dedupKey: 'reuse-key',
    })

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('requests without a dedupKey are never deduplicated', async () => {
    const pipeline = makePipeline()
    const fn = vi.fn().mockResolvedValue({ value: 'done' })

    await Promise.all([
      pipeline.execute('gpt-4o', 'openai', [], fn, {
        streaming: false, priority: 'normal', timeoutMs: 5_000,
      }),
      pipeline.execute('gpt-4o', 'openai', [], fn, {
        streaming: false, priority: 'normal', timeoutMs: 5_000,
      }),
    ])

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('all subscribers receive the same result when deduped', async () => {
    const pipeline = makePipeline()
    let seq = 0
    const fn = vi.fn(async () => ({ seq: ++seq }))

    const opts = {
      streaming: false as const,
      priority: 'normal' as const,
      timeoutMs: 5_000,
      dedupKey: 'shared',
    }

    // Fire three concurrent requests
    const results = await Promise.all([
      pipeline.execute('gpt-4o', 'openai', [], fn, opts),
      pipeline.execute('gpt-4o', 'openai', [], fn, opts),
      pipeline.execute('gpt-4o', 'openai', [], fn, opts),
    ])

    expect(fn).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
  })
})
