# Provider API tokens (Cloudflare · Supabase · Vercel)

When you apply a tool that uses **`target: vercel`** and/or **`data: supabase`** — or deploy
the **keepalive** Worker — Terraform's providers need their own API tokens. Greenlight reads
each from a standard environment variable, so it's **one token → one env var**. Store them
only in the gitignored `.greenlight/secrets.env` (+ the provider stores) — never commit or
echo them (greenlight-v1.md §14).

| env var | used by | needed when |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | cloudflare provider (DNS + Workers) | always (DNS); keepalive Worker |
| `SUPABASE_ACCESS_TOKEN` | supabase provider | `data: supabase` tools |
| `VERCEL_API_TOKEN` | vercel provider | `target: vercel` tools |

Replace every `<placeholder>` below with your own values.

---

## `CLOUDFLARE_API_TOKEN` — DNS **and** Workers

A DNS-only token is **not** enough once you deploy keepalive (a Worker with a cron trigger).
Create one custom token with both scopes:

1. **https://dash.cloudflare.com/profile/api-tokens** → **Create Token** → **Create Custom Token**.
2. **Permissions:**
   - **Account → Workers Scripts → Edit**   (the keepalive worker + cron trigger)
   - **Zone → DNS → Edit**                  (the tool's subdomain CNAMEs)
   - **Account → Account Settings → Read**  (lets tooling resolve the account)
3. **Account Resources:** Include → your account.
4. **Zone Resources:** Include → Specific zone → `<your-domain>`.
5. Create → copy. This is a superset of a DNS-only token, so it can replace an existing one.

Verify: `curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"` → `"status":"active"`.

## `SUPABASE_ACCESS_TOKEN` — Management API

1. **https://supabase.com/dashboard/account/tokens** → **Generate new token** → copy (shown once).

Personal access tokens are account-scoped (Supabase has no finer grain) — they can manage
every project in your account, so keep this in the gitignored file only.

Verify: `curl -s https://api.supabase.com/v1/projects -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"` → your project list.

## `VERCEL_API_TOKEN`

1. **https://vercel.com/account/settings/tokens** → **Create Token**.
2. **Scope:** the **team** that owns the project (not "personal"), set an expiration, create, copy.

Verify: `curl -s "https://api.vercel.com/v2/user" -H "Authorization: Bearer $VERCEL_API_TOKEN"` → your user.

---

## Terraform variables

- **`TF_VAR_cloudflare_zone_id`** — the zone's id. Dashboard: the zone's **Overview → API →
  Zone ID**. Or:
  ```
  curl -s "https://api.cloudflare.com/client/v4/zones?name=<your-domain>" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep -o '"id":"[^"]*"' | head -1
  ```
- **`TF_VAR_supabase_database_password`** — only used if a Supabase project is **created**.
  When importing an existing project the module sets `ignore_changes` on the password, so any
  non-empty placeholder works.
- **`TF_VAR_keepalive_github_token`** *(optional)* — for keepalive's `github-issue` alerts: a
  fine-grained PAT with **Issues: Read and write** on the alert repo. Empty = no alerts (the
  pings still run).

---

## Where they go: `.greenlight/secrets.env` (gitignored)

```sh
# provider auth (terraform reads these from the environment)
CLOUDFLARE_API_TOKEN=...
SUPABASE_ACCESS_TOKEN=...
VERCEL_API_TOKEN=...
# terraform variables
TF_VAR_cloudflare_zone_id=...
TF_VAR_supabase_database_password=import-placeholder
TF_VAR_keepalive_github_token=        # optional
```

Load before running Terraform: `set -a; source .greenlight/secrets.env; set +a`.

> The same `CLOUDFLARE_API_TOKEN` / `SUPABASE_ACCESS_TOKEN` also authenticate the Cloudflare
> and Supabase MCP servers, and `gh` handles GitHub — so the agent loop can introspect these
> providers with the tokens you already created.
