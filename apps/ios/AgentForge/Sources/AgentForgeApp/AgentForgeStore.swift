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

    init(client: AgentForgeAPIClient = AgentForgeAPIClient()) {
        self.client = client
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
        apiBaseURLText = value
        apiURLError = nil
    }

    func updateDashboardBaseURL(_ value: String) {
        dashboardBaseURLText = value
        dashboardURLError = nil
    }

    func resetDefaults() {
        apiBaseURLText = defaultAPIBaseURL
        dashboardBaseURLText = defaultDashboardBaseURL
        apiURLError = nil
        dashboardURLError = nil
    }

    func checkAll() async {
        await checkHealth()
        await checkReadiness()
    }

    func checkHealth() async {
        guard let apiBaseURL = normalizeAPIBaseURL() else {
            return
        }

        isCheckingHealth = true
        healthError = nil
        defer { isCheckingHealth = false }

        do {
            health = try await client.fetchHealth(from: apiBaseURL.appending(path: "health"))
        } catch is CancellationError {
            return
        } catch {
            healthError = error.localizedDescription
        }
    }

    func checkReadiness() async {
        guard let apiBaseURL = normalizeAPIBaseURL() else {
            return
        }

        isCheckingReadiness = true
        readinessError = nil
        defer { isCheckingReadiness = false }

        do {
            readiness = try await client.fetchReadiness(from: apiBaseURL.appending(path: "ready"))
        } catch is CancellationError {
            return
        } catch {
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
            return url
        } catch {
            dashboardURLError = error.localizedDescription
            return nil
        }
    }
}
