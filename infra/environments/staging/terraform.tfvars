# staging environment — committed values only. NO SECRETS HERE (enforced by
# the infra secret-scan test): secrets live in SSM Parameter Store under
# /balashikshana/staging (docs/deployment.md). Migrations-on-deploy and the
# post-deploy smoke are demonstrated HERE first (issue #64 AC).

environment = "staging"
aws_region  = "us-east-1"

hosted_zone_name    = "balashikshana.example." # replace with your Route53 zone
acm_certificate_arn = "arn:aws:acm:us-east-1:000000000000:certificate/replace-me"
api_image_uri       = "000000000000.dkr.ecr.us-east-1.amazonaws.com/balashikshana-staging/api:latest"
allowed_origins     = "https://portal.staging.balashikshana.example"

api_hostname     = "api"
portal_hostname  = "portal"
create_edge_slot = true # reserve gateway.staging.<zone> for Dwara (#65)

# Staging mirrors prod mechanics at minimum size, but keeps final snapshots
# (staging data is still COPPA-relevant) and no demo seeding.
db_instance_class        = "db.t4g.micro"
db_multi_az              = false
db_deletion_protection   = false
db_skip_final_snapshot   = false
db_backup_retention_days = 7
db_apply_immediately     = true

api_cpu                                = 256
api_memory                             = 512
api_desired_count                      = 1
api_deployment_minimum_healthy_percent = 0
api_enable_autoscaling                 = false

seed_demo_students    = "0"
weekly_digest_enabled = "0"
smtp_host             = ""
smtp_from             = ""

enable_nat_gateway      = true
alb_deletion_protection = false
portal_force_destroy    = false
packs_force_destroy     = false
