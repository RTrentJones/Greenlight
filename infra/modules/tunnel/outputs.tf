output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
  description = "UUID of the tunnel."
}

output "cname_target" {
  value       = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  description = "Wire the tool module's `cname_target` to this so <name>.<domain> resolves through the tunnel."
}

output "token" {
  value       = local.token
  sensitive   = true
  description = "cloudflared connector token — place on the VM and run `cloudflared tunnel run --token <token>`."
}
