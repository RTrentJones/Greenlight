# Getting started — stand up a new Greenlight wrapper

You don't fork Greenlight. You **install the CLI** and run `greenlight init`, which scaffolds a thin
**wrapper repo you own** — your manifest + content — that depends on the published
`@rtrentjones/greenlight` package and updates via `pnpm update`. Then each tool is `greenlight add`
(or `adopt`), which also gathers exactly that tool's keys.

> Mental model: **the wrapper is yours; the framework is a versioned dependency.** The CLI *edits*
> declarative IaC (Terraform you can read), and your CI/CD *applies* it. Nothing here is a PaaS.

## 0. Prerequisites (one-time)

- **Node 24 + pnpm** (the wrapper pins them in `mise.toml`; [mise](https://mise.jdx.dev) installs them).
- **`gh`** authenticated (`gh auth login`) — the CLI pushes secrets to GitHub Actions via `gh`.
- A **domain on Cloudflare** (the zone), and free accounts as needed per tool: HCP Terraform
  (remote state), Vercel (`next`), Supabase (`data: supabase`), Oracle Cloud (`mcp`/`oci`).
- Tokens are entered once, verified, and pushed **straight to GitHub Actions secrets** — never
  committed or written to disk (Greenlight keeps no local secret file).

## 1. Create the wrapper repo

```bash
gh repo create <you>/<site> --private --clone && cd <site>
# or: mkdir <site> && cd <site> && git init && gh repo create --source=. --private --push
```

## 2. `greenlight init` — scaffold the wrapper + gather base keys

```bash
npx -y @rtrentjones/greenlight init --domain you.dev
```

This writes (never clobbering existing files):
- `greenlight.config.ts` — the **manifest** (domain + blog; tools are added next)
- `.github/workflows/infra.yml` — **HCP-backed `terraform apply` on push** (provider creds from
  GitHub secrets; the full provider map is pre-wired, unused entries stay empty)
- `.gitignore` (ignores `.greenlight/`), `package.json` (depends on `@rtrentjones/greenlight`),
  `mise.toml`, `.node-version`

…then interactively **gathers the always-on base tokens** (Cloudflare API token, HCP Terraform
token, optional GitHub PAT), verifies them, and pushes them to your repo's GitHub Actions secrets.

```bash
mise install && pnpm install      # the wrapper now has the greenlight CLI: `pnpm greenlight …`
```

## 3. Add your first tool — `greenlight add` (emits infra **and** gathers its keys)

One command per tool. It validates the `lane × target × data` matrix, emits `infra/<tool>.tf`
(scaffolding `infra/main.tf` on the first tool), wires the agent kit, and then **gathers exactly
that tool's provider keys** straight to GitHub (link-first, hidden, verified — base tokens already
set show `[already set]`, Enter to keep):

```bash
pnpm greenlight add notes --lane mcp  --target oci                 # stateful MCP server (free A1)
pnpm greenlight add app   --lane next --target vercel --data supabase
pnpm greenlight add blog2 --lane astro --target workers
```

What each target needs (the gather prompts walk you through it, with the create-link per token):

| lane / target | keys gathered (beyond the base Cloudflare/HCP) |
|---|---|
| `mcp` / `oci` | `TF_VAR_OCI_*` API-key auth (the config-preview shortcut: `--oci-config ~/path/config`); optional compartment. VCN/subnet/AD are **IaC** — not keys. |
| `next` / `vercel` + `supabase` | `VERCEL_API_TOKEN`, `SUPABASE_ACCESS_TOKEN` (+ DB password). Add **Cloudflare Tunnel:Edit** to the CF token only for `oci`. |
| `astro` / `workers` | nothing beyond the base Cloudflare token. |

> Non-interactive (CI)? `add` prints the exact `greenlight secrets gather <tool> --repo <o/r>` to
> run yourself. The `--oci-config <path>` flag auto-fills the OCI auth from the API-key config
> preview + `.pem` (incl. the multi-line key — never pasted).

## 4. Set the remote-state backend (once)

Open `infra/main.tf` and fill the `cloud {}` block with your HCP Terraform org + workspace
(free tier, no credit card). See [terraform-state.md](terraform-state.md).

## 5. Commit + push → CI applies

```bash
git add -A && git commit -m "add notes" && git push
```
`infra.yml` runs `terraform plan` → `apply` (HCP-backed) and creates the tool's infra (DNS, and for
`oci`: VCN + subnet + free A1 container instance + Cloudflare Tunnel; for `vercel`: project config).

## 6. Verify

```bash
pnpm greenlight verify notes --env prod      # the shared harness (api | mcp | playwright | …)
pnpm greenlight doctor                        # manifest ↔ infra ↔ workflow consistency
```

## The ongoing loop (deploy → verify → promote)

Day-to-day changes ship through the gated loop — the
[deploy-verify-promote skill](../.claude/skills/deploy-verify-promote/SKILL.md):
`branch → change → preview → verify → develop/beta → verify → promote (gated develop→main) → prod →
verify`. Install the agent kit for it: `/plugin marketplace add RTrentJones/greenlight` (or
`greenlight agent sync`).

## Adopting an existing tool (poly-repo)

To wrap a tool that already has its own repo, instead of `add`:
```bash
pnpm greenlight adopt mytool --repo <url> --lane <l> --target <t> [--data --auth]
```
It adds the tool as a `tools/<name>` git submodule, emits its infra in the wrapper, and pushes the
loop kit (+ a deploy/verify workflow) into the tool repo. The tool repo holds **one** secret
(`GREENLIGHT_DISPATCH_TOKEN`); all provider creds stay in the wrapper. See
[provider-tokens.md](provider-tokens.md#poly-repo-adopted-tool-tokens--wrapper--sub-repo).

## Updating the framework

```bash
pnpm update @rtrentjones/greenlight     # the CLI + bundled libs
```
Terraform module refs are pinned per emitted block (e.g. `?ref=v0.2.20`); bump them when you adopt a
newer line. You never merge framework code — your wrapper only consumes it.

---

See [architecture.md](architecture.md) for how it all fits together, and the per-provider skills
(`provider-cloudflare`, `provider-oci`, `provider-vercel`, `provider-supabase`, …) for the details
of each backend.
