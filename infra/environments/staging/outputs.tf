# Environment outputs — IDENTICAL file across dev/staging/prod. The deploy
# tooling (infra/scripts/deploy.sh, migrate.sh) consumes these via
# `terraform output -raw <name>`.

output "api_url" {
  description = "Public API base URL (post-deploy smoke target)"
  value       = module.api_service.api_url
}

output "portal_url" {
  description = "Public parent-portal URL"
  value       = module.static_site.portal_url
}

output "portal_bucket" {
  description = "Portal dist bucket (aws s3 sync target)"
  value       = module.static_site.bucket_name
}

output "portal_distribution_id" {
  description = "CloudFront distribution ID (cache invalidation after portal sync)"
  value       = module.static_site.cloudfront_distribution_id
}

output "packs_bucket" {
  description = "Content-pack bucket (tools/content-pipeline build output target)"
  value       = module.packs_store.bucket_name
}

output "ecr_repository_url" {
  description = "ECR repository for the API image"
  value       = module.api_service.ecr_repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster (migrate run-task + deploys)"
  value       = module.api_service.cluster_name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = module.api_service.service_name
}

output "ecs_task_definition_family" {
  description = "Task definition family (migrations job uses command overrides on it)"
  value       = module.api_service.task_definition_family
}

output "database_endpoint" {
  description = "RDS endpoint (host:port)"
  value       = module.postgres.endpoint
}

output "gateway_edge_url" {
  description = "Dwara edge base URL clients hit when the gateway is enabled (empty otherwise)"
  value       = var.enable_gateway ? module.gateway[0].edge_url : ""
}

output "gateway_ecr_repository_url" {
  description = "ECR repository for the gateway image (empty when the gateway is disabled)"
  value       = var.enable_gateway ? module.gateway[0].ecr_repository_url : ""
}
