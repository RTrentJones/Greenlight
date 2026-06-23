# One Neon project per tool. The project's DEFAULT branch is prod; every other non-ephemeral env
# (e.g. beta) is a copy-on-write child branch with its own read-write compute endpoint. Compute
# autosuspends and AUTO-RESUMES on the next connection, so a Neon tool needs NO keepalive (unlike
# Supabase's 7-day manual-unpause pause — this is why Neon is the default Postgres). The project's
# role / password / database are shared across branches; per-branch connection strings differ only
# by host. See README.md for the recreate + import runbooks.

locals {
  # Branches to create: every env except prod (the default branch) and preview (ephemeral, per-PR —
  # created/destroyed by CI, not Terraform).
  branch_envs = [for e in var.envs : e if e != "prod" && e != "preview"]
}

resource "neon_project" "this" {
  name       = var.name
  region_id  = var.region
  pg_version = var.pg_version
}

resource "neon_branch" "env" {
  for_each = toset(local.branch_envs)

  project_id = neon_project.this.id
  parent_id  = neon_project.this.default_branch_id
  name       = each.key
}

# A child branch needs its own compute endpoint to be queryable; the default branch (prod) already
# has the project's default endpoint.
resource "neon_endpoint" "env" {
  for_each = neon_branch.env

  project_id     = neon_project.this.id
  branch_id      = each.value.id
  type           = "read_write"
  pooler_enabled = true
}
