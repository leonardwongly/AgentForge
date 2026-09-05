package com.leonardwongly.agentforge.data

import java.io.IOException
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CancellationException
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
private const val MAX_RESPONSE_BYTES = 1_048_576

open class AgentForgeApiClient(
  private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val connectionFactory: (String) -> HttpURLConnection = { url ->
    URL(url).openConnection() as HttpURLConnection
  },
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
          val connection = connectionFactory(url)
          connection.requestMethod = "GET"
          connection.connectTimeout = NETWORK_TIMEOUT_MS
          connection.readTimeout = NETWORK_TIMEOUT_MS
          connection.setRequestProperty("Accept", "application/json")

          val statusCode = connection.responseCode
          val body =
            try {
              val stream = if (statusCode in 200..399) connection.inputStream else connection.errorStream
              stream?.use { it.readBounded(MAX_RESPONSE_BYTES) }?.toString(Charsets.UTF_8).orEmpty()
            } finally {
              connection.disconnect()
            }

          ProbeResult.Success(parse(statusCode, body))
        }
        .getOrElse { throwable ->
          // Cancellation is control flow, not a failed probe. Swallowing it
          // here would let a cancelled ViewModel request complete normally and
          // potentially mutate state after its owner is gone.
          if (throwable is CancellationException) {
            throw throwable
          }
          ProbeResult.Failure(throwable.message ?: "Unable to reach AgentForge.", throwable)
        }
    }
}

internal fun InputStream.readBounded(maxBytes: Int): ByteArray {
  val output = ByteArrayOutputStream(minOf(maxBytes, 64 * 1024))
  val buffer = ByteArray(8 * 1024)
  var total = 0
  while (true) {
    val read = read(buffer)
    if (read < 0) break
    if (read == 0) {
      // InputStream implementations are expected to make progress for a
      // non-empty buffer, but a provider can violate that contract. Fall back
      // to a one-byte read so a zero-progress stream cannot spin forever.
      val singleByte = read()
      if (singleByte < 0) break
      if (total >= maxBytes) {
        throw IOException("AgentForge response exceeded the size limit.")
      }
      output.write(singleByte)
      total += 1
      continue
    }
    total += read
    if (total > maxBytes) {
      throw IOException("AgentForge response exceeded the size limit.")
    }
    output.write(buffer, 0, read)
  }
  return output.toByteArray()
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
  /** True when the response included a queue field (including null/invalid). */
  val hasExplicitQueue: Boolean = false,
) {
  val isReady: Boolean = httpStatus in 200..299 && status == "ready"
  val hasDurableRecords: Boolean = runtimeStore == "postgres" && database == "configured"
  val hasQueueBackedEvaluations: Boolean =
    workerQueue == "configured" &&
      queueStatus == "ready" &&
      (queueBackend == "redis" || (!hasExplicitQueue && queueBackend == "configured"))
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
  val queueElement = json["queue"]
  val queue = queueElement?.jsonObjectOrNull()
  val status = json.stringValue("status")
  val workerQueue = json.stringValue("workerQueue")
  val hasExplicitQueue = json.containsKey("queue")
  val queueStatus =
    when {
      queue != null -> queue.stringValue("status")
      hasExplicitQueue -> ""
      workerQueue == "configured" && status == "ready" -> "ready"
      else -> ""
    }
  val queueBackend =
    when {
      queue != null -> queue.stringValue("backend")
      hasExplicitQueue -> ""
      else -> workerQueue
    }
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
    hasExplicitQueue = hasExplicitQueue,
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
