output "cluster_name" {
  description = "ECS cluster name (used by infra/scripts/migrate.sh + deploy.sh)"
  value       = aws_ecs_cluster.this.name
}

output "service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.api.name
}

output "task_definition_family" {
  description = "Task definition family (run-task command overrides target migrations)"
  value       = aws_ecs_task_definition.api.family
}

output "task_security_group_id" {
  description = "API task security group ID (passed to the postgres module)"
  value       = aws_security_group.task.id
}

output "ecr_repository_url" {
  description = "ECR repository URL for the API image"
  value       = aws_ecr_repository.api.repository_url
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.this.dns_name
}

output "api_url" {
  description = "Public API base URL (https://<api_hostname>.<zone>)"
  value       = "https://${var.api_hostname}.${var.hosted_zone_name}"
}
