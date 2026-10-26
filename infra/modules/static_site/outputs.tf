output "bucket_name" {
  description = "Portal dist bucket (npm run build in apps/parent-portal, then aws s3 sync)"
  value       = aws_s3_bucket.portal.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain"
  value       = aws_cloudfront_distribution.portal.domain_name
}

output "cloudfront_distribution_id" {
  description = "Distribution ID (cache invalidation after a portal sync)"
  value       = aws_cloudfront_distribution.portal.id
}

output "portal_url" {
  description = "Public portal URL"
  value       = "https://${var.portal_hostname}.${var.hosted_zone_name}"
}
