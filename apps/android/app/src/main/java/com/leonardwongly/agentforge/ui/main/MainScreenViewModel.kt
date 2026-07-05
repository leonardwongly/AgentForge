package com.leonardwongly.agentforge.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.leonardwongly.agentforge.data.AgentForgeApiClient
import com.leonardwongly.agentforge.data.AgentForgeEndpoints
import com.leonardwongly.agentforge.data.DEFAULT_API_BASE_URL
import com.leonardwongly.agentforge.data.DEFAULT_DASHBOARD_BASE_URL
import com.leonardwongly.agentforge.data.EndpointValidator
import com.leonardwongly.agentforge.data.HealthSnapshot
import com.leonardwongly.agentforge.data.InMemoryOperatorSettingsStore
import com.leonardwongly.agentforge.data.OperatorSettingsStore
import com.leonardwongly.agentforge.data.ProbeResult
import com.leonardwongly.agentforge.data.ReadinessSnapshot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class MainScreenViewModel(
  private val apiClient: AgentForgeApiClient = AgentForgeApiClient(),
  private val settings: OperatorSettingsStore = InMemoryOperatorSettingsStore(),
) : ViewModel() {
  private val _uiState = MutableStateFlow(MainScreenUiState())
  val uiState: StateFlow<MainScreenUiState> = _uiState.asStateFlow()

  private var initialCheckStarted = false

  init {
    _uiState.update {
      it.copy(
        apiBaseUrl = settings.loadApiBaseUrl() ?: DEFAULT_API_BASE_URL,
        dashboardBaseUrl = settings.loadDashboardBaseUrl() ?: DEFAULT_DASHBOARD_BASE_URL,
      )
    }
  }

  /** Runs the health + readiness check once per ViewModel lifetime (survives config changes). */
  fun startInitialCheck() {
    if (initialCheckStarted) return
    initialCheckStarted = true
    checkAll()
  }

  fun updateApiBaseUrl(value: String) {
    _uiState.update { it.copy(apiBaseUrl = value, apiUrlError = null) }
  }

  fun updateDashboardBaseUrl(value: String) {
    _uiState.update { it.copy(dashboardBaseUrl = value, dashboardUrlError = null) }
  }

  fun resetDefaults() {
    _uiState.value =
      MainScreenUiState(
        apiBaseUrl = DEFAULT_API_BASE_URL,
        dashboardBaseUrl = DEFAULT_DASHBOARD_BASE_URL,
      )
    settings.saveApiBaseUrl(DEFAULT_API_BASE_URL)
    settings.saveDashboardBaseUrl(DEFAULT_DASHBOARD_BASE_URL)
  }

  fun checkAll() {
    checkHealth()
    checkReadiness()
  }

  fun checkHealth() {
    val apiBaseUrl = normalizeApiBaseUrl() ?: return
    _uiState.update { it.copy(isCheckingHealth = true, healthError = null) }
    viewModelScope.launch {
      when (val result = apiClient.fetchHealth(apiBaseUrl)) {
        is ProbeResult.Success ->
          _uiState.update {
            it.copy(
              isCheckingHealth = false,
              health = result.value,
              healthError = null,
            )
          }
        is ProbeResult.Failure ->
          _uiState.update {
            it.copy(
              isCheckingHealth = false,
              healthError = result.message,
            )
          }
      }
    }
  }

  fun checkReadiness() {
    val apiBaseUrl = normalizeApiBaseUrl() ?: return
    _uiState.update { it.copy(isCheckingReadiness = true, readinessError = null) }
    viewModelScope.launch {
      when (val result = apiClient.fetchReadiness(apiBaseUrl)) {
        is ProbeResult.Success ->
          _uiState.update {
            it.copy(
              isCheckingReadiness = false,
              readiness = result.value,
              readinessError = null,
            )
          }
        is ProbeResult.Failure ->
          _uiState.update {
            it.copy(
              isCheckingReadiness = false,
              readinessError = result.message,
            )
          }
      }
    }
  }

  fun githubOAuthUrl(): String? {
    val dashboardBaseUrl = normalizeDashboardBaseUrl() ?: return null
    return AgentForgeEndpoints(dashboardBaseUrl = dashboardBaseUrl).githubOAuthUrl
  }

  private fun normalizeApiBaseUrl(): String? =
    EndpointValidator.normalizeBaseUrl(uiState.value.apiBaseUrl).fold(
      onSuccess = { normalized ->
        _uiState.update { it.copy(apiBaseUrl = normalized, apiUrlError = null) }
        settings.saveApiBaseUrl(normalized)
        normalized
      },
      onFailure = { throwable ->
        _uiState.update { it.copy(apiUrlError = throwable.message ?: "Invalid API URL.") }
        null
      },
    )

  private fun normalizeDashboardBaseUrl(): String? =
    EndpointValidator.normalizeBaseUrl(uiState.value.dashboardBaseUrl).fold(
      onSuccess = { normalized ->
        _uiState.update { it.copy(dashboardBaseUrl = normalized, dashboardUrlError = null) }
        settings.saveDashboardBaseUrl(normalized)
        normalized
      },
      onFailure = { throwable ->
        _uiState.update { it.copy(dashboardUrlError = throwable.message ?: "Invalid dashboard URL.") }
        null
      },
    )
}

data class MainScreenUiState(
  val apiBaseUrl: String = DEFAULT_API_BASE_URL,
  val dashboardBaseUrl: String = DEFAULT_DASHBOARD_BASE_URL,
  val apiUrlError: String? = null,
  val dashboardUrlError: String? = null,
  val isCheckingHealth: Boolean = false,
  val isCheckingReadiness: Boolean = false,
  val health: HealthSnapshot? = null,
  val readiness: ReadinessSnapshot? = null,
  val healthError: String? = null,
  val readinessError: String? = null,
) {
  val endpoints: AgentForgeEndpoints?
    get() {
      val api = EndpointValidator.normalizeBaseUrl(apiBaseUrl).getOrNull()
      val dashboard = EndpointValidator.normalizeBaseUrl(dashboardBaseUrl).getOrNull()
      return if (api == null || dashboard == null) null else AgentForgeEndpoints(api, dashboard)
    }
}
