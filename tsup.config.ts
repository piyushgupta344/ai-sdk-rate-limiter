import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/redis.ts'],
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
})
