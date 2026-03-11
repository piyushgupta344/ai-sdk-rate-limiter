/**
 * Raw SDK proxy adapter.
 *
 * Wraps any OpenAI-compatible client (OpenAI, Groq, Mistral, Cohere) or the
 * Anthropic SDK with rate limiting, priority queuing, smart retry, and cost
 * tracking — using a transparent JavaScript Proxy.
 *
 * The proxied client is a complete drop-in: every method, property, and
 * nested namespace works exactly as before. Only calls that include a
 * `model` field in their first argument are intercepted.
 */

import type { Priority, RateLimiterConfig } from '../types.js'
import { Pipeline } from '../core/pipeline.js'

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface RawSdkProxyOptions {
  /**
   * Provider name used for registry lookup (e.g. 'openai', 'anthropic',
   * 'groq', 'mistral', 'cohere'). Auto-detected from the client's
   * constructor name when omitted.
   */
  provider?: string
  /** Default request priority for all calls through this proxy. Default: 'normal' */
  priority?: Priority
  /**
   * Rate limiter config — same shape as createRateLimiter().
   * Only used by the standalone rateLimited() function; rawProxy() on a
   * limiter instance ignores this (the limiter's own config is used).
   */
  config?: RateLimiterConfig
}

// ---------------------------------------------------------------------------
// Usage extraction — handles OpenAI / OpenAI-compatible and Anthropic shapes
// ---------------------------------------------------------------------------

function extractUsage(response: unknown): { inputTokens: number; outputTokens: number } {
  if (!response || typeof response !== 'object') return { inputTokens: 0, outputTokens: 0 }
  const r = response as Record<string, unknown>
  const usage = r['usage'] as Record<string, unknown> | undefined
  if (!usage) return { inputTokens: 0, outputTokens: 0 }

  // OpenAI / OpenAI-compatible (Groq, Mistral, Cohere): prompt_tokens / completion_tokens
  if (typeof usage['prompt_tokens'] === 'number') {
    return {
      inputTokens: usage['prompt_tokens'],
      outputTokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
    }
  }

  // Anthropic: input_tokens / output_tokens
  if (typeof usage['input_tokens'] === 'number') {
    return {
      inputTokens: usage['input_tokens'],
      outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0,
    }
  }

  return { inputTokens: 0, outputTokens: 0 }
}

// ---------------------------------------------------------------------------
// Streaming — wraps an AsyncIterable to capture usage from event chunks
// ---------------------------------------------------------------------------

function wrapAsyncIterableStream(
  stream: AsyncIterable<unknown>,
  pipeline: Pipeline,
  modelId: string,
  provider: string,
  startMs: number,
): AsyncIterable<unknown> {
  const original = stream[Symbol.asyncIterator]()
  let inputTokens = 0
  let outputTokens = 0

  const wrapped: AsyncIterator<unknown> = {
    async next() {
      const result = await original.next()

      if (result.value && typeof result.value === 'object') {
        const chunk = result.value as Record<string, unknown>

        // Anthropic SSE: message_start carries input token count
        if (chunk['type'] === 'message_start') {
          const msg = chunk['message'] as Record<string, unknown> | undefined
          const u = msg?.['usage'] as Record<string, unknown> | undefined
          if (typeof u?.['input_tokens'] === 'number') inputTokens = u['input_tokens']
        }

        // Anthropic SSE: message_delta carries output token count
        if (chunk['type'] === 'message_delta') {
          const u = chunk['usage'] as Record<string, unknown> | undefined
          if (typeof u?.['output_tokens'] === 'number') outputTokens = u['output_tokens']
        }

        // OpenAI: final chunk carries usage when stream_options.include_usage is set
        if (chunk['usage']) {
          const u = extractUsage(result.value)
          if (u.inputTokens > 0) inputTokens = u.inputTokens
          if (u.outputTokens > 0) outputTokens = u.outputTokens
        }
      }

      if (result.done) {
        pipeline.recordUsage(modelId, provider, { inputTokens, outputTokens }, Date.now() - startMs, true)
      }

      return result
    },
    // Only include return/throw if the original iterator supports them
    ...(original.return && { return: original.return.bind(original) }),
    ...(original.throw && { throw: original.throw.bind(original) }),
  }

  return { [Symbol.asyncIterator]: () => wrapped }
}

// ---------------------------------------------------------------------------
// Provider auto-detection from constructor name
// ---------------------------------------------------------------------------

function detectProvider(client: object, hint?: string): string {
  if (hint) return hint
  const name = (client.constructor?.name ?? '').toLowerCase()
  // Order matters: Groq extends OpenAI, so check groq first
  if (name.includes('groq')) return 'groq'
  if (name.includes('openai')) return 'openai'
  if (name.includes('anthropic')) return 'anthropic'
  if (name.includes('mistralclient') || name.includes('mistral')) return 'mistral'
  if (name.includes('cohere')) return 'cohere'
  // Default to openai — most OpenAI-compatible SDKs use the same API shape
  return 'openai'
}

// ---------------------------------------------------------------------------
// Deep proxy — intercepts method calls that have a { model: string } param
// ---------------------------------------------------------------------------

export function createRawProxy<T extends object>(
  client: T,
  pipeline: Pipeline,
  queueTimeout: number,
  options: { provider?: string; priority?: Priority } = {},
): T {
  const provider = detectProvider(client, options.provider)
  const priority = options.priority ?? 'normal'

  function proxyObject<O extends object>(target: O): O {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver)

        // Wrap functions — only intercept if first arg has model: string
        if (typeof value === 'function') {
          // Bind to the original object so internal `this` references work
          // (e.g. OpenAI SDK's this._client inside create())
          const bound = (value as (...args: unknown[]) => unknown).bind(obj)

          return function (...args: unknown[]) {
            const params = args[0]
            if (params && typeof params === 'object' && !Array.isArray(params)) {
              const modelId = (params as Record<string, unknown>)['model']
              if (typeof modelId === 'string') {
                return executeViaProxy(bound, args, modelId, provider, params as Record<string, unknown>, pipeline, queueTimeout, priority)
              }
            }
            return bound(...args)
          }
        }

        // Recursively proxy nested objects so openai.chat.completions.create() works
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return proxyObject(value as object)
        }

        return value
      },
    }) as O
  }

  return proxyObject(client)
}

// ---------------------------------------------------------------------------
// Route a detected AI call through the pipeline
// ---------------------------------------------------------------------------

async function executeViaProxy(
  fn: (...args: unknown[]) => unknown,
  args: unknown[],
  modelId: string,
  provider: string,
  params: Record<string, unknown>,
  pipeline: Pipeline,
  queueTimeout: number,
  priority: Priority,
): Promise<unknown> {
  const startMs = Date.now()
  const isStreaming = params['stream'] === true

  // Use messages/prompt as the "prompt" for token estimation
  const prompt = params['messages'] ?? params['prompt'] ?? params

  const result = await pipeline.execute(
    modelId,
    provider,
    prompt,
    () => fn(...args) as Promise<unknown>,
    {
      streaming: isStreaming,
      priority,
      timeoutMs: queueTimeout,
      onUsage: () => {},
    },
  )

  // Streaming: wrap the returned AsyncIterable to capture usage on completion
  if (
    isStreaming &&
    result !== null &&
    typeof result === 'object' &&
    Symbol.asyncIterator in (result as object)
  ) {
    return wrapAsyncIterableStream(result as AsyncIterable<unknown>, pipeline, modelId, provider, startMs)
  }

  // Non-streaming: extract usage from the response immediately
  const usage = extractUsage(result)
  pipeline.recordUsage(modelId, provider, usage, Date.now() - startMs, false)

  return result
}

// ---------------------------------------------------------------------------
// Standalone rateLimited() — creates its own pipeline
// ---------------------------------------------------------------------------

/**
 * Wrap a raw AI SDK client with rate limiting, queuing, and cost tracking.
 *
 * Works with any OpenAI-compatible client (OpenAI, Groq, Mistral, Cohere)
 * and the Anthropic SDK. The returned proxy is a drop-in replacement — all
 * existing calls continue to work without any changes.
 *
 * @example
 * ```typescript
 * import { rateLimited } from 'ai-sdk-rate-limiter'
 * import OpenAI from 'openai'
 *
 * const openai = rateLimited(new OpenAI(), {
 *   config: { cost: { budget: { daily: 50 } } },
 * })
 *
 * // Use exactly as before — rate limiting is transparent
 * const completion = await openai.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * })
 * ```
 */
export function rateLimited<T extends object>(client: T, options: RawSdkProxyOptions = {}): T {
  const config = options.config ?? {}
  const pipeline = new Pipeline(config)
  const queueTimeout = config.queue?.timeout ?? 30_000
  return createRawProxy(client, pipeline, queueTimeout, {
    ...(options.provider !== undefined && { provider: options.provider }),
    ...(options.priority !== undefined && { priority: options.priority }),
  })
}
