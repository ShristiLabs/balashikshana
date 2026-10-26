# Environment root variables — IDENTICAL file across dev/staging/prod
# (enforced by services/api/test/infra-secrets.test.mjs). Every
# environment difference lives in terraform.tfvars.

variable "environment" {
  description = "Environment name (dev | staging | prod) — drives name prefixes, SSM paths, and tags"
  type        = string
}

variable "aws_region" {
  description = "AWS region for all environment resources (single-region doctrine; multi-region is out of scope for #64)"
  type        = string
  default     = "us-east-1"
}

variable "hosted_zone_name" {
  description = "Existing Route53 hosted zone name (FQDN with trailing dot, e.g. balashikshana.example.)"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN covering the API + portal names (ALB: region-local; CloudFront: us-east-1)"
  type        = string
}

variable "api_image_uri" {
  description = "ECR image URI for the API (docker/Dockerfile.api build, pushed per deploy)"
  type        = string
}

variable "allowed_origins" {
  description = "CORS ALLOWED_ORIGINS for the API (comma-separated; must include the portal URL of THIS environment)"
  type        = string
}

variable "api_hostname" {
  description = "API hostname label in the hosted zone"
  type        = string
  default     = "api"
}

variable "portal_hostname" {
  description = "Portal hostname label in the hosted zone"
  type        = string
  default     = "portal"
}

variable "create_edge_slot" {
  description = "Reserve the Dwara gateway DNS slot (D10, #65)"
  type        = bool
  default     = false
}

variable "edge_slot_hostname" {
  description = "Hostname label reserved for the Dwara gateway (#65)"
  type        = string
  default     = "gateway"
}

variable "enable_gateway" {
  description = "Deploy the Dwara edge gateway (#65, D10): NLB TCP passthrough -> gateway (TLS terminates at Dwara) -> origin ALB over HTTPS"
  type        = bool
  default     = false
}

variable "gateway_image_uri" {
  description = "ECR image URI for the Dwara gateway (deploy/dwara/docker build, pushed per deploy)"
  type        = string
  default     = ""
}

variable "gateway_allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the public edge listener (default: everywhere, same posture as the api ALB)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "gateway_admin_ingress_cidrs" {
  description = "CIDRs allowed to reach the gateway mTLS admin port — INTERNAL ops ranges only (VPN/bastion); the module rejects 0.0.0.0/0"
  type        = list(string)
  default     = ["10.0.0.0/8"] # RFC1918 placeholder — replace with the environment's real ops ranges
}

variable "gateway_nlb_deletion_protection" {
  description = "Gateway NLB deletion protection (prod: true)"
  type        = bool
  default     = false
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "RDS multi-AZ standby"
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "RDS deletion protection"
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "Skip the RDS final snapshot on destroy"
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "RDS automated backup retention days"
  type        = number
  default     = 7
}

variable "db_apply_immediately" {
  description = "Apply RDS maintenance immediately (dev convenience)"
  type        = bool
  default     = false
}

variable "api_cpu" {
  description = "Fargate task CPU units"
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Fargate task memory MiB"
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "Desired API task count — keep 1 under the single-instance doctrine (D2 revisit, docs/deployment.md)"
  type        = number
  default     = 1
}

variable "api_deployment_minimum_healthy_percent" {
  description = "Rolling-deploy minimum healthy percent (0 for single-instance envs, 100 for prod)"
  type        = number
  default     = 0
}

variable "api_enable_autoscaling" {
  description = "Opt-in API autoscaling (off by default — D2 single-instance doctrine)"
  type        = bool
  default     = false
}

variable "seed_demo_students" {
  description = "SEED_DEMO_STUDENTS — 1 for dev-like environments only"
  type        = string
  default     = "0"
}

variable "weekly_digest_enabled" {
  description = "WEEKLY_DIGEST_ENABLED (requires SMTP_HOST + credentials; app refuses to start when enabled without SMTP)"
  type        = string
  default     = "0"
}

variable "smtp_host" {
  description = "SMTP_HOST for outbound parent digests"
  type        = string
  default     = ""
}

variable "smtp_from" {
  description = "SMTP_FROM display address"
  type        = string
  default     = ""
}

variable "enable_nat_gateway" {
  description = "NAT gateway for private-subnet egress (turn off for a hibernated dev env)"
  type        = bool
  default     = true
}

variable "alb_deletion_protection" {
  description = "ALB deletion protection"
  type        = bool
  default     = false
}

variable "portal_force_destroy" {
  description = "Allow portal bucket destroy (dev convenience)"
  type        = bool
  default     = false
}

variable "packs_force_destroy" {
  description = "Allow packs bucket destroy (dev convenience)"
  type        = bool
  default     = false
}
