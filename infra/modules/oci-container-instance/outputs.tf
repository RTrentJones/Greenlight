output "container_instance_id" {
  value       = oci_container_instances_container_instance.this.id
  description = "OCID — set as OCI_CONTAINER_INSTANCE_OCID for `greenlight deploy` / the wrapper deploy workflow (restart = re-pull)."
}

output "state" {
  value       = oci_container_instances_container_instance.this.state
  description = "Lifecycle state (ACTIVE when running)."
}
