# Example root that instantiates `module "tool"` — used for `terraform test` (mock
# providers, no creds) and as the shape the wrapper's infra/ follows (one module
# block per tool, appended by `greenlight add`). No backend here; the wrapper uses R2.

variable "name" {
  type    = string
  default = "ping-mcp"
}
variable "domain" {
  type    = string
  default = "example.dev"
}
variable "target" {
  type    = string
  default = "oci"
}
variable "lane" {
  type    = string
  default = "mcp"
}
variable "data" {
  type    = string
  default = "none"
}
variable "envs" {
  type    = list(string)
  default = ["beta", "prod"]
}

module "tool" {
  source      = "../../modules/tool"
  name        = var.name
  domain      = var.domain
  zone_id     = "0000000000000000000000000000test"
  github_repo = "example/site"
  lane        = var.lane
  target      = var.target
  data        = var.data
  envs        = var.envs
}

module "repo" {
  source          = "../../modules/repo"
  repository      = "site"
  required_checks = ["ci"]
}

output "prod_url" {
  value = module.tool.prod_url
}
output "beta_url" {
  value = module.tool.beta_url
}
output "record_count" {
  value = module.tool.record_count
}
output "env_count" {
  value = module.tool.env_count
}
output "develop_branch" {
  value = module.repo.develop_branch
}
output "protected_patterns" {
  value = module.repo.protected_patterns
}
