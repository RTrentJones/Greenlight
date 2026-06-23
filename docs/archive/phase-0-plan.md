# Phase 0 — Monorepo skeleton + the seam (implementation plan)

> **Parent:** [greenlight-v1.md](greenlight-v1.md) §16 Phase 0. **Goal of this doc:** the concrete, ordered build plan for Phase 0 — what to create, in what order, and how we know it's done.

## Objective

Stand up a **buildable, lintable pnpm + Turborepo monorepo** with the package boundaries drawn, the **manifest schema + loader** implemented, an **example config**, and the **seam enforced in CI** — *before any deploy/verify logic exists* (that's Phase 1). Phase 0 produces no deployable artifact; it produces the skeleton and the guarantees that keep the clone-seam (§15) and the future package split honest.

**Out of scope for Phase 0:** verify modes, deploy adapters, real lane-template content, Terraform, the keepalive worker, the `init` flow. Those are stubbed as interfaces/placeholders only.

## Decisions — LOCKED

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Lint/format stack | **Biome** ✅ | One tool, fast, zero-config for a fresh monorepo. (HeistMind's ESLint config reconciled at the Phase 9 adopt, not now.) |
| D2 | Schema/validation lib | **Zod** ✅ | Ubiquitous, great TS inference; the schema doubles as the runtime validator and the source of exported types. |
| D3 | Test runner | **Vitest** ✅ | Fast, TS-native, works across all workspace packages. |
| D4 | Import-boundary enforcement (rule 15.2.2) | **dependency-cruiser** ✅ | Mechanically enforces "no load-bearing logic outside `packages/*` and `cli/`" and that consumer-facing files don't import internals. |
| D5 | Lane-template content | **Placeholder dirs only** ✅ | Real Astro/MCP templates are built in their own phases (2/4). Phase 0 just reserves the structure. |

## Target layout after Phase 0

```
greenlight/
  package.json                 # root: workspaces, scripts, packageManager pin
  pnpm-workspace.yaml
  turbo.json                   # build / lint / typecheck / test pipelines
  tsconfig.base.json
  biome.json                   # (D1)
  .dependency-cruiser.cjs      # (D4) boundary rules
  mise.toml                    # node + pnpm pin (mise)
  .gitignore                   # incl. .greenlight/secrets.env, .turbo, dist, node_modules
  .husky/                      # pre-commit → lint-staged
  greenlight.config.example.ts # generic domain, blog only, zero tools
  .github/workflows/ci.yml     # FRAMEWORK-repo CI: build+lint+typecheck+test+seam-check
  scripts/
    check-seam.ts              # rule 15.2.1 enforcement (no personal strings in framework files)
  packages/
    shared/                    # @rtrentjones/greenlight-shared  ← the real Phase-0 content
      src/{schema.ts,defineConfig.ts,load.ts,types.ts,index.ts}
      src/__tests__/schema.test.ts
    verify/                    # @rtrentjones/greenlight-verify   ← interface stub only
      src/index.ts
    adapters/                  # @rtrentjones/greenlight-adapters ← interface stub only
      src/index.ts
  cli/                         # @rtrentjones/greenlight (bin: greenlight) ← thin: load+validate+print
    src/index.ts  bin/greenlight.ts
  tools/
    _template-astro/  _template-next/  _template-mcp/   # placeholder READMEs (D5)
```

## The substantive deliverable: manifest schema + loader (`packages/shared`)

This is the core of Phase 0 — everything else is scaffolding around it.

**`schema.ts` (Zod)** mirrors §4 and **enforces the V1 lane × target × data matrix** as a refinement, so an illegal combo fails at load time, not at deploy:

```ts
// shape (sketch — not final)
const Lane   = z.enum(["astro", "next", "mcp"]);
const Target = z.enum(["workers", "vercel", "oci"]);
const Data   = z.enum(["none", "d1", "kv", "supabase"]);
const Auth   = z.enum(["none", "bearer", "oauth"]);

const Tool = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  lane: Lane, target: Target, data: Data,
  auth: Auth.default("none"),
  access: z.enum(["public", "private"]).default("public"),
  envs: z.array(z.enum(["preview", "beta", "prod"])).nonempty(),
  adopted: z.boolean().default(false),
}).superRefine(matrixRule);   // astro→workers; next→vercel; mcp→workers|oci; blog never supabase; etc.

export const Config = z.object({
  domain: z.string(),
  alerts: z.object({ sink: z.enum(["github-issue", "email"]) }),
  blog: z.object({ lane: z.literal("astro"), target: z.literal("workers"),
                   data: z.enum(["none", "d1", "kv"]) }),   // blog can NOT be supabase — enforced here
  tools: z.array(Tool),
});
```

- **`defineConfig.ts`** — `defineConfig(c): Config` = identity + type inference for authoring `greenlight.config.ts`.
- **`types.ts`** — `export type GreenlightConfig = z.infer<typeof Config>` and the sub-types; this is what `cli/`, `verify`, `adapters` import.
- **`load.ts`** — read + evaluate `greenlight.config.ts` (or `.example.ts`), run `Config.parse`, return typed object with friendly error formatting on failure.
- **Tests** — valid example parses; each matrix violation (`mcp→vercel`, `next→workers`, `blog data:supabase`, bad tool name) is rejected with a clear message.

## The seam check (`scripts/check-seam.ts`, rule 15.2.1)

Greps **framework paths** (`cli/`, `packages/`, `infra/`, `tools/_template-*`, `.github/workflows/`) for **forbidden personal strings** and exits non-zero on any hit. Config = a small denylist (`rtrentjones.dev`, real tokens patterns) plus an allowlist of legitimate example strings (`example.dev`). Wired as the last CI job. Must be demonstrably *able to fail*: a test fixture / a deliberate temporary hardcode proves it catches a planted domain.

## Ordered task list

1. **Tooling baseline** — root `package.json` (+ `packageManager` pin), `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `mise.toml` (node + pnpm pin), `.gitignore` (incl. `.greenlight/secrets.env`), Husky + lint-staged, Vitest config. ⇒ `pnpm install` clean.
2. **`packages/shared`** — schema + defineConfig + types + loader + tests. ⇒ the substantive deliverable.
3. **`greenlight.config.example.ts`** — generic `example.dev`, `blog` only, `tools: []`, `alerts.sink: "github-issue"`. ⇒ loads + type-checks via `shared`.
4. **`cli/`** — `bin: greenlight`; one working subcommand (`greenlight config` / `greenlight doctor --check-manifest`) that loads + validates + pretty-prints the manifest. ⇒ proves bin wiring + loader end-to-end.
5. **Stubs** — `packages/verify` and `packages/adapters` export typed interfaces only (`VerifyMode`, `Adapter` four-hook signature) so Phase 1 fills implementations against fixed contracts.
6. **Lane-template placeholders** — `tools/_template-{astro,next,mcp}/README.md` describing intent (D5).
7. **Seam check** — `scripts/check-seam.ts` + prove-it-fails fixture.
8. **Boundary enforcement** — `.dependency-cruiser.cjs` (D4): nothing outside `packages/*`/`cli/` may contain logic; consumer-facing entrypoints may not import package internals.
9. **CI** — `.github/workflows/ci.yml`: `install → build → typecheck → lint → test → check-seam` on PR + push.
10. **Dev README** — short "how to build/test/extend" for `packages/shared` and the seam rules.

## Acceptance criteria (Phase 0 is done when…)

- `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test` all pass clean.
- `greenlight.config.example.ts` loads and type-checks via `@rtrentjones/greenlight-shared`.
- Schema **rejects** every out-of-matrix combo and `blog data:supabase`, each with a readable error (covered by tests).
- `pnpm greenlight config` (or equivalent) prints the validated example manifest.
- The **seam CI check is green**, and a planted `rtrentjones.dev` in a framework file makes it **red** (proven by fixture).
- Boundary rules pass; a deliberate logic-in-workflow / internal-import violation is flagged.
- No personal data anywhere in the repo; `.greenlight/secrets.env` is gitignored.

## What Phase 0 sets up for Phase 1

- `packages/verify` and `packages/adapters` interface stubs become the contracts Phase 1 implements.
- The validated `GreenlightConfig` + loader is what the deploy/verify loop consumes.
- The CI skeleton gains the deploy/verify jobs in Phase 3; the package boundaries are already publish-ready for Phase 7.
