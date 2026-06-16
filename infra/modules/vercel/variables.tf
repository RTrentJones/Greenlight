variable "project_id" {
  type        = string
  description = "Existing Vercel project id (prj_...). The project is created/linked to git in the Vercel dashboard; this module configures its domains + env vars."
}

variable "name" {
  type        = string
  description = "Tool name (subdomain). Project serves <name>.<domain> / beta.<name>.<domain>."
}

variable "domain" {
  type        = string
  description = "Apex domain, e.g. example.dev."
}

variable "beta_branch" {
  type        = string
  default     = "develop"
  description = "Branch whose deployments the beta domain tracks (HeistMind uses 'development')."
}

# Env var metadata (non-sensitive, drives for_each), keyed by a unique id. The same
# env-var `key` can appear under different ids for distinct values per target.
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
