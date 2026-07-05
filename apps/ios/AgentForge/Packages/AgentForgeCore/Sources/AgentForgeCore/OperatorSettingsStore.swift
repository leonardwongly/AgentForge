import Foundation

/// Persists the operator's configured API and dashboard base URLs across app
/// launches. Kept in AgentForgeCore (not the app target) so the persistence
/// contract is unit-testable without a booted simulator.
///
/// Only the two non-secret base URLs are persisted. No tokens, secrets, or
/// session material are ever stored on device — that stays behind the deployed
/// dashboard/API, consistent with the client's security boundary.
public protocol OperatorSettingsStore: Sendable {
    func loadAPIBaseURL() -> String?
    func loadDashboardBaseURL() -> String?
    func saveAPIBaseURL(_ value: String)
    func saveDashboardBaseURL(_ value: String)
}

/// `UserDefaults`-backed persistence used by the shipping app.
public struct UserDefaultsOperatorSettingsStore: OperatorSettingsStore {
    // UserDefaults is documented as thread-safe but is not marked Sendable;
    // exclude it from Sendable checking rather than weakening the whole type.
    nonisolated(unsafe) private let defaults: UserDefaults

    private enum Key {
        static let apiBaseURL = "agentforge.apiBaseURL"
        static let dashboardBaseURL = "agentforge.dashboardBaseURL"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func loadAPIBaseURL() -> String? {
        normalizedNonEmpty(defaults.string(forKey: Key.apiBaseURL))
    }

    public func loadDashboardBaseURL() -> String? {
        normalizedNonEmpty(defaults.string(forKey: Key.dashboardBaseURL))
    }

    public func saveAPIBaseURL(_ value: String) {
        defaults.set(value, forKey: Key.apiBaseURL)
    }

    public func saveDashboardBaseURL(_ value: String) {
        defaults.set(value, forKey: Key.dashboardBaseURL)
    }

    private func normalizedNonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }
}

/// In-memory store for tests and SwiftUI previews.
public final class InMemoryOperatorSettingsStore: OperatorSettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var apiBaseURL: String?
    private var dashboardBaseURL: String?

    public init(apiBaseURL: String? = nil, dashboardBaseURL: String? = nil) {
        self.apiBaseURL = apiBaseURL
        self.dashboardBaseURL = dashboardBaseURL
    }

    public func loadAPIBaseURL() -> String? {
        lock.withLock { apiBaseURL }
    }

    public func loadDashboardBaseURL() -> String? {
        lock.withLock { dashboardBaseURL }
    }

    public func saveAPIBaseURL(_ value: String) {
        lock.withLock { apiBaseURL = value }
    }

    public func saveDashboardBaseURL(_ value: String) {
        lock.withLock { dashboardBaseURL = value }
    }
}
