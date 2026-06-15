# Example root for the Vercel + Supabase shape (HeistMind): supabase (project-per-env)
# feeds its keys into the Vercel project's env vars; `module "tool"` owns the subdomain
# CNAME (-> cname.vercel-dns.com). Mirrors what the wrapper's infra/ does. Used by
# `terraform test` with mock providers (no creds, no resources).

variable "name" {
  type    = string
  default = "heistmind"
}
variable "domain" {
  type    = string
  default = "example.dev"
}

module "supabase" {
  source            = "../../modules/supabase"
  name              = var.name
  organization_id   = "test-org"
  database_password = "test-password-123"
  region            = "us-east-1"
  envs              = ["beta", "prod"]
}

module "vercel" {
  source         = "../../modules/vercel"
  name           = var.name
  domain         = var.domain
  github_repo    = "example/heistmind"
  beta_branch    = "development"
  root_directory = "apps/web"

  # Supabase creds flow straight from the supabase module into Vercel env (no manual copy).
  environment = {
    site_url_prod     = { key = "SITE_URL", target = ["production"], sensitive = false }
    site_url_beta     = { key = "SITE_URL", target = ["preview"], sensitive = false }
    supa_url_prod     = { key = "NEXT_PUBLIC_SUPABASE_URL", target = ["production"], sensitive = false }
    supa_anon_prod    = { key = "NEXT_PUBLIC_SUPABASE_ANON_KEY", target = ["production"], sensitive = false }
    supa_service_prod = { key = "SUPABASE_SERVICE_ROLE_KEY", target = ["production"], sensitive = true }
    supa_url_beta     = { key = "NEXT_PUBLIC_SUPABASE_URL", target = ["preview"], sensitive = false }
    supa_anon_beta    = { key = "NEXT_PUBLIC_SUPABASE_ANON_KEY", target = ["preview"], sensitive = false }
    supa_service_beta = { key = "SUPABASE_SERVICE_ROLE_KEY", target = ["preview"], sensitive = true }
  }
  environment_values = {
    site_url_prod     = "https://${var.name}.${var.domain}"
    site_url_beta     = "https://beta.${var.name}.${var.domain}"
    supa_url_prod     = module.supabase.urls["prod"]
    supa_anon_prod    = module.supabase.anon_keys["prod"]
    supa_service_prod = module.supabase.service_role_keys["prod"]
    supa_url_beta     = module.supabase.urls["beta"]
    supa_anon_beta    = module.supabase.anon_keys["beta"]
    supa_service_beta = module.supabase.service_role_keys["beta"]
  }
}

module "dns" {
  source      = "../../modules/tool"
  name        = var.name
  domain      = var.domain
  zone_id     = "0000000000000000000000000000test"
  github_repo = "example/heistmind"
  lane        = "next"
  target      = "vercel"
  data        = "supabase"
  envs        = ["beta", "prod"]
}

output "prod_url" {
  value = module.vercel.prod_url
}
output "beta_url" {
  value = module.vercel.beta_url
}
output "supabase_project_count" {
  value = module.supabase.project_count
}
output "vercel_env_count" {
  value = module.vercel.env_count
}
output "dns_cname_target" {
  value = module.dns.cname_target
}
output "dns_record_count" {
  value = module.dns.record_count
}
