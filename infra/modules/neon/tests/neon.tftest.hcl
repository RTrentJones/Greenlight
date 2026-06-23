# No-creds verification of the Neon module shape — the provider is mocked, so apply runs without any
# cloud access. Asserts the project name, a child branch per non-prod/non-preview env, and that the
# pooled/direct connection-string outputs carry one entry per env.

mock_provider "neon" {}

run "branch_per_env" {
  command = apply

  variables {
    name = "notes"
    envs = ["beta", "prod"]
  }

  assert {
    condition     = neon_project.this.name == "notes"
    error_message = "project name should be the tool name"
  }
  assert {
    condition     = length(neon_branch.env) == 1
    error_message = "expected one child branch (beta); prod = default branch, preview = ephemeral"
  }
  assert {
    condition     = contains(keys(output.database_url), "prod") && contains(keys(output.database_url), "beta")
    error_message = "database_url (pooled) must have an entry per env (prod + beta)"
  }
  assert {
    condition     = contains(keys(output.direct_url), "prod") && contains(keys(output.direct_url), "beta")
    error_message = "direct_url must have an entry per env (prod + beta)"
  }
}

run "prod_only_has_no_child_branches" {
  command = apply

  variables {
    name = "solo"
    envs = ["prod"]
  }

  assert {
    condition     = length(neon_branch.env) == 0
    error_message = "a prod-only tool needs no child branches"
  }
  assert {
    condition     = keys(output.database_url) == ["prod"]
    error_message = "prod-only → only a prod connection string"
  }
}
