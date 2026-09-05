package com.leonardwongly.agentforge.ui.main

import com.leonardwongly.agentforge.data.AgentForgeApiClient
import com.leonardwongly.agentforge.data.HealthSnapshot
import com.leonardwongly.agentforge.data.InMemoryOperatorSettingsStore
import com.leonardwongly.agentforge.data.OperatorSettingsStore
import com.leonardwongly.agentforge.data.ProbeResult
import com.leonardwongly.agentforge.data.ReadinessSnapshot
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MainScreenViewModelTest {
  private val dispatcher = StandardTestDispatcher()

  @Before
  fun setUp() {
    Dispatchers.setMain(dispatcher)
  }

  @After
  fun tearDown() {
    Dispatchers.resetMain()
  }

  @Test
  fun init_loadsPersistedUrls() {
    val settings =
      InMemoryOperatorSettingsStore(
        apiBaseUrl = "https://persisted-api.example.com",
        dashboardBaseUrl = "https://persisted-dash.example.com",
      )

    val viewModel = MainScreenViewModel(settings = settings)

    assertEquals("https://persisted-api.example.com", viewModel.uiState.value.apiBaseUrl)
    assertEquals("https://persisted-dash.example.com", viewModel.uiState.value.dashboardBaseUrl)
  }

  @Test
  fun init_fallsBackToDefaultsWhenNothingPersisted() {
    val viewModel = MainScreenViewModel(settings = InMemoryOperatorSettingsStore())

    assertEquals(
      com.leonardwongly.agentforge.data.DEFAULT_API_BASE_URL,
      viewModel.uiState.value.apiBaseUrl,
    )
  }

  @Test
  fun checkAll_persistsNormalizedApiUrl() =
    runTest(dispatcher) {
      val settings = InMemoryOperatorSettingsStore()
      val viewModel = MainScreenViewModel(apiClient = FakeApiClient(), settings = settings)

      // A bare host (no scheme, trailing slash) should be normalized then persisted.
      viewModel.updateApiBaseUrl("example.com/")
      viewModel.checkReadiness()

      assertEquals("https://example.com", settings.loadApiBaseUrl())
    }

  @Test
  fun checkReadiness_invalidUrlSetsErrorAndDoesNotPersist() =
    runTest(dispatcher) {
      val settings = InMemoryOperatorSettingsStore()
      val viewModel = MainScreenViewModel(settings = settings)

      viewModel.updateApiBaseUrl("http://deployed.example.com")
      viewModel.checkReadiness()

      assertEquals(
        "Use HTTPS for deployed AgentForge URLs.",
        viewModel.uiState.value.apiUrlError,
      )
      assertNull(settings.loadApiBaseUrl())
    }

  @Test
  fun resetDefaults_persistsDefaults() {
    val settings =
      InMemoryOperatorSettingsStore(apiBaseUrl = "https://custom.example.com")
    val viewModel = MainScreenViewModel(settings = settings)

    viewModel.resetDefaults()

    assertEquals(com.leonardwongly.agentforge.data.DEFAULT_API_BASE_URL, settings.loadApiBaseUrl())
    assertEquals(
      com.leonardwongly.agentforge.data.DEFAULT_DASHBOARD_BASE_URL,
      settings.loadDashboardBaseUrl(),
    )
  }

  @Test
  fun githubOAuthUrl_derivedFromDashboardUrl() {
    val settings: OperatorSettingsStore =
      InMemoryOperatorSettingsStore(dashboardBaseUrl = "https://dash.example.com")
    val viewModel = MainScreenViewModel(settings = settings)

    assertEquals("https://dash.example.com/auth/github/login", viewModel.githubOAuthUrl())
  }

  @Test
  fun checkHealth_ignoresOlderCompletionAfterEndpointChanges() =
    runTest(dispatcher) {
      val client = DeferredApiClient()
      val viewModel = MainScreenViewModel(apiClient = client, settings = InMemoryOperatorSettingsStore())

      viewModel.updateApiBaseUrl("https://old.example.com")
      viewModel.checkHealth()
      advanceUntilIdle()
      viewModel.updateApiBaseUrl("https://new.example.com")
      viewModel.checkHealth()
      advanceUntilIdle()

      assertEquals(listOf("https://old.example.com", "https://new.example.com"), client.healthCalls.map { it.url })

      val oldSnapshot = healthSnapshot("old")
      val newSnapshot = healthSnapshot("new")
      client.healthCalls[1].result.complete(ProbeResult.Success(newSnapshot))
      advanceUntilIdle()
      client.healthCalls[0].result.complete(ProbeResult.Success(oldSnapshot))
      advanceUntilIdle()

      assertEquals(newSnapshot, viewModel.uiState.value.health)
      assertFalse(viewModel.uiState.value.isCheckingHealth)
    }

  @Test
  fun checkReadiness_ignoresOlderCompletionAfterRepeatedCheck() =
    runTest(dispatcher) {
      val client = DeferredApiClient()
      val viewModel = MainScreenViewModel(apiClient = client, settings = InMemoryOperatorSettingsStore())

      viewModel.updateApiBaseUrl("https://api.example.com")
      viewModel.checkReadiness()
      advanceUntilIdle()
      viewModel.checkReadiness()
      advanceUntilIdle()

      val oldSnapshot = readinessSnapshot("old")
      val newSnapshot = readinessSnapshot("new")
      client.readinessCalls[1].result.complete(ProbeResult.Success(newSnapshot))
      advanceUntilIdle()
      client.readinessCalls[0].result.complete(ProbeResult.Success(oldSnapshot))
      advanceUntilIdle()

      assertEquals(newSnapshot, viewModel.uiState.value.readiness)
      assertFalse(viewModel.uiState.value.isCheckingReadiness)
    }
}


/** Fake client that returns a healthy/ready stack without touching the network. */
private class FakeApiClient : AgentForgeApiClient() {
  override suspend fun fetchHealth(apiBaseUrl: String): ProbeResult<HealthSnapshot> =
    ProbeResult.Success(
      HealthSnapshot(
        httpStatus = 200,
        status = "ok",
        database = "configured",
        workerQueue = "configured",
        runtimeStore = "postgres",
        unsignedWebhookMode = "disabled",
        version = "1.0.0",
        checkedAt = Instant.EPOCH,
      ),
    )

  override suspend fun fetchReadiness(apiBaseUrl: String): ProbeResult<ReadinessSnapshot> =
    ProbeResult.Success(
      ReadinessSnapshot(
        httpStatus = 200,
        status = "ready",
        database = "configured",
        workerQueue = "configured",
        runtimeStore = "postgres",
        queueStatus = "ready",
        queueBackend = "redis",
        version = "1.0.0",
        checkedAt = Instant.EPOCH,
      ),
    )
}

private class DeferredApiClient : AgentForgeApiClient() {
  data class PendingHealth(
    val url: String,
    val result: CompletableDeferred<ProbeResult<HealthSnapshot>> = CompletableDeferred(),
  )

  data class PendingReadiness(
    val url: String,
    val result: CompletableDeferred<ProbeResult<ReadinessSnapshot>> = CompletableDeferred(),
  )

  val healthCalls = mutableListOf<PendingHealth>()
  val readinessCalls = mutableListOf<PendingReadiness>()

  override suspend fun fetchHealth(apiBaseUrl: String): ProbeResult<HealthSnapshot> {
    val pending = PendingHealth(apiBaseUrl)
    healthCalls += pending
    return pending.result.await()
  }

  override suspend fun fetchReadiness(apiBaseUrl: String): ProbeResult<ReadinessSnapshot> {
    val pending = PendingReadiness(apiBaseUrl)
    readinessCalls += pending
    return pending.result.await()
  }
}

private fun healthSnapshot(version: String) =
  HealthSnapshot(
    httpStatus = 200,
    status = "ok",
    database = "configured",
    workerQueue = "configured",
    runtimeStore = "postgres",
    unsignedWebhookMode = "disabled",
    version = version,
    checkedAt = Instant.EPOCH,
  )

private fun readinessSnapshot(version: String) =
  ReadinessSnapshot(
    httpStatus = 200,
    status = "ready",
    database = "configured",
    workerQueue = "configured",
    runtimeStore = "postgres",
    queueStatus = "ready",
    queueBackend = "redis",
    version = version,
    checkedAt = Instant.EPOCH,
  )
