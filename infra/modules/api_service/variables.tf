# API service module — ECS Fargate service for services/api (docker/Dockerfile.api,
# node:22-alpine image, container port 4000), fronted by a public ALB with TLS,
# DNS alias records, and a reserved edge slot for the Dwara gateway (#65, D10).
#
# Single-instance doctrine (roadmap D2, revisited by issue #64 — see
# docs/deployment.md "Single instance vs multi-instance"): desired_count
# defaults to 1 and autoscaling is opt-in. The retention sweep and weekly
# digest schedulers hold pg_try_advisory_lock, so a second instance is SAFE
# for them; the rate-limit buckets are per-process until Redis (or an
# equivalent shared store) is introduced.

variable "name_prefix" {
  description = "Resource name prefix, e.g. balashikshana-dev"
  type        = string
}

variable "aws_region" {
  description = "AWS region (used for the awslogs log driver)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnets for the ECS tasks"
  type        = list(string)
}

variable "api_image_uri" {
  description = "Full container image URI (ECR or other registry), e.g. <account>.dkr.ecr.<region>.amazonaws.com/balashikshana-dev/api:1.2.3"
  type        = string
}

variable "api_container_port" {
  description = "Container port the Fastify server listens on"
  type        = number
  default     = 4000
}

variable "api_cpu" {
  description = "Task CPU units (256 | 512 | 1024 ...)"
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Task memory MiB (512 | 1024 ...; must be valid Fargate combo)"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired task count. Keep 1 under the single-instance doctrine (D2); see docs/deployment.md before raising."
  type        = number
  default     = 1
}

variable "deployment_minimum_healthy_percent" {
  description = "Rolling-deploy minimum healthy percent (0 lets single-instance envs replace the only task; prod uses 100)"
  type        = number
  default     = 0
}

variable "deployment_maximum_percent" {
  description = "Rolling-deploy maximum percent"
  type        = number
  default     = 200
}

variable "enable_autoscaling" {
  description = "Opt-in CPU target-tracking autoscaling (off by default — single-instance doctrine, D2)"
  type        = bool
  default     = false
}

variable "autoscaling_max_count" {
  description = "Autoscaling ceiling when enabled"
  type        = number
  default     = 2
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB on :80/:443"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_origins" {
  description = "ALLOWED_ORIGINS for the API CORS allowlist (portal origin per environment)"
  type        = string
}

variable "log_level" {
  description = "pino LOG_LEVEL"
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the API log group"
  type        = number
  default     = 30
}

variable "body_limit_bytes" {
  description = "BODY_LIMIT_BYTES request cap (matches server.mjs default)"
  type        = string
  default     = "65536"
}

variable "rate_limits" {
  description = "RATE_LIMIT_* env bucket map passed through to the container (per-minute ceilings)"
  type        = map(string)
  default = {
    RATE_LIMIT_PER_IP_MIN               = "120"
    RATE_LIMIT_PER_TOKEN_MIN            = "60"
    RATE_LIMIT_LOGIN_PER_IP_MIN         = "10"
    RATE_LIMIT_SYNC_PER_TOKEN_MIN       = "30"
    RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN = "5"
    RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN  = "10"
    RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN  = "10"
    RATE_LIMIT_PARENT_RESET_PER_IP_MIN  = "5"
    RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN  = "10"
    RATE_LIMIT_DELETE_PER_IP_MIN        = "5"
  }
}

variable "content_packs_dir" {
  description = "BALASHIKSHANA_CONTENT_PACKS_DIR inside the container (image layout; packs sync strategy in docs/deployment.md)"
  type        = string
  default     = "/app/services/api/content-packs"
}

variable "seed_demo_students" {
  description = "SEED_DEMO_STUDENTS — 1 only for dev-like environments; 0 in staging/prod"
  type        = string
  default     = "0"
}

variable "retention_sweep_interval_ms" {
  description = "RETENTION_SWEEP_INTERVAL_MS (#62 retention scheduler; 0 disables)"
  type        = string
  default     = "21600000"
}

variable "weekly_digest_enabled" {
  description = "WEEKLY_DIGEST_ENABLED (#63; requires SMTP — refuse-to-start guard is in the app)"
  type        = string
  default     = "0"
}

variable "weekly_digest_interval_ms" {
  description = "WEEKLY_DIGEST_INTERVAL_MS (bounds send latency, never duplication — sent-ledger is idempotent)"
  type        = string
  default     = "3600000"
}

variable "smtp_host" {
  description = "SMTP_HOST (credentials USER/PASS come from SSM, never tf)"
  type        = string
  default     = ""
}

variable "smtp_port" {
  description = "SMTP_PORT"
  type        = string
  default     = "587"
}

variable "smtp_from" {
  description = "SMTP_FROM display address"
  type        = string
  default     = ""
}

variable "ssm_parameter_prefix" {
  description = "SSM Parameter Store prefix holding this environment's secrets (scopes the execution role's GetParameter grant)"
  type        = string
}

variable "database_url_parameter_arn" {
  description = "SSM parameter ARN (SecureString) holding the composed postgresql:// DATABASE_URL"
  type        = string
}

variable "smtp_user_parameter_arn" {
  description = "SSM parameter ARN (SecureString) holding SMTP_USER"
  type        = string
}

variable "smtp_pass_parameter_arn" {
  description = "SSM parameter ARN (SecureString) holding SMTP_PASS"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener (us-east-1 for CloudFront; ALB region = aws_region)"
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID for the environment domains"
  type        = string
}

variable "hosted_zone_name" {
  description = "Route53 hosted zone name (e.g. balashikshana.example.)"
  type        = string
}

variable "api_hostname" {
  description = "API hostname label inside the hosted zone (record -> ALB)"
  type        = string
  default     = "api"
}

variable "create_edge_slot" {
  description = "Reserve the Dwara gateway hostname (D10, #65): a CNAME to the ALB placeholder. Dwara replaces the target when it lands."
  type        = bool
  default     = false
}

variable "edge_slot_hostname" {
  description = "Hostname label reserved for the Dwara gateway (#65)"
  type        = string
  default     = "gateway"
}

variable "alb_deletion_protection" {
  description = "ALB deletion protection (prod: true)"
  type        = bool
  default     = false
}

variable "deregistration_delay_seconds" {
  description = "Target-group drain window — the deploy runbook's connection-drain story"
  type        = number
  default     = 60
}

variable "health_check_grace_period_seconds" {
  description = "ECS health-check grace period (boot runs migrations — db.mjs — before listen)"
  type        = number
  default     = 60
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
