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
import { BudgetExceededError } from '../errors.js'

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
  abortSignal?: AbortSignal
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
): {
  priority: Priority
  timeoutMs: number
  metadata: Record<string, unknown>
  skipBudgetCheck: boolean
  scope: string | undefined
} {
  const raw = params.providerOptions?.['rateLimiter'] as (PerRequestOptions & { _skipBudgetCheck?: boolean }) | undefined
  return {
    priority: raw?.priority ?? 'normal',
    timeoutMs: raw?.timeout ?? queueTimeout,
    metadata: raw?.metadata ?? {},
    skipBudgetCheck: raw?._skipBudgetCheck ?? false,
    scope: raw?.scope,
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
      const { priority, timeoutMs, skipBudgetCheck, scope } = getPerRequestOptions(params, queueTimeout)
      const modelId = model.modelId
      const provider = model.provider
      const startMs = Date.now()

      const result = await pipeline.execute(
        modelId,
        provider,
        params.prompt,
        doGenerate,
        {
          streaming: false,
          priority,
          timeoutMs,
          skipBudgetCheck,
          ...(scope !== undefined && { scope }),
          ...(params.abortSignal !== undefined && { signal: params.abortSignal }),
        },
      )

      const usage = result.usage
        ? extractTokenUsage(result.usage)
        : { inputTokens: 0, outputTokens: 0 }
      pipeline.recordUsage(modelId, provider, scope, usage, Date.now() - startMs, false)

      return result
    },

    // -----------------------------------------------------------------------
    // wrapStream — streaming
    // -----------------------------------------------------------------------
    async wrapStream({ doStream, params, model }) {
      const { priority, timeoutMs, skipBudgetCheck, scope } = getPerRequestOptions(params, queueTimeout)
      const modelId = model.modelId
      const provider = model.provider
      const startMs = Date.now()

      const streamResult = await pipeline.execute(
        modelId,
        provider,
        params.prompt,
        doStream,
        {
          streaming: true,
          priority,
          timeoutMs,
          skipBudgetCheck,
          ...(scope !== undefined && { scope }),
          ...(params.abortSignal !== undefined && { signal: params.abortSignal }),
        },
      )

      const { stream, ...rest } = streamResult

      // Intercept the stream to capture the 'finish' chunk usage.
      // The flush() callback fires on clean close — it handles the case where
      // the stream ends without a finish chunk (some providers, or errors).
      let usageRecorded = false
      const transformStream = new TransformStream<
        LanguageModelV4StreamPart,
        LanguageModelV4StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === 'finish') {
            usageRecorded = true
            const usage = chunk.usage
              ? extractTokenUsage(chunk.usage as LanguageModelV4GenerateResult['usage'])
              : { inputTokens: 0, outputTokens: 0 }
            pipeline.recordUsage(modelId, provider, scope, usage, Date.now() - startMs, true)
          }
          controller.enqueue(chunk)
        },
        flush() {
          if (!usageRecorded) {
            pipeline.recordUsage(
              modelId, provider, scope,
              { inputTokens: 0, outputTokens: 0 },
              Date.now() - startMs,
              true,
            )
          }
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
  overrides?: { modelId?: string; providerId?: string; fallback?: WrappableModel; scope?: string },
): WrappableModel {
  const providerId = overrides?.providerId ?? model.provider
  const modelId = overrides?.modelId ?? model.modelId
  const fallbackModel = overrides?.fallback
  const staticScope = overrides?.scope

  // Inject static scope into params if no per-request scope is set
  function injectScope(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
    if (!staticScope) return params
    const existingRl = (params.providerOptions?.['rateLimiter'] as Record<string, unknown>) ?? {}
    if (existingRl['scope']) return params // per-request scope takes precedence
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        rateLimiter: { ...existingRl, scope: staticScope },
      },
    }
  }

  return {
    specificationVersion: 'v4' as const,
    provider: providerId,
    modelId,
    supportedUrls: (model as unknown as Record<string, unknown>)['supportedUrls'],

    async doGenerate(params: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const enrichedParams = injectScope(params)
      try {
        return await middleware.wrapGenerate({
          doGenerate: () => model.doGenerate(enrichedParams),
          doStream: () => model.doStream(enrichedParams),
          params: enrichedParams,
          model,
        })
      } catch (err) {
        if (err instanceof BudgetExceededError && fallbackModel) {
          const fallbackParams = {
            ...enrichedParams,
            providerOptions: {
              ...enrichedParams.providerOptions,
              rateLimiter: {
                ...((enrichedParams.providerOptions?.['rateLimiter'] as Record<string, unknown>) ?? {}),
                _skipBudgetCheck: true,
              },
            },
          }
          return middleware.wrapGenerate({
            doGenerate: () => fallbackModel.doGenerate(fallbackParams),
            doStream: () => fallbackModel.doStream(fallbackParams),
            params: fallbackParams,
            model: fallbackModel,
          })
        }
        throw err
      }
    },

    async doStream(params: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const enrichedParams = injectScope(params)
      try {
        return await middleware.wrapStream({
          doGenerate: () => model.doGenerate(enrichedParams),
          doStream: () => model.doStream(enrichedParams),
          params: enrichedParams,
          model,
        })
      } catch (err) {
        if (err instanceof BudgetExceededError && fallbackModel) {
          const fallbackParams = {
            ...enrichedParams,
            providerOptions: {
              ...enrichedParams.providerOptions,
              rateLimiter: {
                ...((enrichedParams.providerOptions?.['rateLimiter'] as Record<string, unknown>) ?? {}),
                _skipBudgetCheck: true,
              },
            },
          }
          return middleware.wrapStream({
            doGenerate: () => fallbackModel.doGenerate(fallbackParams),
            doStream: () => fallbackModel.doStream(fallbackParams),
            params: fallbackParams,
            model: fallbackModel,
          })
        }
        throw err
      }
    },
  } as WrappableModel
}
