output "subnet_id" {
  value       = oci_core_subnet.this.id
  description = "Public subnet OCID — wire into the oci-container-instance module's subnet_id."
}

output "vcn_id" {
  value       = oci_core_vcn.this.id
  description = "VCN OCID."
}
