# The Greenlight keepalive Worker, deployed as code: a cron-triggered Cloudflare Worker
# that pings every data:supabase project so it never hits the 7-day idle pause, and opens
# a github-issue on failure. The worker bundle is passed in as `content`
# (packages/keepalive/dist/index.js); its config (targets, alert sink, schedule) is set
# here as bindings, so it is fully declarative — no `wrangler deploy` by hand.

locals {
  bindings = concat(
    [
      { name = "KEEPALIVE_TARGETS", type = "plain_text", text = var.targets_json },
      { name = "ALERT_GITHUB_REPO", type = "plain_text", text = var.alert_github_repo },
    ],
    var.github_token != "" ? [
      { name = "GITHUB_TOKEN", type = "secret_text", text = var.github_token },
    ] : [],
  )
}

resource "cloudflare_workers_script" "keepalive" {
  account_id         = var.account_id
  script_name        = var.script_name
  content            = var.content
  main_module        = "worker.js"
  compatibility_date = var.compatibility_date
  bindings           = local.bindings

  observability = {
    enabled = true
  }
}

resource "cloudflare_workers_cron_trigger" "keepalive" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.keepalive.script_name
  schedules   = [{ cron = var.cron }]
}
