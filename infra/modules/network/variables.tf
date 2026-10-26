# Network module — VPC with public/private subnets across az_count zones.
# Cost-lean by design: a single NAT gateway serves all private subnets
# (docs/deployment.md "Cost posture"); set enable_nat_gateway = false for
# throwaway environments that run nothing in private subnets.

variable "name_prefix" {
  description = "Resource name prefix, e.g. balashikshana-dev"
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across (2 keeps cost down; RDS multi-AZ requires 2)"
  type        = number
  default     = 2
}

variable "enable_nat_gateway" {
  description = "Create a NAT gateway for private-subnet egress (API tasks + RDS patching). ~$32/month; disable only for environments that run no private workloads."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to all network resources"
  type        = map(string)
  default     = {}
}
