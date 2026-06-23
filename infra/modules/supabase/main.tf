# A single Supabase project, owned declaratively so it is recreatable from scratch and
# never silently abandoned (the failure that took HeistMind down). One project with
# env-isolation by SCHEMA (a beta schema + the prod schema) — Supabase branching is paid
# and the free tier is one project, so project-per-env isn't the model here. Schemas live
# in the app repo's supabase/migrations; this module owns the project + which schemas the
# API exposes. See README.md for the recreate + import runbooks.

resource "supabase_project" "this" {
  organization_id         = var.organization_id
  name                    = var.project_name
  database_password       = var.database_password
  region                  = var.region
  instance_size           = var.instance_size
  legacy_api_keys_enabled = var.legacy_api_keys_enabled

  # Imported, never replaced. name/region/instance_size are replace-forcing in the
  # provider (a replace destroys the database), and the password is set out-of-band.
  # A true rebuild is the deliberate recreate runbook, not a stray plan diff.
  #
  # DANGER: `database_password` MUST stay in ignore_changes. Consumers pass a placeholder for it
  # (infra.yml: `${{ secrets.… || 'import-placeholder' }}`) since the live password is set
  # out-of-band; removing it here would make a stray apply RESET the live DB password and lock the
  # app out. A guard test (cli/src/__tests__/infra-supabase-guard.test.ts) fails CI on removal.
  lifecycle {
    ignore_changes = [database_password, name, region, instance_size]
  }
}

locals {
  # Partial auth config — built only when Discord is enabled, and carrying ONLY the keys we
  # explicitly manage. The Management API PATCHes /config/auth, so keys not present here (email,
  # phone, JWT, other providers…) are left untouched. site_url / uri_allow_list are included
  # only when supplied, so enabling Discord doesn't clobber a redirect setup unless asked to.
  auth_config = var.discord_auth_enabled ? merge(
    {
      external_discord_enabled   = true
      external_discord_client_id = var.discord_client_id
      external_discord_secret    = var.discord_client_secret
    },
    var.auth_site_url != "" ? { site_url = var.auth_site_url } : {},
    length(var.auth_additional_redirect_urls) > 0 ? { uri_allow_list = join(",", var.auth_additional_redirect_urls) } : {},
  ) : null
}

resource "supabase_settings" "this" {
  project_ref = supabase_project.this.id
  api = jsonencode({
    db_schema            = var.api_db_schema
    db_extra_search_path = "public,extensions"
    max_rows             = 1000
  })

  # Auth config is managed ONLY when Discord auth is on. null => attribute unset => the provider
  # does not touch /config/auth, preserving every existing consumer's behavior unchanged.
  auth = local.auth_config != null ? jsonencode(local.auth_config) : null

  lifecycle {
    precondition {
      condition     = !var.discord_auth_enabled || (var.discord_client_id != "" && var.discord_client_secret != "")
      error_message = "discord_auth_enabled requires both discord_client_id and discord_client_secret to be set."
    }
  }
}

data "supabase_apikeys" "this" {
  project_ref = supabase_project.this.id
}
