variable "name" {
  type        = string
  description = "Tool name (used for labels / keepalive target naming)."
}

variable "project_name" {
  type        = string
  description = "Exact Supabase project name. Match the existing project when importing (e.g. heistmind-db) — name is replace-forcing, so a mismatch would destroy the database."
}

variable "organization_id" {
  type        = string
  description = "Supabase organization slug/id."
}

variable "database_password" {
  type        = string
  sensitive   = true
  description = "Database password. Set on create; ignored on update (rotations happen out-of-band)."
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Supabase region. Replace-forcing — match the existing project on import."
}

variable "instance_size" {
  type        = string
  default     = "micro"
  description = "Desired instance size."
}

variable "legacy_api_keys_enabled" {
  type        = bool
  default     = true
  description = "Keep the JWT anon/service_role keys (the app uses them). Publishable/secret keys are the forward path."
}

variable "api_db_schema" {
  type        = string
  default     = "public,graphql_public"
  description = "Schemas PostgREST exposes. For schema-per-env (beta/prod in one project), add the extra schema here, e.g. \"public,graphql_public,beta\"."
}
