/**
 * ai-sdk-rate-limiter/middleware
 *
 * Framework-agnostic middleware helpers. Reduces per-route boilerplate to zero:
 * scope extraction, priority assignment, and rate-limiter error handling are
 * all handled at the middleware layer.
 *
 * @example Express
 * ```typescript
 * import { createRateLimiterMiddleware } from 'ai-sdk-rate-limiter/middleware'
 *
 * const { middleware, errorHandler } = createRateLimiterMiddleware(limiter, {
 *   scope: (req) => `user:${req.headers['x-user-id']}`,
 * })
 *
 * app.use(middleware)        // BEFORE routes — attaches req.rateLimiter
 *
 * app.post('/chat', async (req, res) => {
 *   await generateText({
 *     model,
 *     providerOptions: { rateLimiter: req.rateLimiter }, // just pass it through
 *   })
 * })
 *
 * app.use(errorHandler)      // AFTER routes — converts errors to proper HTTP responses
 * ```
 *
 * @example Hono
 * ```typescript
 * import { createHonoMiddleware } from 'ai-sdk-rate-limiter/middleware'
 *
 * app.use(createHonoMiddleware(limiter, {
 *   scope: (c) => c.req.header('x-user-id'),
 * }))
 *
 * app.post('/chat', async (c) => {
 *   await generateText({
 *     model,
 *     providerOptions: { rateLimiter: c.var.rateLimiter },
 *   })
 * })
 * ```
 */

import type { RateLimiter, Priority } from './types.js'
import {
  RateLimiterError,
  QueueTimeoutError,
  QueueFullError,
  BudgetExceededError,
  CircuitOpenError,
  ShutdownError,
} from './errors.js'

// ---------------------------------------------------------------------------
// Shared request context
//
// Stored on req.rateLimiter (Express) or c.var.rateLimiter (Hono).
// Pass directly to providerOptions.rateLimiter in route handlers.
// ---------------------------------------------------------------------------

export interface RateLimiterRequestContext {
  /** Scope key for per-user/org isolated rate limiting */
  scope?: string
  /** Queue priority for this request. Default: 'normal' */
  priority?: Priority
}

// Augment Node.js http.IncomingMessage so TypeScript knows about req.rateLimiter
// without requiring users to install @types/express separately.
declare module 'http' {
  interface IncomingMessage {
    /**
     * Populated by createRateLimiterMiddleware(). Pass directly to providerOptions:
     * ```typescript
     * providerOptions: { rateLimiter: req.rateLimiter }
     * ```
     */
    rateLimiter?: RateLimiterRequestContext
  }
}

// ---------------------------------------------------------------------------
// Minimal structural types — no runtime dep on express / hono / fastify
// ---------------------------------------------------------------------------

interface MinReq {
  headers: Record<string, string | string[] | undefined>
  [key: string]: unknown
}

interface MinRes {
  setHeader(name: string, value: string | number): void
  status(code: number): MinRes
  json(body: unknown): void
  readonly headersSent: boolean
  [key: string]: unknown
}

type NextFn = (err?: unknown) => void

// ---------------------------------------------------------------------------
// Options — Express
// ---------------------------------------------------------------------------

export interface RateLimiterMiddlewareOptions {
  /**
   * Extract the per-request scope from the incoming request.
   * Stored in req.rateLimiter.scope.
   *
   * @example (req) => req.headers['x-user-id'] as string
   * @example (req) => `user:${(req as any).user.id}`
   */
  scope?: (req: MinReq) => string | undefined

  /**
   * Default queue priority, or derive it per-request.
   * Stored in req.rateLimiter.priority. Default: 'normal'
   *
   * @example (req) => req.headers['x-priority'] === 'high' ? 'high' : 'normal'
   */
  priority?: Priority | ((req: MinReq) => Priority)

  /**
   * Inject X-RateLimit-* informational headers into every response.
   * Pass the model ID to inspect, or a function to derive it per-request.
   *
   * @example 'gpt-4o'
   * @example (req) => req.headers['x-ai-model'] as string ?? 'gpt-4o-mini'
   */
  injectHeaders?: string | ((req: MinReq) => string)
}

export interface ErrorHandlerOptions {
  /**
   * Include structured details (retryAfter, period, limitUsd…) in the
   * response body. Default: true
   */
  includeDetails?: boolean

  /**
   * Override the default error → HTTP mapping.
   * Return null/undefined to fall through to the next error handler.
   */
  format?: (err: RateLimiterError) => { status: number; body: unknown } | null | undefined
}

// ---------------------------------------------------------------------------
// Express: createRateLimiterMiddleware
// ---------------------------------------------------------------------------

/**
 * Returns a middleware + error handler pair for Express (or any Node.js
 * framework that uses the `(req, res, next)` calling convention).
 *
 * **middleware** — place BEFORE routes. Attaches req.rateLimiter.
 * **errorHandler** — place AFTER routes. Converts RateLimiterErrors to HTTP.
 */
export function createRateLimiterMiddleware(
  limiter: RateLimiter,
  options: RateLimiterMiddlewareOptions = {},
): {
  middleware:   (req: MinReq, res: MinRes, next: NextFn) => void
  errorHandler: (err: unknown, req: MinReq, res: MinRes, next: NextFn) => void
} {
  const middleware = (req: MinReq, res: MinRes, next: NextFn): void => {
    const scope    = options.scope?.(req)
    const priority = typeof options.priority === 'function'
      ? options.priority(req)
      : options.priority

    const ctx: RateLimiterRequestContext = {
      ...(scope    !== undefined && { scope }),
      ...(priority !== undefined && { priority }),
    }
    ;(req as Record<string, unknown>)['rateLimiter'] = ctx

    if (options.injectHeaders && !res.headersSent) {
      const modelId   = typeof options.injectHeaders === 'function'
        ? options.injectHeaders(req)
        : options.injectHeaders
      const status    = limiter.getStatus()
      const modelStat = status.models.find(m => m.modelId === modelId)

      if (modelStat) {
        res.setHeader('X-RateLimit-Model',           modelId)
        res.setHeader('X-RateLimit-Queue-Depth',     modelStat.queueDepth)
        res.setHeader('X-RateLimit-Requests-Window', modelStat.requestsInWindow)
        if (modelStat.estimatedWaitMs > 0) {
          res.setHeader('X-RateLimit-Estimated-Wait-Ms', modelStat.estimatedWaitMs)
        }
      }
    }

    next()
  }

  const errorHandler = (err: unknown, _req: MinReq, res: MinRes, next: NextFn): void => {
    if (!(err instanceof RateLimiterError)) { next(err); return }
    if (res.headersSent)                    { next(err); return }
    const { status, body } = mapErrorToResponse(err)
    res.status(status).json(body)
  }

  return { middleware, errorHandler }
}

/**
 * Standalone Express 4-argument error handler.
 * Use this when you only need error handling and not scope injection.
 *
 * @example
 * ```typescript
 * app.use(createRateLimiterErrorHandler({ includeDetails: false }))
 * ```
 */
export function createRateLimiterErrorHandler(
  options: ErrorHandlerOptions = {},
): (err: unknown, req: MinReq, res: MinRes, next: NextFn) => void {
  return (err, _req, res, next) => {
    if (!(err instanceof RateLimiterError)) { next(err); return }
    if (res.headersSent)                    { next(err); return }

    if (options.format) {
      const custom = options.format(err)
      if (custom == null) { next(err); return }
      res.status(custom.status).json(custom.body)
      return
    }

    const { status, body } = mapErrorToResponse(err, options.includeDetails)
    res.status(status).json(body)
  }
}

// ---------------------------------------------------------------------------
// Hono middleware
// ---------------------------------------------------------------------------

/**
 * Minimal Hono Context interface — structural typing, no hard `hono` dep.
 */
export interface HonoContext {
  req: {
    raw: Request
    header(name: string): string | undefined
  }
  set(key: string, value: unknown): void
  json(body: unknown, status?: number): Response
  header(name: string, value: string): void
  var: Record<string, unknown>
}

type HonoNext = () => Promise<Response | void>

/** Hono middleware handler signature */
export type HonoMiddlewareHandler = (c: HonoContext, next: HonoNext) => Promise<Response | void>

export interface HonoMiddlewareOptions {
  /**
   * Extract scope from the Hono context. Stored in c.var.rateLimiter.scope.
   *
   * @example (c) => c.req.header('x-user-id')
   * @example (c) => c.var.user?.id ? `user:${c.var.user.id}` : undefined
   */
  scope?: (c: HonoContext) => string | undefined

  /** Default queue priority, or derive it per-request. */
  priority?: Priority | ((c: HonoContext) => Priority)

  /** Inject X-RateLimit-* headers. Pass model ID or function. */
  injectHeaders?: string | ((c: HonoContext) => string)
}

/**
 * Hono middleware that attaches rateLimiter context and catches RateLimiterErrors.
 *
 * Access the context in route handlers via `c.var.rateLimiter`.
 */
export function createHonoMiddleware(
  limiter: RateLimiter,
  options: HonoMiddlewareOptions = {},
): HonoMiddlewareHandler {
  return async (c, next) => {
    const scope    = options.scope?.(c)
    const priority = typeof options.priority === 'function'
      ? options.priority(c)
      : options.priority

    const ctx: RateLimiterRequestContext = {
      ...(scope    !== undefined && { scope }),
      ...(priority !== undefined && { priority }),
    }
    c.set('rateLimiter', ctx)

    if (options.injectHeaders) {
      const modelId   = typeof options.injectHeaders === 'function'
        ? options.injectHeaders(c)
        : options.injectHeaders
      const status    = limiter.getStatus()
      const modelStat = status.models.find(m => m.modelId === modelId)

      if (modelStat) {
        c.header('X-RateLimit-Model',           modelId)
        c.header('X-RateLimit-Queue-Depth',     String(modelStat.queueDepth))
        c.header('X-RateLimit-Requests-Window', String(modelStat.requestsInWindow))
        if (modelStat.estimatedWaitMs > 0) {
          c.header('X-RateLimit-Estimated-Wait-Ms', String(modelStat.estimatedWaitMs))
        }
      }
    }

    try {
      await next()
    } catch (err) {
      if (err instanceof RateLimiterError) {
        const { status, body } = mapErrorToResponse(err)
        return c.json(body, status as Parameters<typeof c.json>[1])
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Shared: error → HTTP response
// ---------------------------------------------------------------------------

/**
 * Map any RateLimiterError to an HTTP status code + JSON body.
 *
 * Exported so you can use it in custom error handlers, non-Express frameworks,
 * or API gateway integrations.
 *
 * @example
 * ```typescript
 * import { mapErrorToResponse } from 'ai-sdk-rate-limiter/middleware'
 *
 * // Fastify onError hook
 * fastify.setErrorHandler((err, request, reply) => {
 *   if (err instanceof RateLimiterError) {
 *     const { status, body } = mapErrorToResponse(err)
 *     return reply.status(status).send(body)
 *   }
 *   reply.send(err)
 * })
 * ```
 */
export function mapErrorToResponse(
  err: RateLimiterError,
  includeDetails = true,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof QueueTimeoutError) {
    return {
      status: 503,
      body: {
        error: 'Request queued too long. Try again shortly.',
        code:  'QUEUE_TIMEOUT',
        ...(includeDetails && {
          retryAfterMs: 5_000,
          queueDepth:   err.queueDepth,
        }),
      },
    }
  }

  if (err instanceof QueueFullError) {
    return {
      status: 503,
      body: {
        error: 'Server is busy. Try again in a moment.',
        code:  'QUEUE_FULL',
      },
    }
  }

  if (err instanceof BudgetExceededError) {
    return {
      status: 402,
      body: {
        error: 'AI usage budget exceeded.',
        code:  'BUDGET_EXCEEDED',
        ...(includeDetails && {
          period:         err.period,
          limitUsd:       err.limitUsd,
          currentCostUsd: err.currentCostUsd,
        }),
      },
    }
  }

  if (err instanceof CircuitOpenError) {
    return {
      status: 503,
      body: {
        error: 'AI provider temporarily unavailable.',
        code:  'CIRCUIT_OPEN',
        ...(includeDetails && {
          retryAfter: Math.max(0, Math.ceil((err.openUntilMs - Date.now()) / 1000)),
        }),
      },
    }
  }

  if (err instanceof ShutdownError) {
    return {
      status: 503,
      body: {
        error: 'Service is shutting down.',
        code:  'SHUTDOWN',
      },
    }
  }

  return {
    status: 429,
    body: {
      error: 'Rate limit exceeded.',
      code:  'RATE_LIMITED',
    },
  }
}
