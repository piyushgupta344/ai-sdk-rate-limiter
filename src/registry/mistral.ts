import type { ModelLimits } from '../types.js'

/**
 * Mistral AI model limits.
 *
 * Rate limits are not published tier-by-tier by Mistral; 500 RPM / 100k ITPM
 * is a typical Tier 1 allocation. Override with your actual limits via
 * createRateLimiter({ limits: {...} }).
 *
 * Pricing: https://mistral.ai/technology  (USD per million tokens, as of 2025-Q1)
 */
export const MISTRAL_MODELS: Record<string, ModelLimits> = {
  // -------------------------------------------------------------------------
  // Mistral Large — frontier model
  // -------------------------------------------------------------------------
  'mistral-large-latest': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 6.00,
  },
  'mistral-large-2411': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 6.00,
  },
  'mistral-large-2407': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 6.00,
  },

  // -------------------------------------------------------------------------
  // Mistral Small — efficient, low-cost
  // -------------------------------------------------------------------------
  'mistral-small-latest': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.30,
  },
  'mistral-small-2409': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.30,
  },

  // -------------------------------------------------------------------------
  // Pixtral Large — multimodal
  // -------------------------------------------------------------------------
  'pixtral-large-latest': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 6.00,
  },
  'pixtral-large-2411': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 6.00,
  },
  'pixtral-12b': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.15,
  },
  'pixtral-12b-2409': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.15,
  },

  // -------------------------------------------------------------------------
  // Codestral — code-optimized
  // -------------------------------------------------------------------------
  'codestral-latest': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.30,
    outputPricePerMillion: 0.90,
  },
  'codestral-2501': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.30,
    outputPricePerMillion: 0.90,
  },

  // -------------------------------------------------------------------------
  // Open models (free / self-hosted weights available)
  // -------------------------------------------------------------------------
  'open-mistral-nemo': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.15,
  },
  'open-mixtral-8x22b': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 6.00,
  },
  'open-mixtral-8x7b': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.70,
    outputPricePerMillion: 0.70,
  },
  'open-mistral-7b': {
    rpm: 500,
    itpm: 100_000,
    otpm: 100_000,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 0.25,
  },

  // -------------------------------------------------------------------------
  // Mistral Embed — embedding only (no RPM-based generation limits)
  // -------------------------------------------------------------------------
  'mistral-embed': {
    rpm: 500,
    itpm: 100_000,
    otpm: 0,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.00,
  },
}
