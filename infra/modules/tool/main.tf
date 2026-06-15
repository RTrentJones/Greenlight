locals {
  is_blog = var.name == ""

  # DNS record name per env (CNAME-at-apex relies on Cloudflare CNAME flattening).
  record_names = {
    for e in var.envs : e => (
      e == "prod"
      ? (local.is_blog ? var.domain : "${var.name}.${var.domain}")
      : (local.is_blog ? "beta.${var.domain}" : "beta.${var.name}.${var.domain}")
    )
  }

  # Where the subdomain points. Real value is set by the wrapper; this keeps plan/test valid.
  cname = (
    var.cname_target != "" ? var.cname_target :
    var.target == "oci" ? "tunnel.${var.domain}" :
    var.target == "vercel" ? "cname.vercel-dns.com" :
    "${coalesce(var.name, "blog")}.workers.dev"
  )
}

# One DNS record per env (plug-and-play subdomain). Proxied through Cloudflare.
resource "cloudflare_dns_record" "tool" {
  for_each = local.record_names

  zone_id = var.zone_id
  name    = each.value
  type    = "CNAME"
  content = local.cname
  ttl     = 1
  proxied = true
}

# A GitHub deployment environment per env (gates beta/prod; secrets attach here).
resource "github_repository_environment" "env" {
  for_each = toset(var.envs)

  repository  = split("/", var.github_repo)[1]
  environment = local.is_blog ? "blog-${each.key}" : "${var.name}-${each.key}"
}
