variable "name" {
  type        = string
  description = "Tool name — the Neon project name + the label for per-env branches."
}

variable "region" {
  type        = string
  default     = "aws-us-east-1"
  description = "Neon region id (e.g. aws-us-east-1, aws-us-west-2, aws-eu-central-1)."
}

variable "pg_version" {
  type        = number
  default     = 17
  description = "Postgres major version."
}

variable "history_retention_seconds" {
  type    = number
  default = 21600 # 6h — the Neon FREE-tier maximum. The provider's own default (86400 / 24h) is
  # rejected on free projects ("requested history retention seconds exceeds allowed maximum ... max
  # 21600"). Bump this on a paid plan (up to 7d / 604800) for longer point-in-time restore.
  description = "Point-in-time restore window (seconds). Default 21600 = the free-tier cap."

  validation {
    condition     = var.history_retention_seconds >= 0 && var.history_retention_seconds <= 604800
    error_message = "history_retention_seconds must be between 0 and 604800 (7 days)."
  }
}

variable "envs" {
  type        = list(string)
  description = <<-EOT
    Greenlight envs. 'prod' is the project's DEFAULT branch (always present). Every other env gets
    its own copy-on-write child branch — except the ephemeral 'preview' (per-PR; created/destroyed by
    CI via the Neon API, not Terraform). So envs = ["beta","prod"] → a prod default branch + a beta branch.
  EOT
}
