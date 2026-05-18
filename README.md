# AgentForge Merge Guard

AgentForge Merge Guard is a GitHub-first pull request governance service for high-risk and agent-assisted changes. It evaluates pull requests with deterministic facts, explicit policy-as-code rules, required evidence, reviewer routing, and a structured Change Control Record.

Core principle:

> Deterministic checks decide. AI explains and assists. Humans approve risk.

Merge Guard is not a vague AI code review product. V1 governs configured pull requests, detects high-risk change-control facts, applies stricter controls when agent-assistance signals are present, and records why a PR passed, warned, blocked, was overridden, merged, or closed.

## Repository Structure

```text
apps/
  api/      Fastify API, GitHub webhook receiver, dashboard APIs
  web/      Next.js dashboard
  worker/   BullMQ worker scaffold for async evaluations
packages/
  core/      Shared domain types
  config/    Environment parsing
  db/        Prisma schema and seed
  detectors/ Deterministic PR fact extraction
  evidence/  Evidence derivation and attestation helpers
  github/    Webhook verification, normalization, checks publisher
  policy/    YAML policy parser, packs, evaluator
  records/   Change Control Record creation/export/override helpers
  reviewers/ Reviewer routing
  security/  Redaction and data-handling utilities
  testing/   Fixture helpers
fixtures/    PR, diff, policy, webhook fixtures
docs/        Product, setup, security, policy, and testing docs
```

## Local Setup

Prerequisites:

- Node.js 22.13 or newer
- Corepack enabled for pnpm
- Docker for local Postgres, Redis, and optional MinIO exports

```bash
corepack enable
corepack prepare pnpm@11.1.1 --activate
pnpm install
docker compose up -d postgres redis minio
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The local Compose Postgres service is exposed on `localhost:15432` to avoid common conflicts with a developer workstation Postgres on `5432`. The Prisma scripts use `postgresql://agentforge:agentforge@localhost:15432/agentforge` unless `DATABASE_URL` is set.
The local Redis service is exposed on `localhost:6379`; `.env.example` includes both local service URLs so the API and worker start connected after a fresh copy.

Useful commands:

```bash
pnpm dev
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm lint
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm fixtures:run
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
```

`pnpm test` should be safe to run from a clean shell. DB-backed checks such as
integration and E2E runs expect the local Compose services to be running and
seeded with `pnpm db:migrate && pnpm db:seed`.

Production launch and rollback steps are documented in `docs/runbook.md`.
Railway-specific service setup, migration, and webhook cutover steps are documented in `docs/railway-deployment.md`.
Launch-readiness evidence for the initial production-integrated V1 rollout is documented in `docs/launch-readiness-evidence.md`.

## Environment Variables

Copy `.env.example` to `.env` and fill in values. The defaults are safe for local development, but production must set secrets explicitly.

- `DATABASE_URL`: PostgreSQL connection string. Local default: `postgresql://agentforge:agentforge@localhost:15432/agentforge`.
- `REDIS_URL`: Redis connection string for BullMQ. Local default: `redis://localhost:6379`.
- `NODE_ENV`: Runtime environment.
- `GITHUB_APP_ID`: GitHub App numeric ID.
- `GITHUB_APP_PRIVATE_KEY`: GitHub App private key.
- `GITHUB_WEBHOOK_SECRET`: Secret used to validate webhook signatures. Webhooks are rejected when this is missing unless explicit local unsigned-webhook mode is enabled.
- `ALLOW_UNSIGNED_GITHUB_WEBHOOKS`: Local-only escape hatch for fixture webhook testing. Keep `false` for normal development and all deployed environments.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: OAuth values for installation flows.
- `APP_BASE_URL`: Dashboard URL.
- `API_BASE_URL`: API URL.
- `DEFAULT_POLICY_MODE`: `observe`, `warn`, `enforce`, or `optimize`.
- `SOURCE_CODE_STORAGE`: Defaults to `false`; V1 stores metadata, not source code.
- `FULL_DIFF_RETENTION`: `disabled`, `7d`, `30d`, or `custom`.
- `REDACT_SECRETS`: Defaults to `true`.
- `LLM_FEATURES`: Defaults to `false`; advisory only when enabled.
- `AUDIT_RECORD_RETENTION_DAYS`: Audit retention duration.
- `EXPORT_STORAGE_BUCKET` / `EXPORT_STORAGE_REGION`: Optional export storage.
- `SESSION_SECRET`: Session signing secret for deployed dashboard/API usage.
- `AGENTFORGE_DASHBOARD_ACTOR`: Local dashboard server-action actor for settings/policy saves in non-production runs.
- `AGENTFORGE_DASHBOARD_ROLE`: Local dashboard server-action role. Use `platform_admin` or `engineering_manager` for repository setup.
- `AGENTFORGE_API_TRUST_PROXY_HEADERS`: Set `true` only when the API is behind a trusted auth proxy that injects `x-agentforge-authenticated-actor` and `x-agentforge-authenticated-role`.
- `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS`: Explicit production-like local fallback for raw `x-agentforge-actor` / `x-agentforge-role` API headers. Keep `false` for deployed environments.
- `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS`: Set `true` only when a trusted auth proxy injects `x-agentforge-authenticated-actor` and `x-agentforge-authenticated-role`.
- `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR`: Explicit production-like local fallback for `AGENTFORGE_DASHBOARD_ACTOR` / `AGENTFORGE_DASHBOARD_ROLE`. Keep `false` for deployed environments.

When `NODE_ENV=production`, startup fails closed if `GITHUB_WEBHOOK_SECRET` is missing, unsigned webhooks are enabled, source-code storage is enabled, or secret redaction is disabled.

## GitHub App Setup

Create a GitHub App with these webhook events:

- `pull_request`
- `pull_request_review`
- `check_suite`
- `check_run`
- `push`
- `repository`
- `installation`
- `installation_repositories`

Minimum permissions:

- Pull requests: read/write
- Checks: read/write
- Contents: read
- Metadata: read
- Issues: read/write if PR-visible comments are enabled
- Members: read for GitHub-verified team reviewer approvals

Set the webhook URL to:

```text
https://your-api-domain.example/webhooks/github
```

For local development, expose `http://localhost:4000/webhooks/github` through a tunnel and set `GITHUB_WEBHOOK_SECRET` to the same secret configured in GitHub.

When a policy requires a team reviewer, Merge Guard only clears that reviewer requirement if GitHub verifies that the approving user is an active member of the required team. If membership cannot be checked because the app lacks `Members: read` or GitHub is unavailable, the requirement fails closed and stays pending.
Unsigned webhook delivery is disabled by default. If you need to replay local fixture payloads without a GitHub secret, set `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true` only for that local process.

State-changing API calls require server-resolved actor context:

```text
x-agentforge-authenticated-actor: <login>
x-agentforge-authenticated-role: platform_admin | engineering_manager | auditor | security_reviewer | developer
```

The API ignores any `actorRole` value submitted in override request bodies; authorization is based on server-resolved headers. In production, raw local `x-agentforge-actor` and `x-agentforge-role` headers are rejected unless `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true` is explicitly set for a local production-mode smoke test.

Policy/settings changes require `platform_admin` or `engineering_manager`. Repository settings are persisted as runtime state, including enabled status, repository mode, data-handling overrides, and configured owner mappings. Change Control Record exports and audit access require `auditor`, `platform_admin`, or `engineering_manager`. Overrides use the role allowlist configured by policy.

The Next.js dashboard uses server actions for onboarding and settings changes. In development/test, those server actions can use `AGENTFORGE_DASHBOARD_ACTOR` and `AGENTFORGE_DASHBOARD_ROLE` as a local actor fallback. In production, server actions fail closed unless a trusted auth proxy is configured with `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true` and injects `x-agentforge-authenticated-actor` plus `x-agentforge-authenticated-role`, or `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true` is explicitly set for a production-like local run.

## Policy Modes

- `observe`: always publishes a passing check, records findings, and never blocks.
- `warn`: publishes a non-blocking warning, records what would block, and never blocks.
- `enforce`: blocks when required evidence, required reviews, or blocking policy conditions are unmet.
- `optimize`: keeps enforce controls active and surfaces governance improvement opportunities after teams have stabilized enforcement.

Mode can be set at organization, repository, and rule level. The evaluator resolves the safest explicit mode and never uses advisory AI output as a blocking condition.

## Policy Files

Policies are YAML files validated with zod. A policy pack includes mode, scoped applicability, sensitive paths, tests, dependencies, database migrations, reviewers, evidence requirements, overrides, and data-retention defaults.

Example:

```yaml
version: 1
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
```

Validate and preview policies:

```bash
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
```

`agentforge.apply_to` supports `all_pull_requests`, `repo:<glob>`, `base:<glob>`, `head:<glob>`, `branch:<glob>`, and `label:<glob>`. API policy previews are read-only by default; persisting preview-generated Change Control Records requires `persist: true` plus a server-resolved `platform_admin` or `engineering_manager` actor.

## Change Control Records

Every evaluated PR receives a structured Change Control Record with repository, PR number, head SHA, policy version, policy pack version, mode, verified findings, evidence requirements, reviewer requirements, check status, overrides, final decision, timestamps, and lifecycle transitions.

Runtime evaluations are also normalized into policy-version, evaluation, verified-fact, evidence-requirement, reviewer-requirement, check-run, and override tables for audit queries. Evidence counts as complete only after approval; provided-but-unapproved evidence remains open.

Records are exportable as JSON and CSV and intentionally exclude full source code by default.

## Data Handling Defaults

- Store metadata, file paths, findings, policy results, reviewer state, evidence state, and override state.
- Do not store source blobs by default.
- Do not retain full diffs unless configured.
- Redact secrets from logs, stored snippets, check output, dashboard display, exports, and advisory prompts.
- LLM features are disabled by default and advisory only when enabled.
- Customer code is not used for model training by this V1 implementation.

## What V1 Does Not Support

V1 intentionally excludes autonomous merge decisions, full agent orchestration, semantic architecture review, prompt/session replay, IDE extensions, agentic blame, line-by-line AI authorship labeling, semantic duplicate detection, full provenance SDKs, LLM-based blocking, and numeric risk-score-centered workflows.

Backlog placeholders are documented in `docs/roadmap.md`.
