# Adding a provider type

Greenlight's extension seam is the **provider-pack registry**
([cli/src/providers.ts](../cli/src/providers.ts)). Adding a new free-tier backend — a **data** store
(e.g. Neon), a **target** runtime, or a new **tool category** (e.g. agents) — means writing one
`ProviderPack` and the Terraform it points at. The CLI's onboarding (`init` / `add` / `adopt` /
`secrets gather` / `agent sync`) is driven entirely from the registry, so a new provider plugs in
without touching the commands.

**Golden rule: default-off, additive.** A new pack must change nothing for existing consumers — its
`appliesTo` only matches tools that opt in (by `target`/`data`/`lane`), and `pnpm run check-all`
stays green. The seam checks (`check-seam`, `check-boundaries`) forbid personal values and
out-of-bounds logic.

## The `ProviderPack` contract

```ts
interface ProviderPack {
  id: string;                              // 'neon'
  name: string;                            // 'Neon (serverless Postgres)'
  always?: boolean;                        // applies to every setup (Cloudflare, HCP, GitHub)
  appliesTo(tool: { target?; data? }): boolean;   // when this provider is needed
  tokens: TokenSpec[];                     // what to gather + fail-fast verify
  guide: string;                           // pointer into docs/provider-tokens.md
  setupUrl?: string;                       // console where the tokens are created
  mcp?: Record<string, McpServer>;         // MCP server(s) for the agent kit's .mcp.json
  skill?: string;                          // per-provider skill dir (plugin/skills/provider-<id>)
  tfModules?: string[];                    // infra/modules/* this provider's block references
}

interface TokenSpec {
  envVar: string;                          // SUPABASE_ACCESS_TOKEN
  label: string;                           // shown during `secrets gather`
  scopes?: string[];                       // least-privilege scopes to request
  optional?: boolean;                      // not required up front
  setupUrl?: string;                       // a different page (e.g. a PAT page)
  perTool?: boolean;                       // scoped to one tool's repo → `_<TOOL>` suffix (§ token scoping)
  verify?: (token, env) => Promise<{ ok; detail? }>;   // cheap auth/scope check — fail fast
}
```

The `verify()` is the point: a wrong-scope or dead token fails at gather time (a `curl`-style check),
**not** on the first `terraform apply`.

## Steps

### 1. Write the pack

Add an entry to `PACKS` in [cli/src/providers.ts](../cli/src/providers.ts). Mirror an existing one —
`supabase` is the model for a data store, `vercel` for a target, `oci` for a multi-token target.

```ts
{
  id: 'neon',
  name: 'Neon (serverless Postgres)',
  appliesTo: (t) => t.data === 'neon',
  guide: 'docs/provider-tokens.md — NEON_API_KEY (project + branch management)',
  setupUrl: 'https://console.neon.tech/app/settings/api-keys',
  tokens: [
    {
      envVar: 'NEON_API_KEY',
      label: 'Neon API key (project + branch management)',
      verify: async (t) => {
        const r = await fetch('https://console.neon.tech/api/v2/projects', {
          headers: { Authorization: `Bearer ${t}` },
        });
        return { ok: r.ok, detail: `HTTP ${r.status}` };
      },
    },
  ],
  mcp: { neon: { type: 'http', url: 'https://mcp.neon.tech/mcp' } },
  skill: 'provider-neon',
  tfModules: ['neon'],
}
```

### 2. Add the Terraform module

Create `infra/modules/<provider>/` (`main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`,
`README.md`) — copy [infra/modules/supabase](../infra/modules/supabase) for shape. Keep it
**declarative + recreatable**: pin the provider version, set `ignore_changes` on replace-forcing /
out-of-band attributes, document an import runbook, and expose deterministic outputs (`url`,
keys) so verification and the `vercel`/env wiring can consume them without scraping. Outputs flow
into the consuming tool's env (no manual copy).

For a store with **branch-per-env** (Neon's model), the module owns one project and creates a branch
per env — no keepalive needed (scale-to-zero, no 7-day pause), which is the advantage over Supabase.

### 3. Wire the emitter

[cli/src/tf-emit.ts](../cli/src/tf-emit.ts) turns a manifest entry into `infra/<name>.tf`. Add the
provider's module block (gated on `appliesTo`), its per-tool variables, and any env wiring — and the
`tokenOverrides` aliased-provider path if a second account should be supported (see the supabase
override block for the pattern: `providers = { <p> = <p>.<tool> }`, no module change needed).

### 4. Extend the schema matrix (only if it's a new axis value)

A new **data** value (`neon`), **target**, or **lane** goes in
[packages/shared/src/schema.ts](../packages/shared/src/schema.ts): add the enum value **and** the
`MATRIX` entry that says which lanes allow it. The schema validates at load, so an illegal combo
fails when the config is read — never at deploy.

### 5. Add a verify mode (only if the validation surface is new)

If the new provider exposes a surface the six existing modes
([docs/architecture.md](architecture.md) / [packages/verify](../packages/verify)) can't assert, add a
mode to `packages/verify` and the `VerifySpec` union. Most providers don't need this — a Postgres
backend is still verified through the tool's `api`/`test`/`playwright` surface. A genuinely new
category (see *agents* below) is the case that does.

### 6. Skill, MCP, docs, tests

- **Skill** — `plugin/skills/provider-<id>/SKILL.md`: how the provider works in a Greenlight setup,
  token scopes, the MCP, common failure modes (model the existing `provider-*` skills).
- **MCP** — already declared in the pack's `mcp`; the agent kit merges it into `.mcp.json`.
- **Docs** — add a row/section to [docs/tokens-reference.md](tokens-reference.md) and
  [docs/provider-tokens.md](provider-tokens.md).
- **Tests** — extend `cli/src/__tests__/providers.test.ts` (the pack resolves for the right tools)
  and `tf-emit.test.ts` (the module block emits). Run `pnpm run check-all`.

### 7. Release

Lockstep release (npm version == git tag == `MODULE_REF`), then consumers `pnpm update` and pin the
new module ref. See [docs/development.md](development.md).

## Worked example: a new tool category (agents)

A new **category** (not just a backend) touches more axes — it's the case that exercises every step:

1. **Schema** — add an `agents` lane (and/or target) + its `MATRIX` row.
2. **Adapter** — the deploy-target contract (`build`/`deploy`/`url`/`teardown`) for where agents run.
3. **Verify mode** — agents need behavioural verification: extend `eval` (LLM-judged) or add an
   `agent-eval` mode that drives the agent and judges transcripts, with `exactTools`-style
   drift-guards.
4. **Pack + module + skill + templates** — a `_template-agents` lane template and a `provider-agents`
   skill, same as the other lanes.
5. **Loop** — it still ships through the **uniform deliver-a-feature loop** (§6 of
   [greenlight-v2.md](../greenlight-v2.md)); only the matrix cell (local gate, ship gate, deploy)
   differs.

The point of the registry is that an `agents` tool is *added the same way* a `notes` MCP server is —
one manifest entry, one pack, the same gates.
