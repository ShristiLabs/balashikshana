# dev environment — committed values only. NO SECRETS HERE (enforced by the
# infra secret-scan test): secrets live in SSM Parameter Store under
# /balashikshana/dev and are created by the operator (docs/deployment.md).
# The hosted zone / certificate / image URI are placeholders an operator
# replaces on first use; terraform validate does not resolve them.

environment = "dev"
aws_region  = "us-east-1"

hosted_zone_name    = "balashikshana.example." # replace with your Route53 zone
acm_certificate_arn = "arn:aws:acm:us-east-1:000000000000:certificate/replace-me"
api_image_uri       = "000000000000.dkr.ecr.us-east-1.amazonaws.com/balashikshana-dev/api:latest"
allowed_origins     = "https://portal.balashikshana.example"

api_hostname     = "api"
portal_hostname  = "portal"
create_edge_slot = false

# No cloud gateway in dev: local fronting runs the gateway directly
# against startup.sh via deploy/dwara/envs/dev.yaml (docs/gateway.md).
enable_gateway = false

# Cost-lean dev: smallest instances, no standby, snapshots skippable,
# demo students seeded, tasks replaceable (min healthy 0).
db_instance_class        = "db.t4g.micro"
db_multi_az              = false
db_deletion_protection   = false
db_skip_final_snapshot   = true
db_backup_retention_days = 1
db_apply_immediately     = true

api_cpu                                = 256
api_memory                             = 512
api_desired_count                      = 1
api_deployment_minimum_healthy_percent = 0
api_enable_autoscaling                 = false

seed_demo_students    = "1"
weekly_digest_enabled = "0"
smtp_host             = ""
smtp_from             = ""

enable_nat_gateway      = true
alb_deletion_protection = false
portal_force_destroy    = true
packs_force_destroy     = true
