import XCTest
@testable import AgentForgeCore

final class EndpointValidatorTests: XCTestCase {
    func testNormalizeAddsHTTPSAndTrimsTrailingSlash() throws {
        let url = try EndpointValidator.normalizedBaseURL(from: " agentforge-api.example.com/ ")

        XCTAssertEqual(url.absoluteString, "https://agentforge-api.example.com")
    }

    func testNormalizeAllowsLocalHTTPForDevelopment() throws {
        let url = try EndpointValidator.normalizedBaseURL(from: "http://localhost:4000/")

        XCTAssertEqual(url.absoluteString, "http://localhost:4000")
    }

    func testNormalizeRejectsDeployedHTTP() {
        XCTAssertThrowsError(try EndpointValidator.normalizedBaseURL(from: "http://agentforge.example.com")) { error in
            XCTAssertEqual(error as? EndpointValidationError, .insecureDeployedURL)
        }
    }
}
