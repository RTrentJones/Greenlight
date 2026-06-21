variable "compartment_id" {
  type        = string
  description = "OCI compartment OCID the VCN + subnet live in (the tenancy/root compartment is fine)."
}

variable "name" {
  type        = string
  description = "Name prefix for the VCN/subnet/gateway (the tool name)."
}

variable "vcn_cidr" {
  type        = string
  default     = "10.0.0.0/16"
  description = "VCN CIDR block."
}

variable "subnet_cidr" {
  type        = string
  default     = "10.0.0.0/24"
  description = "Public subnet CIDR (within the VCN)."
}
