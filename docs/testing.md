# Testing Strategy

Test layers:

- Unit tests for policy parsing, validation, applicability scoping, mode resolution, detectors, evidence, reviewer routing, status mapping, redaction, overrides, and records.
- Integration tests for webhook ingestion, duplicate delivery handling, policy preview, evidence updates, override flow, and export flow.
- End-to-end tests for dashboard rendering and primary navigation.
- Performance sanity tests for large changed-file lists and repeated synchronize events.
- Security tests for webhook signature validation, read-only previews, redaction, LLM disabled mode, unauthorized override rejection, and source-excluding exports.

Fixture scenarios live under `fixtures/repos`:

1. README-only PR
2. Billing path changed
3. Billing path changed with agent signal
4. CI workflow changed
5. Deleted test file
6. Skipped test
7. Assertion weakening
8. Dependency added
9. Major dependency bump
10. Database migration added
11. Secret-like token in diff
12. Override
13. Policy update after PR opens

Run fixtures:

```bash
pnpm fixtures:run
```

Run tests:

```bash
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
pnpm smoke:e2e-readiness
pnpm format:check
```

## Browser And E2E Smoke Path

The supported automated browser path is Playwright through `pnpm test:e2e`.
That script performs an E2E preflight, takes an advisory lock, builds
`@agentforge/web` once, then starts isolated API and web servers through the
Playwright `webServer` configuration. This avoids running `next build` inside
the Playwright server lifecycle, where parallel local builds can leave Next's
build lock in an ambiguous state.

Default E2E endpoints are isolated from the normal dev ports:

- web: `http://127.0.0.1:3100`
- API: `http://127.0.0.1:4100`

Override them with `APP_BASE_URL` and `API_BASE_URL` only when those ports are
unavailable. `pnpm test:e2e:preflight` fails early if the API and web targets
share a port, if a target port is already occupied, if another `pnpm test:e2e`
run holds the AgentForge E2E lock, or if a native Next build lock is present.
The error message names the blocking resource and the corrective action.

For manual smoke checks against already-running local services, run:

```bash
pnpm smoke:e2e-readiness
```

Browser-use CLI and Computer Use are optional operator tools for exploratory
assessment. They are not required for CI or for the supported local E2E path; if
one is unavailable, treat that as an environment limitation and use Playwright
for product validation.

## Runtime Dependencies

`pnpm test` is expected to be deterministic from a clean shell and should not
require Postgres or Redis unless a test explicitly opts into a runtime-backed
path. Test cases that exercise in-memory API state set `NODE_ENV=test`; the API
and worker must not leak local `DATABASE_URL` or `REDIS_URL` defaults back into
`process.env` during those runs.

Database-backed validation uses the local Compose services:

```bash
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm test:integration
pnpm test:e2e
```

The local Postgres URL is
`postgresql://agentforge:agentforge@localhost:15432/agentforge`. Keep DB-backed
tests explicit so production-mode auth and config tests can verify fail-closed
behavior without depending on a live local database by accident.
