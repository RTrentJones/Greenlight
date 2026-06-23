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

# --- Auth: optional Discord OAuth provider ---------------------------------------------------
# Default OFF. When discord_auth_enabled is false the module does NOT manage the auth config at
# all (the `auth` argument is null), so a project's existing email/JWT/redirect settings are
# left exactly as-is — adding these vars is byte-identical to before for current consumers. When
# enabled, only the keys below are sent; the Management API PATCHes /config/auth, so unset keys
# (email, phone, JWT, etc.) are untouched. Field names mirror the Supabase Management API auth
# config. The Discord *application* itself is created manually (Discord Developer Portal); its
# redirect URI is https://<project_ref>.supabase.co/auth/v1/callback.

variable "discord_auth_enabled" {
  type        = bool
  default     = false
  description = "Enable Discord as an OAuth provider on this project's auth config. Default off — when false this module does not manage the auth config (existing settings untouched)."
}

variable "discord_client_id" {
  type        = string
  default     = ""
  description = "Discord application Client ID (Discord Developer Portal → OAuth2). Required when discord_auth_enabled."
}

variable "discord_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Discord application Client Secret. Required when discord_auth_enabled."
}

variable "auth_site_url" {
  type        = string
  default     = ""
  description = "GoTrue Site URL (default post-auth redirect target). Managed only when non-empty AND auth is being managed (discord_auth_enabled). e.g. https://app.example.com."
}

variable "auth_additional_redirect_urls" {
  type        = list(string)
  default     = []
  description = "Allowed post-auth redirect URLs (GoTrue uri_allow_list; supports * wildcards). Managed only when non-empty AND auth is being managed. e.g. [\"https://app.example.com/**\"]."
}
