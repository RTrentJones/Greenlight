# Development

> Phase 0 baseline. See [phase-0-plan.md](phase-0-plan.md) and [../greenlight-v1.md](../greenlight-v1.md) §16.

## Prerequisites

Toolchain is pinned in `mise.toml` (Node 24, pnpm 10.12.1). With [mise](https://mise.jdx.dev):

```bash
mise install      # installs the pinned Node + pnpm
mise upgrade      # later: bump within the pinned spec
```

Make sure mise is activated in your shell (`mise activate bash` in `~/.bashrc`) so versions switch on `cd`. Engines floor is `>=22` if you manage Node another way.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install workspace deps |
| `pnpm build` | typecheck all packages (Turbo). *No emit yet — see "Build model" below.* |
| `pnpm test` | run Vitest across the workspace |
| `pnpm lint` / `pnpm lint:fix` | Biome check / autofix |
| `pnpm check-seam` | fail if personal data leaked into a framework file (rule 15.2.1) |
| `pnpm check-boundaries` | dependency-cruiser: enforce consumer → framework import direction (rule 15.2.2) |
| `pnpm greenlight config` | load + validate + print the manifest (runs the CLI via tsx) |
| `pnpm run check-all` | build + lint + test + check-seam + check-boundaries (what CI runs). *Use `run` — `pnpm ci` is a reserved pnpm builtin.* |

## Layout

- `packages/shared` — `@rtrentjones/greenlight-shared`: the manifest schema (Zod), `defineConfig`, types, loader. **The substantive Phase 0 deliverable.**
- `packages/verify` — `@rtrentjones/greenlight-verify`: verify-mode contracts (impl in Phase 1).
- `packages/adapters` — `@rtrentjones/greenlight-adapters`: four-hook deploy-adapter contract (impl in Phase 1).
- `cli/` — `@rtrentjones/greenlight`: the `greenlight` bin (Phase 0: `config`/`doctor` validate the manifest).
- `tools/_template-*` — lane-template placeholders (real content in Phases 2/4/9).

## The two seam rules (keep these true)

1. **No personal data in framework files.** Domain/tokens/tool-names live only in `greenlight.config.ts` + `.greenlight/secrets.env`. `pnpm check-seam` enforces it; docs are exempt.
2. **No load-bearing logic outside `packages/*` and `cli/`.** Workflows and app files only *call* the framework. `dependency-cruiser` guards the import direction (consumer → framework, never reverse).

These two rules are what make the clone seam (§15.1) and the future package split (Phase 7) work without merge-hell.

## Build model (Phase 0)

Packages are consumed **from source** (`main`/`exports` point at `src/index.ts`), so tsx, Vitest, and jiti run them directly with no build step. `pnpm build` therefore typechecks only (`tsc --noEmit`). Real bundled artifacts + `dist` exports are introduced in **Phase 7** when the packages are published to npm.
