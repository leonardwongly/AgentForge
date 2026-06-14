import SwiftUI

@main
struct AgentForgeApp: App {
    @State private var store = AgentForgeStore()

    var body: some Scene {
        WindowGroup {
            OperatorConsoleView(store: store)
        }
    }
}
