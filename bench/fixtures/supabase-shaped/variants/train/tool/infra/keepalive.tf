module "keepalive" {
  source     = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/keepalive?ref=v0.10.1"
  account_id = var.cloudflare_account_id

  targets_json      = file("${path.module}/../keepalive/targets.json")
  alert_github_repo = var.alert_github_repo
  github_token      = var.keepalive_github_token
  cron              = "0 6 */3 * *"
}
