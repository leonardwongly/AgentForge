output "load_balancer_dns" {
  description = "DNS name of the application load balancer."
  value       = aws_lb.this.dns_name
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.this.name
}

output "postgres_endpoint" {
  description = "Endpoint of the managed Postgres instance."
  value       = aws_db_instance.postgres.endpoint
}

output "redis_endpoint" {
  description = "Endpoint of the managed Redis cluster."
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}
