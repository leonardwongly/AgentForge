import Foundation
import XCTest
@testable import AgentForgeCore

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class APIClientNetworkTests: XCTestCase {
    func testFetchHealthAcceptsMinimalPublicPayloadOverHTTP() async throws {
        StubURLProtocol.body = #"{"status":"ok","version":"1.1.0"}"#.data(using: .utf8)!
        StubURLProtocol.statusCode = 200
        let client = makeClient()

        let snapshot = try await client.fetchHealth(from: URL(string: "https://agentforge.test/health")!)

        XCTAssertTrue(snapshot.isProcessHealthy)
        XCTAssertEqual(snapshot.version, "1.1.0")
        XCTAssertEqual(snapshot.database, "")
    }

    func testFetchHealthRejectsOversizedPayloadBeforeDecoding() async {
        StubURLProtocol.body = Data(repeating: 0x7B, count: 1_048_577)
        StubURLProtocol.statusCode = 200
        let client = makeClient()

        do {
            _ = try await client.fetchHealth(from: URL(string: "https://agentforge.test/health")!)
            XCTFail("An oversized response must be rejected")
        } catch let error as APIClientError {
            if case .responseTooLarge = error {
                // Expected.
            } else {
                XCTFail("Expected responseTooLarge, got \(error)")
            }
        } catch {
            XCTFail("Expected APIClientError.responseTooLarge, got \(error)")
        }
    }

    private func makeClient() -> AgentForgeAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return AgentForgeAPIClient(session: URLSession(configuration: configuration))
    }
}

private final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var statusCode = 200

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: Self.statusCode,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              )
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
