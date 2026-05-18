# Launch Readiness Evidence

This document closes the launch-readiness tracker for AgentForge Merge Guard V1.
It records the evidence available at the point of initial production-integrated
launch validation and the commands used to re-check the state.

Date: 2026-05-18

Tracked issue: <https://github.com/leonardwongly/AgentForge/issues/2>

## Scope

V1 launch readiness covers deterministic pull request governance only:

- signed GitHub webhook ingestion;
- duplicate delivery idempotency;
- BullMQ-backed worker evaluation;
- deterministic policy, detector, evidence, and reviewer evaluation;
- GitHub check publication;
- persisted Change Control Records;
- dashboard visibility and exports;
- metadata-only, redacted storage by default;
- production fail-closed configuration;
- observe-first rollout.

V1 intentionally does not include autonomous merging, LLM-based blocking,
semantic architecture review, prompt/session replay, IDE extensions, or full
agent orchestration.

## Implementation Evidence

| Area                    | Evidence                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime topology        | `apps/api`, `apps/worker`, and `apps/web` are separate deployable services with shared `pnpm railway:build` and service-specific start commands.                                                                                          |
| Backing services        | Railway health reports database and worker queue configured, runtime store `postgres`, and unsigned webhook mode disabled.                                                                                                                |
| GitHub App flow         | PR #3 published a live `AgentForge Merge Guard` check with persisted record URL: <https://agentforge-web-production.up.railway.app/records/c8c7e9a8-3126-4c68-96d2-1627c69e21bf>.                                                         |
| Branch protection       | `main` requires strict, up-to-date `ci`, `security`, `e2e`, and `AgentForge Merge Guard` checks.                                                                                                                                          |
| Policy packs            | Built-in policy packs are covered by `packages/policy/src/packs.test.ts` and `pnpm policy:validate`.                                                                                                                                      |
| Production config gates | `packages/config/src/index.test.ts` covers production fail-closed behavior for missing webhook secret, unsigned webhooks, source-code storage, and disabled redaction.                                                                    |
| API security            | `apps/api/test/security-hardening.test.ts` covers signed webhook rejection paths, server-resolved actors, production local-header rejection, role-gated settings, override authorization, redacted records, and source-excluding exports. |
| Dashboard behavior      | Web data loading and production-like actor context are covered by `apps/web/app/data.test.ts`, `apps/web/app/settings/actor-context.test.ts`, and Playwright E2E tests.                                                                   |
| Worker behavior         | `apps/worker/test/worker.test.ts` covers queue processing, runtime persistence, check publishing, webhook-triggered jobs, and non-PR event handling.                                                                                      |
| GitHub smoke tooling    | `scripts/smoke-github-app.ts` can run read-only GitHub App validation and optional check publication without printing source, patches, tokens, credentials, or installation tokens.                                                       |
| Operations docs         | `docs/runbook.md`, `docs/railway-deployment.md`, `docs/github-app-setup.md`, and `docs/testing.md` document setup, deployment, smoke, rollback, incident response, and adoption.                                                          |

## Live Verification Commands

Run from the repository root.

```bash
curl -fsS https://agentforge-api-production-5fc1.up.railway.app/health
curl -fsSI https://agentforge-web-production.up.railway.app/records/c8c7e9a8-3126-4c68-96d2-1627c69e21bf
gh pr checks 3 --repo leonardwongly/AgentForge
gh api repos/leonardwongly/AgentForge/branches/main/protection \
  --jq '{required_status_checks:.required_status_checks.contexts, strict:.required_status_checks.strict}'
```

Expected health output:

```json
{
  "status": "ok",
  "database": "configured",
  "workerQueue": "configured",
  "runtimeStore": "postgres",
  "unsignedWebhookMode": "disabled",
  "version": "0.1.0"
}
```

Expected branch-protection output:

```json
{
  "required_status_checks": ["ci", "security", "e2e", "AgentForge Merge Guard"],
  "strict": true
}
```

## Local Validation Commands

These commands are the release gate before changes are merged:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm prisma:validate
pnpm fixtures:run
pnpm railway:build
pnpm audit --audit-level high
```

Database-backed and browser-backed validation additionally require local Compose
services:

```bash
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm test:e2e
```

## GitHub App Smoke

Use a non-production test pull request first:

```bash
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id> --publish-check
```

The first command is read-only. The second command publishes the
`AgentForge Merge Guard` check and should only be used against a test pull
request after the app permissions are verified.

## Data Handling Assertions

Launch readiness depends on these invariants:

- source code blobs are not stored by default;
- full diffs are disabled by default;
- retained snippets are redacted before persistence or output;
- JSON and CSV exports exclude source blobs and raw secrets;
- GitHub webhook secrets, private keys, OAuth secrets, installation tokens, and
  session secrets are never logged;
- LLM features remain disabled by default and cannot affect blocking decisions.

## Rollout State

Initial rollout mode is `observe`. Repositories should move through:

1. `observe` for data collection without blocking;
2. `warn` after findings and records are explainable and non-leaky;
3. `enforce` after evidence and reviewer flows are proven for that repository;
4. `optimize` after teams are stable in enforcement.

Do not enable `enforce` or `optimize` for a repository until a test PR proves
that team reviewer approvals clear correctly and branch protection requires the
`AgentForge Merge Guard` check.

## Rollback

Rollback is documented in `docs/runbook.md` and `docs/railway-deployment.md`.
The shortest operational rollback is to downgrade the affected repository to
`warn` or `observe`, remove `AgentForge Merge Guard` from required checks only
when incident recovery requires it, and point GitHub webhooks back to the last
known-good endpoint if webhook delivery is failing.
