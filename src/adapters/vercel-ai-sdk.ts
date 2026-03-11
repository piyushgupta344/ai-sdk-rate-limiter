/**
 * Vercel AI SDK adapter.
 *
 * Implements LanguageModelV4Middleware (from @ai-sdk/provider) and exposes a
 * .wrap() convenience method that calls wrapLanguageModel() from 'ai'.
 *
 * The middleware interface is implemented WITHOUT importing from 'ai' at
 * runtime — the interface is structurally compatible so we only need the
 * types, which means zero mandatory runtime deps.
 */

import type { Pipeline } from '../core/pipeline.js'
import type { Priority, PerRequestOptions } from '../types.js'

// ---------------------------------------------------------------------------
// Minimal structural types mirroring @ai-sdk/provider
// We re-declare only what we use so the package works even when
// @ai-sdk/provider is not installed (e.g. non-Vercel AI SDK projects).
// ---------------------------------------------------------------------------

export interface LanguageModelV4 {
  readonly modelId: string
  readonly provider: string
  doGenerate(params: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult>
  doStream(params: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult>
}

export interface LanguageModelV4CallOptions {
  prompt: unknown
  maxOutputTokens?: number
  providerOptions?: Record<string, unknown>
  [key: string]: unknown
}

export interface LanguageModelV4GenerateResult {
  usage?: {
    inputTokens?: { total?: number; noCache?: number }
    outputTokens?: { total?: number; text?: number }
  }
  response?: {
    headers?: Record<string, string>
  }
  [key: string]: unknown
}

export interface LanguageModelV4StreamPart {
  type: string
  usage?: {
    inputTokens?: { total?: number; noCache?: number }
    outputTokens?: { total?: number; text?: number }
  }
  [key: string]: unknown
}

export interface LanguageModelV4StreamResult {
  stream: ReadableStream<LanguageModelV4StreamPart>
  [key: string]: unknown
}

export type WrappableModel = LanguageModelV4

// ---------------------------------------------------------------------------
// Middleware type (structural — does not require @ai-sdk/provider at runtime)
// ---------------------------------------------------------------------------

export interface Middleware {
  readonly specificationVersion?: string
  wrapGenerate(opts: {
    doGenerate: () => Promise<LanguageModelV4GenerateResult>
    doStream: () => Promise<LanguageModelV4StreamResult>
    params: LanguageModelV4CallOptions
    model: LanguageModelV4
  }): Promise<LanguageModelV4GenerateResult>
  wrapStream(opts: {
    doGenerate: () => Promise<LanguageModelV4GenerateResult>
    doStream: () => Promise<LanguageModelV4StreamResult>
    params: LanguageModelV4CallOptions
    model: LanguageModelV4
  }): Promise<LanguageModelV4StreamResult>
}

// ---------------------------------------------------------------------------
// Per-request option extraction
// ---------------------------------------------------------------------------

function getPerRequestOptions(
  params: LanguageModelV4CallOptions,
  queueTimeout: number,
): { priority: Priority; timeoutMs: number; metadata: Record<string, unknown> } {
  const raw = params.providerOptions?.['rateLimiter'] as PerRequestOptions | undefined
  return {
    priority: raw?.priority ?? 'normal',
    timeoutMs: raw?.timeout ?? queueTimeout,
    metadata: raw?.metadata ?? {},
  }
}

// ---------------------------------------------------------------------------
// Token extraction from API results
// ---------------------------------------------------------------------------

function extractTokenUsage(usage: LanguageModelV4GenerateResult['usage']): {
  inputTokens: number
  outputTokens: number
} {
  return {
    inputTokens: usage?.inputTokens?.total ?? usage?.inputTokens?.noCache ?? 0,
    outputTokens: usage?.outputTokens?.total ?? usage?.outputTokens?.text ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function createMiddleware(pipeline: Pipeline, queueTimeout: number): Middleware {
  return {
    specificationVersion: 'v4',

    // -----------------------------------------------------------------------
    // wrapGenerate — non-streaming
    // -----------------------------------------------------------------------
    async wrapGenerate({ doGenerate, params, model }) {
      const { priority, timeoutMs } = getPerRequestOptions(params, queueTimeout)
      const modelId = model.modelId
      const provider = model.provider
      const startMs = Date.now()

      // Run through the full pipeline: budget → acquire → retry
      const result = await pipeline.execute(
        modelId,
        provider,
        params.prompt,
        doGenerate,
        {
          streaming: false,
          priority,
          timeoutMs,
          onUsage: () => {
            // placeholder — we reconcile with actuals below
          },
        },
      )

      // Reconcile with actual usage from the API response
      if (result.usage) {
        const usage = extractTokenUsage(result.usage)
        pipeline.recordUsage(modelId, provider, usage, Date.now() - startMs, false)
      }

      return result
    },

    // -----------------------------------------------------------------------
    // wrapStream — streaming
    // -----------------------------------------------------------------------
    async wrapStream({ doStream, params, model }) {
      const { priority, timeoutMs } = getPerRequestOptions(params, queueTimeout)
      const modelId = model.modelId
      const provider = model.provider
      const startMs = Date.now()

      // Run through pipeline for the initial request
      const streamResult = await pipeline.execute(
        modelId,
        provider,
        params.prompt,
        doStream,
        {
          streaming: true,
          priority,
          timeoutMs,
          onUsage: () => {},
        },
      )

      const { stream, ...rest } = streamResult

      // Intercept the stream to capture the 'finish' chunk usage
      const transformStream = new TransformStream<
        LanguageModelV4StreamPart,
        LanguageModelV4StreamPart
      >({
        transform(chunk, controller) {
          // Capture usage from the finish event
          if (chunk.type === 'finish' && chunk.usage) {
            const usage = extractTokenUsage(
              chunk.usage as LanguageModelV4GenerateResult['usage'],
            )
            pipeline.recordUsage(modelId, provider, usage, Date.now() - startMs, true)
          }
          controller.enqueue(chunk)
        },
      })

      return {
        stream: stream.pipeThrough(transformStream),
        ...rest,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// .wrap() convenience method
// Wraps a LanguageModelV4 with the middleware, returning the same type.
// Does NOT import from 'ai' — implements the wrapping inline so the package
// remains dependency-free at runtime.
// ---------------------------------------------------------------------------

export function wrapModel(
  model: WrappableModel,
  middleware: Middleware,
  overrides?: { modelId?: string; providerId?: string },
): WrappableModel {
  const providerId = overrides?.providerId ?? model.provider
  const modelId = overrides?.modelId ?? model.modelId

  return {
    specificationVersion: 'v4' as const,
    provider: providerId,
    modelId,
    supportedUrls: (model as unknown as Record<string, unknown>)['supportedUrls'],

    async doGenerate(params: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      return middleware.wrapGenerate({
        doGenerate: () => model.doGenerate(params),
        doStream: () => model.doStream(params),
        params,
        model,
      })
    },

    async doStream(params: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      return middleware.wrapStream({
        doGenerate: () => model.doGenerate(params),
        doStream: () => model.doStream(params),
        params,
        model,
      })
    },
  } as WrappableModel
}
