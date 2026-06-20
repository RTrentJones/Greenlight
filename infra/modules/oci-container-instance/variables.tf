variable "compartment_id" {
  type        = string
  description = "OCI compartment OCID where the container instance runs."
}

variable "availability_domain" {
  type        = string
  description = "Availability domain for the instance, e.g. \"AbCd:US-ASHBURN-1-AD-1\"."
}

variable "subnet_id" {
  type        = string
  description = "Existing subnet OCID for the instance VNIC (a public subnet so it has egress)."
}

variable "name" {
  type        = string
  description = "Instance + tool container display name (the tool name)."
}

variable "image_url" {
  type        = string
  description = "Tool container image on GHCR, e.g. ghcr.io/owner/tool:prod (built by the tool's own CI)."
}

variable "environment" {
  type        = map(string)
  default     = {}
  description = "Environment variables for the tool container (incl. its PORT, auth, etc.)."
}

variable "tunnel_token" {
  type        = string
  sensitive   = true
  description = "cloudflared connector token (from the `tunnel` module) for the sidecar."
}

variable "shape" {
  type        = string
  default     = "CI.Standard.A1.Flex" # Ampere A1 — Always-Free eligible
  description = "Container instance shape."
}

variable "ocpus" {
  type        = number
  default     = 1 # within the Always-Free A1 allotment (2 OCPU / 12 GB as of 2026-06-15)
  description = "OCPUs for the instance."
}

variable "memory_in_gbs" {
  type        = number
  default     = 6
  description = "Memory (GB) for the instance."
}

variable "cloudflared_image" {
  type        = string
  default     = "docker.io/cloudflare/cloudflared:latest"
  description = "cloudflared sidecar image."
}
