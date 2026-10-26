output "db_instance_identifier" {
  description = "RDS instance identifier"
  value       = aws_db_instance.this.identifier
}

output "endpoint" {
  description = "RDS endpoint in host:port form"
  value       = aws_db_instance.this.endpoint
}

output "db_name" {
  description = "Database name"
  value       = aws_db_instance.this.db_name
}

output "master_username" {
  description = "Master username (used to compose the API DATABASE_URL)"
  value       = aws_db_instance.this.username
}

output "security_group_id" {
  description = "DB security group ID"
  value       = aws_security_group.db.id
}
