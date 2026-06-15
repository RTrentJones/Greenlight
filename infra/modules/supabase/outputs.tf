output "project_ref" {
  value       = supabase_project.this.id
  description = "Supabase project ref."
}

output "url" {
  value       = "https://${supabase_project.this.id}.supabase.co"
  description = "Project API URL (NEXT_PUBLIC_SUPABASE_URL)."
}

output "anon_key" {
  value       = data.supabase_apikeys.this.anon_key
  sensitive   = true
  description = "anon (publishable) key."
}

output "service_role_key" {
  value       = data.supabase_apikeys.this.service_role_key
  sensitive   = true
  description = "service_role (secret) key."
}
