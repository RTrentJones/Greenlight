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

variable "envs" {
  type        = list(string)
  description = <<-EOT
    Greenlight envs. 'prod' is the project's DEFAULT branch (always present). Every other env gets
    its own copy-on-write child branch — except the ephemeral 'preview' (per-PR; created/destroyed by
    CI via the Neon API, not Terraform). So envs = ["beta","prod"] → a prod default branch + a beta branch.
  EOT
}
