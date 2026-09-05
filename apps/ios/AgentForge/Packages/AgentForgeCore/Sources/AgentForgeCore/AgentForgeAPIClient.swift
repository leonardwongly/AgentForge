import Foundation

public struct AgentForgeAPIClient: Sendable {
    private static let maxResponseBytes = 1_048_576
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchHealth(from url: URL) async throws -> HealthSnapshot {
        let response = try await fetchJSON(HealthResponse.self, from: url)
        return HealthSnapshot(response: response.value, httpStatus: response.httpStatus, checkedAt: .now)
    }

    public func fetchReadiness(from url: URL) async throws -> ReadinessSnapshot {
        let response = try await fetchJSON(ReadinessResponse.self, from: url)
        return ReadinessSnapshot(response: response.value, httpStatus: response.httpStatus, checkedAt: .now)
    }

    private func fetchJSON<Value: Decodable>(_ type: Value.Type, from url: URL) async throws -> HTTPDecodedResponse<Value> {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10

        let (bytes, response) = try await session.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        var data = Data()
        data.reserveCapacity(min(Self.maxResponseBytes, 64 * 1024))
        for try await byte in bytes {
            if data.count >= Self.maxResponseBytes {
                throw APIClientError.responseTooLarge
            }
            data.append(byte)
        }

        do {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .useDefaultKeys
            return HTTPDecodedResponse(value: try decoder.decode(type, from: data), httpStatus: httpResponse.statusCode)
        } catch {
            throw APIClientError.invalidJSON
        }
    }
}

struct HTTPDecodedResponse<Value> {
    let value: Value
    let httpStatus: Int
}

public enum APIClientError: LocalizedError {
    case invalidResponse
    case invalidJSON
    case responseTooLarge

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "AgentForge returned an invalid response."
        case .invalidJSON:
            "AgentForge returned invalid JSON."
        case .responseTooLarge:
            "AgentForge returned an unexpectedly large response."
        }
    }
}

struct HealthResponse: Decodable {
    let status: String
    // `/health` is intentionally a minimal public load-balancer contract.
    // Deployment details are only present on older/private responses, so do
    // not make those optional fields a reason to reject an otherwise healthy
    // process response.
    let database: String?
    let workerQueue: String?
    let runtimeStore: String?
    let unsignedWebhookMode: String?
    let version: String
}

struct ReadinessResponse: Decodable {
    let status: String
    let database: String
    let workerQueue: String
    let runtimeStore: String
    let queue: QueueResponse?
    let version: String
    /// Distinguishes the legacy response (where `queue` was omitted) from an
    /// explicitly null queue. The latter must not be treated as ready.
    let hasQueueField: Bool

    private enum CodingKeys: String, CodingKey {
        case status
        case database
        case workerQueue
        case runtimeStore
        case queue
        case version
    }

    init(
        status: String,
        database: String,
        workerQueue: String,
        runtimeStore: String,
        queue: QueueResponse?,
        version: String,
        hasQueueField: Bool? = nil
    ) {
        self.status = status
        self.database = database
        self.workerQueue = workerQueue
        self.runtimeStore = runtimeStore
        self.queue = queue
        self.version = version
        self.hasQueueField = hasQueueField ?? (queue != nil)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        database = try container.decode(String.self, forKey: .database)
        workerQueue = try container.decode(String.self, forKey: .workerQueue)
        runtimeStore = try container.decode(String.self, forKey: .runtimeStore)
        queue = try container.decodeIfPresent(QueueResponse.self, forKey: .queue)
        version = try container.decode(String.self, forKey: .version)
        hasQueueField = container.contains(.queue)
    }
}

struct QueueResponse: Decodable {
    let status: String?
    let backend: String?
}

public struct HealthSnapshot: Equatable {
    public let httpStatus: Int
    public let status: String
    public let database: String
    public let workerQueue: String
    public let runtimeStore: String
    public let unsignedWebhookMode: String
    public let version: String
    public let checkedAt: Date

    public var isProcessHealthy: Bool {
        (200..<300).contains(httpStatus) && status == "ok"
    }

    public init(
        httpStatus: Int,
        status: String,
        database: String,
        workerQueue: String,
        runtimeStore: String,
        unsignedWebhookMode: String,
        version: String,
        checkedAt: Date
    ) {
        self.httpStatus = httpStatus
        self.status = status
        self.database = database
        self.workerQueue = workerQueue
        self.runtimeStore = runtimeStore
        self.unsignedWebhookMode = unsignedWebhookMode
        self.version = version
        self.checkedAt = checkedAt
    }

    init(response: HealthResponse, httpStatus: Int, checkedAt: Date) {
        self.init(
            httpStatus: httpStatus,
            status: response.status,
            database: response.database ?? "",
            workerQueue: response.workerQueue ?? "",
            runtimeStore: response.runtimeStore ?? "",
            unsignedWebhookMode: response.unsignedWebhookMode ?? "",
            version: response.version,
            checkedAt: checkedAt
        )
    }
}

public struct ReadinessSnapshot: Equatable {
    public let httpStatus: Int
    public let status: String
    public let database: String
    public let workerQueue: String
    public let runtimeStore: String
    public let queueStatus: String
    public let queueBackend: String
    public let version: String
    public let checkedAt: Date
    // Internal compatibility marker: old deployments omitted `queue`, while
    // a present-but-null/malformed queue is not evidence of readiness.
    let hasExplicitQueue: Bool

    public var isReady: Bool {
        (200..<300).contains(httpStatus) && status == "ready"
    }

    public var hasDurableRecords: Bool {
        runtimeStore == "postgres" && database == "configured"
    }

    public var hasQueueBackedEvaluations: Bool {
        workerQueue == "configured" && queueStatus == "ready" &&
            (queueBackend == "redis" || (!hasExplicitQueue && queueBackend == "configured"))
    }

    public var isProductionReady: Bool {
        isReady && hasDurableRecords && hasQueueBackedEvaluations
    }

    public init(
        httpStatus: Int,
        status: String,
        database: String,
        workerQueue: String,
        runtimeStore: String,
        queueStatus: String,
        queueBackend: String,
        version: String,
        checkedAt: Date
    ) {
        self.httpStatus = httpStatus
        self.status = status
        self.database = database
        self.workerQueue = workerQueue
        self.runtimeStore = runtimeStore
        self.queueStatus = queueStatus
        self.queueBackend = queueBackend
        self.version = version
        self.checkedAt = checkedAt
        self.hasExplicitQueue = false
    }

    init(response: ReadinessResponse, httpStatus: Int, checkedAt: Date) {
        self.httpStatus = httpStatus
        self.status = response.status
        self.database = response.database
        self.workerQueue = response.workerQueue
        self.runtimeStore = response.runtimeStore
        self.queueStatus = response.queue?.status ?? (response.hasQueueField ? "" : (response.workerQueue == "configured" && response.status == "ready" ? "ready" : ""))
        self.queueBackend = response.queue?.backend ?? (response.hasQueueField ? "" : response.workerQueue)
        self.version = response.version
        self.checkedAt = checkedAt
        self.hasExplicitQueue = response.hasQueueField
    }
}
