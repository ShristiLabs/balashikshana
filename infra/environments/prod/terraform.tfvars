# prod environment — committed values only. NO SECRETS HERE (enforced by
# the infra secret-scan test): secrets live in SSM Parameter Store under
# /balashikshana/prod (docs/deployment.md). terraform apply against prod is
# a HUMAN step (standing manual-deploy preference, issue #64).

environment = "prod"
aws_region  = "us-east-1"

hosted_zone_name    = "balashikshana.example." # replace with your Route53 zone
acm_certificate_arn = "arn:aws:acm:us-east-1:000000000000:certificate/replace-me"
api_image_uri       = "000000000000.dkr.ecr.us-east-1.amazonaws.com/balashikshana-prod/api:latest"
allowed_origins     = "https://portal.balashikshana.example"

api_hostname     = "api"
portal_hostname  = "portal"
create_edge_slot = true # reserve gateway.<zone> for Dwara (#65)

# Prod posture: multi-AZ standby, deletion protection everywhere, real
# backups, rolling deploys keep the old task healthy until the new one
# passes checks (min healthy 100). desired_count stays 1 — single-instance
# doctrine (D2 revisit, docs/deployment.md).
db_instance_class        = "db.t4g.small"
db_multi_az              = true
db_deletion_protection   = true
db_skip_final_snapshot   = false
db_backup_retention_days = 14
db_apply_immediately     = false

api_cpu                                = 512
api_memory                             = 1024
api_desired_count                      = 1
api_deployment_minimum_healthy_percent = 100
api_enable_autoscaling                 = false

seed_demo_students    = "0"
weekly_digest_enabled = "1" # prod sends digests (SMTP creds via SSM)
smtp_host             = "smtp.example.com"
smtp_from             = "Balashikshana <no-reply@balashikshana.example>"

enable_nat_gateway      = true
alb_deletion_protection = true
portal_force_destroy    = false
packs_force_destroy     = false
