import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DebugLogger } from './debug-logger.js'

describe('DebugLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('does not log when disabled', () => {
    const logger = new DebugLogger(false)
    logger.log('gpt-4o', 'test message')
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('logs when enabled', () => {
    const logger = new DebugLogger(true)
    logger.log('gpt-4o', 'slot acquired')
    expect(consoleSpy).toHaveBeenCalledOnce()
    expect(consoleSpy.mock.calls[0]![0]).toContain('[ai-sdk-rate-limiter]')
    expect(consoleSpy.mock.calls[0]![0]).toContain('gpt-4o')
    expect(consoleSpy.mock.calls[0]![0]).toContain('slot acquired')
  })

  it('includes serialised details in output', () => {
    const logger = new DebugLogger(true)
    logger.log('gpt-4o', 'queuing', { queueDepth: 3, estimatedWaitMs: 1200 })
    const output = consoleSpy.mock.calls[0]![0] as string
    expect(output).toContain('queueDepth=3')
    expect(output).toContain('estimatedWaitMs=1200')
  })

  it('omits details section when details object is empty', () => {
    const logger = new DebugLogger(true)
    logger.log('gpt-4o', 'execute', {})
    const output = consoleSpy.mock.calls[0]![0] as string
    expect(output).not.toContain('()')
    expect(output).toBe('[ai-sdk-rate-limiter] gpt-4o: execute')
  })

  it('is zero-overhead when disabled — no JSON.stringify called', () => {
    const logger = new DebugLogger(false)
    const expensive = { get value() { throw new Error('should not be accessed') } }
    // Would throw if accessed — proves details are never touched when disabled
    expect(() => logger.log('m', 'msg', expensive as never)).not.toThrow()
  })
})
