output "prod_url" {
  value       = local.is_blog ? "https://${var.domain}" : "https://${var.name}.${var.domain}"
  description = "Deterministic prod URL (matches resolveUrl in @rtrentjones/greenlight-shared)."
}

output "beta_url" {
  value = local.is_blog ? "https://beta.${var.domain}" : "https://beta.${var.name}.${var.domain}"
}

output "record_count" {
  value       = length(cloudflare_dns_record.tool)
  description = "DNS records created (one per env)."
}

output "env_count" {
  value = length(github_repository_environment.env)
}

output "record_ids" {
  value = { for e, r in cloudflare_dns_record.tool : e => r.id }
}

output "cname_target" {
  value       = local.cname
  description = "Where the subdomain CNAME points (oci=tunnel, vercel=cname.vercel-dns.com, else *.workers.dev)."
}
