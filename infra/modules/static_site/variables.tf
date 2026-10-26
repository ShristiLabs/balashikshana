# Static site module — S3 + CloudFront hosting for apps/parent-portal dist/
# (Vite SPA build, no client-side router). The bucket is fully private;
# only the CloudFront origin access identity may read it.

variable "name_prefix" {
  description = "Resource name prefix, e.g. balashikshana-dev"
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID for the portal domain"
  type        = string
}

variable "hosted_zone_name" {
  description = "Route53 hosted zone name (e.g. balashikshana.example.)"
  type        = string
}

variable "portal_hostname" {
  description = "Portal hostname label inside the hosted zone"
  type        = string
  default     = "portal"
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (MUST be in us-east-1 for CloudFront)"
  type        = string
}

variable "price_class" {
  description = "CloudFront price class (PriceClass_100 = US/Canada/EU only — cost-lean default for a US SaaS)"
  type        = string
  default     = "PriceClass_100"
}

variable "default_ttl_seconds" {
  description = "Default browser/edge cache TTL for hashed build assets"
  type        = number
  default     = 3600
}

variable "versioning" {
  description = "S3 object versioning (deploy rollbacks: re-sync a previous dist)"
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Allow bucket destruction (dev convenience; prod: false)"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
