# OCI Container Instance (Always-Free Ampere A1) running the tool's GHCR image + a cloudflared
# sidecar. Free: the A1 allotment is shared across VM / Bare-Metal / Container-Instances, and
# the image comes from GHCR (OCIR — Oracle's registry — is paid). The tool's own CI builds +
# pushes the image (provider-agnostic); `greenlight deploy` / the wrapper's deploy workflow
# restarts this instance so it re-pulls the latest. The two containers share a network
# namespace, so cloudflared reaches the tool at localhost (the tunnel's ingress target).
#
# Private GHCR image? add `image_pull_secrets { ... }` here (a registry credential). Default
# assumes a public package.

resource "oci_container_instances_container_instance" "this" {
  compartment_id      = var.compartment_id
  availability_domain = var.availability_domain
  display_name        = var.name
  shape               = var.shape

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  container_restart_policy = "ALWAYS"

  # The tool — reachable by the sidecar at localhost (shared netns).
  containers {
    display_name          = var.name
    image_url             = var.image_url
    environment_variables = var.environment
  }

  # cloudflared sidecar — runs the named tunnel; routes <name>.<domain> → localhost:<app port>.
  containers {
    display_name = "cloudflared"
    image_url    = var.cloudflared_image
    arguments    = ["tunnel", "run", "--token", var.tunnel_token]
  }

  vnics {
    subnet_id = var.subnet_id
  }
}
