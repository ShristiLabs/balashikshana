# Packs store module — S3 bucket for compiled per-grade content packs
# (tools/content-pipeline output: index.json + pack-<grade>-v<version>.sqlite).
# The API serves packs from BALASHIKSHANA_CONTENT_PACKS_DIR; the cloud
# strategy (one-off sync task before a deploy) is documented in
# docs/deployment.md "Content packs".

variable "name_prefix" {
  description = "Resource name prefix, e.g. balashikshana-dev"
  type        = string
}

variable "versioning" {
  description = "Keep pack object versions (rollback to a prior content version)"
  type        = bool
  default     = true
}

variable "noncurrent_version_expiration_days" {
  description = "Expire noncurrent pack versions after N days"
  type        = number
  default     = 90
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
