# AgentForge AWS deployment module (ECS Fargate + RDS + ElastiCache + ALB).
# Reference implementation for enterprise self-hosted deployments.
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5"
}

locals {
  name_prefix = "${var.name_prefix}-${var.environment}"
  common_tags = {
    Project     = "AgentForge"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Networking
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = local.common_tags
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = local.common_tags
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 10)
  availability_zone = var.azs[count.index]
  tags              = local.common_tags
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.common_tags
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = local.common_tags
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Data stores
resource "aws_db_instance" "postgres" {
  identifier              = "${local.name_prefix}-postgres"
  engine                  = "postgres"
  engine_version          = "16.4"
  instance_class          = var.postgres_instance_class
  allocated_storage       = 20
  db_name                 = "agentforge"
  username                = var.postgres_username
  password                = var.postgres_password
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [aws_security_group.postgres.id]
  publicly_accessible     = false
  storage_encrypted       = true
  deletion_protection     = var.rds_deletion_protection
  skip_final_snapshot     = false
  backup_retention_period = 7
  tags                    = local.common_tags
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.common_tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "AgentForge durable queue and replay store"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  # Redis carries replay state and tenant-scoped queue data; require both
  # encrypted storage and an operator-supplied auth token.
  at_rest_encryption_enabled = true
  transit_encryption_enabled  = true
  auth_token                  = var.redis_auth_token
  tags                        = local.common_tags
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name_prefix}-redis-subnet"
  subnet_ids = aws_subnet.private[*].id
}

# ECS cluster + services
resource "aws_ecs_cluster" "this" {
  name = local.name_prefix
  tags = local.common_tags
}

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_replicas
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name_prefix}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_replicas
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name_prefix}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_replicas
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
}

# Load balancer
resource "aws_lb" "this" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  dynamic "access_logs" {
    for_each = var.alb_access_logs_bucket == "" ? [] : [var.alb_access_logs_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.alb_access_logs_prefix
      enabled = true
    }
  }
  tags               = local.common_tags
}

resource "aws_wafv2_web_acl" "this" {
  name  = "${local.name_prefix}-web-acl"
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  rule {
    name     = "AWSManagedCommonRules"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-common-rules"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "WebhookRateLimit"
    priority = 20
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 300
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            field_to_match {
              uri_path {}
            }
            positional_constraint = "STARTS_WITH"
            search_string         = "/webhooks/"
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-webhook-rate-limit"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-web-acl"
    sampled_requests_enabled   = true
  }
  tags = local.common_tags
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

resource "aws_flow_log" "vpc" {
  count                = var.vpc_flow_logs_destination_arn == "" ? 0 : 1
  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination       = var.vpc_flow_logs_destination_arn
  log_destination_type = startswith(var.vpc_flow_logs_destination_arn, "arn:aws:s3:") ? "s3" : "cloud-watch-logs"
  iam_role_arn         = var.vpc_flow_logs_iam_role_arn == "" ? null : var.vpc_flow_logs_iam_role_arn
  tags                 = local.common_tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api-tg"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"
  health_check {
    path = "/ready"
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"
  health_check {
    path = "/"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern { values = ["/api", "/api/*", "/webhooks/*", "/health", "/ready"] }
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# Security groups
resource "aws_security_group" "alb" {
  name   = "${local.name_prefix}-alb"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 3000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = local.common_tags
}

resource "aws_security_group" "api" {
  name   = "${local.name_prefix}-api"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["169.254.169.253/32"]
  }
  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["169.254.169.253/32"]
  }
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = local.common_tags
}

resource "aws_security_group" "worker" {
  name   = "${local.name_prefix}-worker"
  vpc_id = aws_vpc.this.id
  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["169.254.169.253/32"]
  }
  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["169.254.169.253/32"]
  }
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = local.common_tags
}

resource "aws_security_group" "web" {
  name   = "${local.name_prefix}-web"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["169.254.169.253/32"]
  }
  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["169.254.169.253/32"]
  }
  egress {
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = local.common_tags
}

resource "aws_security_group" "postgres" {
  name   = "${local.name_prefix}-postgres"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
  }
  tags = local.common_tags
}

resource "aws_security_group" "redis" {
  name   = "${local.name_prefix}-redis"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
  }
  tags = local.common_tags
}
