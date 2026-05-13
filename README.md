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

- Node.js 20 or newer
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
- `DEFAULT_POLICY_MODE`: `observe`, `warn`, or `enforce`.
- `SOURCE_CODE_STORAGE`: Defaults to `false`; V1 stores metadata, not source code.
- `FULL_DIFF_RETENTION`: `disabled`, `7d`, `30d`, or `custom`.
- `REDACT_SECRETS`: Defaults to `true`.
- `LLM_FEATURES`: Defaults to `false`; advisory only when enabled.
- `AUDIT_RECORD_RETENTION_DAYS`: Audit retention duration.
- `EXPORT_STORAGE_BUCKET` / `EXPORT_STORAGE_REGION`: Optional export storage.
- `SESSION_SECRET`: Session signing secret for deployed dashboard/API usage.
- `AGENTFORGE_DASHBOARD_ACTOR`: Local dashboard server-action actor for settings/policy saves.
- `AGENTFORGE_DASHBOARD_ROLE`: Local dashboard server-action role. Use `platform_admin` or `engineering_manager` for repository setup.

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
- Members: read if team membership validation is enabled

Set the webhook URL to:

```text
https://your-api-domain.example/webhooks/github
```

For local development, expose `http://localhost:4000/webhooks/github` through a tunnel and set `GITHUB_WEBHOOK_SECRET` to the same secret configured in GitHub.
Unsigned webhook delivery is disabled by default. If you need to replay local fixture payloads without a GitHub secret, set `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true` only for that local process.

State-changing API calls require server-resolved actor context in local V1:

```text
x-agentforge-actor: <login>
x-agentforge-role: platform_admin | engineering_manager | auditor | security_reviewer | developer
```

Policy/settings changes require `platform_admin` or `engineering_manager`. Repository settings are persisted as runtime state, including enabled status, repository mode, data-handling overrides, and configured owner mappings. Change Control Record exports and audit access require `auditor`, `platform_admin`, or `engineering_manager`. Overrides use the role allowlist configured by policy.

The Next.js dashboard uses server actions for onboarding and settings changes. In local V1 those server actions send `AGENTFORGE_DASHBOARD_ACTOR` and `AGENTFORGE_DASHBOARD_ROLE` to the API; production authentication should replace those local defaults with authenticated user context.

## Policy Modes

- `observe`: always publishes a passing check, records findings, and never blocks.
- `warn`: publishes a non-blocking warning, records what would block, and never blocks.
- `enforce`: blocks when required evidence, required reviews, or blocking policy conditions are unmet.

Mode can be set at organization, repository, and rule level. The evaluator resolves the safest explicit mode and never uses advisory AI output as a blocking condition.

## Policy Files

Policies are YAML files validated with zod. A policy pack includes mode, sensitive paths, tests, dependencies, database migrations, reviewers, evidence requirements, overrides, and data-retention defaults.

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

## Change Control Records

Every evaluated PR receives a structured Change Control Record with repository, PR number, head SHA, policy version, policy pack version, mode, verified findings, evidence requirements, reviewer requirements, check status, overrides, final decision, timestamps, and lifecycle transitions.

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
