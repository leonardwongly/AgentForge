import Foundation
import AgentForgeCore
import Observation

@MainActor
@Observable
final class AgentForgeStore {
    var apiBaseURLText = defaultAPIBaseURL
    var dashboardBaseURLText = defaultDashboardBaseURL
    var apiURLError: String?
    var dashboardURLError: String?
    var health: HealthSnapshot?
    var readiness: ReadinessSnapshot?
    var healthError: String?
    var readinessError: String?
    var isCheckingHealth = false
    var isCheckingReadiness = false

    private let client: AgentForgeAPIClient
    private let settings: OperatorSettingsStore
    // Requests are intentionally allowed to overlap, but only the newest
    // request for each panel may publish its result. This prevents a slow
    // response for an old endpoint from replacing a newer check's state.
    private var healthRequestGeneration = 0
    private var readinessRequestGeneration = 0

    init(
        client: AgentForgeAPIClient = AgentForgeAPIClient(),
        settings: OperatorSettingsStore = UserDefaultsOperatorSettingsStore()
    ) {
        self.client = client
        self.settings = settings
        self.apiBaseURLText = settings.loadAPIBaseURL() ?? defaultAPIBaseURL
        self.dashboardBaseURLText = settings.loadDashboardBaseURL() ?? defaultDashboardBaseURL
    }

    var endpoints: AgentForgeEndpoints? {
        guard let apiBaseURL = try? EndpointValidator.normalizedBaseURL(from: apiBaseURLText),
              let dashboardBaseURL = try? EndpointValidator.normalizedBaseURL(from: dashboardBaseURLText)
        else {
            return nil
        }

        return AgentForgeEndpoints(apiBaseURL: apiBaseURL, dashboardBaseURL: dashboardBaseURL)
    }

    var isChecking: Bool {
        isCheckingHealth || isCheckingReadiness
    }

    func updateAPIBaseURL(_ value: String) {
        healthRequestGeneration += 1
        readinessRequestGeneration += 1
        apiBaseURLText = value
        apiURLError = nil
    }

    func updateDashboardBaseURL(_ value: String) {
        dashboardBaseURLText = value
        dashboardURLError = nil
    }

    func resetDefaults() {
        healthRequestGeneration += 1
        readinessRequestGeneration += 1
        apiBaseURLText = defaultAPIBaseURL
        dashboardBaseURLText = defaultDashboardBaseURL
        apiURLError = nil
        dashboardURLError = nil
        settings.saveAPIBaseURL(defaultAPIBaseURL)
        settings.saveDashboardBaseURL(defaultDashboardBaseURL)
    }

    func checkAll() async {
        await checkHealth()
        await checkReadiness()
    }

    func checkHealth() async {
        healthRequestGeneration += 1
        let requestGeneration = healthRequestGeneration
        guard let apiBaseURL = normalizeAPIBaseURL() else {
            return
        }

        isCheckingHealth = true
        healthError = nil
        defer {
            if requestGeneration == healthRequestGeneration {
                isCheckingHealth = false
            }
        }

        do {
            let snapshot = try await client.fetchHealth(from: apiBaseURL.appending(path: "health"))
            guard requestGeneration == healthRequestGeneration else { return }
            health = snapshot
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == healthRequestGeneration else { return }
            healthError = error.localizedDescription
        }
    }

    func checkReadiness() async {
        readinessRequestGeneration += 1
        let requestGeneration = readinessRequestGeneration
        guard let apiBaseURL = normalizeAPIBaseURL() else {
            return
        }

        isCheckingReadiness = true
        readinessError = nil
        defer {
            if requestGeneration == readinessRequestGeneration {
                isCheckingReadiness = false
            }
        }

        do {
            let snapshot = try await client.fetchReadiness(from: apiBaseURL.appending(path: "ready"))
            guard requestGeneration == readinessRequestGeneration else { return }
            readiness = snapshot
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == readinessRequestGeneration else { return }
            readinessError = error.localizedDescription
        }
    }

    func githubOAuthURL() -> URL? {
        guard let dashboardBaseURL = normalizeDashboardBaseURL() else {
            return nil
        }
        return dashboardBaseURL.appending(path: "auth/github/login")
    }

    @discardableResult
    private func normalizeAPIBaseURL() -> URL? {
        do {
            let url = try EndpointValidator.normalizedBaseURL(from: apiBaseURLText)
            apiBaseURLText = url.absoluteString
            apiURLError = nil
            settings.saveAPIBaseURL(url.absoluteString)
            return url
        } catch {
            apiURLError = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    private func normalizeDashboardBaseURL() -> URL? {
        do {
            let url = try EndpointValidator.normalizedBaseURL(from: dashboardBaseURLText)
            dashboardBaseURLText = url.absoluteString
            dashboardURLError = nil
            settings.saveDashboardBaseURL(url.absoluteString)
            return url
        } catch {
            dashboardURLError = error.localizedDescription
            return nil
        }
    }
}
