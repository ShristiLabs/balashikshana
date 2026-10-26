output "vpc_id" {
  description = "ID of the environment VPC"
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC CIDR block (origin TRUST_PROXY_CIDRS when the edge fronts it, #65)"
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs (ALB placement)"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (API tasks + RDS placement)"
  value       = aws_subnet.private[*].id
}

output "availability_zone_names" {
  description = "Availability zones in use"
  value       = local.azs
}
