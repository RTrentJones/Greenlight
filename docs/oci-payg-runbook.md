# OCI Always-Free idle-reclaim — the PAYG runbook

**Keepalive does not fix this.** The `packages/keepalive` Worker health-checks `target: oci`
services and alerts on failure, but it **cannot stop Oracle from reclaiming idle Always-Free
compute**. OCI reclaims Always-Free VMs that look idle, and **pings don't count** — only
*account standing* does. The fix is to convert the tenancy to **Pay-As-You-Go (PAYG)** and
guard it with a **billing budget alarm**. This is a one-time manual change (greenlight-v1.md
§6/§13); the harness only nags via `doctor`.

## Deploy architecture (free-tier: A1 VM + Docker + tunnel)

The reusable, Always-Free OCI deploy target is an **Ampere A1 Compute VM** (up to 4 OCPU /
24 GB free) running Docker — **not OCI Container Instances**, which is a paid managed service
(the trap that made the old BAMCP pipeline non-free). Greenlight owns the build + ship:

- **Adapter** (`@rtrentjones/greenlight-adapters`, `target: oci`): `greenlight deploy <tool>
  --env <env>` builds an **ARM64** image (Ampere) → pushes to **GHCR** (free) → `ssh`es to the
  VM and `docker run`s it as `<tool>-<env>` (`--restart=always`, bound to `127.0.0.1:<port>`).
  Config via env (synced to CI secrets): `OCI_DEPLOY_HOST` (the VM), `GHCR_OWNER`,
  `OCI_DEPLOY_USER` (default `ubuntu`), `OCI_APP_PORT` (prod 8000 / beta 8001), `OCI_ENV_FILE`.
- **Tunnel** (`infra/modules/tunnel`): a Cloudflare Tunnel (cloudflared on the VM) routes
  `<name>.<domain>` → `http://localhost:<port>` — no public app port. `greenlight add/adopt`
  emits the module + wires the DNS CNAME; the module's **sensitive token output** goes on the
  VM (`cloudflared tunnel run --token <token>`).
- **One-time VM prep:** create the A1 VM (Oracle Linux/Ubuntu) with Docker + a public IP for
  SSH (port 22; the app port stays private behind the tunnel), drop the per-env `~/<tool>-<env>.env`
  runtime file, and run cloudflared with the tunnel token. Then deploys are just the adapter.

PAYG (below) is still required so the VM isn't reclaimed.

## Why

- Always-Free idle-reclaim is triggered by Oracle's heuristics, not by inbound traffic, so a
  keepalive ping is not a reliable defense. BAMCP (mcp on OCI) is the tool this protects.
- Converting to PAYG **keeps the Always-Free resources free** (you are not charged for
  Always-Free-eligible shapes) but removes the idle-reclaim behavior — the VM stays up.
- The risk PAYG introduces is an accidental charge if you exceed Always-Free limits, which the
  **billing budget alarm** catches.

## Steps (one-time, per tenancy)

1. **Upgrade to PAYG** — OCI Console → your profile → **Tenancy** → *Upgrade to Pay As You Go*.
   Add a payment method. Existing Always-Free resources are unaffected and remain free.
2. **Create a budget** — Console → **Billing & Cost Management → Budgets → Create Budget**.
   - Scope: the tenancy (root compartment).
   - Amount: a low monthly cap (e.g. **$5**) — enough to flag any non-free usage.
3. **Add an alarm rule** on the budget at **50% / 100%** with an email recipient. This is the
   backstop against an accidental paid resource.
4. **(Recommended) Cost alert** — also set a Cost-Analysis threshold alert as a second signal.

## Verify

- The tenancy shows **Pay As You Go** (not *Always Free* / *Free Tier*) under Tenancy details.
- The budget exists with an alarm rule and a confirmed email recipient.
- The OCI VM no longer gets reclaimed after idle periods (observe over a week; keepalive's
  health check + alert will tell you if it goes down).

## What `doctor` checks

`greenlight doctor` reports **keepalive coverage** (which tools need it) today. The live
checks — *OCI PAYG status* and *billing alarm presence* — are listed as `skip` until wired to
OCI creds (they require reading the tenancy via the OCI API). Until then this runbook is the
source of truth; do it by hand and keep the budget alarm green.
