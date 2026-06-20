variable "account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "name" {
  type        = string
  description = "Tunnel name, e.g. <tool>-tunnel."
}

variable "ingress" {
  type = list(object({
    hostname = string
    service  = string
  }))
  description = <<-EOT
    Public hostname -> local service routes, e.g.
    [{ hostname = "bamcp.example.dev", service = "http://localhost:8000" }].
    A catch-all `http_status:404` rule is appended automatically (must be last).
  EOT
}
