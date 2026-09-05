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

    func testNormalizeAllowsIPv6LoopbackForLocalDevelopment() throws {
        let url = try EndpointValidator.normalizedBaseURL(from: "http://[::1]:4000/")

        XCTAssertEqual(url.absoluteString, "http://[::1]:4000")
    }

    func testNormalizeRejectsCredentialsAndRoutingDecorations() {
        let inputs = [
            "https://operator:secret@agentforge.example.com",
            "https://agentforge.example.com?redirect=https://evil.example",
            "https://agentforge.example.com/#oauth"
        ]

        for input in inputs {
            XCTAssertThrowsError(try EndpointValidator.normalizedBaseURL(from: input), input)
        }
    }

    func testNormalizeDoesNotStripLeadingSlashesFromMalformedInput() {
        XCTAssertThrowsError(try EndpointValidator.normalizedBaseURL(from: "/https://agentforge.example.com"))
    }
}
