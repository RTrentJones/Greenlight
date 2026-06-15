variable "name" {
  type        = string
  description = "Tool name; the per-env project is named <name>-<env> (e.g. heistmind-prod)."
}

variable "organization_id" {
  type        = string
  description = "Supabase organization slug (dashboard URL / org settings)."
}

variable "database_password" {
  type        = string
  sensitive   = true
  description = "Database password applied to every env's project. ignore_changes keeps an out-of-band rotation from forcing a replace."
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Supabase region for all envs."
}

variable "envs" {
  type        = list(string)
  default     = ["beta", "prod"]
  description = "One Supabase project per env (Supabase branching is paid; project-per-env is the V1 model)."
}

variable "instance_size" {
  type        = string
  default     = "micro"
  description = "Desired instance size (micro|small|...)."
}

variable "legacy_api_keys_enabled" {
  type        = bool
  default     = true
  description = "Keep the JWT-based anon/service_role keys (the app consumes NEXT_PUBLIC_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY). Publishable/secret keys are the forward path."
}
