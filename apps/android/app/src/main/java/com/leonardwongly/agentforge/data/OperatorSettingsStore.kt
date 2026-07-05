package com.leonardwongly.agentforge.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Persists the operator's configured API and dashboard base URLs across app
 * launches.
 *
 * Only the two non-secret base URLs are persisted. No tokens, secrets, or
 * session material are stored on device — that stays behind the deployed
 * dashboard/API, consistent with the client's security boundary.
 */
interface OperatorSettingsStore {
  fun loadApiBaseUrl(): String?

  fun loadDashboardBaseUrl(): String?

  fun saveApiBaseUrl(value: String)

  fun saveDashboardBaseUrl(value: String)
}

/** In-memory store for unit tests and previews. */
class InMemoryOperatorSettingsStore(
  private var apiBaseUrl: String? = null,
  private var dashboardBaseUrl: String? = null,
) : OperatorSettingsStore {
  override fun loadApiBaseUrl(): String? = apiBaseUrl

  override fun loadDashboardBaseUrl(): String? = dashboardBaseUrl

  override fun saveApiBaseUrl(value: String) {
    apiBaseUrl = value
  }

  override fun saveDashboardBaseUrl(value: String) {
    dashboardBaseUrl = value
  }
}

/** SharedPreferences-backed persistence used by the shipping app. */
class SharedPreferencesOperatorSettingsStore(
  private val preferences: SharedPreferences,
) : OperatorSettingsStore {
  constructor(context: Context) : this(
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE),
  )

  override fun loadApiBaseUrl(): String? = preferences.getString(KEY_API_BASE_URL, null)?.ifBlank { null }

  override fun loadDashboardBaseUrl(): String? =
    preferences.getString(KEY_DASHBOARD_BASE_URL, null)?.ifBlank { null }

  override fun saveApiBaseUrl(value: String) {
    preferences.edit().putString(KEY_API_BASE_URL, value).apply()
  }

  override fun saveDashboardBaseUrl(value: String) {
    preferences.edit().putString(KEY_DASHBOARD_BASE_URL, value).apply()
  }

  private companion object {
    const val PREFERENCES_NAME = "agentforge.operator.settings"
    const val KEY_API_BASE_URL = "apiBaseUrl"
    const val KEY_DASHBOARD_BASE_URL = "dashboardBaseUrl"
  }
}
