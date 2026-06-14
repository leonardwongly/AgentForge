import Foundation
import AgentForgeCore

@MainActor
enum PreviewData {
    static var readyStore: AgentForgeStore {
        let store = AgentForgeStore()
        store.health = HealthSnapshot(
            httpStatus: 200,
            status: "ok",
            database: "configured",
            workerQueue: "configured",
            runtimeStore: "postgres",
            unsignedWebhookMode: "disabled",
            version: "0.1.0",
            checkedAt: .now
        )
        store.readiness = ReadinessSnapshot(
            httpStatus: 200,
            status: "ready",
            database: "configured",
            workerQueue: "configured",
            runtimeStore: "postgres",
            queueStatus: "ready",
            queueBackend: "redis",
            version: "0.1.0",
            checkedAt: .now
        )
        return store
    }
}
