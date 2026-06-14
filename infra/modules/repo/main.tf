# Repo-level setup for the Greenlight loop: the develop (beta) branch + branch
# protection on both branches. Instantiated once per consumer repo (alongside the
# per-tool `module "tool"`). The github provider's owner supplies the org/user.

resource "github_branch" "develop" {
  repository    = var.repository
  branch        = var.develop_branch
  source_branch = var.default_branch
}

resource "github_branch_protection" "main" {
  repository_id  = var.repository
  pattern        = var.default_branch
  enforce_admins = false

  required_status_checks {
    strict   = true
    contexts = var.required_checks
  }
}

resource "github_branch_protection" "develop" {
  repository_id  = var.repository
  pattern        = var.develop_branch
  enforce_admins = false

  required_status_checks {
    strict   = true
    contexts = var.required_checks
  }

  depends_on = [github_branch.develop]
}
