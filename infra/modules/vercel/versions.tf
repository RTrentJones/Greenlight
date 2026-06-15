terraform {
  required_version = ">= 1.7"
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
  }
}
