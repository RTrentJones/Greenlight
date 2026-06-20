terraform {
  required_version = ">= 1.7"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0"
    }
  }
}
