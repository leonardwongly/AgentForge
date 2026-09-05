# AgentForge

AgentForge is a self-hosted, deterministic change-control platform for
high-risk and agent-assisted software changes. It evaluates pull requests
against policy-as-code, records evidence and reviewer decisions, and keeps a
tamper-evident audit trail.

> Deterministic checks decide. AI explains and assists. Humans approve risk.

AgentForge reports whether configured governance requirements are satisfied. It
does not certify that code is secure, correct, compliant, or vulnerability-free.
Optional LLM features are disabled by default, advisory only, and can never
make a blocking decision.

## What is shipped

The current release is **AgentForge Merge Guard v1.2.0**. Merge Guard is the
GitHub-first product in this repository:

- **API** — Fastify endpoints for GitHub webhooks, policy validation and
  previews, repository settings, queue administration, evidence, reviewers,
  overrides, records, exports, health, readiness, metrics, and audit access.
- **Dashboard** — Next.js onboarding and operations UI for repositories, policy
  packs, evidence queues, policy insights, governance health, records, exports,
  and GitHub App installation approval.
- **Worker** — BullMQ processing for deterministic pull-request evaluation,
  bounded retries, safe failure summaries, check publication, and optional
  governance notifications.
- **Durable records** — Prisma/PostgreSQL stores repository settings, policy
  versions, webhook deliveries, evaluations, Change Control Records (CCRs),
  audit events, export jobs, and queue operations. Audit events can be chained
  and streamed to a SIEM-style webhook.
- **Governance** — Built-in YAML policy packs, deterministic detectors, required
  evidence, CODEOWNERS/team reviewer routing, policy tuning reports, per-detector
  precision proxies, and human-gated recommendations.
- **Security defaults** — Signed webhooks, fail-closed production startup,
  nonce-protected trusted-proxy identity, request-time header-stripping
  enforcement, tenant isolation with Postgres RLS, secret redaction, bounded
  exports, and source-code storage disabled by default.
- **Operator clients** — Native Android and iOS read-only consoles for `/health`,
  `/ready`, runtime interpretation, persisted endpoint settings, and GitHub
  OAuth handoff. They never receive database, queue, webhook, OAuth, or GitHub
  private-key credentials.
- **Operations** — `pnpm doctor`, non-destructive `pnpm setup`, fixture replay,
  deterministic benchmarking, Docker images, Helm, AWS Terraform, and
  Cloudflare Tunnel/Pages reference deployments.

The product is designed around a standalone governance domain, but the shipped
Merge Guard integration is currently GitHub-first. See
[the product overview](docs/product-overview.md) for scope and non-goals.

## Loom status

This repository also contains **Loom**, a native agent-first version-control
research program and specification. Loom is pre-1.0 and is not a replacement
for the Merge Guard deployment described above.

The executable Loom packages currently cover tested slices across canonical
DAG-CBOR/CID addressing, binary-safe objects, durable content-addressed storage
and journals, working copies, merge/reapply, Grants and key lifecycle, native
admission and ledger state, replication and recovery, Git import/export,
delegated agent sessions and work graphs, the Wire v1 transport, provenance,
witnessed trust, and the `loom` CLI. The detailed design records phase evidence
and implementation boundaries.

Phase 4 is different: the pilot tooling exists, but the required operational
30-day dual-safety pilot (Loom authority continuously mirrored to Git with
restore evidence) has not yet run. Loom therefore makes **no `LOOM-CORE`
conformance claim**. Start with the [Loom specification index](docs/loom/README.md),
[current implementation status](docs/loom/loom-detailed-design.md#20-current-implementation-status),
and [pilot runbook](docs/loom/pilot-runbook.md).

## Architecture

```text
GitHub App ──signed webhook──> API ──job──> Redis/BullMQ ──> Worker ──> check + notification
                                  │                              │
                                  └──> PostgreSQL CCR/audit <─────┘

Dashboard ──GitHub OAuth or trusted proxy──> signed API requests
Android/iOS ──HTTPS──> /health, /ready, and dashboard OAuth handoff
```

Production runs the API, worker, and optional dashboard as separate services
behind TLS and an authenticating reverse proxy. Durable production mode uses
managed PostgreSQL and Redis; in-memory runtime mode is for tests and local
demos and does not survive a restart.

## Repository layout

```text
apps/
  api/       Fastify API and GitHub webhook receiver
  web/       Next.js dashboard and Playwright smoke coverage
  worker/    BullMQ evaluation worker and check publisher
  android/   Kotlin/Jetpack Compose operator console
  ios/       SwiftUI operator console and AgentForgeCore package
packages/
  config/          Environment loading and production safety checks
  core/            Shared domain types and queue constants
  db/              Prisma schema, migrations, client boundary, and seed data
  detectors/       Deterministic pull-request fact extraction
  evidence/        Evidence derivation and PR-body helpers
  github/          Webhook verification, normalization, and GitHub clients
  notifications/   Governance webhooks and tamper-evident audit streaming
  policy/          YAML schema, parser, built-in packs, and evaluator
  records/         CCRs, audit events, exports, and compliance packages
  reviewers/       Reviewer routing and CODEOWNERS parsing
  security/        Redaction, prompt sanitization, and storage policy helpers
  ui/              Shared dashboard UI primitives
  loom-agent/      Native Loom end-user/agent SDK
  loom-cli/        Loom ratify, verify, repository, and pilot CLI
  loom-core/       Loom objects, state, transforms, merge, storage, and ledger
  loom-git-bridge/ Git interoperability and fidelity tooling
  loom-provenance/ DSSE/in-toto attestations and signing
  loom-ratify/     Loom-to-governance evaluation adapter
fixtures/          Policy, repository, diff, and webhook scenarios
docs/              Product, security, deployment, testing, and Loom references
scripts/            Setup, health, benchmark, release, fixture, and E2E helpers
deploy/             Docker, Cloudflare, Helm, and AWS Terraform packaging
```

## Requirements

- Node.js `22.13` or newer.
- pnpm `11.1.1` (the version is pinned in `package.json`).
- Docker Desktop or a compatible Docker runtime for local PostgreSQL, Redis,
  and optional MinIO.
- A GitHub App only for real webhook/check-run integration. Fixture and unit
  tests do not require GitHub credentials.
- For mobile builds: JDK + Android SDK, and Xcode with the iOS 26 SDK plus
  `xcodegen`.

The TypeScript workspace uses ESM, pnpm workspaces, Turbo, Vitest, Playwright,
Prisma 7, Fastify 5, Next.js 16, React 19, BullMQ, Redis, and zod.

## Quick start

Clone and install:

```bash
git clone https://github.com/leonardwongly/AgentForge.git
cd AgentForge

corepack enable
corepack prepare pnpm@11.1.1 --activate
pnpm install
cp .env.example .env
```

For a seeded local stack, run the non-destructive setup helper:

```bash
pnpm setup
```

`pnpm setup` checks Node, pnpm, and Docker; creates `.env` only when it is
missing; starts loopback-bound Postgres, Redis, and MinIO; waits for Postgres
and Redis; validates Prisma; migrates; and seeds. It never overwrites an
existing `.env`.

To use the onboarding sample preview locally, set these explicit development
flags in `.env`:

```env
AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true
AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true
AGENTFORGE_ENABLE_SAMPLE_PREVIEW=true
```

Keep these flags `false` in every deployed environment. Do not use local actor
fallbacks as production authentication; use GitHub OAuth or a trusted proxy.

Start the applications:

```bash
pnpm dev
```

Open `http://localhost:3000/onboarding`, run the sample preview, and save the
setup progress. The default local endpoints are:

| Surface             | URL                                               |
| ------------------- | ------------------------------------------------- |
| Dashboard           | `http://localhost:3000`                           |
| API                 | `http://localhost:4000`                           |
| Health              | `http://localhost:4000/health`                    |
| Readiness           | `http://localhost:4000/ready`                     |
| GitHub webhook      | `http://localhost:4000/webhooks/github`           |
| PostgreSQL          | `localhost:15432`                                 |
| Redis               | `localhost:6379`                                  |
| MinIO API / console | `http://localhost:9000` / `http://localhost:9001` |

Compose binds all local service ports to `127.0.0.1`. MinIO is optional for
future object-storage adapter experiments; current Merge Guard exports are
authorized API export jobs.

## Commands

```bash
# Local services and diagnostics
pnpm dev:preflight
pnpm dev
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm doctor
pnpm setup

# Production-like build and start commands
pnpm build
pnpm railway:build
pnpm start:api
pnpm start:worker
pnpm start:web

# Database
pnpm prisma:validate
pnpm db:generate
pnpm db:migrate                 # local development
pnpm db:deploy                  # deployed environments
pnpm db:seed

# Tests and quality gates
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
pnpm smoke:e2e-readiness
pnpm --filter './packages/loom-*' typecheck
pnpm --filter './packages/loom-*' test
pnpm typecheck
pnpm lint
pnpm format:check

# Fixtures, policies, and evidence reports
pnpm fixtures:run
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
pnpm design-partner:report --input records.json --output report.md
pnpm messaging:validate
pnpm benchmark --iterations 100

# Release and live GitHub smoke checks
pnpm release:check
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <id>
```

The benchmark iteration count is bounded. The E2E runner builds the dashboard,
uses isolated `127.0.0.1:3100` and `127.0.0.1:4100` ports, and takes an advisory
lock to prevent overlapping runs. Integration and E2E tests require the local
Compose services and a seeded database.

### Loom CLI

Run the private CLI from the workspace (or build it with the package's `build`
script for a deployment-specific distribution):

```bash
pnpm exec tsx packages/loom-cli/src/index.ts --help
pnpm exec tsx packages/loom-cli/src/index.ts init --repo <loom-dir>
pnpm exec tsx packages/loom-cli/src/index.ts status --repo <loom-dir>
pnpm exec tsx packages/loom-cli/src/index.ts propose --repo <loom-dir> --title "Change"
pnpm exec tsx packages/loom-cli/src/index.ts log --repo <loom-dir>
```

The CLI also provides `ratify`, `verify`, and the Phase 4 pilot commands. Use
the generated entry point (or install its private `loom` bin locally):

```bash
pnpm exec tsx packages/loom-cli/src/index.ts pilot mirror --repo <loom-dir> --git <git-mirror> --message "mirror <seq>"
pnpm exec tsx packages/loom-cli/src/index.ts pilot verify --repo <loom-dir> --git <git-mirror>
pnpm exec tsx packages/loom-cli/src/index.ts pilot restore --repo <loom-dir> --backup <backup-dir>
```

The pilot commands stop on divergence and record an equivalence digest; they do
not constitute evidence that the 30-day pilot has been completed.

## Configuration and authentication

Copy [.env.example](.env.example) and review every value before deployment.
Important groups are:

| Group                   | Variables                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                 | `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `APP_BASE_URL`, `API_BASE_URL`                                                                                           |
| GitHub App              | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`, `ALLOW_UNSIGNED_GITHUB_WEBHOOKS`                                           |
| OAuth                   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AGENTFORGE_GITHUB_ADMIN_LOGINS`, `AGENTFORGE_GITHUB_ALLOWED_LOGINS`, `SESSION_SECRET`                                |
| Policy and data         | `DEFAULT_POLICY_MODE`, `SOURCE_CODE_STORAGE`, `FULL_DIFF_RETENTION`, `REDACT_SECRETS`, `AUDIT_RECORD_RETENTION_DAYS`                                              |
| Trusted API proxy       | `AGENTFORGE_API_TRUST_PROXY_HEADERS`, `AGENTFORGE_API_PROXY_SECRET`, `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS`                                                   |
| Trusted dashboard proxy | `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS`, `AGENTFORGE_DASHBOARD_PROXY_SECRET`, `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR`, `AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS` |
| Optional integrations   | `NOTIFICATION_WEBHOOK_URL`, `AUDIT_STREAM_WEBHOOK_URL`, `EXPORT_STORAGE_BUCKET`, `EXPORT_STORAGE_REGION`, `LLM_FEATURES`                                          |

In production, startup fails closed unless webhook signing is enabled,
`ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false`, `SOURCE_CODE_STORAGE=false`,
`REDACT_SECRETS=true`, trusted proxy identity and header stripping are enabled,
and local actor fallbacks are disabled. Session, webhook, and proxy secrets must
be strong (at least 32 characters and not common placeholders). Do not use
local actor fallbacks in deployed environments.

The dashboard supports built-in **GitHub OAuth** or a **trusted proxy**. OAuth
requires explicit login allowlists and `SESSION_SECRET`; trusted proxy mode
requires the proxy to strip spoofable `x-agentforge-*` headers and sign the
forwarded identity with `AGENTFORGE_API_PROXY_SECRET` and
`AGENTFORGE_DASHBOARD_PROXY_SECRET`. There is no username/password login.

Durable production mode requires PostgreSQL and Redis. The application should
connect through a non-superuser, non-`BYPASSRLS` PostgreSQL role so tenant RLS
is an active backstop, not merely a migration artifact. Read
[the authentication guide](docs/auth.md), [tenant isolation guide](docs/tenant-isolation-rls.md),
and [hardened self-hosting reference](docs/self-hosting.md) before exposing a
service publicly.

## GitHub App setup

Configure a GitHub App with these webhook events:

`pull_request`, `pull_request_review`, `check_suite`, `check_run`, `push`,
`repository`, `installation`, and `installation_repositories`.

Minimum permissions are Pull requests read/write, Checks read/write, Contents
read, Metadata read, and Issues read/write when PR-visible comments are used.
Add Members read when a policy requires GitHub-verified team reviewer approval.
Point the webhook to:

```text
https://<api-host>/webhooks/github
```

Installations remain pending until a `platform_admin` approves them. For the
complete install, OAuth, webhook, and smoke-test flow, see
[docs/github-app-setup.md](docs/github-app-setup.md) and
[docs/auth.md](docs/auth.md).

## Policies and governance records

Policies are YAML documents validated with zod. They can select repositories,
branches, labels, or all pull requests and can require sensitive-path reviews,
tests, dependency checks, migrations, evidence, and overrides.

```yaml
version: 1
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths: ["src/billing/**"]
    required_reviewers: ["billing-owner"]
    required_evidence: ["rollback_plan"]
```

Policy modes are:

- `observe` — record findings and requirements without blocking.
- `warn` — show what would block without enforcing it.
- `enforce` — block when configured findings, evidence, or reviews are unmet.
- `optimize` — keep enforcement active while surfacing governance improvements.

Each evaluated pull request receives a Change Control Record containing the
repository, PR and head identity, policy hash/version, verified findings,
evidence and reviewer requirements, check state, overrides, final decision, and
lifecycle transitions. Exports are bounded, authorized JSON/CSV or compliance
packages; full source and diffs are excluded by default and redacted before
output. See [the CCR guide](docs/change-control-records.md) and
[security/data handling](docs/security-and-data-handling.md).

## Deployment

AgentForge is self-hosted; there is no hosted SaaS service. The repository
contains reference packaging for several topologies:

- **Railway** — separate API, worker, and optional web services with managed
  PostgreSQL and Redis; see [docs/railway-deployment.md](docs/railway-deployment.md).
- **Cloudflare** — outbound Tunnel for API/webhook/dashboard exposure, with an
  optional Pages dashboard; see [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).
- **Kubernetes** — multi-stage images and a hardened Helm chart under
  `deploy/helm/agentforge`.
- **AWS** — ECS, RDS, and ElastiCache Terraform under `deploy/terraform/aws`.
- **Docker** — build an `api`, `worker`, or `web` target from the root
  [Dockerfile](Dockerfile); pass a pinned base-image digest at build time.

For a production migration, run `pnpm db:deploy` once, then start the API,
worker, and optional dashboard with `pnpm start:api`, `pnpm start:worker`, and
`pnpm start:web`. Never run `prisma migrate dev` against a hosted production
database. Terminate TLS at the ingress, keep Postgres/Redis private, configure
backups, and complete the [runbook](docs/runbook.md) before webhook cutover.

## Mobile operator consoles

The Android and iOS apps are read-only operational clients. They call the public
`/health` and `/ready` endpoints, persist API/dashboard URL settings locally,
interpret queue/database/runtime readiness, and hand GitHub sign-in to the
dashboard OAuth route. Deployed URLs must use HTTPS; plain HTTP is accepted
only for local development hosts.

```bash
(cd apps/android && ./gradlew testDebugUnitTest assembleDebug)
(cd apps/ios/AgentForge && xcodegen generate && swift test --package-path Packages/AgentForgeCore)
```

Both builds run in `.github/workflows/mobile.yml`. Android instrumentation
tests require an attached emulator/device and are separate from unit tests.

## Validation

The normal local quality ladder is:

```bash
pnpm db:generate
pnpm prisma:validate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm fixtures:run
pnpm build
pnpm audit --audit-level moderate
pnpm release:check
git diff --check
```

With the Compose stack running and seeded, add:

```bash
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
```

The release CI additionally runs security, CodeQL, dependency review, E2E,
mobile, Socket, and Merge Guard workflows. A green local suite or CI run proves
the tested repository revision only; it is not proof of a deployed service,
signing, device availability, or App Store publication.

## Boundaries and known limitations

- Merge Guard is self-hosted and GitHub-first; workspace packages remain
  `private: true` and are not published to npm.
- Durable production state and duplicate-delivery protection require PostgreSQL
  and Redis. In-memory mode is intentionally limited to tests and demos.
- Exports use authorized API jobs. A production object-storage export adapter is
  reserved for later work; MinIO in Compose is an experiment surface.
- There is no username/password authentication. Use GitHub OAuth or a trusted
  identity proxy.
- AI/LLM output is optional, disabled by default, advisory only, and never a
  blocking input. Governance-health and detector-precision metrics are useful
  heuristics, not correctness or recall guarantees.
- Mobile clients are monitoring and OAuth-handoff consoles, not administrative
  clients and not infrastructure clients.
- Loom is pre-1.0. Its prototype packages have broad tested coverage, but the
  Phase 4 30-day pilot remains outstanding and no full native conformance claim
  is made.

## Further documentation

- [Changelog](CHANGELOG.md) and [v1.2.0 release notes](RELEASE_NOTES.md)
- [Product overview](docs/product-overview.md)
- [Policy-as-code](docs/policy-as-code.md) and [policy packs](docs/policy-packs.md)
- [Authentication](docs/auth.md) and [GitHub App setup](docs/github-app-setup.md)
- [CCR and export model](docs/change-control-records.md)
- [Security and data handling](docs/security-and-data-handling.md)
- [Self-hosting](docs/self-hosting.md) and [runtime boundaries](docs/runtime-boundaries.md)
- [Tenant isolation/RLS](docs/tenant-isolation-rls.md)
- [Testing strategy](docs/testing.md)
- [Railway](docs/railway-deployment.md), [Cloudflare](docs/cloudflare-deployment.md),
  [Helm](deploy/helm/agentforge), and [AWS Terraform](deploy/terraform/aws)
- [Loom specification index](docs/loom/README.md), [detailed design](docs/loom/loom-detailed-design.md),
  [merge/reapply engine](docs/loom/reapply-merge-engine.md), [wire protocol](docs/loom/wire-protocol.md),
  [validation plan](docs/loom/validation-plan.md), and [pilot runbook](docs/loom/pilot-runbook.md)
- [Contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), and
  [release checklist](docs/release-checklist.md)
