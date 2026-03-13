# Contributing to ai-sdk-rate-limiter

Thank you for taking the time to contribute.

## Before You Start

- For **bug reports and feature requests**, open a GitHub issue first.
- For **small fixes** (typos, doc clarifications), a PR without an issue is fine.
- For **significant changes** (new features, API changes, new model registry entries), please discuss in an issue first.

## Setup

Requires Node.js 18+.

```bash
git clone https://github.com/piyushgupta344/ai-sdk-rate-limiter.git
cd ai-sdk-rate-limiter
npm install
```

## Development Commands

| Command | Description |
|---|---|
| `npm test` | Run the full test suite |
| `npm run test:watch` | Watch mode for TDD |
| `npm run typecheck` | TypeScript type-check (no emit) |
| `npm run build` | Build ESM + CJS + `.d.ts` to `dist/` |
| `npm run docs:dev` | Start VitePress docs dev server |
| `npm run docs:build` | Build static docs site |

## Making Changes

1. **Fork** the repo and create a branch from `main`.
2. **Write tests** for any new behavior. PRs without tests for new features will not be merged.
3. **Run the full suite** before opening a PR: `npm test && npm run typecheck`.
4. **Update `CHANGELOG.md`** under `[Unreleased]` following the existing format.
5. **Update docs** if you add or change public API surface.

## Project Structure

```
src/
  index.ts              # Public exports
  types.ts              # All public TypeScript types
  errors.ts             # Error hierarchy
  create-rate-limiter.ts
  core/                 # Engine, pipeline, cost tracking, retry, circuit breaker
  adapters/             # Vercel AI SDK middleware, raw SDK proxy, model pool
  registry/             # Built-in model limits (openai, anthropic, google, groq, mistral, cohere)
  store/                # InMemoryStore + RedisStore
  cli/                  # npx ai-sdk-rate-limiter audit
docs/                   # VitePress documentation site
examples/               # Runnable example projects
```

## Adding a Model to the Registry

Model registry files live in `src/registry/`. Each file exports a `Record<string, ModelLimits>`.

1. Add the model entry with accurate `rpm`, `itpm` (if known), `rpd` (if known), `inputPricePerMillion`, and `outputPricePerMillion`.
2. Add a test in `src/registry/registry.test.ts`.
3. If adding a new provider, create a new file and wire it into `src/registry/index.ts`.

Pricing data sources: provider pricing pages and public API documentation. Include a comment with the date if the pricing is time-sensitive.

## Commit Messages

Use conventional commit style:

```
feat: add X
fix: correct Y when Z
docs: update configuration guide
test: cover edge case in rate-limit engine
refactor: simplify drain scheduler
```

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Docs updated if public API changed
- [ ] PR description explains the motivation

## Code Style

- TypeScript strict mode + `exactOptionalPropertyTypes` — no `as any` without justification
- Prefer explicit types on public interfaces; internal inference is fine
- No external runtime dependencies — this package has zero required deps by design
- Tests use Vitest; no `describe`-less top-level `it()` calls

## Releasing (Maintainers)

1. Update `CHANGELOG.md`: move `[Unreleased]` items to a new versioned section.
2. Bump version in `package.json`.
3. Commit: `git commit -m "chore: release vX.Y.Z"`
4. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
5. The release workflow will publish to npm and create a GitHub Release automatically.
