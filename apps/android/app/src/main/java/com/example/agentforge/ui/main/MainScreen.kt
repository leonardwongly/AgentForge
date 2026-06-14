package com.example.agentforge.ui.main

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.agentforge.data.HealthSnapshot
import com.example.agentforge.data.ReadinessSnapshot
import com.example.agentforge.theme.AgentForgeTheme
import java.time.Instant

@Composable
fun MainScreen(
  modifier: Modifier = Modifier,
  viewModel: MainScreenViewModel = viewModel { MainScreenViewModel() },
) {
  val state by viewModel.uiState.collectAsStateWithLifecycle()
  val context = LocalContext.current

  MainScreen(
    state = state,
    onApiBaseUrlChange = viewModel::updateApiBaseUrl,
    onDashboardBaseUrlChange = viewModel::updateDashboardBaseUrl,
    onCheckAll = viewModel::checkAll,
    onCheckHealth = viewModel::checkHealth,
    onCheckReadiness = viewModel::checkReadiness,
    onResetDefaults = viewModel::resetDefaults,
    onOpenGithubOAuth = {
      viewModel.githubOAuthUrl()?.let { url -> openCustomTab(context, url) }
    },
    modifier = modifier,
  )
}

@Composable
internal fun MainScreen(
  state: MainScreenUiState,
  onApiBaseUrlChange: (String) -> Unit,
  onDashboardBaseUrlChange: (String) -> Unit,
  onCheckAll: () -> Unit,
  onCheckHealth: () -> Unit,
  onCheckReadiness: () -> Unit,
  onResetDefaults: () -> Unit,
  onOpenGithubOAuth: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier.verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Header()
    EnvironmentPanel(
      state = state,
      onApiBaseUrlChange = onApiBaseUrlChange,
      onDashboardBaseUrlChange = onDashboardBaseUrlChange,
      onResetDefaults = onResetDefaults,
    )
    ConnectionPanel(
      state = state,
      onCheckAll = onCheckAll,
      onCheckHealth = onCheckHealth,
      onCheckReadiness = onCheckReadiness,
    )
    ReadinessPanel(state = state)
    AuthPanel(state = state, onOpenGithubOAuth = onOpenGithubOAuth)
    SecurityBoundaryPanel()
  }
}

@Composable
private fun Header() {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(
      text = "AgentForge",
      style = MaterialTheme.typography.headlineMedium,
      fontWeight = FontWeight.SemiBold,
    )
    Text(
      text = "Native operations client for the deployed Merge Guard API.",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun EnvironmentPanel(
  state: MainScreenUiState,
  onApiBaseUrlChange: (String) -> Unit,
  onDashboardBaseUrlChange: (String) -> Unit,
  onResetDefaults: () -> Unit,
) {
  Panel(title = "Environment") {
    OutlinedTextField(
      value = state.apiBaseUrl,
      onValueChange = onApiBaseUrlChange,
      modifier = Modifier.fillMaxWidth(),
      label = { Text("API base URL") },
      singleLine = true,
      isError = state.apiUrlError != null,
      supportingText = { Text(state.apiUrlError ?: "Used for /health and /ready.") },
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
    )
    OutlinedTextField(
      value = state.dashboardBaseUrl,
      onValueChange = onDashboardBaseUrlChange,
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Dashboard base URL") },
      singleLine = true,
      isError = state.dashboardUrlError != null,
      supportingText = { Text(state.dashboardUrlError ?: "Used for backend-owned GitHub OAuth.") },
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
    )
    OutlinedButton(onClick = onResetDefaults) { Text("Reset deployed defaults") }
  }
}

@Composable
private fun ConnectionPanel(
  state: MainScreenUiState,
  onCheckAll: () -> Unit,
  onCheckHealth: () -> Unit,
  onCheckReadiness: () -> Unit,
) {
  Panel(title = "Connection") {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(onClick = onCheckAll, enabled = !state.isCheckingHealth && !state.isCheckingReadiness) {
        if (state.isCheckingHealth || state.isCheckingReadiness) {
          SmallProgress()
          Spacer(Modifier.width(8.dp))
        }
        Text("Check all")
      }
      OutlinedButton(onClick = onCheckHealth, enabled = !state.isCheckingHealth) { Text("Health") }
      OutlinedButton(onClick = onCheckReadiness, enabled = !state.isCheckingReadiness) { Text("Readiness") }
    }

    state.healthError?.let { ErrorText("Health check failed: $it") }
    state.readinessError?.let { ErrorText("Readiness check failed: $it") }

    state.health?.let {
      SnapshotRows(
        title = "Health",
        rows =
          listOf(
            "HTTP" to it.httpStatus.toString(),
            "Status" to it.status,
            "Database" to it.database,
            "Worker queue" to it.workerQueue,
            "Runtime store" to it.runtimeStore,
            "Unsigned webhooks" to it.unsignedWebhookMode,
            "Version" to it.version,
            "Checked" to it.checkedAt.toString(),
          ),
      )
    }
  }
}

@Composable
private fun ReadinessPanel(state: MainScreenUiState) {
  val readiness = state.readiness
  Panel(title = "Full-stack readiness") {
    if (readiness == null) {
      Text(
        text = "Run readiness to verify the deployed API, durable records, and queue-backed evaluations.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusChip("Ready", readiness.isReady)
        StatusChip("Postgres records", readiness.hasDurableRecords)
        StatusChip("Redis queue", readiness.hasQueueBackedEvaluations)
        StatusChip("Production ready", readiness.isProductionReady)
      }
      SnapshotRows(
        title = "Readiness",
        rows =
          listOf(
            "HTTP" to readiness.httpStatus.toString(),
            "Status" to readiness.status,
            "Database" to readiness.database,
            "Worker queue" to readiness.workerQueue,
            "Runtime store" to readiness.runtimeStore,
            "Queue status" to readiness.queueStatus,
            "Queue backend" to readiness.queueBackend,
            "Version" to readiness.version,
            "Checked" to readiness.checkedAt.toString(),
          ),
      )
    }
  }
}

@Composable
private fun AuthPanel(state: MainScreenUiState, onOpenGithubOAuth: () -> Unit) {
  Panel(title = "GitHub OAuth") {
    Text(
      text = "Sign-in opens the deployed dashboard OAuth route. GitHub code exchange, session signing, and authorization stay on AgentForge.",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Button(onClick = onOpenGithubOAuth, enabled = state.dashboardUrlError == null) { Text("Sign in with GitHub") }
    Text(
      text = state.endpoints?.githubOAuthUrl ?: "Enter a valid dashboard URL.",
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun SecurityBoundaryPanel() {
  Panel(title = "Security boundary") {
    Text(
      text = "The mobile client only calls public operator endpoints and dashboard OAuth. It never connects directly to Postgres, Redis, MinIO, GitHub private keys, webhook secrets, OAuth secrets, or installation tokens.",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun Panel(title: String, content: @Composable ColumnScope.() -> Unit) {
  Card(
    modifier = Modifier.fillMaxWidth(),
    shape = MaterialTheme.shapes.medium,
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
  ) {
    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(text = title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
      content()
    }
  }
}

@Composable
private fun SnapshotRows(title: String, rows: List<Pair<String, String>>) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    HorizontalDivider()
    Text(text = title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    rows.forEach { (label, value) ->
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(text = label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
          text = value.ifBlank { "unknown" },
          modifier = Modifier.padding(start = 12.dp),
          style = MaterialTheme.typography.bodySmall,
          fontWeight = FontWeight.Medium,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

@Composable
private fun StatusChip(label: String, active: Boolean) {
  AssistChip(
    onClick = {},
    label = { Text(if (active) "$label: yes" else "$label: no") },
  )
}

@Composable
private fun ErrorText(message: String) {
  Text(text = message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
}

@Composable
private fun SmallProgress() {
  CircularProgressIndicator(modifier = Modifier.height(16.dp).width(16.dp), strokeWidth = 2.dp)
}

private fun openCustomTab(context: Context, url: String) {
  val uri = Uri.parse(url)
  try {
    CustomTabsIntent.Builder().build().launchUrl(context, uri)
  } catch (_: ActivityNotFoundException) {
    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
  }
}

@Preview(showBackground = true, widthDp = 390)
@Composable
fun MainScreenPreview() {
  AgentForgeTheme {
    Surface {
      MainScreen(
        state =
          MainScreenUiState(
            health =
              HealthSnapshot(
                httpStatus = 200,
                status = "ok",
                database = "configured",
                workerQueue = "configured",
                runtimeStore = "postgres",
                unsignedWebhookMode = "disabled",
                version = "1.0.0",
                checkedAt = Instant.parse("2026-05-27T12:00:00Z"),
              ),
            readiness =
              ReadinessSnapshot(
                httpStatus = 200,
                status = "ready",
                database = "configured",
                workerQueue = "configured",
                runtimeStore = "postgres",
                queueStatus = "ready",
                queueBackend = "redis",
                version = "1.0.0",
                checkedAt = Instant.parse("2026-05-27T12:00:02Z"),
              ),
          ),
        onApiBaseUrlChange = {},
        onDashboardBaseUrlChange = {},
        onCheckAll = {},
        onCheckHealth = {},
        onCheckReadiness = {},
        onResetDefaults = {},
        onOpenGithubOAuth = {},
        modifier = Modifier.padding(16.dp),
      )
    }
  }
}
