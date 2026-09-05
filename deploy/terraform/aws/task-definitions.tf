# ECS Fargate task definitions for the API, worker, and web dashboard.
# Images are built from the root Dockerfile targets (api|worker|web).

locals {
  task_common = {
    requires_compatibilities = ["FARGATE"]
    network_mode            = "FARGATE"
    cpu                     = 256
    memory                  = 512
    execution_role_arn      = var.ecs_execution_role_arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = local.task_common.requires_compatibilities
  network_mode             = local.task_common.network_mode
  cpu                      = local.task_common.cpu
  memory                   = local.task_common.memory
  execution_role_arn       = local.task_common.execution_role_arn
  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.api_image
      essential = true
      portMappings = [{ containerPort = 4000, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "APP_BASE_URL", value = var.app_base_url },
        { name = "API_BASE_URL", value = var.api_base_url },
        { name = "DEFAULT_POLICY_MODE", value = var.default_policy_mode },
        { name = "SOURCE_CODE_STORAGE", value = "false" },
        { name = "REDACT_SECRETS", value = "true" }
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
        { name = "REDIS_URL", valueFrom = var.redis_url_secret_arn },
        { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = var.github_app_private_key_secret_arn },
        { name = "GITHUB_WEBHOOK_SECRET", valueFrom = var.github_webhook_secret_arn },
        { name = "SESSION_SECRET", valueFrom = var.session_secret_arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/agentforge"
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])
  tags = local.common_tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name_prefix}-worker"
  requires_compatibilities = local.task_common.requires_compatibilities
  network_mode             = local.task_common.network_mode
  cpu                      = local.task_common.cpu
  memory                   = local.task_common.memory
  execution_role_arn       = local.task_common.execution_role_arn
  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.worker_image
      essential = true
      environment = [
        { name = "NODE_ENV", value = "production" }
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
        { name = "REDIS_URL", valueFrom = var.redis_url_secret_arn },
        { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = var.github_app_private_key_secret_arn },
        { name = "GITHUB_WEBHOOK_SECRET", valueFrom = var.github_webhook_secret_arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/agentforge"
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
  tags = local.common_tags
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name_prefix}-web"
  requires_compatibilities = local.task_common.requires_compatibilities
  network_mode             = local.task_common.network_mode
  cpu                      = local.task_common.cpu
  memory                   = local.task_common.memory
  execution_role_arn       = local.task_common.execution_role_arn
  container_definitions = jsonencode([
    {
      name      = "web"
      image     = var.web_image
      essential = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "APP_BASE_URL", value = var.app_base_url }
      ]
      secrets = [
        { name = "SESSION_SECRET", valueFrom = var.session_secret_arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/agentforge"
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }
    }
  ])
  tags = local.common_tags
}
