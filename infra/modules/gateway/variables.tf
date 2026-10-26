# Gateway module inputs (#65). Secrets arrive as SSM parameter ARNs
# (constructed by the environment root from the account/region/prefix —
# no data sources, no values in state beyond the ARN strings).

variable "name_prefix" {
  description = "Resource name prefix (balashikshana-<env>)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "vpc_id" {
  description = "VPC id (network module)"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the NLB (network module)"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnets for the gateway tasks (network module)"
  type        = list(string)
}

variable "cluster_name" {
  description = "Shared ECS cluster name (api_service module output)"
  type        = string
}

variable "gateway_image_uri" {
  description = "Dwara gateway image (built operator-side from deploy/dwara/docker/; pushed to the ECR repo this module creates)"
  type        = string
}

variable "gateway_cpu" {
  description = "Task CPU units"
  type        = number
  default     = 256
}

variable "gateway_memory" {
  description = "Task memory MiB"
  type        = number
  default     = 512
}

variable "gateway_public_port" {
  description = "Container port of the public TLS listener (dwara.yaml listeners[].port)"
  type        = number
  default     = 8443
}

variable "gateway_admin_port" {
  description = "Container port of the mTLS admin listener (dwara.yaml admin.bind port)"
  type        = number
  default     = 2019
}

variable "desired_count" {
  description = "Gateway task count (D2 single-instance default)"
  type        = number
  default     = 1
}

variable "deployment_minimum_healthy_percent" {
  description = "Rolling deploy floor"
  type        = number
  default     = 0
}

variable "deployment_maximum_percent" {
  description = "Rolling deploy ceiling"
  type        = number
  default     = 200
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the public edge (same vocabulary as the api_service ALB)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "admin_ingress_cidrs" {
  description = "CIDRs allowed to reach the mTLS admin port. INTERNAL ops ranges only (VPN/bastion): the admin surface must never be public. There is deliberately no 0.0.0.0/0 default."
  type        = list(string)

  validation {
    condition     = length(var.admin_ingress_cidrs) > 0 && !contains(var.admin_ingress_cidrs, "0.0.0.0/0") && !contains(var.admin_ingress_cidrs, "::/0")
    error_message = "admin_ingress_cidrs must be non-empty and must NOT contain 0.0.0.0/0 or ::/0 (the admin mTLS surface is never public)."
  }
}

variable "ssm_parameter_prefix" {
  description = "SSM prefix the execution role may read (/balashikshana/<env>)"
  type        = string
}

variable "edge_tls_cert_parameter_arn" {
  description = "SSM ARN: public listener certificate PEM"
  type        = string
}

variable "edge_tls_key_parameter_arn" {
  description = "SSM ARN: public listener private key PEM"
  type        = string
}

variable "edge_tls_client_ca_parameter_arn" {
  description = "SSM ARN: admin client CA bundle PEM"
  type        = string
}

variable "edge_key_parent_parameter_arn" {
  description = "SSM ARN: parent-app consumer class key"
  type        = string
}

variable "edge_key_child_device_parameter_arn" {
  description = "SSM ARN: child-device consumer class key"
  type        = string
}

variable "edge_key_portal_parameter_arn" {
  description = "SSM ARN: portal consumer class key"
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 zone id for the edge record"
  type        = string
}

variable "hosted_zone_name" {
  description = "Route53 zone name"
  type        = string
}

variable "edge_hostname" {
  description = "Hostname label for the gateway record (gateway.<env>.<zone>)"
  type        = string
  default     = "gateway"
}

variable "log_retention_days" {
  description = "Gateway log retention"
  type        = number
  default     = 30
}

variable "nlb_deletion_protection" {
  description = "NLB deletion protection (prod: true)"
  type        = bool
  default     = false
}

variable "deregistration_delay_seconds" {
  description = "Target deregistration drain"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
