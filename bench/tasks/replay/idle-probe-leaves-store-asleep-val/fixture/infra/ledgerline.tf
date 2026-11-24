module "ledgerline_neon" {
  source       = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/neon?ref=v0.10.1"
  project_name = "ledgerline"
}

module "ledgerline" {
  source = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/docker-host?ref=v0.10.1"
  name   = "ledgerline"
  port   = 3000
  env = {
    STORE_URL = module.ledgerline_neon.pooled_connection_uri
  }
}
