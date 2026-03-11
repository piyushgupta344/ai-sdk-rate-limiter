import type { ModelLimits } from '../types.js'

/**
 * Anthropic model limits.
 *
 * These are Tier 1 limits — conservative defaults.
 * Anthropic rate limits:
 *   Tier 1: 50 RPM / 30k ITPM (Sonnet/Opus), 50k ITPM (Haiku)
 *   Tier 2: 1000 RPM / 450k ITPM
 *   Tier 3: 2000 RPM / 800k ITPM
 *   Tier 4: 4000 RPM / 2M ITPM
 *
 * Key: cache_read_input_tokens do NOT count toward ITPM for most current models.
 * We only track non-cached input tokens.
 *
 * Pricing as of 2025-Q1, USD per million tokens.
 * Source: https://www.anthropic.com/pricing
 */
export const ANTHROPIC_MODELS: Record<string, ModelLimits> = {
  // -------------------------------------------------------------------------
  // Claude Opus 4 family
  // -------------------------------------------------------------------------
  'claude-opus-4-6': {
    rpm: 50,
    itpm: 30_000,
    otpm: 8_000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
  },
  'claude-opus-4-5': {
    rpm: 50,
    itpm: 30_000,
    otpm: 8_000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
  },
  'claude-opus-4': {
    rpm: 50,
    itpm: 30_000,
    otpm: 8_000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
  },

  // -------------------------------------------------------------------------
  // Claude Sonnet 4 family
  // -------------------------------------------------------------------------
  'claude-sonnet-4-6': {
    rpm: 50,
    itpm: 30_000,
    otpm: 8_000,
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
  },
  'claude-sonnet-4-5': {
    rpm: 50,
    itpm: 30_000,
    otpm: 8_000,
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
  },
  'claude-sonnet-4': {
    rpm: 50,
    itpm: 30_000,
    otpm: 8_000,
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
  },

  // -------------------------------------------------------------------------
  // Claude Haiku 4/3.5 family (high throughput, lower cost)
  // -------------------------------------------------------------------------
  'claude-haiku-4-5': {
    rpm: 50,
    itpm: 50_000,
    otpm: 10_000,
    inputPricePerMillion: 0.80,
    outputPricePerMillion: 4.00,
  },
  'claude-haiku-3-5': {
    rpm: 50,
    itpm: 50_000,
    otpm: 10_000,
    inputPricePerMillion: 0.80,
    outputPricePerMillion: 4.00,
  },
  'claude-haiku-3': {
    rpm: 50,
    itpm: 50_000,
    otpm: 10_000,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 1.25,
  },

  // -------------------------------------------------------------------------
  // Claude 3.7 Sonnet (legacy)
  // -------------------------------------------------------------------------
  'claude-sonnet-3-7': {
    rpm: 50,
    itpm: 20_000,
    otpm: 8_000,
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
  },

  // -------------------------------------------------------------------------
  // Claude 3 Opus (legacy)
  // -------------------------------------------------------------------------
  'claude-3-opus-20240229': {
    rpm: 50,
    itpm: 10_000,
    otpm: 4_000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
  },
}
