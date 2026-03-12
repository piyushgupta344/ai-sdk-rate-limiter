import { describe, it, expect, vi, afterEach } from 'vitest'
import { CostTracker } from './cost-tracker.js'

const HOUR_MS = 60 * 60_000
const DAY_MS  = 24 * HOUR_MS

describe('CostTracker.getForecast()', () => {
  afterEach(() => { vi.useRealTimers() })

  it('returns zero forecast when no requests have been made', () => {
    const tracker = new CostTracker()
    const forecast = tracker.getForecast()
    expect(forecast.hour.spentUsd).toBe(0)
    expect(forecast.hour.ratePerHourUsd).toBe(0)
    expect(forecast.day.projectedUsd).toBe(0)
    expect(forecast.month.projectedUsd).toBe(0)
  })

  it('hour.spentUsd equals the sum of costs recorded in the last 60 minutes', () => {
    vi.useFakeTimers()
    const tracker = new CostTracker()

    tracker.record('gpt-4o', { inputTokens: 1000, outputTokens: 500 }, 2.5, 10, undefined)
    tracker.record('gpt-4o', { inputTokens: 500,  outputTokens: 250 }, 2.5, 10, undefined)

    const forecast = tracker.getForecast()
    // (1000/1M * 2.5) + (500/1M * 10) = 0.0025 + 0.005 = 0.0075
    // (500/1M  * 2.5) + (250/1M * 10) = 0.00125 + 0.0025 = 0.00375
    // total = 0.01125
    expect(forecast.hour.spentUsd).toBeCloseTo(0.01125, 8)
    expect(forecast.hour.ratePerHourUsd).toBeCloseTo(0.01125, 8)
  })

  it('day.projectedUsd = hourlyRate * 24', () => {
    vi.useFakeTimers()
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, 2.5, 10, undefined)

    const forecast = tracker.getForecast()
    // 1M input tokens @ $2.50/M = $2.50 in the last hour
    expect(forecast.hour.spentUsd).toBeCloseTo(2.5, 6)
    expect(forecast.day.projectedUsd).toBeCloseTo(2.5 * 24, 4)
    expect(forecast.month.projectedUsd).toBeCloseTo(2.5 * 24 * 30, 2)
  })

  it('month.spentUsd includes costs older than 24h but within 30 days', () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now - DAY_MS - 1000) // 25 hours ago
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, 5, 0, undefined)

    vi.setSystemTime(now)

    const forecast = tracker.getForecast()
    // Old cost is outside the 24h window so doesn't count toward hourlyRate
    expect(forecast.hour.spentUsd).toBe(0)
    // But it should be in the monthly spent
    expect(forecast.month.spentUsd).toBeCloseTo(5, 6)
    // Day projection is based on hourly rate (0), so 0
    expect(forecast.day.projectedUsd).toBe(0)
  })

  it('ratePerHourUsd is the same across all three periods', () => {
    vi.useFakeTimers()
    const tracker = new CostTracker()
    tracker.record('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, 3, 0, undefined)

    const forecast = tracker.getForecast()
    expect(forecast.hour.ratePerHourUsd).toBe(forecast.day.ratePerHourUsd)
    expect(forecast.day.ratePerHourUsd).toBe(forecast.month.ratePerHourUsd)
  })
})
