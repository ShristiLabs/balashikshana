output "nlb_dns_name" {
  description = "Gateway NLB DNS name"
  value       = aws_lb.gateway.dns_name
}

output "edge_url" {
  description = "Public edge base URL (https://gateway.<env>.<zone>) — what clients hit; TLS terminates at the gateway"
  value       = "https://${var.edge_hostname}.${var.hosted_zone_name}"
}

output "task_security_group_id" {
  description = "Gateway task SG (allow-list at the origin ALB to pin the origin behind the edge when ready)"
  value       = aws_security_group.task.id
}

output "ecr_repository_url" {
  description = "ECR repository URL for the gateway image"
  value       = aws_ecr_repository.gateway.repository_url
}

output "service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.gateway.name
}
