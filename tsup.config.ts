import { defineConfig } from 'tsup'

export default defineConfig([
  // Library bundles (ESM + CJS + .d.ts)
  {
    entry: ['src/index.ts', 'src/redis.ts', 'src/otel.ts', 'src/testing.ts', 'src/prometheus.ts', 'src/statsd.ts', 'src/middleware.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    external: ['@ai-sdk/provider', 'ai'],
    esbuildOptions(options) {
      options.target = 'es2020'
    },
  },
  // CLI bundle — ESM only, shebang injected
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    banner: { js: '#!/usr/bin/env node' },
    esbuildOptions(options) {
      options.target = 'es2020'
    },
  },
])
