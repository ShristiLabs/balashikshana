output "bucket_name" {
  description = "Content-pack bucket (tools/content-pipeline build output target)"
  value       = aws_s3_bucket.packs.id
}

output "bucket_arn" {
  description = "Content-pack bucket ARN"
  value       = aws_s3_bucket.packs.arn
}
