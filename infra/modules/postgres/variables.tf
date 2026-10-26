# Postgres module — managed PostgreSQL 16 for the API (node-pg-migrate
# schema, migrations 001-012). The master password is injected by the
# environment root from SSM Parameter Store; it is never committed
# (secret-scan test enforces this in CI).

variable "name_prefix" {
  description = "Resource name prefix, e.g. balashikshana-dev"
  type        = string
}

variable "vpc_id" {
  description = "VPC for the DB subnet group and security group"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the DB subnet group (>= 2 required for multi_az)"
  type        = list(string)
}

variable "api_security_group_id" {
  description = "Security group of the ECS API tasks — the ONLY source allowed to reach :5432"
  type        = string
}

variable "db_name" {
  description = "Database name (matches the compose/CI default balashikshana_db lineage)"
  type        = string
  default     = "balashikshana_db"
}

variable "master_username" {
  description = "RDS master username (password comes from SSM; never in tf)"
  type        = string
  default     = "balashikshana"
}

variable "master_password" {
  description = "RDS master password, injected from SSM Parameter Store by the environment root"
  type        = string
  sensitive   = true
}

variable "engine_version" {
  description = "PostgreSQL major version — matches the postgres:16 lineage used locally and in CI"
  type        = string
  default     = "16"
}

variable "instance_class" {
  description = "RDS instance class (db.t4g.micro dev/staging, db.t4g.small prod baseline)"
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  description = "Initial allocated storage in GB"
  type        = number
  default     = 20
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling in GB (0 disables)"
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "Standby instance in a second AZ (prod: true)"
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Block instance deletion (prod: true)"
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy (dev: true; staging/prod: false)"
  type        = bool
  default     = false
}

variable "final_snapshot_identifier" {
  description = "Final snapshot identifier prefix used when skip_final_snapshot = false"
  type        = string
  default     = "final"
}

variable "backup_retention_days" {
  description = "Automated backup retention (0 disables)"
  type        = number
  default     = 7
}

variable "apply_immediately" {
  description = "Apply parameter/maintenance changes immediately (dev convenience; prod: false)"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
