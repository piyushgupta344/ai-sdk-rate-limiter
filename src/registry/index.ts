import type { ModelLimits, ModelLimitOverride } from '../types.js'
import { OPENAI_MODELS } from './openai.js'
import { ANTHROPIC_MODELS } from './anthropic.js'
import { GOOGLE_MODELS } from './google.js'

/**
 * Fallback limits used when a model is not in the registry.
 * Very conservative — 60 RPM, 100k ITPM, zero cost tracking.
 */
const FALLBACK_LIMITS: ModelLimits = {
  rpm: 60,
  itpm: 100_000,
  otpm: 100_000,
  inputPricePerMillion: 0,
  outputPricePerMillion: 0,
}

/**
 * Normalize a provider string to a short canonical form.
 * 'openai.chat' → 'openai', 'anthropic' → 'anthropic', etc.
 */
function normalizeProvider(provider: string): string {
  return provider.split('.')[0]?.toLowerCase() ?? provider.toLowerCase()
}

/**
 * Look up rate limits and pricing for a model.
 * Resolution order:
 *   1. User overrides (from createRateLimiter config)
 *   2. Built-in registry (provider + modelId)
 *   3. Fallback defaults
 */
export function resolveModelLimits(
  modelId: string,
  provider: string,
  userOverrides: Record<string, ModelLimitOverride>,
): ModelLimits {
  const normalizedProvider = normalizeProvider(provider)

  // Base from built-in registry
  const registryLookup = getFromRegistry(modelId, normalizedProvider)
  const base: ModelLimits = registryLookup ?? FALLBACK_LIMITS

  // Apply user overrides (exact model ID match, or wildcard via provider)
  const override = userOverrides[modelId] ?? userOverrides[`${normalizedProvider}/*`]
  if (!override) return base

  const merged: ModelLimits = {
    rpm: override.rpm ?? base.rpm,
    inputPricePerMillion: override.inputPricePerMillion ?? base.inputPricePerMillion,
    outputPricePerMillion: override.outputPricePerMillion ?? base.outputPricePerMillion,
  }

  // Only set optional fields when a value exists — required by exactOptionalPropertyTypes
  const itpm = override.itpm ?? base.itpm
  if (itpm !== undefined) merged.itpm = itpm

  const otpm = override.otpm ?? base.otpm
  if (otpm !== undefined) merged.otpm = otpm

  const rpd = override.rpd ?? base.rpd
  if (rpd !== undefined) merged.rpd = rpd

  return merged
}

function getFromRegistry(modelId: string, provider: string): ModelLimits | undefined {
  // Try exact match first
  if (provider === 'openai') {
    if (OPENAI_MODELS[modelId]) return OPENAI_MODELS[modelId]
    // Fuzzy: some providers alias with a prefix (e.g. 'openai/gpt-4o')
    const stripped = modelId.replace(/^openai\//, '')
    if (OPENAI_MODELS[stripped]) return OPENAI_MODELS[stripped]
  }

  if (provider === 'anthropic') {
    if (ANTHROPIC_MODELS[modelId]) return ANTHROPIC_MODELS[modelId]
    const stripped = modelId.replace(/^anthropic\//, '')
    if (ANTHROPIC_MODELS[stripped]) return ANTHROPIC_MODELS[stripped]
  }

  if (provider === 'google' || provider === 'google-generativeai' || provider === 'vertex') {
    if (GOOGLE_MODELS[modelId]) return GOOGLE_MODELS[modelId]
    const stripped = modelId.replace(/^(google|vertex)\//, '')
    if (GOOGLE_MODELS[stripped]) return GOOGLE_MODELS[stripped]
  }

  // Cross-provider scan (for unknown or gateway providers)
  return (
    OPENAI_MODELS[modelId] ??
    ANTHROPIC_MODELS[modelId] ??
    GOOGLE_MODELS[modelId]
  )
}

/** Check whether a model is in the built-in registry */
export function isKnownModel(modelId: string, provider: string): boolean {
  return getFromRegistry(modelId, normalizeProvider(provider)) !== undefined
}
