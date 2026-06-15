output "project_refs" {
  value       = { for e, p in supabase_project.this : e => p.id }
  description = "env => Supabase project ref."
}

output "urls" {
  value       = { for e, p in supabase_project.this : e => "https://${p.id}.supabase.co" }
  description = "env => project API URL (NEXT_PUBLIC_SUPABASE_URL)."
}

output "anon_keys" {
  value       = { for e, k in data.supabase_apikeys.this : e => k.anon_key }
  sensitive   = true
  description = "env => anon (publishable) key."
}

output "service_role_keys" {
  value       = { for e, k in data.supabase_apikeys.this : e => k.service_role_key }
  sensitive   = true
  description = "env => service_role (secret) key."
}

output "project_count" {
  value = length(supabase_project.this)
}
