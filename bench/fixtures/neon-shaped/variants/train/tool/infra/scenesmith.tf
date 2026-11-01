module "scenesmith_neon" {
  source       = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/neon?ref=v0.10.1"
  project_name = "scenesmith"
}

module "scenesmith" {
  source = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/oci-container?ref=v0.10.1"
  name   = "scenesmith"
  port   = 8080
  env = {
    DATABASE_URL = module.scenesmith_neon.pooled_connection_uri
  }
}
