# One Supabase project per env (project-per-env: Supabase branching is paid, and a
# separate beta DB keeps preview writes off prod). The project is fully declared here
# so it is recreatable from scratch; schema lives in the app repo's supabase/migrations
# (replayed via `supabase db push` on recreate). See README.md for the recreate runbook.

resource "supabase_project" "this" {
  for_each = toset(var.envs)

  organization_id         = var.organization_id
  name                    = "${var.name}-${each.key}"
  database_password       = var.database_password
  region                  = var.region
  instance_size           = var.instance_size
  legacy_api_keys_enabled = var.legacy_api_keys_enabled

  # The password is set once; an out-of-band rotation must not force a replace
  # (which would destroy the database). Same guard HeistMind's original tf used.
  lifecycle {
    ignore_changes = [database_password]
  }
}

resource "supabase_settings" "this" {
  for_each = supabase_project.this

  project_ref = each.value.id
  api = jsonencode({
    db_schema            = "public,graphql_public"
    db_extra_search_path = "public,extensions"
    max_rows             = 1000
  })
}

data "supabase_apikeys" "this" {
  for_each = supabase_project.this

  project_ref = each.value.id
}
