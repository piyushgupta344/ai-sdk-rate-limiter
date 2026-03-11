import type { ModelLimits } from '../types.js'

/**
 * Google Gemini model limits.
 *
 * Free tier (conservative defaults). Override via createRateLimiter({ limits: {...} }).
 *
 * Pricing as of 2025-Q1, USD per million tokens.
 * Source: https://ai.google.dev/pricing
 */
export const GOOGLE_MODELS: Record<string, ModelLimits> = {
  'gemini-2.0-flash': {
    rpm: 15,
    itpm: 1_000_000,
    otpm: 1_000_000,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.40,
  },
  'gemini-2.0-flash-exp': {
    rpm: 10,
    itpm: 1_000_000,
    otpm: 1_000_000,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.40,
  },
  'gemini-1.5-pro': {
    rpm: 2,
    itpm: 32_000,
    otpm: 8_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5.00,
  },
  'gemini-1.5-flash': {
    rpm: 15,
    itpm: 1_000_000,
    otpm: 1_000_000,
    inputPricePerMillion: 0.075,
    outputPricePerMillion: 0.30,
  },
  'gemini-1.5-flash-8b': {
    rpm: 15,
    itpm: 1_000_000,
    otpm: 1_000_000,
    inputPricePerMillion: 0.0375,
    outputPricePerMillion: 0.15,
  },
}
