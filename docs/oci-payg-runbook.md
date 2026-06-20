# OCI Always-Free idle-reclaim — the PAYG runbook

**Keepalive does not fix this.** The `packages/keepalive` Worker health-checks `target: oci`
services and alerts on failure, but it **cannot stop Oracle from reclaiming idle Always-Free
compute**. OCI reclaims Always-Free VMs that look idle, and **pings don't count** — only
*account standing* does. The fix is to convert the tenancy to **Pay-As-You-Go (PAYG)** and
guard it with a **billing budget alarm**. This is a one-time manual change (greenlight-v1.md
§6/§13); the harness only nags via `doctor`.

## Deploy architecture (free-tier: A1 Container Instance + tunnel)

The Always-Free OCI target is an **OCI Container Instance** on **Ampere A1** — the A1 allotment
(2 OCPU / 12 GB as of 2026-06-15) is **shared across VM / Bare-Metal / Container-Instances**, so
container instances are free within it. No VM to provision, no cloud-init, no SSH. The image
comes from **GHCR** (free); **OCIR — Oracle's own registry — is paid** (that was the non-free part
of the old BAMCP pipeline). Split of responsibility:

- **Tool (provider-agnostic):** the tool repo's GitHub Actions only **builds + pushes the
  container to GHCR**. No OCI, no deploy logic — portable to any provider.
- **Greenlight infra (Terraform, in the wrapper):** `greenlight add/adopt` emits
  - `oci-container-instance` — the container instance: the tool image from GHCR + a **cloudflared
    sidecar** (shared netns → `localhost:8000`), `CI.Standard.A1.Flex`, restart ALWAYS;
  - `tunnel` — the Cloudflare Tunnel + ingress `<name>.<domain> → http://localhost:8000` + the
    connector token (wired into the sidecar);
  - `tool` — the DNS CNAME → the tunnel.
- **Deploy = restart (re-pull):** `greenlight deploy <tool>` runs `oci container-instances
  container-instance restart --container-instance-id <OCID>` — the instance re-pulls the latest
  image. The adapter does NOT build; the tool's CI does. An event trigger (the chosen deploy
  option) fires the restart after a build.
- **Creds (CLI-gathered):** provider auth `TF_VAR_oci_{tenancy_ocid,user_ocid,fingerprint,private_key,region}`
  + placement `TF_VAR_oci_{compartment_id,availability_domain,subnet_id}` + `OCI_CONTAINER_INSTANCE_OCID`
  (the TF output, for deploy). `greenlight add` gathers them.

PAYG (below) is still required so the instance isn't reclaimed.

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
