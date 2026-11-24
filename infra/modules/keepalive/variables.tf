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
  default     = ""
  description = "Bundled Worker module JS. Defaults to the module's committed worker.js (so the module is self-contained for git-sourced/CI use); override to supply a freshly built bundle."
}

variable "compatibility_date" {
  type    = string
  default = "2025-06-01"
}

variable "targets_json" {
  type        = string
  description = <<-EOT
    KEEPALIVE_TARGETS — JSON array of targets.
    supabase: { name, env, url, anonKey, probeTable, probeSchema?, probeSelect?, probePath? }.
      probeTable is REQUIRED (or an explicit probePath): the probe must SELECT from a real table
      so a query actually reaches Postgres. Supabase counts DATABASE activity, and the PostgREST
      root (/rest/v1/) is answered from the schema cache — pinging it does NOT reset the 7-day
      idle timer. Pick a table the `anon` role can SELECT; RLS returning zero rows is fine.
    oci: { name, env, url, kind = "oci", probePath?, remediate? }.
  EOT
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
  description = "Token with issues:write for the alert sink (+ contents:write if dispatch_github_repo is set, for auto-remediation). Empty = no secret binding (alerts/dispatch no-op)."
}

variable "dispatch_github_repo" {
  type        = string
  default     = ""
  description = "Auto-remediation: owner/repo to fire repository_dispatch at when an oci target with remediate:true fails (usually the wrapper itself). Empty disables self-heal (alert-only)."
}

variable "cron" {
  type        = string
  default     = "0 */4 * * *"
  description = <<-EOT
    Cron schedule (default: every 4 hours, six probes a day). Supabase pauses a free project for
    too LITTLE database activity over a rolling week, not for one fully idle week: its docs say "a
    few user requests to the database each day" is what keeps a project up. The old every-3-days
    default sent two or three queries a week, and heistmind-db paused on 2026-11-22 an hour after a
    probe that returned 200. Do not stretch this past a few hours for supabase targets.
  EOT
}
