import type { ModelLimits } from '../types.js'

/**
 * Cohere model limits.
 *
 * Defaults reflect the Trial API tier (no credit card required):
 *   20 calls/minute, 1,000 calls/month.
 *
 * Production tier raises limits dramatically (10,000+ RPM).
 * Override via createRateLimiter({ limits: {...} }).
 *
 * Pricing: https://cohere.com/pricing  (USD per million tokens, as of 2025-Q1)
 * Rate limits: https://docs.cohere.com/docs/rate-limits
 */
export const COHERE_MODELS: Record<string, ModelLimits> = {
  // -------------------------------------------------------------------------
  // Command R+ — highest capability
  // -------------------------------------------------------------------------
  'command-r-plus': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
  },
  'command-r-plus-08-2024': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
  },
  'command-r-plus-04-2024': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
  },

  // -------------------------------------------------------------------------
  // Command R — balanced, RAG-optimized
  // -------------------------------------------------------------------------
  'command-r': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },
  'command-r-08-2024': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },
  'command-r-03-2024': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },

  // -------------------------------------------------------------------------
  // Command — legacy general-purpose
  // -------------------------------------------------------------------------
  'command': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.50,
    outputPricePerMillion: 1.50,
  },
  'command-nightly': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.50,
    outputPricePerMillion: 1.50,
  },
  'command-light': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },
  'command-light-nightly': {
    rpm: 20,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
  },
}
