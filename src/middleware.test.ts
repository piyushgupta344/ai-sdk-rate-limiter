import { describe, it, expect, vi } from 'vitest'
import {
  createRateLimiterMiddleware,
  createRateLimiterErrorHandler,
  createHonoMiddleware,
  mapErrorToResponse,
} from './middleware.js'
import {
  QueueTimeoutError,
  QueueFullError,
  BudgetExceededError,
  CircuitOpenError,
  ShutdownError,
  RateLimiterError,
} from './errors.js'
import type { RateLimiter, LimiterStatus } from './types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLimiter(overrides: Partial<RateLimiter> = {}): RateLimiter {
  return {
    wrap:          vi.fn(),
    middleware:    {} as never,
    getCostReport:    vi.fn().mockReturnValue({ hour: {}, day: {}, month: {}, byModel: {}, byScope: {} }),
    getCostForecast:  vi.fn().mockReturnValue({ hour: { spentUsd: 0, projectedUsd: 0, ratePerHourUsd: 0 }, day: { spentUsd: 0, projectedUsd: 0, ratePerHourUsd: 0 }, month: { spentUsd: 0, projectedUsd: 0, ratePerHourUsd: 0 } }),
    getStatus:     vi.fn().mockReturnValue({ models: [], totalQueueDepth: 0 } satisfies LimiterStatus),
    estimatedWait: vi.fn().mockResolvedValue(0),
    rawProxy:      vi.fn(),
    on:            vi.fn(),
    off:           vi.fn(),
    shutdown:      vi.fn().mockResolvedValue(undefined),
    warmUp:        vi.fn().mockResolvedValue(undefined),
    reset:         vi.fn(),
    ...overrides,
  }
}

function makeReq(headers: Record<string, string> = {}): Record<string, unknown> {
  return { headers, rateLimiter: undefined }
}

function makeRes() {
  const res = {
    headersSent: false,
    _status: 200,
    _body: undefined as unknown,
    _headers: {} as Record<string, string | number>,
    setHeader(name: string, value: string | number) { this._headers[name] = value },
    status(code: number) { this._status = code; return this },
    json(body: unknown) { this._body = body },
  }
  return res
}

// ---------------------------------------------------------------------------
// mapErrorToResponse
// ---------------------------------------------------------------------------

describe('mapErrorToResponse', () => {
  it('QueueTimeoutError → 503 QUEUE_TIMEOUT', () => {
    const err = new QueueTimeoutError('gpt-4o', 5_000, 10)
    const { status, body } = mapErrorToResponse(err)
    expect(status).toBe(503)
    expect(body['code']).toBe('QUEUE_TIMEOUT')
    expect(body['queueDepth']).toBe(10)
  })

  it('QueueFullError → 503 QUEUE_FULL', () => {
    const { status, body } = mapErrorToResponse(new QueueFullError('gpt-4o', 500))
    expect(status).toBe(503)
    expect(body['code']).toBe('QUEUE_FULL')
  })

  it('BudgetExceededError → 402 BUDGET_EXCEEDED with details', () => {
    const err = new BudgetExceededError('gpt-4o', 9.50, 10.00, 'daily')
    const { status, body } = mapErrorToResponse(err)
    expect(status).toBe(402)
    expect(body['code']).toBe('BUDGET_EXCEEDED')
    expect(body['period']).toBe('daily')
    expect(body['limitUsd']).toBe(10)
  })

  it('BudgetExceededError — includeDetails=false omits sensitive fields', () => {
    const err = new BudgetExceededError('gpt-4o', 9.50, 10.00, 'daily')
    const { body } = mapErrorToResponse(err, false)
    expect(body['period']).toBeUndefined()
    expect(body['limitUsd']).toBeUndefined()
  })

  it('CircuitOpenError → 503 CIRCUIT_OPEN with retryAfter', () => {
    const err = new CircuitOpenError('gpt-4o', Date.now() + 30_000)
    const { status, body } = mapErrorToResponse(err)
    expect(status).toBe(503)
    expect(body['code']).toBe('CIRCUIT_OPEN')
    expect(body['retryAfter']).toBeGreaterThan(0)
  })

  it('ShutdownError → 503 SHUTDOWN', () => {
    const { status, body } = mapErrorToResponse(new ShutdownError())
    expect(status).toBe(503)
    expect(body['code']).toBe('SHUTDOWN')
  })

  it('generic RateLimiterError → 429 RATE_LIMITED', () => {
    const err = new RateLimiterError('something went wrong')
    const { status, body } = mapErrorToResponse(err)
    expect(status).toBe(429)
    expect(body['code']).toBe('RATE_LIMITED')
  })
})

// ---------------------------------------------------------------------------
// createRateLimiterMiddleware — middleware
// ---------------------------------------------------------------------------

describe('createRateLimiterMiddleware — middleware', () => {
  it('attaches scope to req.rateLimiter', () => {
    const { middleware } = createRateLimiterMiddleware(makeLimiter(), {
      scope: (req) => req.headers['x-user-id'] as string,
    })
    const req  = makeReq({ 'x-user-id': 'alice' })
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect((req['rateLimiter'] as Record<string, unknown>)['scope']).toBe('alice')
  })

  it('attaches static priority to req.rateLimiter', () => {
    const { middleware } = createRateLimiterMiddleware(makeLimiter(), {
      priority: 'high',
    })
    const req  = makeReq()
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect((req['rateLimiter'] as Record<string, unknown>)['priority']).toBe('high')
  })

  it('derives priority from a function', () => {
    const { middleware } = createRateLimiterMiddleware(makeLimiter(), {
      priority: (req) => req.headers['x-plan'] === 'pro' ? 'high' : 'low',
    })
    const req  = makeReq({ 'x-plan': 'pro' })
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect((req['rateLimiter'] as Record<string, unknown>)['priority']).toBe('high')
  })

  it('omits undefined scope from context object', () => {
    const { middleware } = createRateLimiterMiddleware(makeLimiter(), {
      scope: () => undefined,
    })
    const req  = makeReq()
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect('scope' in (req['rateLimiter'] as object)).toBe(false)
  })

  it('injects X-RateLimit-* headers when model is found', () => {
    const limiter = makeLimiter({
      getStatus: vi.fn().mockReturnValue({
        models: [{
          modelId:             'gpt-4o',
          provider:            'openai',
          requestsInWindow:    42,
          inputTokensInWindow: 0,
          outputTokensInWindow: 0,
          queueDepth:          3,
          estimatedWaitMs:     500,
          backoffUntil:        null,
        }],
        totalQueueDepth: 3,
      } satisfies LimiterStatus),
    })

    const { middleware } = createRateLimiterMiddleware(limiter, {
      injectHeaders: 'gpt-4o',
    })
    const req  = makeReq()
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect(res._headers['X-RateLimit-Model']).toBe('gpt-4o')
    expect(res._headers['X-RateLimit-Queue-Depth']).toBe(3)
    expect(res._headers['X-RateLimit-Requests-Window']).toBe(42)
    expect(res._headers['X-RateLimit-Estimated-Wait-Ms']).toBe(500)
  })

  it('skips header injection when model not in status', () => {
    const { middleware } = createRateLimiterMiddleware(makeLimiter(), {
      injectHeaders: 'unknown-model',
    })
    const req  = makeReq()
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect(res._headers['X-RateLimit-Model']).toBeUndefined()
  })

  it('derives model for headers from a function', () => {
    const limiter = makeLimiter({
      getStatus: vi.fn().mockReturnValue({
        models: [{
          modelId: 'gpt-4o-mini', provider: 'openai',
          requestsInWindow: 5, inputTokensInWindow: 0, outputTokensInWindow: 0,
          queueDepth: 0, estimatedWaitMs: 0, backoffUntil: null,
        }],
        totalQueueDepth: 0,
      } satisfies LimiterStatus),
    })
    const { middleware } = createRateLimiterMiddleware(limiter, {
      injectHeaders: (req) => req.headers['x-model'] as string,
    })
    const req  = makeReq({ 'x-model': 'gpt-4o-mini' })
    const res  = makeRes()
    const next = vi.fn()

    middleware(req as never, res as never, next)

    expect(res._headers['X-RateLimit-Model']).toBe('gpt-4o-mini')
  })
})

// ---------------------------------------------------------------------------
// createRateLimiterMiddleware — errorHandler
// ---------------------------------------------------------------------------

describe('createRateLimiterMiddleware — errorHandler', () => {
  it('passes non-rate-limiter errors to next', () => {
    const { errorHandler } = createRateLimiterMiddleware(makeLimiter())
    const err  = new Error('db error')
    const next = vi.fn()
    const res  = makeRes()

    errorHandler(err, makeReq() as never, res as never, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res._body).toBeUndefined()
  })

  it('converts QueueTimeoutError to 503', () => {
    const { errorHandler } = createRateLimiterMiddleware(makeLimiter())
    const err  = new QueueTimeoutError('gpt-4o', 30_000, 5)
    const next = vi.fn()
    const res  = makeRes()

    errorHandler(err, makeReq() as never, res as never, next)

    expect(next).not.toHaveBeenCalled()
    expect(res._status).toBe(503)
    expect((res._body as Record<string, unknown>)['code']).toBe('QUEUE_TIMEOUT')
  })

  it('converts BudgetExceededError to 402', () => {
    const { errorHandler } = createRateLimiterMiddleware(makeLimiter())
    const err  = new BudgetExceededError('gpt-4o', 9.99, 10.00, 'daily')
    const next = vi.fn()
    const res  = makeRes()

    errorHandler(err, makeReq() as never, res as never, next)

    expect(res._status).toBe(402)
  })

  it('skips when headers already sent', () => {
    const { errorHandler } = createRateLimiterMiddleware(makeLimiter())
    const err  = new QueueFullError('gpt-4o', 100)
    const next = vi.fn()
    const res  = { ...makeRes(), headersSent: true }

    errorHandler(err, makeReq() as never, res as never, next)

    // passes to next so Express knows to log it
    expect(next).toHaveBeenCalledWith(err)
  })
})

// ---------------------------------------------------------------------------
// createRateLimiterErrorHandler
// ---------------------------------------------------------------------------

describe('createRateLimiterErrorHandler', () => {
  it('uses custom format when provided', () => {
    const handler = createRateLimiterErrorHandler({
      format: (err) => err instanceof BudgetExceededError
        ? { status: 429, body: { custom: true } }
        : null,
    })
    const res  = makeRes()
    const next = vi.fn()

    handler(new BudgetExceededError('m', 1, 10, 'daily'), makeReq() as never, res as never, next)

    expect(res._status).toBe(429)
    expect((res._body as Record<string, unknown>)['custom']).toBe(true)
  })

  it('falls through when format returns null', () => {
    const handler = createRateLimiterErrorHandler({ format: () => null })
    const err  = new ShutdownError()
    const next = vi.fn()
    const res  = makeRes()

    handler(err, makeReq() as never, res as never, next)

    expect(next).toHaveBeenCalledWith(err)
  })

  it('omits details when includeDetails is false', () => {
    const handler = createRateLimiterErrorHandler({ includeDetails: false })
    const res  = makeRes()
    const next = vi.fn()

    handler(
      new BudgetExceededError('gpt-4o', 9, 10, 'daily'),
      makeReq() as never, res as never, next,
    )

    const body = res._body as Record<string, unknown>
    expect(body['period']).toBeUndefined()
    expect(body['limitUsd']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createHonoMiddleware
// ---------------------------------------------------------------------------

describe('createHonoMiddleware', () => {
  function makeHonoContext(headers: Record<string, string> = {}) {
    const vars: Record<string, unknown> = {}
    const responseHeaders: Record<string, string> = {}
    let responseStatus = 200
    let responseBody: unknown

    return {
      req: {
        raw: new Request('http://localhost/'),
        header: (name: string) => headers[name],
      },
      set: (key: string, value: unknown) => { vars[key] = value },
      get: (key: string) => vars[key],
      json: (body: unknown, status?: number) => {
        responseBody  = body
        responseStatus = status ?? 200
        return new Response(JSON.stringify(body), { status: status ?? 200 })
      },
      header: (name: string, value: string) => { responseHeaders[name] = value },
      var: vars,
      // Test inspection
      _vars:            vars,
      _responseHeaders: responseHeaders,
      _responseStatus:  () => responseStatus,
      _responseBody:    () => responseBody,
    }
  }

  it('attaches scope to c.var.rateLimiter', async () => {
    const mw = createHonoMiddleware(makeLimiter(), {
      scope: (c) => c.req.header('x-user-id'),
    })
    const c    = makeHonoContext({ 'x-user-id': 'bob' })
    const next = vi.fn().mockResolvedValue(undefined)

    await mw(c as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect((c._vars['rateLimiter'] as Record<string, unknown>)['scope']).toBe('bob')
  })

  it('catches RateLimiterError and returns JSON response', async () => {
    const mw = createHonoMiddleware(makeLimiter())
    const c  = makeHonoContext()
    const next = vi.fn().mockRejectedValue(new QueueFullError('gpt-4o', 100))

    const response = await mw(c as never, next)

    expect(response).toBeInstanceOf(Response)
    expect(c._responseStatus()).toBe(503)
    expect((c._responseBody() as Record<string, unknown>)['code']).toBe('QUEUE_FULL')
  })

  it('re-throws non-rate-limiter errors', async () => {
    const mw = createHonoMiddleware(makeLimiter())
    const c  = makeHonoContext()
    const next = vi.fn().mockRejectedValue(new Error('unrelated'))

    await expect(mw(c as never, next)).rejects.toThrow('unrelated')
  })

  it('injects X-RateLimit-* headers', async () => {
    const limiter = makeLimiter({
      getStatus: vi.fn().mockReturnValue({
        models: [{
          modelId: 'gpt-4o', provider: 'openai',
          requestsInWindow: 10, inputTokensInWindow: 0, outputTokensInWindow: 0,
          queueDepth: 1, estimatedWaitMs: 0, backoffUntil: null,
        }],
        totalQueueDepth: 1,
      } satisfies LimiterStatus),
    })
    const mw   = createHonoMiddleware(limiter, { injectHeaders: 'gpt-4o' })
    const c    = makeHonoContext()
    const next = vi.fn().mockResolvedValue(undefined)

    await mw(c as never, next)

    expect(c._responseHeaders['X-RateLimit-Model']).toBe('gpt-4o')
    expect(c._responseHeaders['X-RateLimit-Queue-Depth']).toBe('1')
  })
})
