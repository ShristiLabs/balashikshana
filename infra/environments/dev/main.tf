# Environment root — IDENTICAL file across dev/staging/prod (enforced by
# services/api/test/infra-secrets.test.mjs). All per-environment values come
# from terraform.tfvars; secrets come from SSM Parameter Store (runbook:
# docs/deployment.md "Secrets").

provider "aws" {
  region = var.aws_region
}

locals {
  name_prefix = "balashikshana-${var.environment}"
  ssm_prefix  = "/balashikshana/${var.environment}"

  common_tags = {
    Project     = "balashikshana"
    Environment = var.environment
    ManagedBy   = "terraform"
    Repository  = "ShristiLabs/balashikshana"
  }
}

data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

data "aws_caller_identity" "current" {}

# Bootstrap secret the operator creates BEFORE the first apply (runbook):
# /balashikshana/<env>/db_master_password (SecureString).
data "aws_ssm_parameter" "db_master_password" {
  name = "${local.ssm_prefix}/db_master_password"
}

module "network" {
  source = "../../modules/network"

  name_prefix        = local.name_prefix
  enable_nat_gateway = var.enable_nat_gateway

  tags = local.common_tags
}

module "api_service" {
  source = "../../modules/api_service"

  name_prefix        = local.name_prefix
  aws_region         = var.aws_region
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  api_image_uri = var.api_image_uri
  api_cpu       = var.api_cpu
  api_memory    = var.api_memory

  desired_count                      = var.api_desired_count
  deployment_minimum_healthy_percent = var.api_deployment_minimum_healthy_percent
  enable_autoscaling                 = var.api_enable_autoscaling

  allowed_origins = var.allowed_origins

  # Behind the Dwara edge (#65): honor X-Forwarded-For from VPC-internal
  # hops only (peer-checked), so the origin per-IP buckets key on the true
  # client IP. Empty when the gateway is off — pre-#65 behavior unchanged.
  trust_proxy_cidrs = var.enable_gateway ? module.network.vpc_cidr_block : ""

  seed_demo_students    = var.seed_demo_students
  weekly_digest_enabled = var.weekly_digest_enabled
  smtp_host             = var.smtp_host
  smtp_from             = var.smtp_from

  ssm_parameter_prefix       = local.ssm_prefix
  database_url_parameter_arn = aws_ssm_parameter.database_url.arn
  smtp_user_parameter_arn    = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/smtp_user"
  smtp_pass_parameter_arn    = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/smtp_pass"

  acm_certificate_arn = var.acm_certificate_arn
  hosted_zone_id      = data.aws_route53_zone.this.zone_id
  hosted_zone_name    = data.aws_route53_zone.this.name
  api_hostname        = var.api_hostname
  # When the gateway module owns the gateway.<env>.<zone> record, the
  # placeholder edge-slot CNAME here must be suppressed (duplicate
  # records would otherwise fight over the name).
  create_edge_slot   = var.enable_gateway ? false : var.create_edge_slot
  edge_slot_hostname = var.edge_slot_hostname

  alb_deletion_protection = var.alb_deletion_protection

  tags = local.common_tags
}

# Dwara edge gateway (#65, D10): NLB TCP passthrough -> gateway (TLS
# terminates at Dwara, consumers + edge rate limits applied) -> origin ALB
# over HTTPS. Disabled by default; staging/prod enable it in tfvars. The
# origin KEEPS its own auth — the gateway only adds edge concerns (D10).
module "gateway" {
  count  = var.enable_gateway ? 1 : 0
  source = "../../modules/gateway"

  name_prefix        = local.name_prefix
  aws_region         = var.aws_region
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids
  cluster_name       = module.api_service.cluster_name

  gateway_image_uri = var.gateway_image_uri

  allowed_ingress_cidrs = var.gateway_allowed_ingress_cidrs
  admin_ingress_cidrs   = var.gateway_admin_ingress_cidrs

  ssm_parameter_prefix = local.ssm_prefix

  # ARNs constructed (no data sources — same doctrine as smtp_* above);
  # the operator provisions the SecureStrings before first apply
  # (docs/gateway.md "Credentials and certificates").
  edge_tls_cert_parameter_arn         = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/edge_tls_cert"
  edge_tls_key_parameter_arn          = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/edge_tls_key"
  edge_tls_client_ca_parameter_arn    = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/edge_tls_client_ca"
  edge_key_parent_parameter_arn       = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/edge_key_parent"
  edge_key_child_device_parameter_arn = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/edge_key_child_device"
  edge_key_portal_parameter_arn       = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/edge_key_portal"

  hosted_zone_id          = data.aws_route53_zone.this.zone_id
  hosted_zone_name        = data.aws_route53_zone.this.name
  edge_hostname           = var.edge_slot_hostname
  nlb_deletion_protection = var.gateway_nlb_deletion_protection

  tags = local.common_tags
}

module "postgres" {
  source = "../../modules/postgres"

  name_prefix           = local.name_prefix
  vpc_id                = module.network.vpc_id
  private_subnet_ids    = module.network.private_subnet_ids
  api_security_group_id = module.api_service.task_security_group_id

  master_password = data.aws_ssm_parameter.db_master_password.value
  instance_class  = var.db_instance_class
  multi_az        = var.db_multi_az

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.environment
  backup_retention_days     = var.db_backup_retention_days
  apply_immediately         = var.db_apply_immediately

  tags = local.common_tags
}

# Composed DATABASE_URL for the API. The RDS master password already flows
# through Terraform state by virtue of TF managing the RDS instance (this is
# the standard accepted posture — docs/deployment.md "State sensitivity");
# storing the composed URL as a SecureString means the API only ever needs
# ONE parameter, and rotating the SSM password + re-applying rewrites this
# URL atomically.
resource "aws_ssm_parameter" "database_url" {
  name        = "${local.ssm_prefix}/database_url"
  description = "Composed DATABASE_URL for the API (rotated via terraform apply)"
  type        = "SecureString"
  value       = "postgresql://${module.postgres.master_username}:${data.aws_ssm_parameter.db_master_password.value}@${module.postgres.endpoint}/${module.postgres.db_name}"

  tags = local.common_tags
}

module "static_site" {
  source = "../../modules/static_site"

  name_prefix         = local.name_prefix
  hosted_zone_id      = data.aws_route53_zone.this.zone_id
  hosted_zone_name    = data.aws_route53_zone.this.name
  portal_hostname     = var.portal_hostname
  acm_certificate_arn = var.acm_certificate_arn
  force_destroy       = var.portal_force_destroy

  tags = local.common_tags
}

module "packs_store" {
  source = "../../modules/packs_store"

  name_prefix   = local.name_prefix
  force_destroy = var.packs_force_destroy

  tags = local.common_tags
}
