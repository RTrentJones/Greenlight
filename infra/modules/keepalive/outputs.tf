output "script_name" {
  value = cloudflare_workers_script.keepalive.script_name
}

output "cron" {
  value = var.cron
}
