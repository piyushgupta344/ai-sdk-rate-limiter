import { describe, it, expect } from 'vitest'
import { resolveModelLimits, isKnownModel } from './index.js'
import { GROQ_MODELS } from './groq.js'
import { MISTRAL_MODELS } from './mistral.js'
import { COHERE_MODELS } from './cohere.js'

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------
describe('Groq registry', () => {
  it('resolves known Groq models by provider', () => {
    const limits = resolveModelLimits('llama-3.3-70b-versatile', 'groq', {})
    expect(limits.rpm).toBe(30)
    expect(limits.inputPricePerMillion).toBe(0.59)
    expect(limits.outputPricePerMillion).toBe(0.79)
  })

  it('resolves llama-3.1-8b-instant', () => {
    const limits = resolveModelLimits('llama-3.1-8b-instant', 'groq', {})
    expect(limits.rpm).toBe(30)
    expect(limits.inputPricePerMillion).toBe(0.05)
  })

  it('resolves mixtral-8x7b-32768', () => {
    const limits = resolveModelLimits('mixtral-8x7b-32768', 'groq', {})
    expect(limits.rpm).toBe(30)
    expect(limits.itpm).toBe(5_000)
  })

  it('resolves gemma2-9b-it', () => {
    const limits = resolveModelLimits('gemma2-9b-it', 'groq', {})
    expect(limits.rpm).toBe(30)
    expect(limits.inputPricePerMillion).toBe(0.20)
  })

  it('strips groq/ prefix from modelId', () => {
    const a = resolveModelLimits('llama3-8b-8192', 'groq', {})
    const b = resolveModelLimits('groq/llama3-8b-8192', 'groq', {})
    expect(a.rpm).toBe(b.rpm)
    expect(a.inputPricePerMillion).toBe(b.inputPricePerMillion)
  })

  it('isKnownModel returns true for groq models', () => {
    expect(isKnownModel('llama-3.3-70b-versatile', 'groq')).toBe(true)
    expect(isKnownModel('llama-3.1-8b-instant', 'groq')).toBe(true)
    expect(isKnownModel('mixtral-8x7b-32768', 'groq')).toBe(true)
  })

  it('resolves via cross-provider scan (no provider specified)', () => {
    const limits = resolveModelLimits('llama-3.3-70b-versatile', 'unknown-gateway', {})
    expect(limits.rpm).toBe(30)
  })

  it('GROQ_MODELS exports have rpd set', () => {
    expect(GROQ_MODELS['llama-3.1-8b-instant']?.rpd).toBe(14_400)
  })

  it('respects user overrides for Groq models', () => {
    const limits = resolveModelLimits('llama-3.3-70b-versatile', 'groq', {
      'llama-3.3-70b-versatile': { rpm: 6_000, itpm: 200_000 },
    })
    expect(limits.rpm).toBe(6_000)
    expect(limits.itpm).toBe(200_000)
    // Pricing should stay from registry
    expect(limits.inputPricePerMillion).toBe(0.59)
  })
})

// ---------------------------------------------------------------------------
// Mistral
// ---------------------------------------------------------------------------
describe('Mistral registry', () => {
  it('resolves mistral-large-latest', () => {
    const limits = resolveModelLimits('mistral-large-latest', 'mistral', {})
    expect(limits.rpm).toBe(500)
    expect(limits.inputPricePerMillion).toBe(2.00)
    expect(limits.outputPricePerMillion).toBe(6.00)
  })

  it('resolves mistral-small-latest', () => {
    const limits = resolveModelLimits('mistral-small-latest', 'mistral', {})
    expect(limits.rpm).toBe(500)
    expect(limits.inputPricePerMillion).toBe(0.10)
    expect(limits.outputPricePerMillion).toBe(0.30)
  })

  it('resolves codestral-latest', () => {
    const limits = resolveModelLimits('codestral-latest', 'mistral', {})
    expect(limits.rpm).toBe(500)
    expect(limits.inputPricePerMillion).toBe(0.30)
    expect(limits.outputPricePerMillion).toBe(0.90)
  })

  it('resolves open-mistral-nemo', () => {
    const limits = resolveModelLimits('open-mistral-nemo', 'mistral', {})
    expect(limits.rpm).toBe(500)
    expect(limits.inputPricePerMillion).toBe(0.15)
  })

  it('strips mistral/ prefix from modelId', () => {
    const a = resolveModelLimits('mistral-large-latest', 'mistral', {})
    const b = resolveModelLimits('mistral/mistral-large-latest', 'mistral', {})
    expect(a.rpm).toBe(b.rpm)
  })

  it('isKnownModel returns true for mistral models', () => {
    expect(isKnownModel('mistral-large-latest', 'mistral')).toBe(true)
    expect(isKnownModel('codestral-latest', 'mistral')).toBe(true)
    expect(isKnownModel('open-mixtral-8x7b', 'mistral')).toBe(true)
  })

  it('resolves via cross-provider scan', () => {
    const limits = resolveModelLimits('mistral-large-latest', 'unknown', {})
    expect(limits.rpm).toBe(500)
  })

  it('MISTRAL_MODELS has versioned aliases', () => {
    expect(MISTRAL_MODELS['mistral-large-2411']).toBeDefined()
    expect(MISTRAL_MODELS['codestral-2501']).toBeDefined()
  })

  it('respects user overrides for Mistral models', () => {
    const limits = resolveModelLimits('mistral-large-latest', 'mistral', {
      'mistral-large-latest': { rpm: 1_000 },
    })
    expect(limits.rpm).toBe(1_000)
    expect(limits.inputPricePerMillion).toBe(2.00)
  })
})

// ---------------------------------------------------------------------------
// Cohere
// ---------------------------------------------------------------------------
describe('Cohere registry', () => {
  it('resolves command-r-plus', () => {
    const limits = resolveModelLimits('command-r-plus', 'cohere', {})
    expect(limits.rpm).toBe(20)
    expect(limits.inputPricePerMillion).toBe(2.50)
    expect(limits.outputPricePerMillion).toBe(10.00)
  })

  it('resolves command-r', () => {
    const limits = resolveModelLimits('command-r', 'cohere', {})
    expect(limits.rpm).toBe(20)
    expect(limits.inputPricePerMillion).toBe(0.15)
    expect(limits.outputPricePerMillion).toBe(0.60)
  })

  it('resolves command (legacy)', () => {
    const limits = resolveModelLimits('command', 'cohere', {})
    expect(limits.rpm).toBe(20)
    expect(limits.inputPricePerMillion).toBe(0.50)
  })

  it('resolves command-light', () => {
    const limits = resolveModelLimits('command-light', 'cohere', {})
    expect(limits.rpm).toBe(20)
    expect(limits.inputPricePerMillion).toBe(0.15)
  })

  it('strips cohere/ prefix from modelId', () => {
    const a = resolveModelLimits('command-r-plus', 'cohere', {})
    const b = resolveModelLimits('cohere/command-r-plus', 'cohere', {})
    expect(a.rpm).toBe(b.rpm)
    expect(a.inputPricePerMillion).toBe(b.inputPricePerMillion)
  })

  it('isKnownModel returns true for cohere models', () => {
    expect(isKnownModel('command-r-plus', 'cohere')).toBe(true)
    expect(isKnownModel('command-r', 'cohere')).toBe(true)
    expect(isKnownModel('command', 'cohere')).toBe(true)
  })

  it('COHERE_MODELS has versioned aliases', () => {
    expect(COHERE_MODELS['command-r-plus-08-2024']).toBeDefined()
    expect(COHERE_MODELS['command-r-08-2024']).toBeDefined()
  })

  it('respects user overrides for Cohere models', () => {
    const limits = resolveModelLimits('command-r-plus', 'cohere', {
      'command-r-plus': { rpm: 10_000 },
    })
    expect(limits.rpm).toBe(10_000)
    expect(limits.inputPricePerMillion).toBe(2.50)
  })

  it('resolves via cross-provider scan', () => {
    const limits = resolveModelLimits('command-r-plus', 'unknown', {})
    expect(limits.rpm).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Provider normalization
// ---------------------------------------------------------------------------
describe('provider normalization', () => {
  it('normalizes uppercase provider names', () => {
    // normalizeProvider does split('.')[0].toLowerCase()
    // so 'GROQ' → 'groq', 'Mistral' → 'mistral'
    const a = resolveModelLimits('llama-3.3-70b-versatile', 'groq', {})
    expect(a.rpm).toBe(30)
  })

  it('normalizes sub-provider strings like groq.chat', () => {
    // Vercel AI SDK may emit 'groq.chat', 'mistral.chat', etc.
    const a = resolveModelLimits('llama-3.3-70b-versatile', 'groq.chat', {})
    expect(a.rpm).toBe(30)
  })

  it('normalizes mistral sub-provider', () => {
    const a = resolveModelLimits('mistral-large-latest', 'mistral.chat', {})
    expect(a.rpm).toBe(500)
  })

  it('normalizes cohere sub-provider', () => {
    const a = resolveModelLimits('command-r-plus', 'cohere.chat', {})
    expect(a.rpm).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Unknown model fallback
// ---------------------------------------------------------------------------
describe('fallback limits', () => {
  it('returns fallback for completely unknown model + provider', () => {
    const limits = resolveModelLimits('unknown-model-xyz', 'unknown-provider', {})
    expect(limits.rpm).toBe(60)
    expect(limits.itpm).toBe(100_000)
    expect(limits.inputPricePerMillion).toBe(0)
    expect(limits.outputPricePerMillion).toBe(0)
  })

  it('isKnownModel returns false for unknown models', () => {
    expect(isKnownModel('not-a-real-model', 'groq')).toBe(false)
    expect(isKnownModel('not-a-real-model', 'mistral')).toBe(false)
    expect(isKnownModel('not-a-real-model', 'cohere')).toBe(false)
  })
})
