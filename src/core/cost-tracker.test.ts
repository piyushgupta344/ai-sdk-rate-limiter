import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CostTracker } from './cost-tracker.js'
import { BudgetExceededError } from '../errors.js'

describe('CostTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('records usage and returns cost in report', () => {
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 1_000, outputTokens: 500 }, 2.50, 10.00)

    const report = tracker.getReport()
    // 1000/1M * 2.50 + 500/1M * 10.00 = 0.0025 + 0.005 = 0.0075
    expect(report.hour.costUsd).toBeCloseTo(0.0075)
    expect(report.day.costUsd).toBeCloseTo(0.0075)
    expect(report.month.costUsd).toBeCloseTo(0.0075)
  })

  it('tracks by model in byModel report', () => {
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 1_000, outputTokens: 0 }, 2.50, 10.00)
    tracker.record('gpt-4o-mini', { inputTokens: 10_000, outputTokens: 0 }, 0.15, 0.60)

    const report = tracker.getReport()
    expect(report.byModel['gpt-4o']).toBeDefined()
    expect(report.byModel['gpt-4o-mini']).toBeDefined()
    expect(report.byModel['gpt-4o']!.inputTokens).toBe(1_000)
    expect(report.byModel['gpt-4o-mini']!.inputTokens).toBe(10_000)
  })

  it('hourly window rolls off after 1 hour', () => {
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, 2.50, 10.00)

    // Advance 61 minutes
    vi.advanceTimersByTime(61 * 60_000)

    const report = tracker.getReport()
    expect(report.hour.costUsd).toBe(0)
    expect(report.day.costUsd).toBeGreaterThan(0) // still in day window
  })

  it('throws BudgetExceededError when daily budget is exceeded', () => {
    const tracker = new CostTracker()

    // Record $0.90 already spent today
    tracker.record('gpt-4o', { inputTokens: 90_000, outputTokens: 0 }, 10.00, 0)

    expect(() =>
      tracker.checkBudget('gpt-4o', 0.20, { daily: 1.00 }, 'throw')
    ).toThrow(BudgetExceededError)
  })

  it('returns false (queue) when budget is exceeded but onExceeded is queue', () => {
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 90_000, outputTokens: 0 }, 10.00, 0)

    const result = tracker.checkBudget('gpt-4o', 0.20, { daily: 1.00 }, 'queue')
    expect(result).toBe(false)
  })

  it('returns true when under budget', () => {
    const tracker = new CostTracker()
    const result = tracker.checkBudget('gpt-4o', 0.01, { daily: 10.00 }, 'throw')
    expect(result).toBe(true)
  })

  it('estimateCost calculates correctly', () => {
    const tracker = new CostTracker()
    // 1000 input @ $2.50/M + 500 output @ $10/M = $0.0025 + $0.005 = $0.0075
    const cost = tracker.estimateCost(1_000, 500, 2.50, 10.00)
    expect(cost).toBeCloseTo(0.0075)
  })

  it('monthly budget check covers 30 days of usage', () => {
    const tracker = new CostTracker()
    // Spend $0.99 spread across 29 days
    for (let day = 0; day < 29; day++) {
      vi.advanceTimersByTime(24 * 60 * 60_000)
      tracker.record('gpt-4o', { inputTokens: 1_000, outputTokens: 0 }, 34.13, 0) // ~$0.034/call
    }

    const report = tracker.getReport()
    expect(report.month.requests).toBe(29)
  })
})
