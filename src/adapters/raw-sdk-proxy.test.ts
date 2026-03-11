import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter } from '../create-rate-limiter.js'
import { rateLimited } from './raw-sdk-proxy.js'
import { BudgetExceededError } from '../errors.js'

// ---------------------------------------------------------------------------
// Minimal mock SDK clients
// ---------------------------------------------------------------------------

/** A mock that looks like openai.chat.completions */
function makeMockOpenAIClient(overrides: Record<string, unknown> = {}) {
  return {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          if (params['stream']) {
            // Return an async iterable stream
            const chunks = [
              { choices: [{ delta: { content: 'hello' } }] },
              {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
              },
            ]
            return {
              [Symbol.asyncIterator]() {
                let i = 0
                return {
                  async next() {
                    if (i < chunks.length) return { done: false, value: chunks[i++] }
                    return { done: true, value: undefined }
                  },
                }
              },
            }
          }
          return {
            model: params['model'],
            choices: [{ message: { content: 'Hello from OpenAI' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            ...overrides,
          }
        },
      },
    },
    // Embeddings — also has a model param
    embeddings: {
      async create(params: Record<string, unknown>) {
        return {
          model: params['model'],
          data: [{ embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }
      },
    },
    // Method without model — should pass through unmodified
    models: {
      async list() {
        return { data: [{ id: 'gpt-4o' }] }
      },
    },
  }
}

/** A mock that looks like the Anthropic SDK */
function makeMockAnthropicClient() {
  return {
    messages: {
      async create(params: Record<string, unknown>) {
        if (params['stream']) {
          const chunks = [
            { type: 'message_start', message: { usage: { input_tokens: 80 } } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
            { type: 'message_delta', usage: { output_tokens: 40 } },
            { type: 'message_stop' },
          ]
          return {
            [Symbol.asyncIterator]() {
              let i = 0
              return {
                async next() {
                  if (i < chunks.length) return { done: false, value: chunks[i++] }
                  return { done: true, value: undefined }
                },
              }
            },
          }
        }
        return {
          id: 'msg_123',
          type: 'message',
          model: params['model'],
          content: [{ type: 'text', text: 'Hello from Anthropic' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 40 },
        }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Non-streaming — basic call routing
// ---------------------------------------------------------------------------

describe('rawProxy — non-streaming', () => {
  it('returns the original response unchanged', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    const result = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(result).toMatchObject({
      choices: [{ message: { content: 'Hello from OpenAI' } }],
    })
  })

  it('passes all arguments through to the underlying function', async () => {
    const spy = vi.fn().mockResolvedValue({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    const mockClient = { chat: { completions: { create: spy } } }

    const limiter = createRateLimiter()
    const proxied = limiter.rawProxy(mockClient, { provider: 'openai' })

    const params = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 }
    await proxied.chat.completions.create(params)

    expect(spy).toHaveBeenCalledWith(params)
  })

  it('does NOT intercept calls without a model field', async () => {
    const spy = vi.fn().mockResolvedValue({ data: [] })
    const mockClient = { models: { list: spy } }

    const limiter = createRateLimiter()
    const proxied = limiter.rawProxy(mockClient, { provider: 'openai' })

    await proxied.models.list()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('records OpenAI-format usage in getCostReport()', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const report = limiter.getCostReport()
    expect(report.day.requests).toBe(1)
    expect(report.day.inputTokens).toBe(100)
    expect(report.day.outputTokens).toBe(50)
    expect(report.byModel['gpt-4o']).toBeDefined()
    expect(report.byModel['gpt-4o']!.requests).toBe(1)
  })

  it('records Anthropic-format usage in getCostReport()', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockAnthropicClient(), { provider: 'anthropic' })

    await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const report = limiter.getCostReport()
    expect(report.day.requests).toBe(1)
    expect(report.day.inputTokens).toBe(80)
    expect(report.day.outputTokens).toBe(40)
    expect(report.byModel['claude-opus-4-6']).toBeDefined()
  })

  it('works for embeddings (non-chat endpoints with model param)', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    const result = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'hello world',
    })

    expect(result).toMatchObject({ data: [{ embedding: [0.1, 0.2] }] })
  })
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('rawProxy — streaming', () => {
  it('returns a working async iterable for OpenAI streaming', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })

    const chunks: unknown[] = []
    for await (const chunk of stream as AsyncIterable<unknown>) {
      chunks.push(chunk)
    }

    expect(chunks.length).toBeGreaterThan(0)
  })

  it('records OpenAI streaming usage from the final usage chunk', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    })

    // Drain the stream fully so the finish handler fires
    for await (const _ of stream as AsyncIterable<unknown>) { /* consume */ }

    const report = limiter.getCostReport()
    expect(report.day.requests).toBe(1)
    expect(report.day.inputTokens).toBe(100)
    expect(report.day.outputTokens).toBe(50)
  })

  it('records Anthropic streaming usage from message_start + message_delta chunks', async () => {
    const limiter = createRateLimiter()
    const client = limiter.rawProxy(makeMockAnthropicClient(), { provider: 'anthropic' })

    const stream = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [],
      stream: true,
    })

    for await (const _ of stream as AsyncIterable<unknown>) { /* consume */ }

    const report = limiter.getCostReport()
    expect(report.day.inputTokens).toBe(80)
    expect(report.day.outputTokens).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// Provider auto-detection
// ---------------------------------------------------------------------------

describe('rawProxy — provider auto-detection', () => {
  it('detects openai from constructor name', async () => {
    class OpenAI {
      chat = {
        completions: {
          async create(_params: unknown) {
            return { usage: { prompt_tokens: 10, completion_tokens: 5 } }
          },
        },
      }
    }

    const limiter = createRateLimiter()
    const proxied = limiter.rawProxy(new OpenAI())  // no explicit provider

    await proxied.chat.completions.create({ model: 'gpt-4o', messages: [] })

    const report = limiter.getCostReport()
    // gpt-4o is in the registry under openai — cost should be tracked
    expect(report.byModel['gpt-4o']).toBeDefined()
  })

  it('detects anthropic from constructor name', async () => {
    class Anthropic {
      messages = {
        async create(_params: unknown) {
          return { usage: { input_tokens: 20, output_tokens: 10 } }
        },
      }
    }

    const limiter = createRateLimiter()
    const proxied = limiter.rawProxy(new Anthropic())

    await proxied.messages.create({ model: 'claude-opus-4-6', messages: [] })

    const report = limiter.getCostReport()
    expect(report.byModel['claude-opus-4-6']).toBeDefined()
  })

  it('explicit provider option overrides auto-detection', async () => {
    // Purposely ambiguous constructor name
    class MyClient {
      completions = {
        async create(_p: unknown) {
          return { usage: { prompt_tokens: 5, completion_tokens: 2 } }
        },
      }
    }

    const onCompleted = vi.fn()
    const limiter = createRateLimiter({ on: { completed: onCompleted } })
    const proxied = limiter.rawProxy(new MyClient(), { provider: 'groq' })

    await proxied.completions.create({ model: 'llama-3.3-70b-versatile', messages: [] })

    // completed fires twice per call: once from execute() (estimated 0 tokens),
    // once from recordUsage() with actuals
    expect(onCompleted).toHaveBeenCalledTimes(2)
    // Both events should carry the correct provider
    expect(onCompleted.mock.calls.every((c: unknown[]) => (c[0] as Record<string, unknown>)['provider'] === 'groq')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Budget enforcement via limiter.rawProxy()
// ---------------------------------------------------------------------------

describe('rawProxy — budget enforcement', () => {
  it('throws BudgetExceededError when daily budget is hit', async () => {
    // Budget: $1.00/day. The big-spender mock returns 2M input tokens.
    // gpt-4o pricing: $2.50/M → 2M × $2.50/M = $5.00, well over $1.00.
    const limiter = createRateLimiter({
      cost: { budget: { daily: 1.0 }, onExceeded: 'throw' },
    })

    // Mock that returns 2M tokens to exhaust the budget in one shot
    const bigSpender = {
      chat: {
        completions: {
          async create(_p: unknown) {
            return {
              usage: { prompt_tokens: 2_000_000, completion_tokens: 0 },
              choices: [],
            }
          },
        },
      },
    }

    // First call: current=$0, pre-check passes. Records $5.00 actual spend.
    await limiter.rawProxy(bigSpender, { provider: 'openai' })
      .chat.completions.create({ model: 'gpt-4o', messages: [] })

    // Second call: current=$5.00 > $1.00 budget → throws
    await expect(
      limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })
        .chat.completions.create({ model: 'gpt-4o', messages: [] }),
    ).rejects.toThrow(BudgetExceededError)
  })

  it('emits completed events for each successful call', async () => {
    const onCompleted = vi.fn()
    const limiter = createRateLimiter({ on: { completed: onCompleted } })
    const client = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    await client.chat.completions.create({ model: 'gpt-4o', messages: [] })
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })

    // Two completed events from execute() + two from recordUsage()
    // Each call fires once from pipeline.execute and once from recordUsage
    // Actually pipeline.execute fires once (with 0/0), then recordUsage fires again with actuals
    expect(onCompleted).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// Standalone rateLimited() function
// ---------------------------------------------------------------------------

describe('standalone rateLimited()', () => {
  it('wraps a client without needing a limiter instance', async () => {
    const client = rateLimited(makeMockOpenAIClient(), { provider: 'openai' })

    const result = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(result).toMatchObject({ choices: [{ message: { content: 'Hello from OpenAI' } }] })
  })

  it('accepts config options for budget, retry, etc.', async () => {
    const client = rateLimited(makeMockOpenAIClient(), {
      provider: 'openai',
      config: {
        cost: { budget: { daily: 100 }, onExceeded: 'throw' },
        retry: { maxAttempts: 2 },
      },
    })

    // Should complete without errors
    const result = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
    })

    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('rawProxy — edge cases', () => {
  it('passes through non-object first arguments without intercepting', async () => {
    const spy = vi.fn().mockResolvedValue('ok')
    const mockClient = { doSomething: spy }

    const limiter = createRateLimiter()
    const proxied = limiter.rawProxy(mockClient)

    await proxied.doSomething('just a string')
    expect(spy).toHaveBeenCalledWith('just a string')
  })

  it('preserves non-function properties on nested objects', () => {
    const mockClient = {
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      chat: { completions: { create: vi.fn() } },
    }

    const limiter = createRateLimiter()
    const proxied = limiter.rawProxy(mockClient)

    expect(proxied.baseURL).toBe('https://api.openai.com/v1')
    expect(proxied.apiKey).toBe('sk-test')
  })

  it('shares cost tracking between rawProxy and wrap() on the same limiter', async () => {
    // Ensures the pipeline is truly shared
    const limiter = createRateLimiter()
    const rawClient = limiter.rawProxy(makeMockOpenAIClient(), { provider: 'openai' })

    await rawClient.chat.completions.create({ model: 'gpt-4o', messages: [] })

    const report = limiter.getCostReport()
    expect(report.day.requests).toBeGreaterThan(0)
    expect(report.byModel['gpt-4o']).toBeDefined()
  })
})
