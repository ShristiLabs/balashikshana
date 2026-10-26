resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db-subnets"
  subnet_ids = var.private_subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-db-subnets"
  })
}

# Least-privilege: the only ingress is :5432 from the ECS API task
# security group. No public accessibility, ever.
resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db-sg"
  description = "RDS PostgreSQL ingress from the ECS API tasks only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from the API task security group"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.api_security_group_id]
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-db-sg"
  })
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name_prefix}-pg"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.master_username
  password = var.master_password

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  backup_retention_period   = var.backup_retention_days
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name_prefix}-pg-${var.final_snapshot_identifier}"

  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
  apply_immediately          = var.apply_immediately

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-pg"
  })
}
