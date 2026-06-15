output "project_id" {
  value       = vercel_project.this.id
  description = "Vercel project id (use for `terraform import` of an existing project)."
}

output "prod_url" {
  value       = "https://${local.prod_domain}"
  description = "Deterministic prod URL (matches resolveUrl in @rtrentjones/greenlight-shared)."
}

output "beta_url" {
  value = "https://${local.beta_domain}"
}

output "env_count" {
  value = length(vercel_project_environment_variable.env)
}
