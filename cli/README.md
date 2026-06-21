# @rtrentjones/greenlight

The Greenlight CLI — setup and lifecycle for the [Greenlight](https://github.com/RTrentJones/greenlight)
harness. Greenlight turns a domain + API tokens into a live personal site plus a self-verifying
agentic deploy loop, with plug-and-play subdomain tools (web apps or MCP servers). It is
provider-agnostic and free-tier-first, and it **edits declarative infrastructure-as-code — your CI/CD
applies it**. It is not a hosted PaaS.

**You install this CLI; you don't fork the framework.** `greenlight init` scaffolds a thin **wrapper
repo you own** (your manifest + content) that depends on this package and updates via
`pnpm update` — no framework code to merge. This is the **single published package**: the CLI, with
the framework libraries (`shared`/`verify`/`adapters`/`loop`) bundled in. Terraform modules ship as
git tags (pinned in lockstep with this version); skills ship as a Claude Code plugin.

## Quick start

```bash
npx -y @rtrentjones/greenlight init --domain you.dev   # scaffold the wrapper + gather base keys
pnpm greenlight add notes --lane mcp --target oci      # add a tool: emit infra + gather ITS keys
git push                                               # CI runs `terraform apply`
pnpm greenlight verify notes --env prod                # the shared harness proves it
```

Full walkthrough: [getting-started.md](https://github.com/RTrentJones/greenlight/blob/main/docs/getting-started.md).
Update the mechanics later with `pnpm update @rtrentjones/greenlight`.

Optional peer features lazy-load and degrade to a failing check if absent (never a crash):

```bash
pnpm add -D playwright @anthropic-ai/sdk     # only for verify modes agent-web / eval
```

## CLI

```bash
greenlight <command>
```

| Command | What it does |
|---|---|
| `init --domain <d>` | scaffold the manifest + secrets store |
| `add <name> --lane <l> --target <t> [--data --auth --envs]` | **infra editor**: manifest entry → emit `infra/<name>.tf` + gather/verify tokens + wire the kit (never applies) |
| `adopt <name> --repo <url\|path> --lane --target` | onboard an existing tool repo (submodule wrapper, or `--standalone`) |
| `secrets gather <name> [--repo o/r] [--oci-config <path>]` | guided, link-first token prompts straight to GitHub secrets (no disk, no logs) |
| `secrets sync [--repo o/r] [--env <env>]` | push `.greenlight/secrets.env` → GitHub Actions secrets |
| `agent sync` | materialize the agent loop kit (skill + `.mcp.json` + CLAUDE block) into a repo |
| `preview <name>` | build + serve locally + verify in one command |
| `verify <name> --env <beta\|prod>` (or `--url`) | run the shared verify harness |
| `promote <name>` | gated `develop → main` fast-forward (after beta verify) |
| `deploy <name>` | target deploy hook (e.g. OCI restart = re-pull) |
| `doctor` / `config` | health checks / load + validate + print the manifest |

## The loop

```
greenlight add notes --lane mcp --target oci   # one entry → Terraform + tokens + kit
greenlight verify notes --env beta             # api | mcp | playwright | test | agent-web | eval
greenlight promote notes                        # gated develop → main, after beta verify passes
```

The `verify` gate is the same code CI **and** the agent run — so changes ship with objective
confidence, not vibes.

## Programmatic API

Typed helpers for your `greenlight.config.ts` and `verify.config.ts`:

```ts
import { defineConfig, defineVerify } from '@rtrentjones/greenlight';

export default defineConfig({
  domain: 'you.dev',
  tools: { notes: { lane: 'mcp', target: 'oci', data: 'none', auth: 'bearer' } },
});
```

Also exported: `loadConfig`, and the `GreenlightConfig` / `VerifySpec` types.

## Links

- **Repo + full docs:** <https://github.com/RTrentJones/greenlight>
- **Architecture:** [docs/architecture.md](https://github.com/RTrentJones/greenlight/blob/main/docs/architecture.md)
- **Spec:** [greenlight-v1.md](https://github.com/RTrentJones/greenlight/blob/main/greenlight-v1.md)

MIT
