/**
 * Audit orchestration — probes configured providers, compares to registry
 * defaults, and outputs actionable config overrides.
 */

import { PROBE_MODELS, sniff, type SniffResult } from './sniff.js'
import { resolveModelLimits } from '../registry/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditOptions {
  /** Only audit this provider (default: all configured providers) */
  provider?: string
  /** Output JSON instead of human-readable text */
  json?: boolean
}

interface ModelAuditResult extends SniffResult {
  registryRpm: number
  registryItpm: number | undefined
  rpmChanged: boolean
  tpmChanged: boolean
}

interface ProviderAuditResult {
  provider: string
  envVar: string
  configured: boolean
  models: ModelAuditResult[]
}

interface AuditReport {
  providers: ProviderAuditResult[]
  suggestedConfig: string
  changedCount: number
}

// ---------------------------------------------------------------------------
// Registry lookup (provider → env var name)
// ---------------------------------------------------------------------------

const PROVIDER_ENV: Record<string, string> = {
  openai:    'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq:      'GROQ_API_KEY',
  mistral:   'MISTRAL_API_KEY',
  cohere:    'COHERE_API_KEY',
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

export function compareToRegistry(result: SniffResult): ModelAuditResult {
  const limits = resolveModelLimits(result.model, result.provider, {})
  const rpmChanged = result.rpm !== null && result.rpm !== limits.rpm
  // TPM from headers ≈ ITPM + OTPM. Use as ITPM approximation for comparison.
  const tpmChanged = result.tpm !== null && limits.itpm !== undefined && result.tpm !== limits.itpm

  return {
    ...result,
    registryRpm: limits.rpm,
    registryItpm: limits.itpm,
    rpmChanged,
    tpmChanged,
  }
}

// ---------------------------------------------------------------------------
// Config snippet generation
// ---------------------------------------------------------------------------

export function generateConfigSnippet(results: ProviderAuditResult[]): string {
  const overrides: string[] = []

  for (const pr of results) {
    for (const m of pr.models) {
      if (!m.rpmChanged && !m.tpmChanged) continue
      const parts: string[] = []
      if (m.rpm !== null) parts.push(`rpm: ${m.rpm}`)
      if (m.tpm !== null) parts.push(`itpm: ${formatNum(m.tpm)}`)
      overrides.push(`    '${m.model}': { ${parts.join(', ')} },`)
    }
  }

  if (overrides.length === 0) return ''

  return [
    `const limiter = createRateLimiter({`,
    `  limits: {`,
    ...overrides,
    `  },`,
    `})`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US')
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function formatModelRow(m: ModelAuditResult): string {
  const rpmStr = m.rpm !== null ? String(m.rpm) : '—'
  const tpmStr = m.tpm !== null ? formatNum(m.tpm) : '—'
  const regRpm = String(m.registryRpm)
  const regTpm = m.registryItpm !== undefined ? formatNum(m.registryItpm) : '—'

  const rpmStatus = m.rpmChanged ? ' ≠' : ''
  const tpmStatus = m.tpmChanged ? ' ≠' : ''

  return (
    `  ${pad(m.model, 32)} ` +
    `${pad(rpmStr + rpmStatus, 10)} ` +
    `${pad(tpmStr + tpmStatus, 14)} ` +
    `(registry: ${regRpm} RPM / ${regTpm} TPM)`
  )
}

function formatProviderSection(pr: ProviderAuditResult): string {
  if (!pr.configured) {
    return `  ${pr.provider.padEnd(12)} — ${pr.envVar} not set, skipping`
  }

  const header = `  ${pr.provider.toUpperCase()}  (${pr.envVar})`
  const col = `  ${'Model'.padEnd(32)} ${'RPM'.padEnd(10)} ${'TPM'.padEnd(14)} Registry`
  const sep = `  ${'─'.repeat(78)}`

  const rows = pr.models
    .map(m =>
      m.error
        ? `  ${pad(m.model, 32)} error: ${m.error}`
        : formatModelRow(m),
    )
    .join('\n')

  return [header, col, sep, rows].join('\n')
}

function formatReport(report: AuditReport): string {
  const divider = '─'.repeat(80)
  const lines: string[] = [
    '',
    divider,
    '  ai-sdk-rate-limiter audit',
    divider,
    '',
  ]

  for (const pr of report.providers) {
    lines.push(formatProviderSection(pr))
    lines.push('')
  }

  lines.push(divider)

  if (report.changedCount === 0) {
    lines.push('  ✓ All probed models match registry defaults — no overrides needed.')
    lines.push(divider)
  } else {
    lines.push(
      `  ${report.changedCount} model(s) differ from registry defaults.`,
      `  Paste the config below into createRateLimiter():`,
      '',
      report.suggestedConfig
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n'),
      '',
      divider,
    )
  }

  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export async function runAudit(options: AuditOptions = {}): Promise<void> {
  // Resolve which providers to check
  const allProviders = Object.keys(PROVIDER_ENV)
  const providers = options.provider
    ? [options.provider.toLowerCase()]
    : allProviders

  for (const p of providers) {
    if (!PROVIDER_ENV[p]) {
      console.error(`Unknown provider: ${p}. Valid: ${allProviders.join(', ')}`)
      process.exit(1)
    }
  }

  // Collect per-provider results
  const providerResults: ProviderAuditResult[] = []

  for (const providerName of providers) {
    const envVar = PROVIDER_ENV[providerName]!
    const apiKey = process.env[envVar]

    if (!apiKey) {
      providerResults.push({
        provider: providerName,
        envVar,
        configured: false,
        models: [],
      })
      continue
    }

    const modelsToProbe = PROBE_MODELS[providerName] ?? []

    // Probe all models for this provider concurrently
    const raw = await Promise.all(modelsToProbe.map(m => sniff(providerName, apiKey, m)))
    const models = raw.map(compareToRegistry)

    providerResults.push({ provider: providerName, envVar, configured: true, models })
  }

  // Count differences
  const changedCount = providerResults
    .flatMap(pr => pr.models)
    .filter(m => m.rpmChanged || m.tpmChanged).length

  const suggestedConfig = generateConfigSnippet(providerResults)

  const report: AuditReport = { providers: providerResults, suggestedConfig, changedCount }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatReport(report))
  }
}
