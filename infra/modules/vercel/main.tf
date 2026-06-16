# Configure an EXISTING Vercel project (created + git-linked in the Vercel dashboard):
# its custom domains + env vars. Deploys ride Vercel's git integration — Greenlight
# provisions config here and only verifies. Subdomain DNS (CNAME -> cname.vercel-dns.com)
# is the wrapper's `module "tool"` job. (Vercel projects don't idle-pause, so unlike
# Supabase we don't need to own the whole project resource for recreatability.)

locals {
  prod_domain = "${var.name}.${var.domain}"
  beta_domain = "beta.${var.name}.${var.domain}"
}

# Production domain — assigned to production-branch deployments.
resource "vercel_project_domain" "prod" {
  project_id = var.project_id
  domain     = local.prod_domain
}

# Beta domain — tracks the beta branch's deployments.
resource "vercel_project_domain" "beta" {
  project_id = var.project_id
  domain     = local.beta_domain
  git_branch = var.beta_branch
}

resource "vercel_project_environment_variable" "env" {
  for_each = var.environment

  project_id = var.project_id
  key        = each.value.key
  value      = var.environment_values[each.key]
  target     = each.value.target
  sensitive  = each.value.sensitive
}
