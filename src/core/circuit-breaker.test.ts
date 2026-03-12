import { describe, it, expect, beforeEach } from 'vitest'
import { CircuitBreaker } from './circuit-breaker.js'

const THRESHOLD = 3
const COOLDOWN  = 1_000

let cb: CircuitBreaker

beforeEach(() => {
  cb = new CircuitBreaker({ failureThreshold: THRESHOLD, cooldownMs: COOLDOWN })
})

describe('CircuitBreaker — initial state', () => {
  it('starts CLOSED', () => {
    expect(cb.currentState).toBe('CLOSED')
    expect(cb.isOpen()).toBe(false)
  })
})

describe('CircuitBreaker — opening', () => {
  it('stays CLOSED below threshold', () => {
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.currentState).toBe('CLOSED')
    expect(cb.isOpen()).toBe(false)
  })

  it('opens after failureThreshold consecutive failures', () => {
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure()
    expect(cb.currentState).toBe('OPEN')
    expect(cb.isOpen()).toBe(true)
  })

  it('recordFailure returns true exactly when circuit opens', () => {
    cb.recordFailure()
    cb.recordFailure()
    const opened = cb.recordFailure()
    expect(opened).toBe(true)
  })

  it('recordFailure returns false for subsequent failures while OPEN', () => {
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure()
    expect(cb.recordFailure()).toBe(false)
  })
})

describe('CircuitBreaker — HALF_OPEN transition', () => {
  it('transitions OPEN → HALF_OPEN after cooldown', () => {
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure()

    // Before cooldown expires: still OPEN
    expect(cb.isOpen(Date.now())).toBe(true)

    // After cooldown expires: transitions to HALF_OPEN and allows probe
    const futureNow = Date.now() + COOLDOWN + 1
    expect(cb.isOpen(futureNow)).toBe(false)
    expect(cb.currentState).toBe('HALF_OPEN')
  })

  it('HALF_OPEN → CLOSED on successful probe', () => {
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure()
    cb.isOpen(Date.now() + COOLDOWN + 1) // trigger HALF_OPEN
    const justClosed = cb.recordSuccess()
    expect(justClosed).toBe(true)
    expect(cb.currentState).toBe('CLOSED')
  })

  it('HALF_OPEN → OPEN on failed probe', () => {
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure()
    cb.isOpen(Date.now() + COOLDOWN + 1) // trigger HALF_OPEN
    cb.recordFailure()
    expect(cb.currentState).toBe('OPEN')
  })
})

describe('CircuitBreaker — recovery', () => {
  it('resets failure counter on success', () => {
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    // Need threshold failures again to open
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.currentState).toBe('CLOSED')
    cb.recordFailure()
    expect(cb.currentState).toBe('OPEN')
  })

  it('recordSuccess returns false when circuit was already CLOSED', () => {
    const wasFailing = cb.recordSuccess()
    expect(wasFailing).toBe(false)
  })
})

describe('CircuitBreaker — tripOn', () => {
  it('uses default tripOn [500, 502, 503, 504]', () => {
    expect(cb.tripOn).toEqual([500, 502, 503, 504])
  })

  it('accepts custom tripOn list', () => {
    const custom = new CircuitBreaker({ failureThreshold: 1, tripOn: [503] })
    expect(custom.tripOn).toEqual([503])
  })
})
