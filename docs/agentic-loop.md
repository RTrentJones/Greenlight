# The agentic dev loop kit

Greenlight's aim isn't just "deploy a tool" — it's a **full positive-feedback agentic dev loop**: the agent writes a change, gets guided toward correct patterns, ships it, and receives an **objective pass/fail signal**, then debugs from real telemetry and promotes. To make that loop closed and self-correcting, Greenlight distributes a curated *kit* of agent context — skills, MCP servers, and best-practices — not just the one loop skill.

## The loop, and what closes each step

```
write change ──▶ deploy preview ──▶ VERIFY ──▶ beta ──▶ VERIFY ──▶ promote ──▶ prod ──▶ VERIFY
     ▲              (skills guide)   (signal)            (signal)   (gated)            (signal)
     └──────────────── debug from MCP observability/builds ◀───────────────────────────┘
```

- **Guidance** (write the right thing): best-practice skills (`workers-best-practices`, `wrangler`, `agents-sdk`, `durable-objects`).
- **Objective signal** (did it work?): the `verify` harness — the same code CI runs — gates every promotion. No vibes.
- **Debug** (why did it fail?): Cloudflare MCP servers (builds, observability) surface deploy status + logs in-session.
- **Discipline** (how to ship): the `deploy-verify-promote` skill.

## Components

### 1. Greenlight loop skill + CLI
- Skill: `deploy-verify-promote` — via the Greenlight plugin (`/plugin marketplace add RTrentJones/greenlight` → `/plugin install greenlight@greenlight`) or `greenlight agent sync`.
- CLI: `greenlight preview | deploy | verify | promote | doctor` (the `@rtrentjones/greenlight*` packages).

### 2. MCP servers (verification + observability)
Recommended in `.mcp.json` (run `/mcp` to authenticate — OAuth to your Cloudflare account):
- `cloudflare` — aggregate (Workers, DNS, R2/KV/D1, builds, observability).
- `cloudflare-docs` — documentation Q&A.

`greenlight agent sync` writes/merges these into a repo's `.mcp.json`; the Greenlight plugin also ships them.

### 3. Best-practice skills (Cloudflare)
One-time, user scope:
```bash
claude plugin marketplace add cloudflare/skills
claude plugin install cloudflare@cloudflare
```
Brings `cloudflare`, `wrangler`, `workers-best-practices`, `agents-sdk`, `durable-objects`, `sandbox-sdk`, `cloudflare-email-service`, `turnstile-spin`, `web-perf`.

## One-time setup for a repo
```bash
# user scope (all repos): the loop skill + Cloudflare best-practice skills
/plugin marketplace add RTrentJones/greenlight && /plugin install greenlight@greenlight
claude plugin marketplace add cloudflare/skills && claude plugin install cloudflare@cloudflare

# per repo: materialize the skill + .mcp.json (if not using the plugin)
greenlight agent sync
/mcp        # authenticate the Cloudflare MCP servers
```

The result: in any Greenlight repo, the agent has the loop discipline, the patterns to write correct code, the harness to prove it, and the telemetry to debug it — a closed, self-verifying loop.
