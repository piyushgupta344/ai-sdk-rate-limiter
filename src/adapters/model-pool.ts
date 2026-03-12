/**
 * createModelPool — round-robin load balancer across multiple LanguageModelV4 instances.
 *
 * All models in the pool should already be wrapped with limiter.wrap() so that
 * rate limiting, cost tracking, and events work correctly per model.
 *
 * @example
 * ```typescript
 * import { createRateLimiter, createModelPool } from 'ai-sdk-rate-limiter'
 * import { openai } from '@ai-sdk/openai'
 *
 * // Two API keys, each with their own limiter
 * const limiter1 = createRateLimiter({ limits: { 'gpt-4o': { rpm: 500 } } })
 * const limiter2 = createRateLimiter({ limits: { 'gpt-4o': { rpm: 500 } } })
 *
 * const pool = createModelPool([
 *   limiter1.wrap(openai('gpt-4o')),
 *   limiter2.wrap(openai('gpt-4o')),
 * ])
 *
 * // Use exactly like a regular model
 * const { text } = await generateText({ model: pool, prompt: 'Hello!' })
 * ```
 */

import type { WrappableModel } from './vercel-ai-sdk.js'

export interface ModelPoolOptions {
  /**
   * Load distribution strategy.
   * - 'round-robin' (default): cycle through models in order
   * - 'random': pick a random model each call
   */
  strategy?: 'round-robin' | 'random'
}

export function createModelPool(
  models: WrappableModel[],
  options?: ModelPoolOptions,
): WrappableModel {
  if (models.length === 0) {
    throw new Error('createModelPool: at least one model is required')
  }

  const strategy = options?.strategy ?? 'round-robin'
  let index = 0

  function pick(): WrappableModel {
    if (strategy === 'random') {
      return models[Math.floor(Math.random() * models.length)]!
    }
    const model = models[index % models.length]!
    index = (index + 1) % models.length
    return model
  }

  // Expose the first model's identity as the pool's stable identity.
  // The actual delegation happens in doGenerate/doStream.
  const primary = models[0]!

  return {
    get modelId() {
      return primary.modelId
    },
    get provider() {
      return primary.provider
    },
    doGenerate(params) {
      return pick().doGenerate(params)
    },
    doStream(params) {
      return pick().doStream(params)
    },
  }
}
