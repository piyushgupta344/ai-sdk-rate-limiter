/**
 * CLI entry point for ai-sdk-rate-limiter.
 *
 * Usage:
 *   npx ai-sdk-rate-limiter audit [--provider <name>] [--json]
 *   npx ai-sdk-rate-limiter audit --help
 */

import { runAudit } from './audit.js'

// ---------------------------------------------------------------------------
// Arg parsing (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  command: string | undefined
  provider: string | undefined
  json: boolean
  help: boolean
  version: boolean
} {
  const args = argv.slice(2) // strip node + script path
  let command: string | undefined
  let provider: string | undefined
  let json = false
  let help = false
  let version = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--version' || arg === '-v') {
      version = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--provider' || arg === '-p') {
      provider = args[++i]
    } else if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length)
    } else if (!arg.startsWith('-') && command === undefined) {
      command = arg
    }
  }

  return { command, provider, json, help, version }
}

// ---------------------------------------------------------------------------
// Help / version text
// ---------------------------------------------------------------------------

const VERSION = '0.6.0'

const HELP = `
ai-sdk-rate-limiter — smart rate limiting middleware for AI API calls

USAGE
  npx ai-sdk-rate-limiter <command> [options]

COMMANDS
  audit    Probe your AI API keys to detect your actual rate limit tier
           and output a ready-to-paste config block.

OPTIONS
  --provider, -p <name>   Only audit one provider (openai, anthropic, groq,
                          mistral, cohere)
  --json                  Output machine-readable JSON
  --version, -v           Print version
  --help, -h              Show this help

ENVIRONMENT VARIABLES
  OPENAI_API_KEY          Required for OpenAI audit
  ANTHROPIC_API_KEY       Required for Anthropic audit
  GROQ_API_KEY            Required for Groq audit
  MISTRAL_API_KEY         Required for Mistral audit
  COHERE_API_KEY          Required for Cohere audit

EXAMPLES
  npx ai-sdk-rate-limiter audit
  npx ai-sdk-rate-limiter audit --provider openai
  npx ai-sdk-rate-limiter audit --json
`.trimStart()

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, provider, json, help, version } = parseArgs(process.argv)

  if (version) {
    console.log(VERSION)
    return
  }

  if (help || command === undefined) {
    console.log(HELP)
    process.exit(command === undefined && !help ? 1 : 0)
  }

  if (command !== 'audit') {
    console.error(`Unknown command: ${command}\nRun with --help for usage.`)
    process.exit(1)
  }

  await runAudit({ ...(provider !== undefined && { provider }), json })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
