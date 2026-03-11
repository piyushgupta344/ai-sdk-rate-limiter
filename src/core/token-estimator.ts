/**
 * Fast, dependency-free token estimation.
 *
 * This is a pre-flight estimate used before the request is sent — the actual
 * usage comes from the API response and reconciles the cost tracker afterwards.
 *
 * Rules of thumb:
 *   - ~4 chars per token for English text (GPT/Claude tokenisers are similar)
 *   - Images: ~500 tokens for low-detail, ~1500 for high-detail (OpenAI spec)
 *   - Tool definitions add overhead — rough 100-token flat estimate per tool
 *
 * This estimate intentionally errs slightly high to avoid over-committing the
 * sliding window and then getting a remote 429.
 */

type PromptMessage = {
  role: string
  content: string | Array<{ type: string; text?: string }>
}

/**
 * Estimate the number of input tokens from a prompt.
 * Accepts the LanguageModelV4Prompt shape (array of messages with parts).
 */
export function estimateInputTokens(prompt: unknown): number {
  if (!Array.isArray(prompt)) return 100 // safe default

  let chars = 0
  let imageCount = 0
  let toolCount = 0

  for (const message of prompt as PromptMessage[]) {
    // Count role overhead (~4 tokens per message)
    chars += 16

    const { content } = message
    if (typeof content === 'string') {
      chars += content.length
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue

        switch (part.type) {
          case 'text':
            chars += typeof part.text === 'string' ? part.text.length : 0
            break
          case 'image':
            imageCount++
            break
          case 'tool-call':
          case 'tool-result':
            toolCount++
            chars += JSON.stringify(part).length
            break
          default:
            chars += JSON.stringify(part).length
        }
      }
    }
  }

  // ~4 chars per token, plus image overhead
  const textTokens = Math.ceil(chars / 4)
  const imageTokens = imageCount * 1_000 // conservative middle estimate
  const toolTokens = toolCount * 100

  return textTokens + imageTokens + toolTokens
}

/**
 * Estimate output tokens when maxOutputTokens is set.
 * We assume the model will generate half of the max by default.
 */
export function estimateOutputTokens(maxOutputTokens: number | undefined): number {
  if (!maxOutputTokens) return 500 // conservative default
  return Math.ceil(maxOutputTokens / 2)
}
