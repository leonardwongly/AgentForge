import XCTest
@testable import AgentForgeCore

final class OperatorSettingsStoreTests: XCTestCase {
    func testUserDefaultsStoreRoundTripsBothURLs() {
        let suiteName = "agentforge.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = UserDefaultsOperatorSettingsStore(defaults: defaults)
        XCTAssertNil(store.loadAPIBaseURL())
        XCTAssertNil(store.loadDashboardBaseURL())

        store.saveAPIBaseURL("https://api.example.com")
        store.saveDashboardBaseURL("https://dash.example.com")

        // A fresh store over the same defaults simulates a relaunch.
        let reopened = UserDefaultsOperatorSettingsStore(defaults: defaults)
        XCTAssertEqual(reopened.loadAPIBaseURL(), "https://api.example.com")
        XCTAssertEqual(reopened.loadDashboardBaseURL(), "https://dash.example.com")
    }

    func testUserDefaultsStoreTreatsBlankAsAbsent() {
        let suiteName = "agentforge.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = UserDefaultsOperatorSettingsStore(defaults: defaults)
        store.saveAPIBaseURL("   ")
        XCTAssertNil(store.loadAPIBaseURL())
    }

    func testInMemoryStoreSeedsAndOverwrites() {
        let store = InMemoryOperatorSettingsStore(
            apiBaseURL: "https://seed-api.example.com",
            dashboardBaseURL: "https://seed-dash.example.com"
        )
        XCTAssertEqual(store.loadAPIBaseURL(), "https://seed-api.example.com")

        store.saveAPIBaseURL("https://new-api.example.com")
        XCTAssertEqual(store.loadAPIBaseURL(), "https://new-api.example.com")
    }
}
