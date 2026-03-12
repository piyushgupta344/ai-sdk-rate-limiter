import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateConfig } from './config-validator.js'

describe('validateConfig', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('emits no warnings for a clean config', () => {
    validateConfig({
      retry: { retryOn: [429, 500] },
      queue: { timeout: 30_000 },
      circuit: { failureThreshold: 5 },
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns when cost.store is set', () => {
    validateConfig({
      cost: {
        store: { append: async () => {}, load: async () => [] },
      },
    })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('warmUp()')
  })

  it('warns when circuit.failureThreshold is below 3', () => {
    validateConfig({ circuit: { failureThreshold: 1 } })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('failureThreshold')
  })

  it('does not warn when circuit.failureThreshold is 3 or higher', () => {
    validateConfig({ circuit: { failureThreshold: 3 } })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns when retryOn excludes 429', () => {
    validateConfig({ retry: { retryOn: [500, 503] } })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('429')
  })

  it('does not warn when retryOn includes 429', () => {
    validateConfig({ retry: { retryOn: [429, 500] } })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when retryOn is not set (uses default)', () => {
    validateConfig({})
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns when queue.timeout is below 3000ms', () => {
    validateConfig({ queue: { timeout: 1_000 } })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('queue.timeout')
  })

  it('warns when cost.budget is set without onExceeded', () => {
    validateConfig({ cost: { budget: { daily: 10 } } })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('onExceeded')
  })

  it('does not warn when cost.budget has explicit onExceeded', () => {
    validateConfig({ cost: { budget: { daily: 10 }, onExceeded: 'throw' } })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns when onExceeded is fallback', () => {
    validateConfig({ cost: { onExceeded: 'fallback' } })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('fallback')
  })

  it('emits multiple warnings for multiple issues', () => {
    validateConfig({
      circuit: { failureThreshold: 1 },
      retry: { retryOn: [500] },
      queue: { timeout: 500 },
    })
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})
