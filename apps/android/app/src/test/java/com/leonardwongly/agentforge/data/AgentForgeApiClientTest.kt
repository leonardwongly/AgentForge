package com.leonardwongly.agentforge.data

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AgentForgeApiClientTest {
  @Test
  fun parseHealth_acceptsMinimalPublicHealthContract() {
    val health =
      parseHealth(
        statusCode = 200,
        body = "{\"status\":\"ok\",\"version\":\"1.1.0\"}",
        checkedAt = Instant.EPOCH,
      )

    assertTrue(health.isProcessHealthy)
    assertEquals("", health.database)
    assertEquals("1.1.0", health.version)
  }

  @Test
  fun parseHealth_readsAgentForgeHealthContract() {
    val health =
      parseHealth(
        statusCode = 200,
        body =
          """
          {
            "status": "ok",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "unsignedWebhookMode": "disabled",
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertTrue(health.isProcessHealthy)
    assertEquals("postgres", health.runtimeStore)
    assertEquals("disabled", health.unsignedWebhookMode)
  }

  @Test
  fun parseReadiness_identifiesProductionReadyStack() {
    val readiness =
      parseReadiness(
        statusCode = 200,
        body =
          """
          {
            "status": "ready",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "queue": {
              "status": "ready",
              "backend": "redis"
            },
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertTrue(readiness.isReady)
    assertTrue(readiness.hasDurableRecords)
    assertTrue(readiness.hasQueueBackedEvaluations)
    assertTrue(readiness.isProductionReady)
  }

  @Test
  fun parseReadiness_rejectsInMemoryQueueAsProductionReady() {
    val readiness =
      parseReadiness(
        statusCode = 200,
        body =
          """
          {
            "status": "ready",
            "database": "configured",
            "workerQueue": "in_memory",
            "runtimeStore": "postgres",
            "queue": {
              "status": "ready",
              "backend": "in_memory"
            },
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertFalse(readiness.hasQueueBackedEvaluations)
    assertFalse(readiness.isProductionReady)
  }

  @Test
  fun parseReadiness_handlesCurrentDeploymentWithoutNestedQueue() {
    val readiness =
      parseReadiness(
        statusCode = 200,
        body =
          """
          {
            "status": "ready",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "version": "0.1.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertEquals("ready", readiness.queueStatus)
    assertEquals("configured", readiness.queueBackend)
    assertTrue(readiness.isProductionReady)
  }

  @Test
  fun parseReadiness_treatsMalformedNestedQueueAsUnavailable() {
    val readiness =
      parseReadiness(
        statusCode = 503,
        body =
          """
          {
            "status": "degraded",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "queue": ["ready"],
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertEquals("", readiness.queueStatus)
    assertEquals("", readiness.queueBackend)
    assertFalse(readiness.isReady)
    assertFalse(readiness.isProductionReady)
  }

  @Test
  fun parseReadiness_doesNotAcceptMalformedQueueWhenStatusLooksReady() {
    val readiness =
      parseReadiness(
        statusCode = 200,
        body =
          """
          {
            "status": "ready",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "queue": ["ready"],
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertEquals("", readiness.queueStatus)
    assertEquals("", readiness.queueBackend)
    assertFalse(readiness.hasQueueBackedEvaluations)
    assertFalse(readiness.isProductionReady)
  }

  @Test
  fun parseReadiness_doesNotTreatExplicitlyNullQueueAsLegacyPayload() {
    val readiness =
      parseReadiness(
        statusCode = 200,
        body =
          """
          {
            "status": "ready",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "queue": null,
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertEquals("", readiness.queueStatus)
    assertEquals("", readiness.queueBackend)
    assertFalse(readiness.hasQueueBackedEvaluations)
    assertFalse(readiness.isProductionReady)
  }

  @Test
  fun parseReadiness_rejectsConfiguredWorkerQueueWithInMemoryBackend() {
    val readiness =
      parseReadiness(
        statusCode = 200,
        body =
          """
          {
            "status": "ready",
            "database": "configured",
            "workerQueue": "configured",
            "runtimeStore": "postgres",
            "queue": {
              "status": "ready",
              "backend": "in_memory"
            },
            "version": "1.0.0"
          }
          """
            .trimIndent(),
        checkedAt = Instant.EPOCH,
      )

    assertFalse(readiness.hasQueueBackedEvaluations)
    assertFalse(readiness.isProductionReady)
  }

  @Test
  fun parseHealth_rejectsNonObjectJsonInsteadOfSilentlyAcceptingEmptyFields() {
    try {
      parseHealth(statusCode = 200, body = "[1, 2, 3]", checkedAt = Instant.EPOCH)
      assertTrue("Expected malformed health payload to fail", false)
    } catch (exception: java.io.IOException) {
      assertTrue(exception.message?.contains("invalid JSON") == true)
    }
  }

  @Test
  fun fetchHealth_closesResponseStreamAndHandlesProviderReturningZeroProgress() = runBlocking {
    val stream = ZeroProgressInputStream("{\"status\":\"ok\",\"version\":\"1.1.0\"}".toByteArray())
    val client =
      AgentForgeApiClient(Dispatchers.Unconfined) {
        StubHttpURLConnection(URL(it), statusCode = 200, input = stream)
      }

    val result = client.fetchHealth("https://agentforge.example.test")

    assertTrue(result is ProbeResult.Success)
    assertTrue("The response stream must be closed after parsing", stream.closed)
  }

  @Test
  fun fetchHealth_rejectsOversizedResponseAndClosesStream() = runBlocking {
    val stream = TrackingInputStream(ByteArray(1_048_577) { '{'.code.toByte() })
    val client =
      AgentForgeApiClient(Dispatchers.Unconfined) {
        StubHttpURLConnection(URL(it), statusCode = 200, input = stream)
      }

    val result = client.fetchHealth("https://agentforge.example.test")

    assertTrue(result is ProbeResult.Failure)
    assertTrue((result as ProbeResult.Failure).message.contains("size limit"))
    assertTrue("An oversized response must still close its stream", stream.closed)
  }

  @Test
  fun fetchHealth_propagatesCancellationInsteadOfReturningFailure() = runBlocking {
    val client =
      AgentForgeApiClient(Dispatchers.Unconfined) {
        StubHttpURLConnection(URL(it), statusCode = 200, input = CancellationInputStream())
      }

    try {
      client.fetchHealth("https://agentforge.example.test")
      fail("Cancellation must be propagated to the caller")
    } catch (exception: CancellationException) {
      assertEquals("cancelled", exception.message)
    }
  }
}

private open class TrackingInputStream(bytes: ByteArray) : ByteArrayInputStream(bytes) {
  var closed = false
    private set

  override fun close() {
    closed = true
    super.close()
  }
}

private class ZeroProgressInputStream(bytes: ByteArray) : TrackingInputStream(bytes) {
  private var returnedZero = false

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (!returnedZero) {
      returnedZero = true
      return 0
    }
    return super.read(buffer, offset, length)
  }
}

private class CancellationInputStream : InputStream() {
  override fun read(): Int = throw CancellationException("cancelled")
}

private class StubHttpURLConnection(
  url: URL,
  private val statusCode: Int,
  private val input: InputStream,
) : HttpURLConnection(url) {
  override fun disconnect() = Unit

  override fun usingProxy(): Boolean = false

  override fun connect() = Unit

  override fun getResponseCode(): Int = statusCode

  override fun getInputStream(): InputStream = input
}
