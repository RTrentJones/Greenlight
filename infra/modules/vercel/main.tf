# A Vercel project wired to the app repo's GitHub integration: pushes to the production
# branch deploy prod, pushes to the beta branch deploy the beta domain. Deploys happen
# via Vercel (git integration) — Greenlight provisions the project + domains + env vars
# here and only *verifies* the result. Subdomain DNS (CNAME -> cname.vercel-dns.com) is
# the wrapper's `module "tool"` job, not this module's.

locals {
  prod_domain = "${var.name}.${var.domain}"
  beta_domain = "beta.${var.name}.${var.domain}"
}

resource "vercel_project" "this" {
  name      = var.name
  framework = var.framework

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = var.production_branch
  }

  root_directory   = var.root_directory
  build_command    = var.build_command
  install_command  = var.install_command
  output_directory = var.output_directory
}

# Production domain — assigned to production-branch deployments.
resource "vercel_project_domain" "prod" {
  project_id = vercel_project.this.id
  domain     = local.prod_domain
}

# Beta domain — tracks the beta branch's deployments.
resource "vercel_project_domain" "beta" {
  project_id = vercel_project.this.id
  domain     = local.beta_domain
  git_branch = var.beta_branch
}

resource "vercel_project_environment_variable" "env" {
  for_each = var.environment

  project_id = vercel_project.this.id
  key        = each.value.key
  value      = var.environment_values[each.key]
  target     = each.value.target
  sensitive  = each.value.sensitive
}
