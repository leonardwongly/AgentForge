import SwiftUI
import AgentForgeCore

struct OperatorConsoleView: View {
    @Bindable var store: AgentForgeStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    environmentPanel
                    connectionPanel
                    readinessPanel
                    oauthPanel
                    securityBoundaryPanel
                }
                .padding(20)
            }
            .background(backgroundGradient)
            .navigationTitle("AgentForge")
            .toolbarTitleDisplayMode(.inline)
            .task {
                if store.health == nil, store.readiness == nil {
                    await store.checkAll()
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Merge Guard", systemImage: "checkmark.shield")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("Native operator console")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
            Text("Connects to the deployed AgentForge API, verifies full-stack readiness, and hands GitHub OAuth to the deployed dashboard.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
    }

    private var environmentPanel: some View {
        GlassPanel(title: "Environment", systemImage: "network") {
            VStack(alignment: .leading, spacing: 14) {
                TextField("API base URL", text: $store.apiBaseURLText)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("api-base-url")
                helperText(store.apiURLError ?? "Used for /health and /ready.", isError: store.apiURLError != nil)

                TextField("Dashboard base URL", text: $store.dashboardBaseURLText)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("dashboard-base-url")
                helperText(store.dashboardURLError ?? "Used for backend-owned GitHub OAuth.", isError: store.dashboardURLError != nil)

                Button("Reset deployed defaults", systemImage: "arrow.counterclockwise") {
                    store.resetDefaults()
                }
                .buttonStyle(.glass)
                .accessibilityIdentifier("reset-defaults")
            }
        }
    }

    private var connectionPanel: some View {
        GlassPanel(title: "Connection", systemImage: "antenna.radiowaves.left.and.right") {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Button {
                        Task { await store.checkAll() }
                    } label: {
                        Label(store.isChecking ? "Checking" : "Check all", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(store.isChecking)
                    .accessibilityIdentifier("check-all")

                    Button("Health") {
                        Task { await store.checkHealth() }
                    }
                    .buttonStyle(.glass)
                    .disabled(store.isCheckingHealth)

                    Button("Readiness") {
                        Task { await store.checkReadiness() }
                    }
                    .buttonStyle(.glass)
                    .disabled(store.isCheckingReadiness)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if store.isChecking {
                    ProgressView("Contacting deployed AgentForge...")
                }
                errorText(store.healthError)
                errorText(store.readinessError)

                if let health = store.health {
                    SnapshotRows(
                        title: "Health",
                        rows: [
                            ("HTTP", "\(health.httpStatus)"),
                            ("Status", health.status),
                            ("Database", health.database),
                            ("Worker queue", health.workerQueue),
                            ("Runtime store", health.runtimeStore),
                            ("Unsigned webhooks", health.unsignedWebhookMode),
                            ("Version", health.version),
                            ("Checked", health.checkedAt.formatted(date: .abbreviated, time: .standard))
                        ]
                    )
                }
            }
        }
    }

    private var readinessPanel: some View {
        GlassPanel(title: "Full-stack readiness", systemImage: "server.rack") {
            if let readiness = store.readiness {
                VStack(alignment: .leading, spacing: 14) {
                    FlexibleStatusGrid {
                        StatusPill(title: "Ready", isActive: readiness.isReady)
                        StatusPill(title: "Postgres records", isActive: readiness.hasDurableRecords)
                        StatusPill(title: "Redis queue", isActive: readiness.hasQueueBackedEvaluations)
                        StatusPill(title: "Production ready", isActive: readiness.isProductionReady)
                    }

                    SnapshotRows(
                        title: "Readiness",
                        rows: [
                            ("HTTP", "\(readiness.httpStatus)"),
                            ("Status", readiness.status),
                            ("Database", readiness.database),
                            ("Worker queue", readiness.workerQueue),
                            ("Runtime store", readiness.runtimeStore),
                            ("Queue status", readiness.queueStatus),
                            ("Queue backend", readiness.queueBackend),
                            ("Version", readiness.version),
                            ("Checked", readiness.checkedAt.formatted(date: .abbreviated, time: .standard))
                        ]
                    )
                }
            } else {
                ContentUnavailableView(
                    "No readiness result",
                    systemImage: "server.rack",
                    description: Text("Run readiness to verify durable records and queue-backed evaluations.")
                )
            }
        }
    }

    private var oauthPanel: some View {
        GlassPanel(title: "GitHub OAuth", systemImage: "person.crop.circle.badge.checkmark") {
            VStack(alignment: .leading, spacing: 14) {
                Text("Sign-in opens the deployed dashboard OAuth route. GitHub code exchange, session signing, and authorization stay on AgentForge.")
                    .foregroundStyle(.secondary)

                Button {
                    guard let url = store.githubOAuthURL() else { return }
                    openURL(url)
                } label: {
                    Label("Sign in with GitHub", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(.glassProminent)
                .accessibilityIdentifier("github-oauth")

                Text(store.endpoints?.githubOAuthURL.absoluteString ?? "Enter a valid dashboard URL.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private var securityBoundaryPanel: some View {
        GlassPanel(title: "Security boundary", systemImage: "lock.shield") {
            Text("The iOS client only calls public operator endpoints and dashboard OAuth. It never connects directly to Postgres, Redis, MinIO, GitHub private keys, webhook secrets, OAuth secrets, or installation tokens.")
                .foregroundStyle(.secondary)
        }
    }

    private var backgroundGradient: some View {
        LinearGradient(
            colors: [
                Color(red: 0.07, green: 0.10, blue: 0.12),
                Color(red: 0.10, green: 0.17, blue: 0.14),
                Color(red: 0.16, green: 0.14, blue: 0.09)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }

    @ViewBuilder
    private func helperText(_ text: String, isError: Bool) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(isError ? .red : .secondary)
    }

    @ViewBuilder
    private func errorText(_ text: String?) -> some View {
        if let text {
            Text(text)
                .font(.callout)
                .foregroundStyle(.red)
        }
    }
}

private struct GlassPanel<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var content: Content

    var body: some View {
        GlassEffectContainer(spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                Label(title, systemImage: systemImage)
                    .font(.headline)
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .glassEffect(.regular.tint(.white.opacity(0.12)), in: .rect(cornerRadius: 24))
        }
    }
}

private struct FlexibleStatusGrid<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                content
            }
            VStack(alignment: .leading, spacing: 10) {
                content
            }
        }
    }
}

private struct StatusPill: View {
    let title: String
    let isActive: Bool

    var body: some View {
        Label("\(title): \(isActive ? "yes" : "no")", systemImage: isActive ? "checkmark.circle.fill" : "xmark.circle")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .foregroundStyle(isActive ? Color.green : Color.orange)
            .glassEffect(.regular.tint(isActive ? .green.opacity(0.16) : .orange.opacity(0.16)).interactive(), in: .capsule)
            .accessibilityIdentifier(title.lowercased().replacingOccurrences(of: " ", with: "-"))
    }
}

private struct SnapshotRows: View {
    let title: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            ForEach(rows, id: \.0) { label, value in
                HStack(alignment: .top) {
                    Text(label)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 16)
                    Text(value.isEmpty ? "unknown" : value)
                        .fontWeight(.medium)
                        .multilineTextAlignment(.trailing)
                        .textSelection(.enabled)
                }
                .font(.subheadline)
            }
        }
    }
}

#Preview {
    OperatorConsoleView(store: PreviewData.readyStore)
}
