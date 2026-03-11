import type { CostReport, PeriodCostSummary, BudgetPeriod } from '../types.js'
import { BudgetExceededError } from '../errors.js'

interface CostEntry {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS

export class CostTracker {
  /** Rolling log of all completed requests */
  private entries: CostEntry[] = []

  /** Check whether a prospective request would bust a budget.
   *  If `budget.onExceeded === 'throw'`, throws BudgetExceededError.
   *  Otherwise returns false (caller should queue until period resets).
   */
  checkBudget(
    model: string,
    estimatedCostUsd: number,
    budget: BudgetPeriod,
    onExceeded: 'throw' | 'queue' | 'fallback',
  ): boolean {
    const now = Date.now()
    this.evict(now)

    const currentCosts = this.sumCosts(now)

    const checks: Array<{ limit: number | undefined; current: number; period: 'hourly' | 'daily' | 'monthly' }> = [
      { limit: budget.hourly, current: currentCosts.hour, period: 'hourly' },
      { limit: budget.daily, current: currentCosts.day, period: 'daily' },
      { limit: budget.monthly, current: currentCosts.month, period: 'monthly' },
    ]

    for (const { limit, current, period } of checks) {
      if (limit !== undefined && current + estimatedCostUsd > limit) {
        // 'throw' and 'fallback' both raise an error — the adapter handles
        // the fallback redirect; 'queue' returns false for the caller to queue.
        if (onExceeded === 'throw' || onExceeded === 'fallback') {
          throw new BudgetExceededError(model, current, limit, period)
        }
        return false // caller should queue
      }
    }

    return true // ok to proceed
  }

  /**
   * Record actual token usage from a completed request.
   *
   * @param inputPricePerMillion  USD per million input tokens
   * @param outputPricePerMillion USD per million output tokens
   */
  record(
    model: string,
    usage: TokenUsage,
    inputPricePerMillion: number,
    outputPricePerMillion: number,
  ): number {
    const costUsd =
      (usage.inputTokens / 1_000_000) * inputPricePerMillion +
      (usage.outputTokens / 1_000_000) * outputPricePerMillion

    this.entries.push({
      timestamp: Date.now(),
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
    })

    return costUsd
  }

  estimateCost(
    inputTokens: number,
    outputTokens: number,
    inputPricePerMillion: number,
    outputPricePerMillion: number,
  ): number {
    return (
      (inputTokens / 1_000_000) * inputPricePerMillion +
      (outputTokens / 1_000_000) * outputPricePerMillion
    )
  }

  getReport(): CostReport {
    const now = Date.now()
    this.evict(now)

    const hour = this.summarize(now - HOUR_MS, now)
    const day = this.summarize(now - DAY_MS, now)
    const month = this.summarize(now - MONTH_MS, now)

    const byModel: Record<string, PeriodCostSummary> = {}
    for (const entry of this.entries) {
      if (entry.timestamp > now - MONTH_MS) {
        if (!byModel[entry.model]) {
          byModel[entry.model] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
        }
        const m = byModel[entry.model]!
        m.requests++
        m.inputTokens += entry.inputTokens
        m.outputTokens += entry.outputTokens
        m.costUsd += entry.costUsd
      }
    }

    return { hour, day, month, byModel }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private evict(now: number): void {
    // Keep only last 30 days of entries
    const cutoff = now - MONTH_MS
    let i = 0
    while (i < this.entries.length && (this.entries[i]?.timestamp ?? 0) < cutoff) i++
    if (i > 0) this.entries.splice(0, i)
  }

  private sumCosts(now: number): { hour: number; day: number; month: number } {
    let hour = 0
    let day = 0
    let month = 0

    for (const entry of this.entries) {
      const age = now - entry.timestamp
      if (age < HOUR_MS) hour += entry.costUsd
      if (age < DAY_MS) day += entry.costUsd
      if (age < MONTH_MS) month += entry.costUsd
    }

    return { hour, day, month }
  }

  private summarize(from: number, to: number): PeriodCostSummary {
    const summary: PeriodCostSummary = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }

    for (const entry of this.entries) {
      if (entry.timestamp >= from && entry.timestamp <= to) {
        summary.requests++
        summary.inputTokens += entry.inputTokens
        summary.outputTokens += entry.outputTokens
        summary.costUsd += entry.costUsd
      }
    }

    return summary
  }
}
