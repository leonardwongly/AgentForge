import XCTest
@testable import AgentForgeCore

final class ReadinessSnapshotTests: XCTestCase {
    func testNestedQueuePayloadIsProductionReady() {
        let snapshot = ReadinessSnapshot(
            response: ReadinessResponse(
                status: "ready",
                database: "configured",
                workerQueue: "configured",
                runtimeStore: "postgres",
                queue: QueueResponse(status: "ready", backend: "redis"),
                version: "1.0.0"
            ),
            httpStatus: 200,
            checkedAt: Date(timeIntervalSince1970: 0)
        )

        XCTAssertTrue(snapshot.isReady)
        XCTAssertTrue(snapshot.hasDurableRecords)
        XCTAssertTrue(snapshot.hasQueueBackedEvaluations)
        XCTAssertTrue(snapshot.isProductionReady)
        XCTAssertEqual(snapshot.queueBackend, "redis")
    }

    func testCurrentDeploymentPayloadWithoutNestedQueueIsProductionReady() {
        let snapshot = ReadinessSnapshot(
            response: ReadinessResponse(
                status: "ready",
                database: "configured",
                workerQueue: "configured",
                runtimeStore: "postgres",
                queue: nil,
                version: "0.1.0"
            ),
            httpStatus: 200,
            checkedAt: Date(timeIntervalSince1970: 0)
        )

        XCTAssertEqual(snapshot.queueStatus, "ready")
        XCTAssertEqual(snapshot.queueBackend, "configured")
        XCTAssertTrue(snapshot.isProductionReady)
    }

    func testInMemoryQueueIsNotProductionReady() {
        let snapshot = ReadinessSnapshot(
            response: ReadinessResponse(
                status: "ready",
                database: "configured",
                workerQueue: "in_memory",
                runtimeStore: "postgres",
                queue: QueueResponse(status: "ready", backend: "in_memory"),
                version: "1.0.0"
            ),
            httpStatus: 200,
            checkedAt: Date(timeIntervalSince1970: 0)
        )

        XCTAssertFalse(snapshot.hasQueueBackedEvaluations)
        XCTAssertFalse(snapshot.isProductionReady)
    }
}
