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
  # Vercel needs DNS-only (grey cloud) to verify the domain + serve TLS itself; Workers/OCI
  # are served through the Cloudflare proxy (orange cloud).
  proxied = var.target != "vercel"
}

# Resolve reviewer usernames → user ids for the prod-environment approval gate (only when env
# management is on and reviewers are configured). The reviewers gate the `<name>-prod` environment,
# which the gated migrate workflow runs under — the manual approval before prod DB migrations apply.
data "github_user" "prod_reviewers" {
  for_each = var.manage_github_environments ? toset(var.prod_reviewers) : toset([])
  username = each.value
}

# A GitHub deployment environment per env (gates beta/prod; secrets attach here). Disable
# for tools whose CI you don't gate via GitHub environments — e.g. an `external` tool whose
# repo is managed elsewhere (avoids a cross-repo github provider dependency in the wrapper's CI).
resource "github_repository_environment" "env" {
  for_each = var.manage_github_environments ? toset(var.envs) : toset([])

  repository  = split("/", var.github_repo)[1]
  environment = local.is_blog ? "blog-${each.key}" : "${var.name}-${each.key}"

  # Required-reviewer approval on PROD only (the manual migration gate). Beta/preview stay ungated.
  # github_user.id is a string; the reviewers.users field is list(number) → tonumber each.
  dynamic "reviewers" {
    for_each = each.key == "prod" && length(var.prod_reviewers) > 0 ? [1] : []
    content {
      users = [for u in data.github_user.prod_reviewers : tonumber(u.id)]
    }
  }
}
