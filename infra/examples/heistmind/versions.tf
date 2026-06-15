terraform {
  required_version = ">= 1.7"
  required_providers {
    vercel     = { source = "vercel/vercel", version = "~> 3.0" }
    supabase   = { source = "supabase/supabase", version = "~> 1.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
    github     = { source = "integrations/github", version = "~> 6.0" }
  }
}

provider "vercel" {}
provider "supabase" {}
provider "cloudflare" {}
provider "github" {}
