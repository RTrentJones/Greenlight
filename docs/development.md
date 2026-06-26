# Development

> How to work in the Greenlight repo. For the system design see [architecture.md](architecture.md);
> for the spec see [../greenlight-v2.md](../greenlight-v2.md).

## Prerequisites

Toolchain is pinned in `mise.toml` (Node 24, pnpm 10.12.1). With [mise](https://mise.jdx.dev):

```bash
mise install      # installs the pinned Node + pnpm
mise upgrade      # later: bump within the pinned spec
```

Make sure mise is activated in your shell (`mise activate bash` in `~/.bashrc`) so versions switch on
`cd`. The engines floor is `>=22` if you manage Node another way. Run repo commands under the pinned
toolchain — e.g. `mise exec -- pnpm run check-all`.

`.node-version` (also `24`) exists alongside `mise.toml` because deploy platforms (Vercel, Cloudflare
Workers Builds) read `.node-version`/`engines`, not `mise.toml`. Keep the two in sync.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install workspace deps |
| `pnpm build` | typecheck all packages (Turbo). Dev consumes packages **from source** (`main` → `src`). |
| `pnpm build:packages` | tsup-emit `dist/` — bundles the libs into the CLI (the release build step) |
| `pnpm test` | Vitest across the workspace. Single file: `pnpm test cli/src/__tests__/secrets.test.ts`. Watch: `pnpm test:watch` |
| `pnpm lint` / `pnpm lint:fix` | Biome check / autofix (single quotes for JS/TS, double for JSX) |
| `pnpm check-seam` | fail if personal data (domain/email) leaks into a framework file (seam rule 1) |
| `pnpm check-boundaries` | dependency-cruiser: enforce consumer → framework import direction (seam rule 2) |
| `pnpm greenlight config` | load + validate + print the manifest (runs the CLI via tsx) |
| `pnpm run check-all` | the full suite CI runs. **Use `run`** — `pnpm ci` hits a reserved pnpm builtin |
| `pnpm run infra:test` | Terraform module tests (`infra/examples/*`). **Not in `check-all`** (needs the `terraform` binary); CI runs it in the `ci.yml` infra job. |

CLI surface (run via `pnpm greenlight <cmd>` in dev): `init`, `add`, `adopt`, `secrets gather`,
`agent sync`, `preview`, `deploy`, `verify`, `promote`, `doctor`, `config`. See
[architecture.md](architecture.md) for what each plane's commands do.

## Layout

One published package; the framework libs are bundled into it.

- `cli/` — **`@rtrentjones/greenlight`** (the only published package): the `greenlight` bin, the
  Plane-1 editor commands (`add`/`adopt`/`secrets`), the Terraform emitters, and the loop commands.
  Its npm page is [cli/README.md](../cli/README.md).
- `packages/shared` — `@rtrentjones/greenlight-shared`: the manifest schema (Zod), `defineConfig`,
  types, loader. **Bundled into the CLI; `private`.**
- `packages/verify` — `@rtrentjones/greenlight-verify`: the `verify(baseUrl, spec)` harness. Bundled; `private`.
- `packages/adapters` — `@rtrentjones/greenlight-adapters`: the four-hook deploy-adapter contract. Bundled; `private`.
- `packages/loop` — the loop helpers. Bundled; `private`.
- `packages/keepalive` — the Cloudflare Worker cron (ships as a Worker inside its Terraform module). `private`.
- `infra/modules/*` — git-sourced Terraform modules (`tool`, `tunnel`, `oci-network`,
  `oci-container-instance`, `supabase`, `vercel`, `repo`, `keepalive`).
- `.claude/skills/*` — the loop skill + per-provider skills. **Canonical source**; mirrored to
  `plugin/skills/` (the Claude Code plugin) and copied into `cli/assets/skills/` at build time by
  `scripts/copy-assets.mjs`. Edit `.claude/skills/`, then sync the mirrors (the seam check scans 150+
  framework files; keep the three copies identical).
- `tools/_template-*` — lane-template placeholders.

## Build model

Dev consumes packages **from source** (`main`/`exports` point at `src/index.ts`), so tsx, Vitest, and
jiti run them directly — `pnpm build` typechecks only. `pnpm build:packages` runs `copy-assets` +
**tsup**, bundling `shared`/`verify`/`adapters`/`loop` into `cli/dist` (`noExternal: [/^@rtrentjones\/greenlight-/]`)
while keeping `playwright` + `@anthropic-ai/sdk` external (optional deps that degrade gracefully). The
result is **one self-contained npm package** with zero `@rtrentjones/*` runtime deps. Inspect the
tarball with `pnpm --filter @rtrentjones/greenlight pack`.

## The two seam rules (keep these true)

1. **No personal data in framework files.** Domain/tool-names live only in `greenlight.config.ts`;
   tokens live only in GitHub Actions secrets. `pnpm check-seam` enforces it; docs are exempt.
2. **No load-bearing logic outside `packages/*` and `cli/`.** Workflows and app files only *call* the
   framework. `dependency-cruiser` guards the import direction (consumer → framework, never reverse).

These are what make the clone seam and the thin-consumer model work without merge-hell. The personal
repo (e.g. `RTrentJones.dev`) depends on `@rtrentjones/greenlight` and updates via `pnpm update`.

## Releasing

Publishing is **OIDC Trusted Publishing** ([`.github/workflows/release.yml`](../.github/workflows/release.yml)),
triggered by pushing a **`v*` tag** (or `workflow_dispatch`) — no `NPM_TOKEN`. The npm version, the
`MODULE_REF` ([`cli/src/version.ts`](../cli/src/version.ts)), **every workspace `package.json`**, and
the wrapper's module `?ref=` move in **lockstep**. To cut a release, run the lockstep bump:

```bash
node scripts/release.mjs <version>   # writes MODULE_REF + every package version, runs check-all
```

It does **not** tag or push (the OIDC publish stays gated). Then commit and
`git tag -a vX.Y.Z && git push origin vX.Y.Z`. A consumer adopts the new line with **`greenlight
bump`** — it re-pins the wrapper's infra `?ref=` + the npm dep to the installed version.
