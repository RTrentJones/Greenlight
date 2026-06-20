# No-creds verification of the Vercel + Supabase shape — all providers mocked, so `plan`
# runs without any cloud access. Asserts the URL scheme, project-per-env fan-out, the
# env-var wiring, and that the subdomain CNAME points at Vercel.

mock_provider "vercel" {}
mock_provider "supabase" {}
mock_provider "cloudflare" {}
mock_provider "github" {}

run "vercel_supabase_wiring" {
  command = plan

  variables {
    name   = "heistmind"
    domain = "example.dev"
  }

  assert {
    condition     = output.prod_url == "https://heistmind.example.dev"
    error_message = "vercel prod url wrong"
  }
  assert {
    condition     = output.beta_url == "https://beta.heistmind.example.dev"
    error_message = "vercel beta url wrong"
  }
  assert {
    condition     = output.vercel_env_count == 8
    error_message = "expected 8 env vars (SITE_URL + 3 supabase keys, each x2 targets)"
  }
  assert {
    condition     = output.dns_cname_target == "cname.vercel-dns.com"
    error_message = "vercel subdomain CNAME must point at cname.vercel-dns.com"
  }
  assert {
    condition     = output.dns_record_count == 2
    error_message = "expected one DNS record per env"
  }
  assert {
    condition     = output.dns_env_count == 0
    error_message = "external tool should create no github environments (manage_github_environments=false)"
  }
  assert {
    condition     = output.keepalive_script == "greenlight-keepalive"
    error_message = "keepalive worker script name wrong"
  }
  assert {
    condition     = output.keepalive_cron == "0 6 */3 * *"
    error_message = "keepalive cron schedule wrong"
  }
}
