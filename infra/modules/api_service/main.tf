###############################################################################
# Cluster, registry, logging
###############################################################################

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled" # first-party-only telemetry posture (D5); #65 revisits observability
  }

  tags = var.tags
}

resource "aws_ecr_repository" "api" {
  name = "${var.name_prefix}/api"

  image_tag_mutability = "MUTABLE" # mutable tag + force-new-deployment redeploy flow (docs/deployment.md)

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name_prefix}/api"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

###############################################################################
# IAM — execution role only. The app itself gets NO task role: the API
# talks to no AWS service, so tasks receive no AWS credentials at all.
###############################################################################

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Least-privilege: the execution role may read ONLY this environment's
# parameter prefix (database_url, smtp_user, smtp_pass).
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]

    resources = ["arn:aws:ssm:*:*:parameter${var.ssm_parameter_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name_prefix}-ecs-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

###############################################################################
# Secrets — injected as SSM parameter ARNs (plain strings, no data sources:
# database_url is COMPOSED by the environment root from the RDS endpoint, so
# a plan-time data-source read would be a first-apply chicken-and-egg). ECS
# resolves each SecureString at task start; values never appear in tf source
# or in the task definition payload.
###############################################################################

###############################################################################
# Task definition — mirrors docker/Dockerfile.api (node:22-alpine, CMD
# node services/api/server.mjs). The same image serves as the migrations
# job: `aws ecs run-task` with command override ["npm","run","migrate"]
# (node-pg-migrate is a regular dependency — infra/scripts/migrate.sh).
###############################################################################

locals {
  container_env_base = [
    { name = "PORT", value = tostring(var.api_container_port) },
    { name = "NODE_ENV", value = "production" },
    { name = "ALLOWED_ORIGINS", value = var.allowed_origins },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "BODY_LIMIT_BYTES", value = var.body_limit_bytes },
    { name = "BALASHIKSHANA_CONTENT_PACKS_DIR", value = var.content_packs_dir },
    { name = "SEED_DEMO_STUDENTS", value = var.seed_demo_students },
    { name = "RETENTION_SWEEP_INTERVAL_MS", value = var.retention_sweep_interval_ms },
    { name = "WEEKLY_DIGEST_ENABLED", value = var.weekly_digest_enabled },
    { name = "WEEKLY_DIGEST_INTERVAL_MS", value = var.weekly_digest_interval_ms },
    { name = "SMTP_HOST", value = var.smtp_host },
    { name = "SMTP_PORT", value = var.smtp_port },
    { name = "SMTP_FROM", value = var.smtp_from },
    { name = "TRUST_PROXY_CIDRS", value = var.trust_proxy_cidrs },
  ]

  # #66 first-party metrics listener: env only when the port is enabled
  # (0 = listener off in the app; no port mapping either).
  container_env_metrics = var.metrics_port > 0 ? [
    { name = "METRICS_PORT", value = tostring(var.metrics_port) },
    { name = "METRICS_HOST", value = var.metrics_host },
  ] : []

  container_env_rate_limits = [
    for name, value in var.rate_limits : { name = name, value = value }
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  # No task_role_arn on purpose: the app needs zero AWS API access.

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.api_image_uri
      essential = true

      portMappings = concat(
        [
          {
            containerPort = var.api_container_port
            protocol      = "tcp"
          }
        ],
        # #66: the internal metrics listener port mapping exists only
        # when the listener is enabled; ingress is governed by the
        # metrics-scrape SG rules below (opt-in CIDR list).
        var.metrics_port > 0 ? [
          {
            containerPort = var.metrics_port
            protocol      = "tcp"
          }
        ] : []
      )

      environment = concat(local.container_env_base, local.container_env_metrics, local.container_env_rate_limits)

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = var.database_url_parameter_arn
        },
        {
          name      = "SMTP_USER"
          valueFrom = var.smtp_user_parameter_arn
        },
        {
          name      = "SMTP_PASS"
          valueFrom = var.smtp_pass_parameter_arn
        },
      ]

      healthCheck = {
        command  = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${var.api_container_port}/api/health || exit 1"]
        interval = 30
        timeout  = 5
        retries  = 3
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])

  tags = var.tags
}

###############################################################################
# Security groups — ALB: :80/:443 from allowed CIDRs, egress to the task
# port only. Task: :4000 from the ALB only, egress all (DB 5432, SSM, ECR,
# logs via NAT). DB module adds :5432 ingress from the task group.
#
# The ALB<->task reference is MUTUAL, so the rules live in standalone
# aws_vpc_security_group_*_rule resources — the groups themselves carry no
# cross-references, which breaks what would otherwise be a dependency
# cycle between the two security groups.
###############################################################################

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb-sg"
  description = "ALB ingress :80/:443, egress to the API tasks only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb-sg"
  })
}

resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-api-task-sg"
  description = "API task ingress from the ALB only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-api-task-sg"
  })
}

locals {
  # "port:cidr" keys so every allowed CIDR gets rules on both :80 and :443.
  alb_public_rules = toset(flatten([
    for port in [80, 443] : [for cidr in var.allowed_ingress_cidrs : "${port}:${cidr}"]
  ]))
}

resource "aws_vpc_security_group_ingress_rule" "alb_public" {
  for_each = local.alb_public_rules

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS/HTTP from allowed CIDRs"
  cidr_ipv4         = split(":", each.key)[1]
  from_port         = tonumber(split(":", each.key)[0])
  to_port           = tonumber(split(":", each.key)[0])
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to the API tasks on the container port"
  referenced_security_group_id = aws_security_group.task.id
  from_port                    = var.api_container_port
  to_port                      = var.api_container_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  description                  = "App port from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.api_container_port
  to_port                      = var.api_container_port
  ip_protocol                  = "tcp"
}

# #66: internal metrics scraping (self-hosted Prometheus). Opt-in by
# CIDR list: EMPTY default creates NO rule — the metrics port is
# unreachable from anywhere. Never widen to 0.0.0.0/0 (D5: the
# exposition is internal-only; a source-restricted SG plus the optional
# METRICS_TOKEN are the two gates). The "port:cidr" key convention
# matches the ALB public rules above (IPv4).
locals {
  metrics_scrape_rules = toset([
    for cidr in var.metrics_scrape_cidrs : "${var.metrics_port}:${cidr}"
  ])
}

resource "aws_vpc_security_group_ingress_rule" "task_metrics_scrape" {
  for_each = var.metrics_port > 0 ? local.metrics_scrape_rules : toset([])

  security_group_id = aws_security_group.task.id
  description       = "Internal metrics scrape (issue #66) from ${split(":", each.key)[1]}"
  cidr_ipv4         = split(":", each.key)[1]
  from_port         = var.metrics_port
  to_port           = var.metrics_port
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "task_all" {
  security_group_id = aws_security_group.task.id
  description       = "All egress (DB 5432, SSM/ECR/logs via NAT)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

###############################################################################
# ALB + listeners + target group (drain window = deregistration delay)
###############################################################################

resource "aws_lb" "this" {
  name                       = "${var.name_prefix}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb_deletion_protection

  tags = var.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name_prefix}-api"
  port        = var.api_container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/api/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  deregistration_delay = var.deregistration_delay_seconds

  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  tags = var.tags
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = var.tags
}

###############################################################################
# Service (single-instance default, D2) + opt-in autoscaling
###############################################################################

resource "aws_ecs_service" "api" {
  name            = "${var.name_prefix}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.api_container_port
  }

  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  health_check_grace_period_seconds  = var.health_check_grace_period_seconds

  tags = var.tags
}

resource "aws_appautoscaling_target" "api" {
  count = var.enable_autoscaling ? 1 : 0

  max_capacity       = var.autoscaling_max_count
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  count = var.enable_autoscaling ? 1 : 0

  name               = "${var.name_prefix}-api-cpu-target"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api[0].resource_id
  scalable_dimension = aws_appautoscaling_target.api[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.api[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

###############################################################################
# DNS — API alias to the ALB; optional Dwara edge-slot reservation (#65, D10)
###############################################################################

resource "aws_route53_record" "api" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.hosted_zone_id
  name    = "${var.api_hostname}.${var.hosted_zone_name}"
  type    = each.value

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

# Edge slot reserved for the Dwara gateway (#65, D10). A plain CNAME to the
# ALB placeholder keeps the name claimed in DNS; Dwara replaces the target
# with its own listener when it fronts the API. No gateway infra is invented
# here — validate-only by design.
resource "aws_route53_record" "edge_slot" {
  count = var.create_edge_slot ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = "${var.edge_slot_hostname}.${var.hosted_zone_name}"
  type    = "CNAME"
  ttl     = 300
  records = [aws_lb.this.dns_name]
}
