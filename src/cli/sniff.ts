/**
 * Provider-specific rate limit sniffing.
 *
 * Each provider exposes rate limit headers on every API response. We make a
 * minimal (1-5 token) request per model and read back the limit headers to
 * discover the caller's actual tier.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SniffResult {
  provider: string
  model: string
  /** Requests per minute from response headers, or null if not found */
  rpm: number | null
  /** Tokens per minute from response headers, or null if not found */
  tpm: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Models to probe per provider (most-used models that have per-model limits)
// ---------------------------------------------------------------------------

export const PROBE_MODELS: Record<string, string[]> = {
  openai:    ['gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  groq:      ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  mistral:   ['mistral-large-latest', 'mistral-small-latest'],
  cohere:    ['command-r-plus', 'command-r'],
}

// ---------------------------------------------------------------------------
// Header parsing — pure functions, no I/O
// ---------------------------------------------------------------------------

/** Parse an integer from a response header value, returning null on failure. */
export function parseHeaderInt(value: string | null | undefined): number | null {
  if (!value) return null
  const n = parseInt(value, 10)
  return isNaN(n) ? null : n
}

/** Extract RPM + TPM from OpenAI-compatible response headers. */
export function parseOpenAIHeaders(
  headers: Record<string, string>,
): { rpm: number | null; tpm: number | null } {
  return {
    rpm: parseHeaderInt(headers['x-ratelimit-limit-requests']),
    tpm: parseHeaderInt(headers['x-ratelimit-limit-tokens']),
  }
}

/** Extract RPM + TPM from Anthropic response headers. */
export function parseAnthropicHeaders(
  headers: Record<string, string>,
): { rpm: number | null; tpm: number | null } {
  return {
    rpm: parseHeaderInt(headers['anthropic-ratelimit-requests-limit']),
    tpm: parseHeaderInt(headers['anthropic-ratelimit-tokens-limit']),
  }
}

/** Convert a fetch `Headers` object to a plain lowercase-keyed Record. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

// ---------------------------------------------------------------------------
// HTTP probe helpers
// ---------------------------------------------------------------------------

async function probeOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  provider: string,
): Promise<SniffResult> {
  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ai-sdk-rate-limiter-audit/1.0',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const h = headersToRecord(resp.headers)
    const { rpm, tpm } = parseOpenAIHeaders(h)

    // Accept 2xx and 4xx (headers still present on 429, 400, etc.)
    if (!resp.ok && resp.status >= 500) {
      return { provider, model, rpm: null, tpm: null, error: `HTTP ${resp.status}` }
    }

    return { provider, model, rpm, tpm, error: null }
  } catch (err) {
    return { provider, model, rpm: null, tpm: null, error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// Provider-specific probe functions
// ---------------------------------------------------------------------------

export async function sniffOpenAI(apiKey: string, model: string): Promise<SniffResult> {
  return probeOpenAICompatible('https://api.openai.com', apiKey, model, 'openai')
}

export async function sniffGroq(apiKey: string, model: string): Promise<SniffResult> {
  // Groq uses OpenAI-compatible API but at a different base URL
  return probeOpenAICompatible('https://api.groq.com/openai', apiKey, model, 'groq')
}

export async function sniffMistral(apiKey: string, model: string): Promise<SniffResult> {
  return probeOpenAICompatible('https://api.mistral.ai', apiKey, model, 'mistral')
}

export async function sniffAnthropic(apiKey: string, model: string): Promise<SniffResult> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'User-Agent': 'ai-sdk-rate-limiter-audit/1.0',
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const h = headersToRecord(resp.headers)
    const { rpm, tpm } = parseAnthropicHeaders(h)

    if (!resp.ok && resp.status >= 500) {
      return { provider: 'anthropic', model, rpm: null, tpm: null, error: `HTTP ${resp.status}` }
    }

    return { provider: 'anthropic', model, rpm, tpm, error: null }
  } catch (err) {
    return { provider: 'anthropic', model, rpm: null, tpm: null, error: String(err) }
  }
}

export async function sniffCohere(apiKey: string, model: string): Promise<SniffResult> {
  try {
    const resp = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ai-sdk-rate-limiter-audit/1.0',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    // Cohere uses OpenAI-compatible headers
    const h = headersToRecord(resp.headers)
    const { rpm, tpm } = parseOpenAIHeaders(h)

    if (!resp.ok && resp.status >= 500) {
      return { provider: 'cohere', model, rpm: null, tpm: null, error: `HTTP ${resp.status}` }
    }

    return { provider: 'cohere', model, rpm, tpm, error: null }
  } catch (err) {
    return { provider: 'cohere', model, rpm: null, tpm: null, error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// Dispatch: pick the right sniffer by provider name
// ---------------------------------------------------------------------------

export async function sniff(
  provider: string,
  apiKey: string,
  model: string,
): Promise<SniffResult> {
  switch (provider) {
    case 'openai':    return sniffOpenAI(apiKey, model)
    case 'anthropic': return sniffAnthropic(apiKey, model)
    case 'groq':      return sniffGroq(apiKey, model)
    case 'mistral':   return sniffMistral(apiKey, model)
    case 'cohere':    return sniffCohere(apiKey, model)
    default:
      return { provider, model, rpm: null, tpm: null, error: `Unknown provider: ${provider}` }
  }
}
