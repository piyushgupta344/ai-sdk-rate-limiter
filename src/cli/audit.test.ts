import { describe, it, expect } from 'vitest'
import {
  parseHeaderInt,
  parseOpenAIHeaders,
  parseAnthropicHeaders,
  headersToRecord,
} from './sniff.js'
import { compareToRegistry, generateConfigSnippet } from './audit.js'
import type { SniffResult } from './sniff.js'

// ---------------------------------------------------------------------------
// Header parsing — pure functions
// ---------------------------------------------------------------------------

describe('parseHeaderInt', () => {
  it('parses a valid integer string', () => {
    expect(parseHeaderInt('60')).toBe(60)
  })

  it('returns null for null', () => {
    expect(parseHeaderInt(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseHeaderInt(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseHeaderInt('')).toBeNull()
  })

  it('returns null for a non-numeric string', () => {
    expect(parseHeaderInt('abc')).toBeNull()
  })

  it('truncates to integer (ignores decimals)', () => {
    expect(parseHeaderInt('100.9')).toBe(100)
  })
})

describe('parseOpenAIHeaders', () => {
  it('extracts rpm and tpm from x-ratelimit-limit-* headers', () => {
    const headers = {
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-limit-tokens': '80000',
    }
    expect(parseOpenAIHeaders(headers)).toEqual({ rpm: 60, tpm: 80000 })
  })

  it('returns nulls when headers are absent', () => {
    expect(parseOpenAIHeaders({})).toEqual({ rpm: null, tpm: null })
  })

  it('handles partial headers', () => {
    const headers = { 'x-ratelimit-limit-requests': '30' }
    expect(parseOpenAIHeaders(headers)).toEqual({ rpm: 30, tpm: null })
  })
})

describe('parseAnthropicHeaders', () => {
  it('extracts rpm and tpm from anthropic-ratelimit-* headers', () => {
    const headers = {
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-tokens-limit': '100000',
    }
    expect(parseAnthropicHeaders(headers)).toEqual({ rpm: 50, tpm: 100000 })
  })

  it('returns nulls when headers are absent', () => {
    expect(parseAnthropicHeaders({})).toEqual({ rpm: null, tpm: null })
  })
})

describe('headersToRecord', () => {
  it('converts Headers to a lowercase-keyed plain object', () => {
    const h = new Headers({
      'X-RateLimit-Limit-Requests': '60',
      'Content-Type': 'application/json',
    })
    const record = headersToRecord(h)
    expect(record['x-ratelimit-limit-requests']).toBe('60')
    expect(record['content-type']).toBe('application/json')
    // Originals shouldn't be present
    expect(record['X-RateLimit-Limit-Requests']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// compareToRegistry
// ---------------------------------------------------------------------------

describe('compareToRegistry', () => {
  it('marks rpmChanged when live rpm differs from registry', () => {
    const result: SniffResult = {
      provider: 'openai',
      model: 'gpt-4o',
      rpm: 1000, // registry default is 500
      tpm: null,
      error: null,
    }
    const audit = compareToRegistry(result)
    expect(audit.rpmChanged).toBe(true)
    expect(audit.registryRpm).toBeGreaterThan(0)
  })

  it('marks rpmChanged false when rpm matches registry', () => {
    const result: SniffResult = {
      provider: 'openai',
      model: 'gpt-4o',
      rpm: null, // not detected
      tpm: null,
      error: null,
    }
    const audit = compareToRegistry(result)
    expect(audit.rpmChanged).toBe(false)
  })

  it('marks tpmChanged false when tpm is null', () => {
    const result: SniffResult = {
      provider: 'openai',
      model: 'gpt-4o',
      rpm: null,
      tpm: null,
      error: null,
    }
    const audit = compareToRegistry(result)
    expect(audit.tpmChanged).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// generateConfigSnippet
// ---------------------------------------------------------------------------

describe('generateConfigSnippet', () => {
  it('returns empty string when no models changed', () => {
    const providers = [
      {
        provider: 'openai',
        envVar: 'OPENAI_API_KEY',
        configured: true,
        models: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            rpm: null,
            tpm: null,
            error: null,
            registryRpm: 500,
            registryItpm: 30000,
            rpmChanged: false,
            tpmChanged: false,
          },
        ],
      },
    ]
    expect(generateConfigSnippet(providers)).toBe('')
  })

  it('generates a config snippet for changed models', () => {
    const providers = [
      {
        provider: 'openai',
        envVar: 'OPENAI_API_KEY',
        configured: true,
        models: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            rpm: 1000,
            tpm: 90000,
            error: null,
            registryRpm: 500,
            registryItpm: 30000,
            rpmChanged: true,
            tpmChanged: true,
          },
        ],
      },
    ]
    const snippet = generateConfigSnippet(providers)
    expect(snippet).toContain("'gpt-4o'")
    expect(snippet).toContain('rpm: 1000')
    expect(snippet).toContain('itpm:')
    expect(snippet).toContain('createRateLimiter')
  })

  it('skips unconfigured providers', () => {
    const providers = [
      {
        provider: 'openai',
        envVar: 'OPENAI_API_KEY',
        configured: false,
        models: [],
      },
    ]
    expect(generateConfigSnippet(providers)).toBe('')
  })
})
