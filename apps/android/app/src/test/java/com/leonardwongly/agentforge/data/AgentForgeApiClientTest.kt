package com.leonardwongly.agentforge.data

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentForgeApiClientTest {
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
}
