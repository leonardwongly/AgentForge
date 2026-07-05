package com.leonardwongly.agentforge.ui.main

import com.leonardwongly.agentforge.data.AgentForgeApiClient
import com.leonardwongly.agentforge.data.HealthSnapshot
import com.leonardwongly.agentforge.data.InMemoryOperatorSettingsStore
import com.leonardwongly.agentforge.data.OperatorSettingsStore
import com.leonardwongly.agentforge.data.ProbeResult
import com.leonardwongly.agentforge.data.ReadinessSnapshot
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
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
