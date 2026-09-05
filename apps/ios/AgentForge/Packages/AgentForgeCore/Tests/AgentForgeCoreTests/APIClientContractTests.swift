import XCTest
@testable import AgentForgeCore

final class APIClientContractTests: XCTestCase {
    func testMinimalPublicHealthPayloadRemainsUsable() throws {
        let data = #"{"status":"ok","version":"1.1.0"}"#.data(using: .utf8)!
        let response = try JSONDecoder().decode(HealthResponse.self, from: data)
        let snapshot = HealthSnapshot(
            response: response,
            httpStatus: 200,
            checkedAt: Date(timeIntervalSince1970: 0)
        )

        XCTAssertTrue(snapshot.isProcessHealthy)
        XCTAssertEqual(snapshot.status, "ok")
        XCTAssertEqual(snapshot.version, "1.1.0")
        XCTAssertEqual(snapshot.database, "")
        XCTAssertEqual(snapshot.workerQueue, "")
        XCTAssertEqual(snapshot.runtimeStore, "")
        XCTAssertEqual(snapshot.unsignedWebhookMode, "")
    }

    func testHealthPayloadWithWrongTypeForOptionalDetailIsStillRejected() {
        let data = #"{"status":"ok","database":false,"version":"1.1.0"}"#.data(using: .utf8)!

        XCTAssertThrowsError(try JSONDecoder().decode(HealthResponse.self, from: data))
    }
}
