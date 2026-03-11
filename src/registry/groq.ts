import type { ModelLimits } from '../types.js'

/**
 * Groq model limits.
 *
 * Defaults reflect the free tier (no credit card required) — the most
 * conservative Groq rate limits. Production / on-demand tiers are
 * significantly higher (6,000 RPM, 200k TPM for most models).
 *
 * Override with your actual plan via createRateLimiter({ limits: {...} }).
 *
 * Rate limits: https://console.groq.com/docs/rate-limits
 * Pricing: https://groq.com/pricing  (on-demand, USD per million tokens)
 *
 * Groq does not charge per token on the free tier; pricing below applies to
 * the on-demand (pay-as-you-go) tier. Free tier has $0 cost but hard RPM caps.
 */
export const GROQ_MODELS: Record<string, ModelLimits> = {
  // -------------------------------------------------------------------------
  // Llama 3.3 family
  // -------------------------------------------------------------------------
  'llama-3.3-70b-versatile': {
    rpm: 30,
    itpm: 6_000,
    otpm: 6_000,
    rpd: 1_000,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
  },
  'llama-3.3-70b-specdec': {
    rpm: 30,
    itpm: 6_000,
    otpm: 6_000,
    rpd: 1_000,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.99,
  },

  // -------------------------------------------------------------------------
  // Llama 3.1 family
  // -------------------------------------------------------------------------
  'llama-3.1-8b-instant': {
    rpm: 30,
    itpm: 20_000,
    otpm: 20_000,
    rpd: 14_400,
    inputPricePerMillion: 0.05,
    outputPricePerMillion: 0.08,
  },
  'llama-3.1-70b-versatile': {
    rpm: 30,
    itpm: 6_000,
    otpm: 6_000,
    rpd: 1_000,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
  },

  // -------------------------------------------------------------------------
  // Llama 3 family
  // -------------------------------------------------------------------------
  'llama3-70b-8192': {
    rpm: 30,
    itpm: 6_000,
    otpm: 6_000,
    rpd: 14_400,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
  },
  'llama3-8b-8192': {
    rpm: 30,
    itpm: 30_000,
    otpm: 30_000,
    rpd: 14_400,
    inputPricePerMillion: 0.05,
    outputPricePerMillion: 0.08,
  },
  'llama-guard-3-8b': {
    rpm: 30,
    itpm: 15_000,
    otpm: 15_000,
    rpd: 14_400,
    inputPricePerMillion: 0.20,
    outputPricePerMillion: 0.20,
  },

  // -------------------------------------------------------------------------
  // Mixtral family
  // -------------------------------------------------------------------------
  'mixtral-8x7b-32768': {
    rpm: 30,
    itpm: 5_000,
    otpm: 5_000,
    rpd: 14_400,
    inputPricePerMillion: 0.24,
    outputPricePerMillion: 0.24,
  },

  // -------------------------------------------------------------------------
  // Gemma family
  // -------------------------------------------------------------------------
  'gemma2-9b-it': {
    rpm: 30,
    itpm: 15_000,
    otpm: 15_000,
    rpd: 14_400,
    inputPricePerMillion: 0.20,
    outputPricePerMillion: 0.20,
  },
  'gemma-7b-it': {
    rpm: 30,
    itpm: 15_000,
    otpm: 15_000,
    rpd: 14_400,
    inputPricePerMillion: 0.07,
    outputPricePerMillion: 0.07,
  },

  // -------------------------------------------------------------------------
  // Deepseek family
  // -------------------------------------------------------------------------
  'deepseek-r1-distill-llama-70b': {
    rpm: 30,
    itpm: 6_000,
    otpm: 6_000,
    rpd: 1_000,
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 0.99,
  },
  'deepseek-r1-distill-qwen-32b': {
    rpm: 30,
    itpm: 6_000,
    otpm: 6_000,
    rpd: 1_000,
    inputPricePerMillion: 0.69,
    outputPricePerMillion: 0.69,
  },
}
