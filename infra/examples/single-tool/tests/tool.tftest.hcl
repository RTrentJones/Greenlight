# No-creds, no-resources verification of `module "tool"` — providers are mocked, so
# `plan` runs without any cloud access. Asserts the URL scheme + per-env fan-out.

mock_provider "cloudflare" {}
mock_provider "github" {}

run "subdomain_tool_urls" {
  command = plan
  variables {
    name   = "ping-mcp"
    domain = "example.dev"
    target = "oci"
    lane   = "mcp"
    envs   = ["beta", "prod"]
  }
  assert {
    condition     = output.prod_url == "https://ping-mcp.example.dev"
    error_message = "subdomain prod url wrong"
  }
  assert {
    condition     = output.beta_url == "https://beta.ping-mcp.example.dev"
    error_message = "subdomain beta url wrong"
  }
  assert {
    condition     = output.record_count == 2 && output.env_count == 2
    error_message = "expected one DNS record + one GitHub environment per env"
  }
}

run "blog_apex_urls" {
  command = plan
  variables {
    name   = ""
    domain = "example.dev"
    target = "workers"
    lane   = "astro"
    envs   = ["beta", "prod"]
  }
  assert {
    condition     = output.prod_url == "https://example.dev"
    error_message = "apex prod url wrong"
  }
  assert {
    condition     = output.beta_url == "https://beta.example.dev"
    error_message = "apex beta url wrong"
  }
}

run "single_env" {
  command = plan
  variables {
    name   = "shorten"
    domain = "example.dev"
    target = "workers"
    lane   = "mcp"
    envs   = ["prod"]
  }
  assert {
    condition     = output.record_count == 1 && output.env_count == 1
    error_message = "envs list should drive the fan-out"
  }
}
