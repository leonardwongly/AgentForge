variable "name_prefix" {
  description = "Prefix for all resource names."
  type        = string
  default     = "agentforge"
}

variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "azs" {
  description = "Availability zones to deploy into."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "postgres_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "postgres_username" {
  type      = string
  sensitive = true
}

variable "postgres_password" {
  type      = string
  sensitive = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t3.micro"
}

variable "redis_auth_token" {
  description = "AUTH token for the managed Redis cluster. Must match the password in REDIS_URL."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.redis_auth_token) >= 32
    error_message = "redis_auth_token must be at least 32 characters."
  }
}

variable "api_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "web_image" {
  type = string
}

variable "api_replicas" {
  type    = number
  default = 1
}

variable "worker_replicas" {
  type    = number
  default = 1
}

variable "web_replicas" {
  type    = number
  default = 1
}

variable "app_base_url" {
  type = string
  validation {
    condition     = startswith(var.app_base_url, "https://")
    error_message = "app_base_url must use HTTPS."
  }
}

variable "api_base_url" {
  description = "Canonical HTTPS URL used by API callbacks and dashboard clients."
  type        = string
  validation {
    condition     = startswith(var.api_base_url, "https://")
    error_message = "api_base_url must use HTTPS."
  }
}

variable "default_policy_mode" {
  type    = string
  default = "observe"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener."
  type        = string
}

variable "ecs_execution_role_arn" {
  description = "IAM role ARN used by ECS tasks to pull images and read secrets."
  type        = string
}

variable "database_url_secret_arn" {
  type = string
}

variable "redis_url_secret_arn" {
  type = string
}

variable "github_app_private_key_secret_arn" {
  type = string
}

variable "github_webhook_secret_arn" {
  type = string
}

variable "session_secret_arn" {
  type = string
}

variable "rds_deletion_protection" {
  type    = bool
  default = true
}

variable "alb_access_logs_bucket" {
  description = "Existing S3 bucket for ALB access logs. Leave empty only for development."
  type        = string
  default     = ""
}

variable "alb_access_logs_prefix" {
  type    = string
  default = "agentforge"
}

variable "vpc_flow_logs_destination_arn" {
  description = "Existing S3 or CloudWatch destination ARN for VPC flow logs."
  type        = string
  default     = ""
}

variable "vpc_flow_logs_iam_role_arn" {
  description = "IAM role ARN required when the VPC flow-log destination is CloudWatch Logs."
  type        = string
  default     = ""
}
