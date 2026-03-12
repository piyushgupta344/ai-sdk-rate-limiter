import type { CostReport, PeriodCostSummary, BudgetPeriod } from '../types.js'
import type { CostStore } from '../store/cost-store-interface.js'
import { BudgetExceededError } from '../errors.js'

interface CostEntry {
  timestamp: number
  model: string
  scope?: string
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
  private readonly costStore: CostStore | undefined

  constructor(options: { store?: CostStore } = {}) {
    this.costStore = options.store
  }

  /**
   * Pre-load historical cost entries from a persistent store.
   * Call once at startup so budget caps are accurate after restarts.
   */
  async warmUp(store: CostStore): Promise<void> {
    const sinceMs = Date.now() - MONTH_MS
    try {
      const persisted = await store.load(sinceMs)
      for (const e of persisted) {
        const entry: CostEntry = e.scope !== undefined
          ? { timestamp: e.timestamp, model: e.model, scope: e.scope, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd }
          : { timestamp: e.timestamp, model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd }
        this.entries.push(entry)
      }
      this.entries.sort((a, b) => a.timestamp - b.timestamp)
    } catch {
      // Fail open — cost history not critical for operation
    }
  }

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
   * @param scope                 Optional scope key for multi-tenant attribution
   */
  record(
    model: string,
    usage: TokenUsage,
    inputPricePerMillion: number,
    outputPricePerMillion: number,
    scope?: string,
  ): number {
    const now = Date.now()
    const costUsd =
      (usage.inputTokens / 1_000_000) * inputPricePerMillion +
      (usage.outputTokens / 1_000_000) * outputPricePerMillion

    const entry: CostEntry = {
      timestamp:    now,
      model,
      inputTokens:  usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      ...(scope !== undefined && { scope }),
    }
    this.entries.push(entry)

    // Fire-and-forget persistence
    if (this.costStore) {
      const persistEntry = scope !== undefined
        ? { timestamp: entry.timestamp, model: entry.model, scope, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, costUsd: entry.costUsd }
        : { timestamp: entry.timestamp, model: entry.model, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, costUsd: entry.costUsd }
      void this.costStore.append(persistEntry)
    }

    return costUsd
  }

  /**
   * Returns the soonest timestamp (ms) at which the rolling cost windows will
   * clear enough to allow a request costing `neededCostUsd`.
   * Used by the pipeline to schedule the re-check in 'queue' budget mode.
   */
  nextBudgetClearMs(budget: BudgetPeriod, neededCostUsd: number): number {
    const now = Date.now()
    this.evict(now)

    const periods: Array<{ limit: number; windowMs: number }> = []
    if (budget.hourly !== undefined) periods.push({ limit: budget.hourly, windowMs: HOUR_MS })
    if (budget.daily !== undefined) periods.push({ limit: budget.daily, windowMs: DAY_MS })
    if (budget.monthly !== undefined) periods.push({ limit: budget.monthly, windowMs: MONTH_MS })

    let earliest = now + MONTH_MS

    for (const { limit, windowMs } of periods) {
      const spent = this.entries
        .filter(e => e.timestamp > now - windowMs)
        .reduce((s, e) => s + e.costUsd, 0)

      if (spent + neededCostUsd <= limit) continue // this period is fine

      // Walk entries oldest-first; find when enough ages out to clear the cap
      let accumulated = spent
      for (const entry of this.entries) {
        if (entry.timestamp <= now - windowMs) continue
        accumulated -= entry.costUsd
        if (accumulated + neededCostUsd <= limit) {
          earliest = Math.min(earliest, entry.timestamp + windowMs)
          break
        }
      }
    }

    return earliest
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
    const byScope: Record<string, PeriodCostSummary> = {}

    for (const entry of this.entries) {
      if (entry.timestamp > now - MONTH_MS) {
        if (!byModel[entry.model]) {
          byModel[entry.model] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
        }
        const m = byModel[entry.model]!
        m.requests++
        m.inputTokens  += entry.inputTokens
        m.outputTokens += entry.outputTokens
        m.costUsd      += entry.costUsd

        if (entry.scope) {
          if (!byScope[entry.scope]) {
            byScope[entry.scope] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
          }
          const s = byScope[entry.scope]!
          s.requests++
          s.inputTokens  += entry.inputTokens
          s.outputTokens += entry.outputTokens
          s.costUsd      += entry.costUsd
        }
      }
    }

    return { hour, day, month, byModel, byScope }
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
