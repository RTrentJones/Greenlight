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
  lifecycle {
    ignore_changes = [database_password, name, region, instance_size]
  }
}

resource "supabase_settings" "this" {
  project_ref = supabase_project.this.id
  api = jsonencode({
    db_schema            = var.api_db_schema
    db_extra_search_path = "public,extensions"
    max_rows             = 1000
  })
}

data "supabase_apikeys" "this" {
  project_ref = supabase_project.this.id
}
