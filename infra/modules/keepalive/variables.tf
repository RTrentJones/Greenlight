variable "account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "script_name" {
  type        = string
  default     = "greenlight-keepalive"
  description = "Worker script name."
}

variable "content" {
  type        = string
  description = "Bundled Worker module JS (the contents of packages/keepalive/dist/index.js)."
}

variable "compatibility_date" {
  type    = string
  default = "2025-06-01"
}

variable "targets_json" {
  type        = string
  description = "KEEPALIVE_TARGETS — JSON array of { name, env, url, anonKey, probePath? } for every data:supabase project."
}

variable "alert_github_repo" {
  type        = string
  default     = ""
  description = "github-issue alert sink (owner/repo). Empty disables alerts."
}

variable "github_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Token with issues:write for the alert sink. Empty = no secret binding (alerts no-op)."
}

variable "cron" {
  type        = string
  default     = "0 6 */3 * *"
  description = "Cron schedule (default: every 3 days, inside Supabase's 7-day window)."
}
