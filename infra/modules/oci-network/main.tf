# OCI network for a Container Instance — VCN + internet gateway + a regional PUBLIC subnet.
# All free. The container instance + its cloudflared sidecar only need OUTBOUND internet
# (pull the GHCR image; cloudflared dials out to Cloudflare — the tunnel is outbound-only),
# so the security list opens egress and no ingress. Created by the tool's `infra/<name>.tf`
# (emitted by `greenlight add`) so the subnet/VCN are IaC, never hand-clicked in the console.

resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.name}-vcn"
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "this" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name}-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.this.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "this" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name}-sl"

  # Outbound-only: GHCR image pull + cloudflared dial-out. No ingress needed (tunnel is outbound).
  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
  }
}

resource "oci_core_subnet" "this" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.this.id
  cidr_block        = var.subnet_cidr
  display_name      = "${var.name}-subnet"
  route_table_id    = oci_core_route_table.this.id
  security_list_ids = [oci_core_security_list.this.id]
  # Regional (no availability_domain) + public (egress via the internet gateway).
  prohibit_public_ip_on_vnic = false
}
