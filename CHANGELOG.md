# Changelog

All notable AgentForge Merge Guard changes are tracked here.

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
