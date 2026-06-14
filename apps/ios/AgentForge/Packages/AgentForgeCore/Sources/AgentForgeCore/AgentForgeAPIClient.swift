import Foundation

public struct AgentForgeAPIClient: Sendable {
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

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
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

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "AgentForge returned an invalid response."
        case .invalidJSON:
            "AgentForge returned invalid JSON."
        }
    }
}

struct HealthResponse: Decodable {
    let status: String
    let database: String
    let workerQueue: String
    let runtimeStore: String
    let unsignedWebhookMode: String
    let version: String
}

struct ReadinessResponse: Decodable {
    let status: String
    let database: String
    let workerQueue: String
    let runtimeStore: String
    let queue: QueueResponse?
    let version: String
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
            database: response.database,
            workerQueue: response.workerQueue,
            runtimeStore: response.runtimeStore,
            unsignedWebhookMode: response.unsignedWebhookMode,
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

    public var isReady: Bool {
        (200..<300).contains(httpStatus) && status == "ready"
    }

    public var hasDurableRecords: Bool {
        runtimeStore == "postgres" && database == "configured"
    }

    public var hasQueueBackedEvaluations: Bool {
        workerQueue == "configured" && queueStatus == "ready"
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
    }

    init(response: ReadinessResponse, httpStatus: Int, checkedAt: Date) {
        self.init(
            httpStatus: httpStatus,
            status: response.status,
            database: response.database,
            workerQueue: response.workerQueue,
            runtimeStore: response.runtimeStore,
            queueStatus: response.queue?.status ?? (response.workerQueue == "configured" && response.status == "ready" ? "ready" : ""),
            queueBackend: response.queue?.backend ?? response.workerQueue,
            version: response.version,
            checkedAt: checkedAt
        )
    }
}
