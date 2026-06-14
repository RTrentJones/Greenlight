# Phase 7 — Publish tooling + Claude Code plugin + wrapper repo

> **Parent:** [greenlight-v1.md](../greenlight-v1.md) §16 Phase 7 + §15. **Goal:** make the framework consumable by other repos (the wrapper `RTrentJones.dev` + others). Build the publish tooling, the agent-context plugin, and scaffold the wrapper — validate everything locally; defer the actual `npm publish` + live Cloudflare deploy (need creds).

## What was built (validated, no creds)

### A. Packages are publishable
- **tsup** emits `dist/` for `shared`/`verify`/`adapters`/`loop`/`cli` (turbo `build` task; `pnpm build:packages`). `verify` keeps `playwright` external.
- **`publishConfig` field-overrides** point the *published* package.json at `dist` (main/types/exports, cli `bin`→`dist/bin.js`) while **dev keeps `main`→`src`** — tsx/vitest/jiti/`check-all` unchanged. Versions → `0.1.0`; `repository`/`license`/`files` added.
- **CLI bundles its assets**: `cli/scripts/copy-assets.mjs` copies `tools/_template-*` → `cli/templates/` and the skill → `cli/assets/skills/` at build time; `cli/src/asset-paths.ts` resolves them from the package root (dev fallback to the repo); `add.ts` uses it; `bin.ts` shebang → `node`.
- **Changesets** (`.changeset/config.json`, five packages `fixed`/lockstep) + **`release.yml`** (creds-guarded: publishes with `NPM_TOKEN`, else packs tarballs for inspection).

### B. Agent-context distribution (§15.7)
- **Plugin** `plugin/.claude-plugin/plugin.json` + `plugin/skills/deploy-verify-promote/SKILL.md`; **marketplace** `.claude-plugin/marketplace.json` (`source: ./plugin`). Install: `/plugin marketplace add RTrentJones/greenlight` → `/plugin install greenlight@greenlight` (user scope → every repo).
- **`greenlight agent sync`** materializes the skill + a `CLAUDE.md` loop block from the CLI-bundled asset (fallback for non-plugin repos).

### C. Wrapper `RTrentJones.dev` (scaffolded locally; you push)
- Thin consumer: `greenlight.config.ts` (domain `rtrentjones.dev`), `apps/blog` (copied from the framework), `infra/main.tf` (module via git `?ref=v0.1.0`), creds-guarded `deploy`/`promote` workflows, `mise.toml`/`.node-version`.
- **Bootstrap:** framework consumed from **vendored tarballs** (`vendor/*.tgz`) via `pnpm.overrides` (forces transitive `@rtrentjones/*` → local tarballs, since pnpm won't dedupe a transitive `0.1.0` against a `file:` dep). Flip to `^0.1.0` + delete `vendor/` after publish.

## Verified locally

- `pnpm build:packages` → dist for all five; `pnpm pack` tarballs carry dist + cli `templates/`/`assets/` + dist pointers + `workspace:*`→`0.1.0`.
- Clean tarball install → **published `greenlight` bin runs** (resolves deps to dist).
- Plugin/marketplace JSON valid; `greenlight agent sync` writes the skill + CLAUDE.md.
- **Wrapper:** `pnpm install` (overrides → tarballs) → `greenlight config`/`doctor` ✔ → `pnpm blog:build` ✔ → `greenlight verify blog --url` ✔ (rss+sitemap+links, via the **published CLI**) → `greenlight add hello-mcp` copied from the **installed package's** bundled template ✔.
- Framework `pnpm run check-all` green (dev path unchanged).

## Gated (need your creds/access)

- **`npm publish`** — registry + `NPM_TOKEN`. Then in the wrapper: drop `vendor/` + `pnpm.overrides`, set deps to `^0.1.0`.
- **Tag the framework `v0.1.0`** so the wrapper's `infra/main.tf` `?ref=` resolves.
- **First live Cloudflare deploy + verify** of the wrapper blog (CF token + `rtrentjones.dev` zone + `terraform apply`/`wrangler`). The real-loop payoff.
- **Push the wrapper** (scaffolded at `../RTrentJones.dev`, awaiting your review).

## Acceptance — met (within no-creds reality)

Packages build + pack correctly and the published bin runs from a clean install; the plugin + agent-sync deliver the skill cross-repo; the wrapper consumes the framework and runs the loop locally. Real publish + live deploy are the remaining gated steps.
