import type { NextConfig } from 'next'

const config: NextConfig = {
  // The rate limiter singleton lives in lib/limiter.ts and is imported by
  // both API routes. Next.js server components share module state within a
  // single process, so the singleton is naturally shared across requests.
}

export default config
