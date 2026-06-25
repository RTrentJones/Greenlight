---
name: provider-oci
description: Oracle Cloud (OCI) in a Greenlight setup — the `target: oci` runtime for stateful MCP servers on a free-tier Ampere A1 Container Instance (build-via-GitHub→GHCR; Greenlight-owned compute + tunnel). Use when wiring or debugging an oci-target tool.
---

# provider-oci

OCI is the `target: oci` runtime for **stateful** services that don't fit serverless — the
canonical case is **BAMCP** (a stateful MCP server). The split: **the tool is provider-agnostic and
just builds a container via GitHub; Greenlight owns the OCI infra** (compute + tunnel + DNS),
configured in the wrapper.

## Free tier — A1 Container Instance + GHCR

The Always-Free path is an **OCI Container Instance** on **Ampere A1** (2 OCPU / 12 GB, shared
across VM / Bare-Metal / Container-Instances). No VM, no cloud-init, no SSH. The image comes from
**GHCR** (free); **OCI's own registry (OCIR) is paid** — that was the old-pipeline trap. The
instance runs the tool container + a **cloudflared sidecar** (shared netns → localhost), exposed at
`<name>.<domain>`. The tool repo's only job: a GitHub Actions workflow that builds + pushes to GHCR.

## Greenlight OCI infra (Terraform, in the wrapper)

`greenlight add/adopt` emits, per oci tool:
- **`oci-container-instance`** — the container instance (tool image from GHCR + cloudflared sidecar
  with the tunnel token), `CI.Standard.A1.Flex` within the free allotment, restart ALWAYS.
- **`tunnel`** — cloudflared tunnel + ingress `<name>.<domain> → http://localhost:8000` + token.
- **`tool`** DNS — CNAME → the tunnel.
- The `oci-network` module owns the VCN + public subnet; the instance module looks the AD up via a
  data source. The `oci` provider is added to `infra/main.tf`.

## Token — OCI API-key auth

Auth values + the gather flow live in
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).
The **only manual OCI inputs are the API-key auth values** (`TF_VAR_OCI_TENANCY_OCID`,
`TF_VAR_OCI_USER_OCID`, `TF_VAR_OCI_FINGERPRINT`, `TF_VAR_OCI_PRIVATE_KEY` PEM, `TF_VAR_OCI_REGION`;
`TF_VAR_OCI_COMPARTMENT_ID` optional → root). Auth is API-key request signing (no bearer → no
fetch-verify). **Shortcut:** `greenlight secrets gather <tool> --repo <o/r> --oci-config ~/config
[--oci-key ~/key.pem]` auto-fills the 5 auth secrets from OCI's "Configuration file preview" + the
`.pem` (the multi-line key is read from the file, never pasted).

## Deploy = restart (re-pull)

`greenlight deploy <tool>` (oci) runs `oci container-instances container-instance restart
--container-instance-id <OCID>` — the instance re-pulls the latest GHCR image. The tool's CI builds;
the deploy event fires the restart. The adapter does **not** build. The instance OCID is **not** a
manual input — the deploy workflow resolves it from OCI by display name (= the tool name).

## Verify
The tool is typically an **MCP server**: verify with `mode: mcp`, connect at `<name>.<domain>/mcp`
(FastMCP's `streamable_http_app()` serves `/mcp` by default). If auth gates `initialize`, supply a
token or use an `api`-mode 401 check. Keepalive health-checks `target: oci`.

## Gotchas
- **OCIR is paid — use GHCR.** Pulling from OCI's own registry bills; the free path is GHCR.
- **Idle-reclaim → stay free, recover on alert.** Always-Free can reclaim idle compute. We **stay on
  the free tier**: restart-policy ALWAYS + keepalive health-check + alert → re-apply/redeploy
  restores it. **PAYG is NOT used** (optional last resort; see `docs/oci-payg-runbook.md`). Never
  imply the harness *prevents* reclaim — it only nags and recovers.
- **Out-of-A1-capacity in one AD** → set `availability_domain` on the instance module to pin another
  AD (the only time you touch it).
- **Rotation.** The API signing key is the one long-lived credential — rotate it on a schedule (see
  docs/security.md); nothing automated rotates it.
