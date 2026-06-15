variable "name" {
  type        = string
  description = "Tool name (subdomain). Project deploys at <name>.<domain> / beta.<name>.<domain>."
}

variable "domain" {
  type        = string
  description = "Apex domain, e.g. example.dev."
}

variable "github_repo" {
  type        = string
  description = "owner/repo the project deploys from (Vercel git integration)."
}

variable "framework" {
  type        = string
  default     = "nextjs"
  description = "Vercel framework preset."
}

variable "production_branch" {
  type        = string
  default     = "main"
  description = "Branch that deploys to production."
}

variable "beta_branch" {
  type        = string
  default     = "develop"
  description = "Branch whose deployments the beta domain tracks (HeistMind uses 'development')."
}

variable "root_directory" {
  type        = string
  default     = null
  description = "Source root (null = repo root; auto-detected if omitted)."
}

variable "build_command" {
  type    = string
  default = null
}

variable "install_command" {
  type    = string
  default = null
}

variable "output_directory" {
  type    = string
  default = null
}

# Project env vars, split so `for_each` can run (a sensitive map can't drive for_each):
# `environment` is non-sensitive metadata keyed by a unique id; `environment_values`
# holds the (sensitive) value under the same id. The same env-var `key` can appear under
# different ids when it needs distinct values per target (prod vs preview). `sensitive`
# is required by the provider for preview/production-targeted vars.
variable "environment" {
  type = map(object({
    key       = string
    target    = list(string) # production | preview | development
    sensitive = optional(bool, true)
  }))
  default     = {}
  description = "Env var metadata keyed by a unique id; the value comes from environment_values[id]."
}

variable "environment_values" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Secret values keyed by the same ids as `environment` (Supabase creds + SITE_URL)."
}
