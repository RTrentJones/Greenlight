locals {
  user = neon_project.this.database_user
  pass = neon_project.this.database_password
  db   = neon_project.this.database_name

  # Per-branch (non-prod) connection strings, built from the branch endpoint host + the shared role.
  # The pooled host is the direct host with "-pooler" inserted after the endpoint id (Neon convention).
  branch_direct = {
    for e, ep in neon_endpoint.env :
    e => "postgresql://${local.user}:${local.pass}@${ep.host}/${local.db}?sslmode=require"
  }
  branch_pooled = {
    for e, ep in neon_endpoint.env :
    e => "postgresql://${local.user}:${local.pass}@${replace(ep.host, "/^([^.]+)\\./", "$1-pooler.")}/${local.db}?sslmode=require"
  }
}

output "database_url" {
  description = "Pooled (pgbouncer) connection string per env — for the serverless app (DATABASE_URL)."
  sensitive   = true
  value = merge(
    { prod = neon_project.this.connection_uri_pooler },
    local.branch_pooled,
  )
}

output "direct_url" {
  description = "Direct connection string per env — for migrations (DIRECT_URL)."
  sensitive   = true
  value = merge(
    { prod = neon_project.this.connection_uri },
    local.branch_direct,
  )
}

output "project_id" {
  description = "Neon project id."
  value       = neon_project.this.id
}
