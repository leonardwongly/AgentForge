# Merge Guard Launch Runbook

This runbook is the production handoff checklist for AgentForge Merge Guard.
Initial V1 launch-readiness evidence is recorded in `docs/launch-readiness-evidence.md`.

## Runtime Topology

Run three processes with the same release artifact and compatible environment:

- API: receives GitHub webhooks, validates signatures, serves dashboard/API routes, and enqueues evaluations.
- Worker: consumes `merge-guard-evaluations`, hydrates PR facts from GitHub, runs deterministic policy, persists Change Control Records, and publishes the Merge Guard check.
- Web: serves the Next.js dashboard and server actions for onboarding and settings.

Required backing services:

- PostgreSQL for policy versions, repositories, Change Control Records, audit events, exports, and webhook delivery idempotency.
- Redis for BullMQ worker dispatch.
- Optional object storage for export delivery when `EXPORT_STORAGE_BUCKET` is configured.

## Environment Gate

Set these values before launch:

- `NODE_ENV=production`
- `DATABASE_URL`
- `REDIS_URL`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `APP_BASE_URL`
- `API_BASE_URL`
- `SESSION_SECRET`
- `DEFAULT_POLICY_MODE=observe` for initial rollout, then move repositories to `warn`, `enforce`, and `optimize`.
- `SOURCE_CODE_STORAGE=false`
- `FULL_DIFF_RETENTION=disabled`
- `REDACT_SECRETS=true`
- `LLM_FEATURES=false` unless advisory features have a separate approval.

Keep `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false` in every shared or deployed environment.

In production, configuration loading fails closed when the webhook secret is missing, unsigned webhooks are enabled, source-code storage is enabled, or secret redaction is disabled.

## Auth Proxy Contract

Deploy the dashboard/API behind an authenticated ingress. The ingress must strip untrusted client-supplied actor headers and inject trusted identity headers only after authentication:

- `x-agentforge-authenticated-actor`
- `x-agentforge-authenticated-role`

Set `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true` only after the ingress is verified to strip spoofed `x-agentforge-*` and `x-agentforge-authenticated-*` headers. Do not use `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR` in production.

Set `AGENTFORGE_API_TRUST_PROXY_HEADERS=true` for deployed API traffic after the same ingress stripping check passes. Keep `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=false` outside isolated local production-mode smoke tests.

## Migration Order

1. Stop the worker or pause queue consumption.
2. Back up PostgreSQL.
3. Run `pnpm prisma:validate`.
4. Run `pnpm db:deploy` for deployed environments. Use `pnpm db:migrate` only for local development migrations.
5. Run `pnpm db:seed` when built-in policy packs changed.
6. Start API and web.
7. Start worker.
8. Verify `/health` reports configured database and worker queue.

Rollback rule: if a migration was applied, roll back with a database restore or a reviewed backward migration. Do not manually edit Prisma migration history.

## GitHub App Gate

Install the GitHub App on a test repository first. Required events:

- `pull_request`
- `pull_request_review`
- `check_run`
- `installation`
- `installation_repositories`

Required permissions:

- Pull requests: read/write
- Checks: read/write
- Contents: read
- Metadata: read
- Members: read for GitHub-verified team reviewer approvals
- Issues: read/write only if PR-visible notes are enabled

Branch protection should require the `AgentForge Merge Guard` check before enforce or optimize mode is used as a merge gate.

If `Members: read` is missing or the membership lookup fails, team reviewer requirements remain pending. This is intentional fail-closed behavior; do not move repositories into enforce mode until a test PR proves team approvals clear correctly.

Use Settings > Routing diagnostics during setup. A repository with team owner mappings should show the Members permission as required, and PR reviewer requirements should include the matched policy route plus membership-verification state when a user approval cannot be associated with a GitHub team. For CODEOWNERS-assisted setup, `POST /api/codeowners/preview` with the file content and representative changed paths to generate normalized owner-mapping suggestions before saving repository settings.

## Repository Protection Gate

Before launch, enable branch protection on `main` and require these GitHub checks:

- `CI`
- `Security`
- `E2E`
- `AgentForge Merge Guard` after the GitHub App publish smoke passes

Verify protection is active:

```bash
gh api repos/<owner>/<repo>/branches/main/protection --jq '.required_status_checks.contexts'
```

The protection endpoint must not return `404 Branch not protected` before any repository moves to `enforce` or `optimize`.

## Launch Smoke Tests

Run these before enabling protected-branch enforcement:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm prisma:validate
pnpm db:generate
pnpm build
pnpm test:e2e
pnpm audit --audit-level high
pnpm fixtures:run
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
curl -fsS "$API_BASE_URL/health"
```

Run the GitHub App read-only smoke test against a test PR before sending real webhooks:

```bash
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
```

This verifies that the installed GitHub App can mint an installation token, read PR metadata, files, commits, reviews, manifest contents, and evaluate policy without publishing a check. After the read-only smoke passes, re-run with `--publish-check` on the same test PR to verify `Checks: read/write` and check-run output.

Then create a test PR that changes a sensitive path and confirm:

- the webhook delivery is accepted once and duplicates are ignored;
- the worker fetches changed files from GitHub;
- the `AgentForge Merge Guard` check is published;
- the Change Control Record includes deterministic findings, approved-or-open evidence, reviewers, mode, override history, and decision;
- the normalized evaluation, fact, evidence, reviewer, check-run, and override rows are written;
- the export includes schema-versioned audit events for evidence, reviewer, override, settings, check-publication, and export lifecycle actions;
- no source code, raw patches, secrets, or private key material appears in records, dashboard responses, logs, or exports.

## Queue Operations

- `/health` stays lightweight and safe for load balancers. `/ready` performs a
  worker-queue probe; if `REDIS_URL` is configured but Redis or BullMQ is not
  reachable, `/ready` returns `not_ready` while `/health` remains `ok`.
- `GET /api/admin/queue` requires `platform_admin`, `engineering_manager`, or
  `auditor`. It returns queue counts, bounded retry settings, and sanitized
  failure summaries only. It must not include webhook payloads, source patches,
  tokens, installation credentials, or raw BullMQ job data.
- Evaluation jobs use three attempts with exponential backoff starting at 30
  seconds. Completed jobs retain the last 100 job records; failed jobs retain
  the last 500 job records for incident review.
- Retry failed BullMQ jobs only after confirming the failure is idempotent. A
  job may be retried for GitHub API timeout, transient database failure, or
  check publication timeout.
- Do not blindly retry invalid policy YAML, disabled/unconfigured repositories,
  missing GitHub installation credentials, missing pull request payloads, or
  authorization/configuration failures. These are terminal until configuration
  or payload data changes.
- Failed evaluations update `WebhookDelivery` with attempts, terminal-failure
  state, a safe error class/message, and the webhook delivery ID as correlation
  ID. Inspect these fields before replaying an incident.
- `POST /api/admin/queue/replay` requires `platform_admin` or
  `engineering_manager` and accepts either `{ "deliveryId": "..." }` or
  `{ "repositoryFullName": "owner/repo", "pullRequestNumber": 123 }`.
  Replay enqueues a new evaluation job using the stored delivery envelope,
  increments replay counters, and emits a `webhook_replayed` audit event. The
  original `WebhookDelivery.deliveryId` unique constraint remains the
  idempotency source of truth.
- For stuck jobs, first check `/ready`, then `GET /api/admin/queue`, then
  Railway worker logs. If Redis is unavailable, restore Redis connectivity
  before replaying. If GitHub API failures are transient, wait for bounded
  retries before replaying. If the failure is terminal, fix the configuration,
  repository policy, or GitHub App permissions first.
- For failed GitHub API calls, verify installation permissions, repository
  access, rate-limit status, and that the webhook delivery contains a pull
  request number. Then replay only the affected delivery or PR.
- For webhook replay, prefer delivery ID replay during incident response. PR
  replay uses the most recent stored delivery for that PR and is useful when the
  GitHub delivery ID is not immediately available.

## Incident Response

For false blocks:

1. Switch the affected repository to `warn` or `observe`.
2. Record an override only with an authorized actor and a reason.
3. Export the Change Control Record for audit.
4. Add a regression fixture and policy test before returning to `enforce` or `optimize`.

For false passes:

1. Remove `AgentForge Merge Guard` from required checks only if it is blocking incident recovery.
2. Move affected repositories to `observe`.
3. Preserve webhook delivery IDs, worker logs, policy version, and Change Control Records.
4. Patch detectors or policy routing, rerun smoke tests, then re-enable the required check.

For suspected secret exposure:

1. Rotate the secret outside AgentForge.
2. Confirm redaction in records, exports, logs, and dashboard responses.
3. Purge generated exports that may include the exposed value.
4. Add a redaction regression test.

## Export Retention

Exports are audit artifacts and may contain sensitive metadata even when source code is excluded. Store exports only in approved storage, restrict access to auditors/platform administrators, and purge temporary export jobs according to `AUDIT_RECORD_RETENTION_DAYS` or stricter organizational policy.

## Adoption Path

- `observe`: collect facts and records without blocking.
- `warn`: publish non-blocking warnings and tune evidence/reviewer policy.
- `enforce`: make missing required evidence or approvals block merge.
- `optimize`: keep enforce behavior active while tuning reviewer load, evidence quality, override rate, detector coverage, and operational metrics.
