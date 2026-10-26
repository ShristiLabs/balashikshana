resource "aws_s3_bucket" "portal" {
  bucket        = "${var.name_prefix}-portal"
  force_destroy = var.force_destroy

  tags = var.tags
}

resource "aws_s3_bucket_public_access_block" "portal" {
  bucket = aws_s3_bucket.portal.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "portal" {
  bucket = aws_s3_bucket.portal.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "portal" {
  count = var.versioning ? 1 : 0

  bucket = aws_s3_bucket.portal.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "portal" {
  bucket = aws_s3_bucket.portal.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Origin Access Control (the current AWS-recommended S3+CloudFront access
# pattern; the provider-5 origin block no longer carries the legacy OAI
# argument). The bucket stays fully private — only this distribution may
# read from it, via the SourceArn condition below.
resource "aws_cloudfront_origin_access_control" "portal" {
  name                              = "${var.name_prefix}-portal-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "portal_cloudfront_read" {
  statement {
    effect = "Allow"

    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.portal.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.portal.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "portal" {
  bucket = aws_s3_bucket.portal.id
  policy = data.aws_iam_policy_document.portal_cloudfront_read.json

  depends_on = [aws_s3_bucket_public_access_block.portal]
}

resource "aws_cloudfront_distribution" "portal" {
  enabled         = true
  comment         = "${var.name_prefix} parent portal"
  price_class     = var.price_class
  aliases         = [trimsuffix("${var.portal_hostname}.${var.hosted_zone_name}", ".")]
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.portal.bucket_regional_domain_name
    origin_id                = "s3-${var.name_prefix}-portal"
    origin_access_control_id = aws_cloudfront_origin_access_control.portal.id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "s3-${var.name_prefix}-portal"

    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }

    default_ttl = var.default_ttl_seconds
  }

  # Vite SPA: unknown paths fall back to index.html (harmless today — the
  # portal has no client-side router — and safe if one is added).
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 60
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  default_root_object = "index.html"

  tags = var.tags
}

resource "aws_route53_record" "portal" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.hosted_zone_id
  name    = "${var.portal_hostname}.${var.hosted_zone_name}"
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.portal.domain_name
    zone_id                = aws_cloudfront_distribution.portal.hosted_zone_id
    evaluate_target_health = false
  }
}
