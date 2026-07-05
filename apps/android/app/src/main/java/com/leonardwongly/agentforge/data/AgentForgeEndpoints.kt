package com.leonardwongly.agentforge.data

import java.net.URI

const val DEFAULT_API_BASE_URL = "https://agentforge-api-production-5fc1.up.railway.app"
const val DEFAULT_DASHBOARD_BASE_URL = "https://agentforge-web-production.up.railway.app"

data class AgentForgeEndpoints(
  val apiBaseUrl: String = DEFAULT_API_BASE_URL,
  val dashboardBaseUrl: String = DEFAULT_DASHBOARD_BASE_URL,
) {
  val healthUrl: String = "$apiBaseUrl/health"
  val readinessUrl: String = "$apiBaseUrl/ready"
  val githubOAuthUrl: String = "$dashboardBaseUrl/auth/github/login"
}

object EndpointValidator {
  fun normalizeBaseUrl(input: String): Result<String> {
    val trimmed = input.trim().trimEnd('/')
    if (trimmed.isBlank()) {
      return Result.failure(IllegalArgumentException("URL is required."))
    }

    val withScheme =
      if (trimmed.contains("://")) {
        trimmed
      } else {
        "https://$trimmed"
      }

    val uri =
      runCatching { URI(withScheme) }
        .getOrElse { return Result.failure(IllegalArgumentException("URL is malformed.")) }

    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (scheme !in setOf("https", "http") || host.isNullOrBlank()) {
      return Result.failure(IllegalArgumentException("URL must include an HTTP or HTTPS host."))
    }

    if (scheme == "http" && !host.isLocalDevelopmentHost()) {
      return Result.failure(IllegalArgumentException("Use HTTPS for deployed AgentForge URLs."))
    }

    return Result.success(uri.normalize().toString().trimEnd('/'))
  }

  private fun String.isLocalDevelopmentHost(): Boolean =
    this == "localhost" || this == "127.0.0.1" || this == "10.0.2.2"
}
