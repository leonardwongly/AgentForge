# Configure the backend at `terraform init` time; never use local state for
# production because it contains database credentials and secret references.
# Example:
#   terraform init \
#     -backend-config='bucket=<state-bucket>' \
#     -backend-config='key=agentforge/<environment>/terraform.tfstate' \
#     -backend-config='region=<region>' \
#     -backend-config='dynamodb_table=<state-lock-table>'
# The S3 bucket must have versioning, Block Public Access, SSE-KMS, and a
# restrictive bucket policy. The lock table should use server-side encryption.
terraform {
  backend "s3" {
    encrypt = true
  }
}
