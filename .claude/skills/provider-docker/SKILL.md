---
name: provider-docker
description: Docker host in a Greenlight setup — the `target: docker` runtime for stateful tools on a host you own (VPS/homelab) over SSH; a stable alternative to OCI's idle-reclaimed free tier. Use when wiring or debugging a docker-target tool.
---

# provider-docker

`target: docker` runs a **stateful** tool on **a host you own** — a cheap VPS or a homelab box —
instead of OCI's Always-Free tier. Same shape as `oci`: **the tool is provider-agnostic and just
builds a container via GitHub→GHCR; Greenlight owns the tunnel + DNS** and deploys over SSH. Use it
when you want the OCI loop without OCI's idle-reclaim — you trade "free" for "a host that stays up".

## The model — GHCR image + SSH deploy + Cloudflare tunnel

- **Build:** the tool repo's own CI builds + pushes the image to **GHCR** (free), exactly like oci
  (`greenlight-build.yml`), then fires `repository_dispatch(deploy-<name>)` at the wrapper.
- **Host:** a machine you own runs a **docker-compose** with the GHCR image **+ a cloudflared
  service** using the tunnel token. You set this up **once** (the compute is yours — Greenlight does
  NOT provision it).
- **Deploy:** the wrapper's deploy listener SSHes the host and runs
  `docker compose pull && docker compose up -d` (via `greenlight deploy <name>`), then verifies prod.
- **Ingress:** the **same `tunnel` module as oci** — cloudflared dials out from the host, so no
  inbound ports/firewall holes. DNS `<name>.<domain>` → the tunnel (the `tool` module).

There is **no compute Terraform** (unlike oci's `oci-network` / `oci-container-instance`) — only the
`tunnel` + `tool` (DNS) modules. The wrapper emits the `<name>_tunnel_token` output; put it in the
host's compose env once.

## Tokens — SSH connection (per-tool)

The deploy creds are SSH facts, gathered onto the **wrapper** (they live only there):
- `DOCKER_SSH_HOST` — hostname/IP of the host (required).
- `DOCKER_SSH_KEY` — the deploy user's **private key** (PEM content; required).
- `DOCKER_SSH_USER` — SSH user (optional, default `root`).
- `DOCKER_SSH_PORT` — SSH port (optional, default `22`).

All are **per-tool** (`DOCKER_SSH_HOST_<TOOL>`, …) so multiple docker tools can live on different
hosts without colliding; the deploy workflow maps them to the unsuffixed env the adapter reads. No
cheap verify (SSH reachability isn't a bearer fetch). Plus the option-B event-driven deploy PATs
(same as oci): `GREENLIGHT_DISPATCH_TOKEN` on the tool repo, `GREENLIGHT_STATUS_TOKEN` (per-tool) on
the wrapper. `Cloudflare Tunnel:Edit` is needed on `CLOUDFLARE_API_TOKEN` (as with oci).

Gather: `greenlight secrets gather <tool> --repo <wrapper>` (DOCKER_SSH_* + status) and
`--repo <tool>` (dispatch). Full reference:
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).

## Deploy = SSH `compose pull && up -d`

`greenlight deploy <tool>` (docker) writes `DOCKER_SSH_KEY` to a temp `600` file and runs
`ssh … "cd <remoteDir> && docker compose pull && docker compose up -d"` (default remote dir
`greenlight/<name>`; override with `DOCKER_COMPOSE_DIR`). The adapter does **not** build — the image
is already on GHCR. Verify prod gates the signal on the new image actually serving.

## Verify
Usually an **MCP server**: `mode: mcp`, connect at `<name>.<domain>/mcp`. Keepalive health-checks
`target: docker` (a plain GET); on an outage the keepalive Worker dispatches `remediate-<name>`,
which simply **re-runs the SSH deploy** (no Always-Free box to recreate).

## Gotchas
- **The host is yours — Greenlight won't provision or patch it.** Keep Docker running and the
  compose present; `up -d` + a `restart: unless-stopped` policy survives reboots.
- **Tunnel token lives on the host.** The `<name>_tunnel_token` output must reach the host's
  cloudflared (its compose env), set up once — the deploy step doesn't push it.
- **SSH key hygiene.** Use a dedicated deploy key with least privilege; rotate it on a schedule
  (nothing automated rotates it). `StrictHostKeyChecking=accept-new` trusts the host on first
  connect — pin a known_hosts entry if you want stricter.
- **Not free, but stable.** This is the deliberate trade vs oci: you pay for a host that doesn't get
  idle-reclaimed. For ephemeral/throwaway MCP, `target: workers` is still the cheaper path.
