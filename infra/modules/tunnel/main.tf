# A Cloudflare Tunnel (cloudflared) + remotely-managed ingress, so an OCI Always-Free VM with
# no public app port is reachable at <name>.<domain> over TLS. This is the declarative
# replacement for BAMCP's imperative `setup-cloudflared.sh`: the connector token (a sensitive
# output) is placed on the VM, where `cloudflared tunnel run --token <token>` runs as a sidecar.
# The `tool` module's DNS CNAME points at `cname_target` (<id>.cfargotunnel.com).

# 32-byte tunnel secret (base64) — self-generated so the module is self-contained.
resource "random_bytes" "tunnel_secret" {
  length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id    = var.account_id
  name          = var.name
  config_src    = "cloudflare" # config is managed remotely by the *_config resource below
  tunnel_secret = random_bytes.tunnel_secret.base64
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    # Each route + a required catch-all 404 as the final rule.
    ingress = concat(
      [for r in var.ingress : { hostname = r.hostname, service = r.service }],
      [{ hostname = null, service = "http_status:404" }]
    )
  }
}

locals {
  # The connector token cloudflared expects is base64(json({a:accountTag, t:tunnelID, s:secret})).
  # The resource exposes no `token` attribute, so construct it (the documented format).
  token = base64encode(jsonencode({
    a = var.account_id
    t = cloudflare_zero_trust_tunnel_cloudflared.this.id
    s = random_bytes.tunnel_secret.base64
  }))
}
