# OCI runbook — Always-Free Container Instance (no PAYG)

**We stay on the free tier.** BAMCP runs as an OCI **Container Instance** on the Always-Free
Ampere A1 allotment with restart-policy ALWAYS. The `packages/keepalive` Worker health-checks
`target: oci` services and alerts on failure; if a free instance is ever stopped/reclaimed, the
alert fires and a **re-apply / redeploy** brings it back. **PAYG is NOT required** — it's an
optional last resort (below) only if idle-reclaim ever becomes a recurring problem in practice.

## Deploy architecture (free-tier: A1 Container Instance + tunnel)

The Always-Free OCI target is an **OCI Container Instance** on **Ampere A1** — the A1 allotment
(2 OCPU / 12 GB as of 2026-06-15) is **shared across VM / Bare-Metal / Container-Instances**, so
container instances are free within it. No VM to provision, no cloud-init, no SSH. The image
comes from **GHCR** (free); **OCIR — Oracle's own registry — is paid** (that was the non-free part
of the old BAMCP pipeline). Split of responsibility:

- **Tool (provider-agnostic):** the tool repo's GitHub Actions only **builds + pushes the
  container to GHCR**. No OCI, no deploy logic — portable to any provider.
- **Greenlight infra (Terraform, in the wrapper):** `greenlight add/adopt` emits
  - `oci-network` — a **VCN + public (egress-only) subnet** + internet gateway/route/security list,
    so the network is IaC (never hand-clicked in the console);
  - `oci-container-instance` — the container instance: the tool image from GHCR + a **cloudflared
    sidecar** (shared netns → `localhost:8000`), `CI.Standard.A1.Flex`, restart ALWAYS; the
    **availability domain is auto-looked-up** (`oci_identity_availability_domains` data source);
  - `tunnel` — the Cloudflare Tunnel + ingress `<name>.<domain> → http://localhost:8000` + the
    connector token (wired into the sidecar);
  - `tool` — the DNS CNAME → the tunnel.
- **Deploy = restart (re-pull):** `greenlight deploy <tool>` runs `oci container-instances
  container-instance restart --container-instance-id <OCID>` — the instance re-pulls the latest
  image. The adapter does NOT build; the tool's CI does. An event trigger (the chosen deploy
  option) fires the restart after a build.
- **Creds (CLI-gathered) — only the API key is manual:** `TF_VAR_oci_{tenancy_ocid,user_ocid,fingerprint,private_key,region}`
  (+ optional `TF_VAR_oci_compartment_id`, blank → tenancy root) + `OCI_CONTAINER_INSTANCE_OCID`
  (the TF output, set after the first apply, for deploy). The VCN/subnet/AD are IaC, not secrets.
  `greenlight secrets gather bamcp --repo <o/r> [--oci-config <path>]` pushes them straight to GitHub.

Stay free; PAYG is the optional fallback below.

## Optional: PAYG (only if free reclaim ever recurs)

Always-Free idle-reclaim is triggered by Oracle's heuristics; a keepalive ping is not a
guaranteed defense. We accept that risk on the free tier — keepalive alerts and a redeploy
restores the instance. **If** reclaim becomes a recurring nuisance, converting the tenancy to
**Pay-As-You-Go keeps Always-Free shapes free** (you're not charged for eligible shapes) but
removes the reclaim behavior. Guard it with a billing budget alarm so an accidental paid resource
can't run up a bill:

1. **Upgrade to PAYG** — OCI Console → your profile → **Tenancy** → *Upgrade to Pay As You Go*.
   Add a payment method. Existing Always-Free resources are unaffected and remain free.
2. **Create a budget** — Console → **Billing & Cost Management → Budgets → Create Budget**
   (scope the root compartment; a low monthly cap, e.g. **$5**).
3. **Add an alarm rule** at **50% / 100%** with an email recipient — the backstop against an
   accidental paid resource.

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
