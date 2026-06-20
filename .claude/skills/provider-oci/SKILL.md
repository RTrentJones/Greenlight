---
name: provider-oci
description: How Oracle Cloud (OCI) works in a Greenlight setup — the `target: oci` runtime for stateful MCP servers (BAMCP) on a free-tier Ampere A1 VM + Docker, the build-ARM64→GHCR→ssh deploy adapter, the Cloudflare Tunnel module, the Always-Free idle-reclaim trap (fixed by PAYG, manual), and keepalive. Use when wiring/debugging an oci-target tool.
---

# provider-oci

OCI is the `target: oci` runtime for **stateful** services that don't fit serverless — the
canonical case is **BAMCP** (a stateful MCP server). Greenlight owns the build + ship in a
reusable, **free-tier** way.

## Free tier — A1 VM + Docker, NOT Container Instances

The Always-Free path is an **Ampere A1 Compute VM** (up to 4 OCPU / 24 GB free) running
Docker. **OCI Container Instances is NOT Always-Free** — that's the paid trap to avoid. The
app binds to `localhost`; a **Cloudflare Tunnel** (cloudflared sidecar/container on the VM)
exposes `<name>.<domain>` with TLS — no public app port, no load balancer.

## Deploy adapter (`@rtrentjones/greenlight-adapters`)

`greenlight deploy <tool> --env <env>` (oci) = build an **ARM64** image (Ampere) → push to
**GHCR** (free) → `ssh` to the VM and `docker run` it (per-env container `<tool>-<env>`,
`--restart=always`, bound to `127.0.0.1:<port>`). Env it reads (from secrets, synced to CI):
- `OCI_DEPLOY_HOST` — the A1 VM (IP/DNS) for SSH.
- `GHCR_OWNER` — image namespace (defaults to the repo owner).
- `OCI_DEPLOY_USER` (default `ubuntu`), `OCI_APP_PORT` (default 8000; convention prod=8000, beta=8001),
  `OCI_ENV_FILE` (default `~/<tool>-<env>.env` on the VM — the runtime env lives there).

## Terraform — `infra/modules/tunnel` + `tool`

`greenlight add/adopt` emits, per oci tool: a **`tunnel`** module (cloudflared tunnel +
ingress `<name>.<domain> → http://localhost:8000`, self-generated secret, **sensitive token
output**) and the **`tool`** DNS module with `cname_target = module.<tool>_tunnel.cname_target`
(CNAME → `<id>.cfargotunnel.com`). Put the token output on the VM: `cloudflared tunnel run --token <token>`.

## The idle-reclaim trap — fixed manually, NOT by code

OCI **Always-Free reclaims idle compute**; pings don't count, only account standing. The fix
is converting the tenancy to **Pay-As-You-Go** (+ a low billing budget alarm) — a one-time
manual change (see `docs/oci-payg-runbook.md`). Keepalive only **health-checks** the service
and nags; it cannot stop reclaim. Never imply otherwise.

## Auth, verify
OCI itself uses **API-key request signing** (no bearer token → no cheap `verify()`). The tool
is typically an **MCP server**: verify with `mode: mcp` (initialize → `tools/list` → call →
assert auth rejection), connect at `<name>.<domain>/mcp` (streamable HTTP). Keepalive
health-checks `target: oci` services and alerts via the sink.
