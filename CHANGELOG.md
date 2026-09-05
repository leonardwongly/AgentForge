# Changelog

All notable changes to AgentForge Merge Guard and the Loom implementation and
specification are tracked here.

## [Unreleased]

Changes after v1.2.0 will be recorded here.

## [1.2.0] - 2026-09-05

### Added

- Established the authoritative Loom VCS specification covering the native
  object and history model, working copies, merge/reapply semantics, identity
  and capability Grants, governed admission, provenance, storage and recovery,
  synchronization, Git interoperability, security, and conformance gates.
- Added `pnpm doctor`, a single command that validates the full local stack
  (Node, pnpm, git, Docker, Postgres, Redis, MinIO) and reports a readiness
  score.
- Added `pnpm setup`, a guided one-command setup that creates `.env`, starts the
  Compose backing services, waits for readiness, and runs Prisma validate,
  migrate, and seed — non-destructively.
- Added per-detector precision reporting to the policy-insights report
  (`computeDetectorMetrics`), surfaced in the API and the dashboard Policy
  Insights page as an override-based precision proxy per detector.
- Added a tamper-evident audit trail (`chainAuditEvents`, `verifyAuditChain`,
  `auditChainDigest`) that binds each audit event to the previous event's hash
  and detects insertion, deletion, reordering, and modification.
- Added a composite governance health score (`computeGovernanceHealth`) to the
  policy-insights report, surfaced as a metric card on the dashboard.
- Added `pnpm design-partner:report`, which turns a CCR export into an automated
  validation evidence report (override/evidence/reviewer metrics, per-detector
  precision, governance health, and human-gated proposals).
- Added the `@agentforge/notifications` package with best-effort outbound
  webhook delivery (`deliverWebhook`), governance notification payloads
  (`buildNotificationPayload`), and SIEM-style tamper-evident audit streaming
  (`streamAuditEvents`).
- Wired a blocked-PR notification into the worker (gated by
  `NOTIFICATION_WEBHOOK_URL`) and added `POST /api/admin/audit-stream` for
  streaming chained audit events (gated by `AUDIT_STREAM_WEBHOOK_URL`).
- Made the sample-preview onboarding action available in deployed instances
  behind the explicit `AGENTFORGE_ENABLE_SAMPLE_PREVIEW` flag (the fixture-root
  requirement is now optional).
- Added Cloudflare deployment support: a Cloudflare Tunnel config and compose
  file (`deploy/cloudflare/tunnel`), an optional Cloudflare Pages `wrangler.toml`
  (`deploy/cloudflare/pages`), and `docs/cloudflare-deployment.md`.
- Added `pnpm benchmark`, a reproducible performance baseline for the
  deterministic evaluation pipeline (latency p50/p95/p99 and throughput) with
  dataset and hardware disclosure.
- Added enterprise deployment packaging: a multi-stage root `Dockerfile`
  (api/worker/web targets), a Helm chart under `deploy/helm/agentforge`, and an
  AWS ECS + RDS + ElastiCache Terraform module under `deploy/terraform/aws`.
- Clarified the README product-vs-research positioning: Merge Guard is the
  shipped product; Loom is a pre-1.0 research program.

### Changed

- Reframed the existing Loom design and validation documents around Loom as a
  native VCS destination, with Git as a migration/interoperability bridge rather
  than the permanent product substrate.
- Marked the former Merge Guard V2 roadmap as a legacy product plan so it does
  not conflict with the authoritative Loom roadmap.

## [1.1.0] - 2026-07-05

### Added

- Completed the Android and iOS operator consoles: persistent API/dashboard URL configuration, unit tests for the settings/orchestration layer, an automatic health/readiness check on launch, and a `mobile` CI workflow that builds and tests both apps.

### Fixed

- Fixed the web production build failing when a development `NODE_ENV` leaked in from `.env`: `next build` and `next start` now pin `NODE_ENV=production`, and `.env.example` no longer hardcodes `NODE_ENV=development`.

### Changed

- Migrated the Next.js `middleware` file convention to `proxy` (Next 16), preserving the nonce-based CSP behavior, and upgraded Next to `16.2.10`.
- Removed the deprecated `pnpm` field from `package.json`; workspace build settings are read from `pnpm-workspace.yaml`.
- Standardized the mobile application identifier and aligned all workspace package versions and the API version output to `1.1.0`.

### Security

- Enforced a mandatory signature nonce for trusted-proxy identity headers on both the API and dashboard; the legacy nonce-less payload shape is no longer accepted, closing a replay window where a nonce-less signed request could bypass the replay cache indefinitely inside the 5-minute timestamp window.
- Fixed a related self-replay-rejection bug where the same nonce-signed request could be rejected with 401 by its own route handler after the request's `onRequest` hook had already resolved and consumed the nonce; actor resolution is now idempotent per request.
- Enforced header-stripping attestation at request time: when `AGENTFORGE_API_TRUST_PROXY_HEADERS` is on, the API now rejects any request that also carries a raw `x-agentforge-actor`/`role`/`organization` header alongside or instead of the signed header set, instead of relying solely on the config-load-time `AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS` attestation.
- Rejected weak production secrets: `SESSION_SECRET`, `GITHUB_WEBHOOK_SECRET`, `AGENTFORGE_API_PROXY_SECRET`, and `AGENTFORGE_DASHBOARD_PROXY_SECRET` now require a 32-character minimum and are checked against a common-placeholder denylist in production.
- Hardened Postgres Row-Level Security and tenant isolation: RLS on direct-org tables is now bound inside the same interactive transaction that sets the `agentforge.current_org` session GUC, closing a gap where the GUC could be set on a different pooled connection than the query it was meant to scope. Added FK constraints on `WebhookDelivery`/`ExportJob` and `onDelete: Restrict` on `AuditEvent`/`ChangeControlRecord`. See [docs/tenant-isolation-rls.md](docs/tenant-isolation-rls.md).
- Bounded the dashboard's signature-replay cache memory with throttled, capped eviction sweeps, mirroring the equivalent API-side fix.

### Reliability

- Made retention-sweep deletes and the `retention_swept` audit-event write atomic by moving both into a single interactive transaction; a crash between the two no longer leaves an undocumented deletion with no audit trail.
- Migrated repeatable retention-sweep job registration to BullMQ's `upsertJobScheduler` for idempotent create-or-update behavior across worker restarts.
- Guarded worker evaluations against superseded `pull_request:synchronize` webhooks racing on the same PR; a freshness check against GitHub's live head SHA now prevents an older evaluation's check-run publish from overwriting a newer result.
- Honored GitHub's `retry-after`/`x-ratelimit-reset` value when backing off retries instead of always following a fixed exponential curve.
- Fixed detector false positives: `coverage_threshold_reduced` now pairs same-key before/after values instead of cross-matching any removed/added numeric pair; `test_skipped` is now line-scoped with a comment-position guard instead of matching a raw substring anywhere in the diff.
- Fixed rule-level `action:block` and `action:require_review` being silently downgraded to non-blocking `warn` in built-in policy packs when the org default mode was `warn`; affected rules across `startup-default`, `platform-engineering`, `fintech`, and `healthcare-regulated` now correctly escalate to `enforce`.

### Testing/CI

- Pinned CI service container images (Postgres) and third-party actions by digest.
- Added regression coverage for the nonce-replay and self-replay-rejection fixes, the atomic retention-sweep transaction, and concurrent check-run publish claim/lease behavior.

### Documentation

- Added [docs/tenant-isolation-rls.md](docs/tenant-isolation-rls.md) describing the application-layer and Postgres RLS tenant isolation model.
- Added [docs/self-hosting.md](docs/self-hosting.md) as the hardened self-hosting reference and production security contract.
- Added [docs/self-governance.md](docs/self-governance.md) describing how AgentForge governs its own repository with the Merge Guard check.
- Added [docs/roadmap-v2.md](docs/roadmap-v2.md) for V2+ planning.

## [1.0.0] - 2026-05-26

### Added

- Fastify API for GitHub webhooks, dashboard APIs, queue administration, policy previews, evidence updates, overrides, exports, health, readiness, metrics, and audit access.
- Next.js dashboard for onboarding, repository settings, policy setup, policy previews, records, evidence queues, overrides, exports, GitHub installation review, and operational settings.
- BullMQ worker for asynchronous pull request evaluations, deterministic policy checks, GitHub check publication, bounded retries, and durable failure summaries.
- Prisma/PostgreSQL persistence for repository settings, policy versions, webhook deliveries, evaluations, Change Control Records, audit events, export jobs, GitHub installations, and queue operations.
- Redis-backed queue processing with in-memory development fallback, readiness checks, queue inspection, and platform-admin replay controls.
- Built-in policy packs, YAML validation, policy preview tooling, CODEOWNERS/team routing, evidence requirements, and reviewer requirement tracking.
- GitHub App installation linking with pending approval, platform-admin approval, repository synchronization, and archive/disable handling for removed repositories.
- GitHub OAuth dashboard sessions and trusted-proxy identity support for self-hosted deployments.
- Production fail-closed configuration for signed webhooks, auth proxy trust, local actor fallback, source storage, secret redaction, and session/OAuth settings.
- Public OSS support files: Apache-2.0 license, notice, README, security policy, contribution guide, code of conduct, issue templates, pull request template, CodeQL, dependency review, Dependabot, CI, E2E, and security workflows.
- Release-readiness validation script covering v1 metadata, public release files, tracked local artifacts, common secret patterns, workflow coverage, and production auth documentation.

### Changed

- Split API route registration into named route plugins to reduce the main app surface and make route ownership easier to review.
- Restricted global queue inspection and replay to `platform_admin` because queue status is platform-wide rather than tenant-scoped.
- Standardized authorization failure handling with structured logs and request-correlated safe error responses.
- Hardened webhook replay bookkeeping so replay enqueue success and failure mirror normal webhook delivery state transitions.
- Rejected malformed policy preview requests before repository lookup to avoid internal validation errors.
- Aligned monorepo package metadata and API health/readiness version output with `1.0.0`.

### Security

- Signed GitHub webhook verification is required in production.
- Raw local actor headers are rejected in production.
- Trusted proxy identity requires explicit proxy trust and shared API proxy signing secret.
- Built-in GitHub OAuth requires explicit allowlists and signed dashboard sessions.
- Source-code storage remains disabled by default and secret redaction remains enabled by default.
- Exports, check output, dashboard views, and prompts are designed to avoid raw source and secret leakage under the default storage policy.

### Validation

- Local validation before this release candidate included formatting, linting, unit tests, API integration tests, browser E2E tests, typecheck, build, and diff whitespace checks.
- Post-merge `main` validation passed CI, Security, and CodeQL workflows for the release candidate commit.

### Known Limitations

- AgentForge v1.0 is a self-hosted GitHub governance service, not a hosted SaaS release.
- Email/password login is intentionally not included; use GitHub OAuth or a trusted identity proxy.
- AI features are advisory only and are disabled by default.
- V1 exports are delivered as authorized API export jobs; object-storage export adapters are reserved for later work.
- Production deployments require Postgres, Redis, signed GitHub webhooks, GitHub App credentials, and a configured authentication boundary.
