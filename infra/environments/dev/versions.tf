terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state — S3 + DynamoDB lock. UNCOMMENT and configure once per
  # account before the first real `terraform init` (the delivery pipeline
  # itself only ever runs `init -backend=false`, `fmt`, `validate` —
  # issue #64 is validate-only; plan/apply are human steps, see
  # docs/deployment.md "Remote state").
  #
  # backend "s3" {
  #   bucket         = "balashikshana-tfstate-<account-id>"
  #   key            = "env/<env>/terraform.tfstate" # e.g. env/dev, env/staging, env/prod
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "balashikshana-tfstate-locks"
  # }
}
