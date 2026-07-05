package com.leonardwongly.agentforge.data

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val NETWORK_TIMEOUT_MS = 10_000

open class AgentForgeApiClient(
  private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  open suspend fun fetchHealth(apiBaseUrl: String): ProbeResult<HealthSnapshot> =
    fetchJson("$apiBaseUrl/health") { statusCode, body ->
      parseHealth(statusCode = statusCode, body = body, checkedAt = Instant.now())
    }

  open suspend fun fetchReadiness(apiBaseUrl: String): ProbeResult<ReadinessSnapshot> =
    fetchJson("$apiBaseUrl/ready") { statusCode, body ->
      parseReadiness(statusCode = statusCode, body = body, checkedAt = Instant.now())
    }

  private suspend fun <T> fetchJson(url: String, parse: (Int, String) -> T): ProbeResult<T> =
    withContext(dispatcher) {
      runCatching {
          val connection = URL(url).openConnection() as HttpURLConnection
          connection.requestMethod = "GET"
          connection.connectTimeout = NETWORK_TIMEOUT_MS
          connection.readTimeout = NETWORK_TIMEOUT_MS
          connection.setRequestProperty("Accept", "application/json")

          val statusCode = connection.responseCode
          val body =
            try {
              val stream = if (statusCode in 200..399) connection.inputStream else connection.errorStream
              stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            } finally {
              connection.disconnect()
            }

          ProbeResult.Success(parse(statusCode, body))
        }
        .getOrElse { throwable ->
          ProbeResult.Failure(throwable.message ?: "Unable to reach AgentForge.", throwable)
        }
    }
}

sealed interface ProbeResult<out T> {
  data class Success<T>(val value: T) : ProbeResult<T>

  data class Failure(val message: String, val throwable: Throwable? = null) : ProbeResult<Nothing>
}

data class HealthSnapshot(
  val httpStatus: Int,
  val status: String,
  val database: String,
  val workerQueue: String,
  val runtimeStore: String,
  val unsignedWebhookMode: String,
  val version: String,
  val checkedAt: Instant,
) {
  val isProcessHealthy: Boolean = httpStatus in 200..299 && status == "ok"
}

data class ReadinessSnapshot(
  val httpStatus: Int,
  val status: String,
  val database: String,
  val workerQueue: String,
  val runtimeStore: String,
  val queueStatus: String,
  val queueBackend: String,
  val version: String,
  val checkedAt: Instant,
) {
  val isReady: Boolean = httpStatus in 200..299 && status == "ready"
  val hasDurableRecords: Boolean = runtimeStore == "postgres" && database == "configured"
  val hasQueueBackedEvaluations: Boolean = workerQueue == "configured" && queueStatus == "ready"
  val isProductionReady: Boolean = isReady && hasDurableRecords && hasQueueBackedEvaluations
}

fun parseHealth(statusCode: Int, body: String, checkedAt: Instant): HealthSnapshot {
  val json = parseObject(body)
  return HealthSnapshot(
    httpStatus = statusCode,
    status = json.stringValue("status"),
    database = json.stringValue("database"),
    workerQueue = json.stringValue("workerQueue"),
    runtimeStore = json.stringValue("runtimeStore"),
    unsignedWebhookMode = json.stringValue("unsignedWebhookMode"),
    version = json.stringValue("version"),
    checkedAt = checkedAt,
  )
}

fun parseReadiness(statusCode: Int, body: String, checkedAt: Instant): ReadinessSnapshot {
  val json = parseObject(body)
  val queue = json["queue"]?.jsonObjectOrNull()
  val status = json.stringValue("status")
  val workerQueue = json.stringValue("workerQueue")
  val queueStatus = queue?.stringValue("status").orEmpty().ifBlank {
    if (workerQueue == "configured" && status == "ready") "ready" else ""
  }
  val queueBackend = queue?.stringValue("backend").orEmpty().ifBlank { workerQueue }
  return ReadinessSnapshot(
    httpStatus = statusCode,
    status = status,
    database = json.stringValue("database"),
    workerQueue = workerQueue,
    runtimeStore = json.stringValue("runtimeStore"),
    queueStatus = queueStatus,
    queueBackend = queueBackend,
    version = json.stringValue("version"),
    checkedAt = checkedAt,
  )
}

private fun parseObject(body: String): JsonObject =
  try {
    Json.parseToJsonElement(body).jsonObject
  } catch (exception: Exception) {
    throw IOException("AgentForge returned invalid JSON.", exception)
  }

private fun JsonObject.stringValue(key: String): String =
  this[key]?.jsonPrimitiveOrNull()?.contentOrNull.orEmpty()

private fun JsonElement.jsonObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement.jsonPrimitiveOrNull(): JsonPrimitive? = this as? JsonPrimitive
