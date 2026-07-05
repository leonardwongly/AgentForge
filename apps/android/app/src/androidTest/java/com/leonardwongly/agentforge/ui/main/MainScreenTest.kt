package com.leonardwongly.agentforge.ui.main

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.leonardwongly.agentforge.data.HealthSnapshot
import com.leonardwongly.agentforge.data.ReadinessSnapshot
import java.time.Instant
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class MainScreenTest {
  @get:Rule val composeTestRule = createAndroidComposeRule<ComponentActivity>()

  @Before
  fun setup() {
    composeTestRule.setContent {
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
                checkedAt = Instant.EPOCH,
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
                checkedAt = Instant.EPOCH,
              ),
          ),
        onApiBaseUrlChange = {},
        onDashboardBaseUrlChange = {},
        onCheckAll = {},
        onCheckHealth = {},
        onCheckReadiness = {},
        onResetDefaults = {},
        onOpenGithubOAuth = {},
      )
    }
  }

  @Test
  fun rendersOperatorPanels() {
    composeTestRule.onNodeWithText("AgentForge").assertExists()
    composeTestRule.onNodeWithText("Full-stack readiness").assertExists()
    composeTestRule.onNodeWithText("Sign in with GitHub").assertExists()
    composeTestRule.onNodeWithText("Production ready: yes").assertExists()
  }
}
