import type { ModelLimits } from '../types.js'

/**
 * OpenAI model limits.
 *
 * These are Tier 1 (free/starter) limits — the lowest common denominator.
 * They're intentionally conservative so the limiter works safely out of the box.
 * Override with your actual tier limits via createRateLimiter({ limits: {...} }).
 *
 * Pricing as of 2025-Q1, USD per million tokens.
 * Source: https://openai.com/pricing
 */
export const OPENAI_MODELS: Record<string, ModelLimits> = {
  // -------------------------------------------------------------------------
  // GPT-4o family
  // -------------------------------------------------------------------------
  'gpt-4o': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
  },
  'gpt-4o-2024-11-20': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
  },
  'gpt-4o-2024-08-06': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
  },
  'gpt-4o-mini': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },
  'gpt-4o-mini-2024-07-18': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },

  // -------------------------------------------------------------------------
  // Reasoning models (o-series)
  // -------------------------------------------------------------------------
  'o1': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 60.00,
  },
  'o1-2024-12-17': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 60.00,
  },
  'o1-mini': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 12.00,
  },
  'o3': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 10.00,
    outputPricePerMillion: 40.00,
  },
  'o3-mini': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 1.10,
    outputPricePerMillion: 4.40,
  },
  'o4-mini': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 1.10,
    outputPricePerMillion: 4.40,
  },

  // -------------------------------------------------------------------------
  // GPT-4 Turbo
  // -------------------------------------------------------------------------
  'gpt-4-turbo': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 10.00,
    outputPricePerMillion: 30.00,
  },
  'gpt-4-turbo-preview': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 10.00,
    outputPricePerMillion: 30.00,
  },

  // -------------------------------------------------------------------------
  // GPT-3.5
  // -------------------------------------------------------------------------
  'gpt-3.5-turbo': {
    rpm: 3_500,
    itpm: 90_000,
    otpm: 90_000,
    inputPricePerMillion: 0.50,
    outputPricePerMillion: 1.50,
  },
  'gpt-3.5-turbo-0125': {
    rpm: 3_500,
    itpm: 90_000,
    otpm: 90_000,
    inputPricePerMillion: 0.50,
    outputPricePerMillion: 1.50,
  },

  // -------------------------------------------------------------------------
  // GPT-4.1 family (hypothetical/future)
  // -------------------------------------------------------------------------
  'gpt-4.1': {
    rpm: 500,
    itpm: 30_000,
    otpm: 30_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 8.00,
  },
  'gpt-4.1-mini': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 0.40,
    outputPricePerMillion: 1.60,
  },
  'gpt-4.1-nano': {
    rpm: 500,
    itpm: 200_000,
    otpm: 200_000,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.40,
  },
}
