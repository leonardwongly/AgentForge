# AgentForge Merge Guard

AgentForge Merge Guard is a GitHub-first pull request governance service for high-risk and agent-assisted changes. It evaluates configured pull requests with deterministic detectors, policy-as-code rules, required evidence, reviewer routing, GitHub check runs, and durable Change Control Records.

The operating principle is simple:

> Deterministic checks decide. AI explains and assists. Humans approve risk.

Merge Guard is not an AI code review replacement and does not certify that a pull request is secure, correct, compliant, or vulnerability-free. The current V1 implementation reports whether configured policy requirements are satisfied, records the decision trail, and keeps LLM features disabled by default and advisory only when enabled.

## Current State

This repository is a working TypeScript monorepo for the Merge Guard V1 runtime:

- Fastify API for GitHub webhooks, dashboard APIs, queue administration, policy previews, evidence updates, overrides, exports, health, and readiness.
- Next.js dashboard for repositories, policy setup, dashboard views, evidence queues, overrides, records, and policy insights.
- BullMQ worker for asynchronous pull request evaluations and GitHub check publication.
- Prisma/PostgreSQL persistence for repository settings, policy versions, webhook deliveries, evaluations, Change Control Records, audit events, exports, and queue operations.
- Redis-backed queue processing, with explicit readiness checks for queue health.
- Built-in policy packs and YAML policy validation/preview tooling.
- Security-focused defaults: signed GitHub webhooks, fail-closed production config, metadata-only storage, secret redaction, source-code storage disabled, and trusted-proxy identity requirements for deployed state-changing actions.
- Local Docker Compose services for Postgres, Redis, and optional MinIO-backed export experiments.

For product positioning and non-goals, see [docs/product-overview.md](docs/product-overview.md) and [docs/launch-positioning-and-pricing.md](docs/launch-positioning-and-pricing.md).

## Repository Layout

```text
apps/
  api/       Fastify API, webhook receiver, dashboard APIs, queue admin
  web/       Next.js dashboard and Playwright smoke coverage
  worker/    BullMQ worker for PR evaluation jobs
packages/
  config/    Environment loading and production safety validation
  core/      Shared domain types and queue constants
  db/        Prisma schema, migrations, generated client boundary, seed data
  detectors/ Deterministic PR fact extraction
  evidence/  Evidence derivation and PR-body evidence helpers
  github/    Webhook verification, normalization, GitHub clients, check output
  policy/    YAML policy schema, parser, built-in policy packs, evaluator
  records/   Change Control Records, audit events, exports, compliance packages
  reviewers/ Reviewer routing and CODEOWNERS parsing
  security/  Redaction, advisory prompt sanitization, storage policy helpers
  testing/   Shared fixture helpers
  ui/        Shared dashboard UI primitives
fixtures/
  diffs/     Patch fixtures used by detectors and policy tests
  policies/  Example policy packs
  repos/     Pull request fixture scenarios
  webhooks/  GitHub webhook payload fixtures
docs/        Product, setup, policy, security, testing, deployment, runbook docs
scripts/     Local validation, policy, fixture, GitHub, and E2E helpers
```

## Prerequisites

- Node.js `22.13` or newer.
- `pnpm 11.1.1`, preferably through Corepack.
- Docker Desktop or another Docker-compatible runtime for local Postgres, Redis, and MinIO.
- GitHub App credentials only when testing real GitHub webhook or check-run flows.

The repository uses:

- TypeScript ESM.
- pnpm workspaces.
- Turbo for build/typecheck orchestration.
- Vitest for unit and API integration tests.
- Playwright for dashboard E2E smoke tests.
- Prisma `6.19.3` with PostgreSQL.
- Fastify `5`, Next.js `16`, React `19`, BullMQ, Redis, and zod.

## Quick Start

Clone the repository and install dependencies:

```bash
git clone <repo-url> AgentForge
cd AgentForge

if command -v corepack >/dev/null 2>&1; then
  corepack enable
  corepack prepare pnpm@11.1.1 --activate
else
  npm install -g pnpm@11.1.1
fi

pnpm install
```

Create local configuration:

```bash
cp .env.example .env
```

Start the local backing services:

```bash
docker compose up -d postgres redis minio
```

Prepare the database:

```bash
pnpm prisma:validate
pnpm db:migrate
pnpm db:seed
```

Start the full local stack:

```bash
pnpm dev
```

Default local endpoints:

- Dashboard: `http://localhost:3000`
- API: `http://localhost:4000`
- API health: `http://localhost:4000/health`
- API readiness: `http://localhost:4000/ready`
- GitHub webhook receiver: `http://localhost:4000/webhooks/github`
- Postgres: `localhost:15432`
- Redis: `localhost:6379`
- MinIO: `http://localhost:9000`
- MinIO console: `http://localhost:9001`

The local Postgres port is `15432` to avoid conflicts with a workstation Postgres on `5432`.
Redis is required for queue-backed API and worker flows. MinIO is optional for
routine development and is only needed when testing local export or
object-storage behavior.

## Common Commands

```bash
# Run services
pnpm dev:preflight
pnpm dev
pnpm dev:api
pnpm dev:web
pnpm dev:worker

# Build and static checks
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm format

# Database
pnpm prisma:validate
pnpm db:generate
pnpm db:migrate
pnpm db:deploy
pnpm db:seed

# Tests
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
pnpm smoke:e2e-readiness

# Fixtures and policy tools
pnpm fixtures:run
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
pnpm messaging:validate
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
```

`pnpm test` is expected to be safe from a clean shell. DB-backed integration and E2E checks require the Compose services and seeded database. The Playwright E2E runner uses isolated default ports, `127.0.0.1:3100` for web and `127.0.0.1:4100` for API, so it does not need the normal dev servers to already be running.

## Configuration

Copy [.env.example](.env.example) to `.env` for local development. Defaults are intentionally local-safe, but production must set secrets and trusted identity settings explicitly.

Important variables:

| Variable                                          | Purpose                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | PostgreSQL connection string. Local default is `postgresql://agentforge:agentforge@localhost:15432/agentforge`.        |
| `REDIS_URL`                                       | Redis connection string used by BullMQ. Local default is `redis://localhost:6379`.                                     |
| `NODE_ENV`                                        | `development`, `test`, or `production`. Production enables fail-closed config checks.                                  |
| `GITHUB_APP_ID`                                   | Numeric GitHub App ID.                                                                                                 |
| `GITHUB_APP_PRIVATE_KEY`                          | GitHub App private key. Use escaped newlines in hosted environment variables when required.                            |
| `GITHUB_INSTALLATION_ID`                          | Optional installation id for smoke tests. Runtime jobs use webhook payload installation ids.                           |
| `GITHUB_WEBHOOK_SECRET`                           | Shared secret used to verify GitHub webhook signatures. Required in production.                                        |
| `ALLOW_UNSIGNED_GITHUB_WEBHOOKS`                  | Local fixture escape hatch. Keep `false` outside explicit local replay tests.                                          |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`       | GitHub App OAuth values for installation flows.                                                                        |
| `APP_BASE_URL`                                    | Public dashboard URL. Local default is `http://localhost:3000`.                                                        |
| `API_BASE_URL`                                    | Public API URL. Local default is `http://localhost:4000`.                                                              |
| `DEFAULT_POLICY_MODE`                             | `observe`, `warn`, `enforce`, or `optimize`.                                                                           |
| `SOURCE_CODE_STORAGE`                             | Must remain `false` for the V1 production posture.                                                                     |
| `FULL_DIFF_RETENTION`                             | `disabled`, `7d`, `30d`, or `custom`.                                                                                  |
| `REDACT_SECRETS`                                  | Redacts secrets in logs, snippets, check output, dashboard display, exports, and prompts.                              |
| `LLM_FEATURES`                                    | Optional advisory AI features. Blocking decisions never depend on this.                                                |
| `AUDIT_RECORD_RETENTION_DAYS`                     | Retention period for audit and change-control records.                                                                 |
| `EXPORT_STORAGE_BUCKET` / `EXPORT_STORAGE_REGION` | Optional object storage settings for exports.                                                                          |
| `SESSION_SECRET`                                  | Session signing secret. Required before production deployment.                                                         |
| `AGENTFORGE_API_TRUST_PROXY_HEADERS`              | Trust authenticated API actor headers only behind a verified stripping auth proxy.                                     |
| `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS`        | Local-only API fallback for raw actor headers. Keep `false` in deployed environments.                                  |
| `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS`        | Trust authenticated dashboard actor headers only behind a verified auth proxy.                                         |
| `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR`          | Local-only dashboard fallback. Keep `false` in deployed environments.                                                  |
| `AGENTFORGE_ENABLE_SAMPLE_PREVIEW`                | Explicitly exposes the local sample-preview onboarding action in production-like E2E runs. Keep `false` when deployed. |
| `AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS`            | Production acknowledgement that ingress strips spoofable identity headers before injecting trusted headers.            |

When `NODE_ENV=production`, startup fails closed if webhook signing, redaction, source-code storage, trusted proxy identity, local actor fallback, or header-stripping requirements are unsafe.

## Running Locally

For routine development, run all three application services:

```bash
pnpm dev:preflight
pnpm dev
```

`pnpm dev` runs the same local preflight before starting the stack. If Docker,
Postgres, Redis, or `.env` are missing, the command fails before noisy API or
worker connection errors and prints the exact setup command to run. MinIO is
reported as a warning when it is unavailable because it is optional unless you
are testing local export or object-storage behavior.

To run services separately:

```bash
pnpm dev:api
pnpm dev:web
pnpm dev:worker
```

The API listens on `PORT` or `4000`; the web app listens on `3000`; the worker consumes the `merge-guard-evaluations` BullMQ queue when `REDIS_URL` is configured.

Check local service health:

```bash
curl -fsS http://localhost:4000/health
curl -fsS http://localhost:4000/ready
```

`/health` verifies the API process is alive. `/ready` verifies dependencies such as the queue backend are reachable and should be used before cutting over webhook traffic.

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
- Members: read when policies require GitHub-verified team reviewer approvals

Set the webhook URL to:

```text
https://<api-host>/webhooks/github
```

For local webhook testing, expose `http://localhost:4000/webhooks/github` through a tunnel and set `GITHUB_WEBHOOK_SECRET` to the same value configured in GitHub. Unsigned webhook delivery is disabled by default; use `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true` only for explicit local fixture replay.

More detail is in [docs/github-app-setup.md](docs/github-app-setup.md).

## Policy Files

Policies are YAML files validated with zod. A policy pack can define applicability, mode, sensitive paths, tests, dependencies, database migrations, required reviewers, evidence requirements, override rules, and data-retention defaults.

Minimal example:

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

Validate and preview policies locally:

```bash
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
```

`agentforge.apply_to` supports `all_pull_requests`, `repo:<glob>`, `base:<glob>`, `head:<glob>`, `branch:<glob>`, and `label:<glob>`.

See [docs/policy-as-code.md](docs/policy-as-code.md) and [docs/policy-packs.md](docs/policy-packs.md).

## Policy Modes

- `observe`: records findings and open requirements, publishes a passing check, and never blocks.
- `warn`: records what would block and publishes a non-blocking warning.
- `enforce`: blocks when required evidence, required reviews, or blocking policy conditions are unmet.
- `optimize`: keeps enforce controls active and surfaces governance improvement opportunities for mature teams.

Mode can be set at organization, repository, and rule level. The evaluator resolves the safest explicit mode and never uses advisory AI output as a blocking condition.

## API Examples

Validate a policy:

```bash
curl -fsS http://localhost:4000/api/policies/validate \
  -H "content-type: application/json" \
  --data '{"contentYaml":"version: 1\nagentforge:\n  mode: warn\n  apply_to:\n    - all_pull_requests\n"}'
```

Inspect dashboard records:

```bash
curl -fsS "http://localhost:4000/api/dashboard/records?limit=25&offset=0"
```

Read queue status with a local operator actor:

```bash
AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true pnpm dev:api

curl -fsS http://localhost:4000/api/admin/queue \
  -H "x-agentforge-actor: local-admin" \
  -H "x-agentforge-role: platform_admin" \
  -H "x-agentforge-organization: org_local"
```

In production, state-changing and admin routes must use trusted `x-agentforge-authenticated-*` headers injected by an auth proxy that strips spoofable client identity headers.

## Change Control Records And Exports

Each evaluated PR receives a Change Control Record containing repository, PR number, head SHA, policy version, policy pack, mode, verified findings, evidence requirements, reviewer requirements, check status, overrides, final decision, timestamps, and lifecycle transitions.

The runtime also normalizes evaluations into queryable tables for audit views and exports. JSON/CSV Change Control Record exports and JSON compliance evidence packages intentionally exclude full source code by default and apply redaction before output.

See [docs/change-control-records.md](docs/change-control-records.md) and [docs/security-and-data-handling.md](docs/security-and-data-handling.md).

## Testing

Recommended validation before handing off changes:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm fixtures:run
```

When the local Compose stack is running and seeded:

```bash
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
```

The fixture scenarios in `fixtures/repos` cover README-only changes, sensitive paths, CI workflow changes, deleted tests, skipped tests, assertion weakening, dependency changes, database migrations, secret-like diffs, overrides, and policy updates after PR open.

See [docs/testing.md](docs/testing.md).

## Deployment

The documented deployment target is one Railway project with separate services:

- `agentforge-api` for the Fastify API and GitHub webhook receiver.
- `agentforge-worker` for BullMQ processing and check publication.
- `agentforge-web` for the optional Next.js dashboard, or host the dashboard elsewhere and point `APP_BASE_URL` at it.
- Managed Postgres and Redis services.

Build and start commands are defined in [docs/railway-deployment.md](docs/railway-deployment.md). Production migration deploys should use:

```bash
pnpm db:deploy
```

Do not run `prisma migrate dev` in hosted production environments.

Operational launch and rollback guidance is in [docs/runbook.md](docs/runbook.md). Launch-readiness evidence is tracked in [docs/launch-readiness-evidence.md](docs/launch-readiness-evidence.md).

## Troubleshooting

### `pnpm install` uses the wrong package manager

Use Corepack to activate the pinned package manager:

```bash
corepack enable
corepack prepare pnpm@11.1.1 --activate
pnpm --version
```

### Prisma cannot connect to Postgres

Start Compose and verify the non-default local port:

```bash
docker compose up -d postgres
docker compose ps
pnpm prisma:validate
```

The local database URL should be:

```text
postgresql://agentforge:agentforge@localhost:15432/agentforge
```

### `/ready` is not ready but `/health` works

`/health` only proves the API process is alive. `/ready` also checks runtime dependencies such as Redis/BullMQ. Start Redis and the worker:

```bash
docker compose up -d redis
pnpm dev:worker
curl -fsS http://localhost:4000/ready
```

### MinIO is unavailable in local development

MinIO backs optional local export and object-storage experiments. Start it only
when those flows are under test:

```bash
docker compose up -d minio
curl -fsS http://localhost:9000/minio/health/live
```

The local console is `http://localhost:9001` with username `agentforge` and
password `agentforge-local`.

### GitHub webhooks are rejected locally

Confirm the tunnel URL points to `/webhooks/github`, the GitHub App webhook secret matches `GITHUB_WEBHOOK_SECRET`, and the payload includes the `x-hub-signature-256` header. Use unsigned webhooks only for explicit local fixture replay:

```bash
ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true pnpm dev:api
```

Never enable unsigned webhooks in production.

### Dashboard settings saves fail in local development

Local dashboard server actions need an actor fallback or trusted proxy identity. For local-only setup, `.env.example` provides:

```text
AGENTFORGE_DASHBOARD_ACTOR=dashboard-local
AGENTFORGE_DASHBOARD_ROLE=platform_admin
AGENTFORGE_DASHBOARD_ORGANIZATION=org_local
```

For deployed environments, configure trusted proxy headers instead of local actor fallbacks.

### E2E tests report occupied ports or build locks

Run the preflight to identify the blocking resource:

```bash
pnpm test:e2e:preflight
```

The E2E runner uses `127.0.0.1:3100` and `127.0.0.1:4100` by default and takes an advisory lock to avoid overlapping Playwright runs.

## Security Notes

- External input is validated at API boundaries with zod schemas where practical.
- GitHub webhook signatures are verified by default.
- Production config fails closed when unsafe security flags are enabled.
- Raw actor headers are local-only and disabled by default for deployed environments.
- Trusted proxy headers are accepted only when explicitly configured.
- Source-code storage is disabled by default.
- Secret redaction is applied to logs, snippets, check summaries, exports, dashboard output, and advisory prompts.
- LLM features are disabled by default and cannot determine blocking status.
- Exports are bounded and exclude full source code by default.

See [docs/security-and-data-handling.md](docs/security-and-data-handling.md) for the current data-handling model.

## Contributing

1. Create a focused branch for the change.
2. Inspect nearby code and follow existing package patterns.
3. Keep changes small, typed, and covered by tests.
4. Update docs or fixtures when behavior changes.
5. Run the narrowest relevant checks while iterating, then run the broader validation ladder before handoff.
6. Do not commit secrets, local `.env` files, generated junk, or unrelated workspace changes.

Suggested pre-commit validation:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm fixtures:run
```

For API, worker, database, or dashboard changes, also run the relevant integration or E2E checks described in [docs/testing.md](docs/testing.md).

## More Documentation

- [docs/product-overview.md](docs/product-overview.md) - product scope, buyer hypothesis, and non-goals.
- [docs/github-app-setup.md](docs/github-app-setup.md) - GitHub App setup details.
- [docs/policy-as-code.md](docs/policy-as-code.md) - policy schema and examples.
- [docs/policy-packs.md](docs/policy-packs.md) - built-in policy packs.
- [docs/change-control-records.md](docs/change-control-records.md) - CCR lifecycle and export model.
- [docs/security-and-data-handling.md](docs/security-and-data-handling.md) - security and privacy posture.
- [docs/testing.md](docs/testing.md) - validation strategy and E2E details.
- [docs/railway-deployment.md](docs/railway-deployment.md) - Railway topology, variables, deploy, validation, and rollback.
- [docs/runbook.md](docs/runbook.md) - operational launch and rollback steps.
- [docs/roadmap.md](docs/roadmap.md) - backlog and intentionally excluded V1 capabilities.
