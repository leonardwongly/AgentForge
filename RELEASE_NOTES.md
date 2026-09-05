# AgentForge Merge Guard v1.2.0

AgentForge Merge Guard v1.2.0 expands the self-hosted GitHub governance
runtime with operational tooling, governance evidence, tamper-evident audit
streaming, deployment packaging, and a substantially hardened Loom prototype.

> Deterministic checks decide. AI explains and assists. Humans approve risk.

## Highlights

### Merge Guard runtime

- Added `pnpm doctor` for toolchain, Docker, Postgres, Redis, and MinIO
  readiness, plus non-destructive `pnpm setup` for fresh local clones.
- Added per-detector precision proxies, a composite governance-health score, and
  `pnpm design-partner:report` for CCR-based validation evidence. Tuning
  proposals remain human-gated and are never auto-applied.
- Added tamper-evident audit-chain construction and verification, optional
  `AUDIT_STREAM_WEBHOOK_URL` delivery, and blocked-PR notifications through
  `NOTIFICATION_WEBHOOK_URL`.
- Added an explicitly gated sample-preview onboarding path for deployed
  environments and a bounded deterministic evaluation benchmark.
- Added multi-stage Docker targets, a hardened Helm chart, AWS ECS/RDS/
  ElastiCache Terraform packaging, and Cloudflare Tunnel/Pages references.

### Security and reliability

- Hardened trusted-proxy identity with mandatory nonces, request-time
  header-stripping enforcement, replay-cache bounds, and stronger production
  secret validation.
- Bound Postgres tenant isolation to the same transaction as the scoped query,
  added relevant foreign-key/restrict constraints, and documented the required
  non-superuser RLS role.
- Made retention deletion and its audit event atomic, made repeatable worker
  schedules idempotent, and prevented stale synchronized-PR evaluations from
  overwriting newer GitHub check results.
- Honored GitHub retry/rate-limit hints and corrected detector false positives
  for coverage-threshold and skipped-test findings.
- Pinned service images and third-party actions in CI, kept dependency review
  and moderate-level audit gates blocking, and closed the adversarial sweep's
  malformed-input, resource-boundary, race, state-corruption, and confused-user
  regressions.

### Loom research program

- Added and tested native Loom slices for canonical DAG-CBOR/CID addressing,
  binary-safe content, durable content-addressed storage and journals, working
  copies, merge/reapply, Grants and key lifecycle, proposals/admission, ledger,
  replication, garbage collection, backup/restore, Git fidelity, agent
  sessions/work graphs, Wire v1, provenance, witnessed trust, and the native
  `@agentforge/loom-agent` SDK.
- Extended the private `loom` CLI with `init`, `status`, `propose`, `log`, and
  the `pilot mirror|verify|restore` commands.
- Loom remains pre-1.0. The Phase 4 dual-safety pilot tooling is available, but
  the required operational 30-day pilot has not run; this release makes no
  `LOOM-CORE` conformance claim.

## Validation

The release branch was validated with:

- `CI=true pnpm test` — 126 files, 1,372 passed, 8 skipped; coverage was
  80.03% statements, 70.95% branches, 83.84% functions, and 80.12% lines.
- `pnpm test:integration` — 16 files, 148 passed, 8 skipped.
- `pnpm test:e2e` — 16 Chromium tests passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm fixtures:run`,
  `pnpm prisma:validate`, and `pnpm release:check` — passed.
- `pnpm audit --audit-level moderate` and `pnpm audit --json` — no known
  vulnerabilities (0 informational/low/moderate/high/critical findings).
- Android unit tests and debug assembly, plus iOS Swift package tests and
  simulator build — passed. Android instrumentation was not run because no
  emulator or device was attached.
- Post-merge `main` workflows on the release predecessor (`004c694`) were green
  for CI, E2E, CodeQL, Security, Mobile, Merge Guard, Socket, dependency
  review, and Dependabot Updates.

Docker build checks requiring a running Docker daemon and Helm/Terraform CLI
validation were not available in the local environment. No production
deployment, signing, device, App Store, or hosted-service claim is implied by
the local results above.

## Deployment scope and security contract

This is a self-hosted release. A production deployment needs Node.js 22.13 or
newer, pnpm 11.1.1, PostgreSQL, Redis, a GitHub App, signed webhooks, and either
GitHub OAuth with configured allowlists or a trusted authentication proxy.
Production startup fails closed when source-code storage, unsigned webhooks,
secret redaction, proxy signing, header stripping, or local actor fallbacks are
unsafe. Use a non-superuser, non-`BYPASSRLS` database role for the RLS backstop.

Exports are authorized API jobs and exclude full source by default. MinIO and
object-storage variables remain an experiment/future-adapter surface. AI/LLM
features are disabled by default and advisory only.

See [README.md](README.md), [docs/self-hosting.md](docs/self-hosting.md),
[docs/auth.md](docs/auth.md), [docs/github-app-setup.md](docs/github-app-setup.md),
[docs/railway-deployment.md](docs/railway-deployment.md), and
[docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).

## Upgrade and rollback

Upgrade from v1.1.0 by deploying the v1.2.0 application revision, applying
database migrations once with `pnpm db:deploy`, and restarting the API, worker,
and optional dashboard services. Review the production configuration contract
and tenant-isolation role requirements before accepting public traffic.

If a migration or deployment is not backward-compatible, restore the database
from a verified backup before reverting application code. If webhook delivery
fails, point the GitHub App back to the previous known-good endpoint while
keeping unsigned webhooks disabled. Do not rewrite public git history after
tagging this release.
