variable "name" {
  type        = string
  description = "Tool name (subdomain). Empty string = the blog (apex domain)."
}

variable "domain" {
  type        = string
  description = "Apex domain, e.g. example.dev."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone id for the domain."
}

variable "github_repo" {
  type        = string
  description = "owner/repo the tool ships from."
}

variable "lane" {
  type        = string
  description = "astro | next | mcp."
}

variable "target" {
  type        = string
  description = "workers | vercel | oci."
}

variable "data" {
  type    = string
  default = "none"
}

variable "auth" {
  type    = string
  default = "none"
}

variable "access" {
  type    = string
  default = "public"
}

variable "envs" {
  type    = list(string)
  default = ["beta", "prod"]
}

variable "cname_target" {
  type        = string
  default     = ""
  description = "Where the subdomain CNAME points (a *.workers.dev host or a Tunnel host). Set by the wrapper; defaulted for plan/test."
}

variable "manage_github_environments" {
  type        = bool
  default     = true
  description = "Create a GitHub deployment environment per env. Set false for external tools (repo managed elsewhere) to avoid a cross-repo github dependency."
}
