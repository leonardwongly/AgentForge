# Merge Guard Launch Runbook

This runbook is the production handoff checklist for AgentForge Merge Guard.

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
4. Run `pnpm db:migrate`.
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
- no source code, raw patches, secrets, or private key material appears in records, dashboard responses, logs, or exports.

## Queue Operations

- Retry failed BullMQ jobs only after confirming the failure is idempotent.
- A job may be retried for GitHub API timeout, transient database failure, or check publication timeout.
- A job should not be retried blindly for invalid policy YAML, disabled repositories, missing GitHub installation credentials, or authorization/configuration failures.
- Keep webhook delivery idempotency enabled through the `WebhookDelivery.deliveryId` unique constraint.

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
