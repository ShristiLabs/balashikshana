###############################################################################
# Dwara edge gateway (#65, D10) — ECS Fargate service running the Dwara
# image, fronted by a NETWORK load balancer that passes TCP through
# untouched so TLS TERMINATES AT DWARA (issue AC; an ALB would terminate
# TLS first and falsify the doctrine). The gateway forwards to the origin
# ALB over HTTPS (see deploy/dwara/envs/*.yaml upstreams).
#
# Admin surface: the admin mTLS listener (container port 2019) is NOT
# wired to any load balancer. It is reachable only from inside the VPC,
# restricted to var.admin_ingress_cidrs (ops VPN / bastion) — never the
# public internet, never 0.0.0.0/0. mTLS (client-ca verification) is the
# authentication; the security group is the network fence.
#
# Validate-only doctrine (#64): this module provisions NOTHING until an
# operator runs terraform apply; the pipeline runs fmt/validate only.
###############################################################################

###############################################################################
# Registry + logging
###############################################################################

resource "aws_ecr_repository" "gateway" {
  name = "${var.name_prefix}/gateway"

  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${var.name_prefix}/gateway"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

###############################################################################
# IAM — execution role only (same posture as the API: no task role, the
# gateway needs no AWS API access; SSM reads happen at task START by the
# execution role, scoped to this environment's parameter prefix).
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
  name               = "${var.name_prefix}-gateway-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

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
  name   = "${var.name_prefix}-gateway-ecs-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

###############################################################################
# Task definition — image built operator-side from deploy/dwara/docker/
# (entrypoint bridges SSM env-injected TLS material into the PEM files the
# config references). Ports: 8443 public TLS listener, 2019 admin mTLS.
###############################################################################

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name_prefix}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.gateway_cpu
  memory                   = var.gateway_memory
  execution_role_arn       = aws_iam_role.execution.arn
  # No task_role_arn on purpose: the gateway talks to no AWS service.

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = var.gateway_image_uri
      essential = true

      portMappings = [
        {
          containerPort = var.gateway_public_port
          protocol      = "tcp"
        },
        {
          containerPort = var.gateway_admin_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "DWARA_CONFIG", value = "/etc/dwara/dwara.yaml" },
        { name = "DWARA_STATE_DB", value = "/var/lib/dwara/state.db" },
      ]

      secrets = [
        {
          name      = "EDGE_TLS_CERT"
          valueFrom = var.edge_tls_cert_parameter_arn
        },
        {
          name      = "EDGE_TLS_KEY"
          valueFrom = var.edge_tls_key_parameter_arn
        },
        {
          name      = "EDGE_TLS_CLIENT_CA"
          valueFrom = var.edge_tls_client_ca_parameter_arn
        },
        {
          name      = "BALASHIKSHANA_EDGE_KEY_PARENT"
          valueFrom = var.edge_key_parent_parameter_arn
        },
        {
          name      = "BALASHIKSHANA_EDGE_KEY_CHILD_DEVICE"
          valueFrom = var.edge_key_child_device_parameter_arn
        },
        {
          name      = "BALASHIKSHANA_EDGE_KEY_PORTAL"
          valueFrom = var.edge_key_portal_parameter_arn
        },
      ]

      healthCheck = {
        # The gateway serves the reserved /healthz path on its listener;
        # the cert is the task's own, hence --no-check-certificate.
        command = [
          "CMD-SHELL",
          "wget -q --no-check-certificate -O /dev/null https://127.0.0.1:${var.gateway_public_port}/healthz || exit 1",
        ]
        interval = 30
        timeout  = 5
        retries  = 3
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.gateway.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "gateway"
        }
      }
    }
  ])

  tags = var.tags
}

###############################################################################
# Security groups — NLB: :443 from allowed CIDRs, egress to the gateway
# task port only. Task: :8443 from the allowed CIDRs AND from the NLB —
# the target group preserves the client IP (pinned below), so forwarded
# packets arrive with the CLIENT's source address, not the NLB's: the
# CIDR rules admit real traffic (same exposure the NLB SG grants on 443),
# the NLB-SG rule admits health-check probes; :2019 (admin) from the ops
# CIDRs only; egress all (origin ALB 443, ECR, logs via NAT).
# Standalone rule resources break the NLB<->task mutual-reference cycle
# (same pattern as the api_service module).
###############################################################################

resource "aws_security_group" "nlb" {
  name        = "${var.name_prefix}-gateway-nlb-sg"
  description = "Gateway NLB ingress :443, egress to gateway tasks only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-gateway-nlb-sg"
  })
}

resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-gateway-task-sg"
  description = "Gateway task: 8443 from allowed CIDRs + NLB; admin 2019 from ops CIDRs only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-gateway-task-sg"
  })
}

locals {
  nlb_public_rules = toset([
    for cidr in var.allowed_ingress_cidrs : "443:${cidr}"
  ])

  # Client-IP preservation (pinned on the target group) means forwarded
  # packets carry the client's source IP — the task SG must admit the
  # same CIDRs the NLB does, on the listener port.
  task_public_rules = toset([
    for cidr in var.allowed_ingress_cidrs : "${var.gateway_public_port}:${cidr}"
  ])
}

resource "aws_vpc_security_group_ingress_rule" "nlb_public" {
  for_each = local.nlb_public_rules

  security_group_id = aws_security_group.nlb.id
  description       = "TLS passthrough from allowed CIDRs"
  cidr_ipv4         = split(":", each.key)[1]
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "nlb_to_task" {
  security_group_id            = aws_security_group.nlb.id
  description                  = "Passthrough to the gateway tasks on 8443"
  referenced_security_group_id = aws_security_group.task.id
  from_port                    = var.gateway_public_port
  to_port                      = var.gateway_public_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "task_from_nlb" {
  security_group_id            = aws_security_group.task.id
  description                  = "NLB-originated probes (health checks) on the public listener port"
  referenced_security_group_id = aws_security_group.nlb.id
  from_port                    = var.gateway_public_port
  to_port                      = var.gateway_public_port
  ip_protocol                  = "tcp"
}

# Real client traffic: the target group preserves the client IP, so
# forwarded packets match these CIDR rules, not the NLB-SG rule above.
resource "aws_vpc_security_group_ingress_rule" "task_public" {
  for_each = local.task_public_rules

  security_group_id = aws_security_group.task.id
  description       = "Public listener from allowed CIDRs (client IP preserved by the NLB)"
  cidr_ipv4         = split(":", each.key)[1]
  from_port         = var.gateway_public_port
  to_port           = var.gateway_public_port
  ip_protocol       = "tcp"
}

# Admin mTLS surface: internal ops CIDRs ONLY. The validation gate for
# "never public" is two-fold: this rule set is a dedicated variable the
# operator must set deliberately (no default 0.0.0.0/0), and the gateway
# itself rejects non-mTLS connections on 2019 (verify-edge.sh check 4).
resource "aws_vpc_security_group_ingress_rule" "task_admin" {
  for_each = toset(var.admin_ingress_cidrs)

  security_group_id = aws_security_group.task.id
  description       = "Admin mTLS port from ops CIDRs (never public)"
  cidr_ipv4         = each.value
  from_port         = var.gateway_admin_port
  to_port           = var.gateway_admin_port
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "task_all" {
  security_group_id = aws_security_group.task.id
  description       = "All egress (origin ALB 443, ECR, logs via NAT)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

###############################################################################
# NLB — TCP passthrough (TLS terminates at the gateway, not here) + DNS
# alias claiming gateway.<env>.<zone>: the #64 edge slot becomes real.
###############################################################################

resource "aws_lb" "gateway" {
  name                       = "${var.name_prefix}-gateway-nlb"
  internal                   = false
  load_balancer_type         = "network"
  security_groups            = [aws_security_group.nlb.id]
  subnets                    = var.public_subnet_ids
  enable_deletion_protection = var.nlb_deletion_protection

  tags = var.tags
}

resource "aws_lb_target_group" "gateway" {
  name        = "${var.name_prefix}-gw"
  port        = var.gateway_public_port
  protocol    = "TCP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  # Pinned explicitly: client-IP preservation is REQUIRED by design —
  # per-IP edge GCRA and the origin's peer-checked XFF chain both key on
  # the true client address. It also drives the task SG shape: preserved
  # source IPs mean forwarded packets arrive as client traffic, not NLB
  # traffic (see the task_public ingress rules).
  preserve_client_ip = true

  health_check {
    protocol            = "TCP"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = var.deregistration_delay_seconds

  tags = var.tags
}

resource "aws_lb_listener" "tls_passthrough" {
  load_balancer_arn = aws_lb.gateway.arn
  port              = 443
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  tags = var.tags
}

resource "aws_route53_record" "edge" {
  zone_id = var.hosted_zone_id
  name    = "${var.edge_hostname}.${var.hosted_zone_name}"
  type    = "A"

  alias {
    name                   = aws_lb.gateway.dns_name
    zone_id                = aws_lb.gateway.zone_id
    evaluate_target_health = true
  }
}

###############################################################################
# Service — single instance by default (D2); the gateway is stateless
# apart from quota counters (documented limitation, docs/gateway.md).
###############################################################################

resource "aws_ecs_service" "gateway" {
  name            = "${var.name_prefix}-gateway"
  cluster         = var.cluster_name
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = var.gateway_public_port
  }

  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent

  tags = var.tags
}
