import Foundation

public let defaultAPIBaseURL = "https://agentforge-api-production-5fc1.up.railway.app"
public let defaultDashboardBaseURL = "https://agentforge-web-production.up.railway.app"

public struct AgentForgeEndpoints: Equatable {
    public let apiBaseURL: URL
    public let dashboardBaseURL: URL

    public init(apiBaseURL: URL, dashboardBaseURL: URL) {
        self.apiBaseURL = apiBaseURL
        self.dashboardBaseURL = dashboardBaseURL
    }

    public var healthURL: URL {
        apiBaseURL.appending(path: "health")
    }

    public var readinessURL: URL {
        apiBaseURL.appending(path: "ready")
    }

    public var githubOAuthURL: URL {
        dashboardBaseURL.appending(path: "auth/github/login")
    }
}

public enum EndpointValidationError: LocalizedError, Equatable {
    case missing
    case malformed
    case insecureDeployedURL

    public var errorDescription: String? {
        switch self {
        case .missing:
            "URL is required."
        case .malformed:
            "URL must include an HTTP or HTTPS host."
        case .insecureDeployedURL:
            "Use HTTPS for deployed AgentForge URLs."
        }
    }
}

public enum EndpointValidator {
    public static func normalizedBaseURL(from input: String) throws -> URL {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard !trimmed.isEmpty else {
            throw EndpointValidationError.missing
        }

        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              ["https", "http"].contains(scheme)
        else {
            throw EndpointValidationError.malformed
        }

        if scheme == "http", !isLocalDevelopmentHost(host) {
            throw EndpointValidationError.insecureDeployedURL
        }

        guard let url = components.url else {
            throw EndpointValidationError.malformed
        }
        return url
    }

    private static func isLocalDevelopmentHost(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local")
    }
}
