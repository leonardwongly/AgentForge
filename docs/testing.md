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
pnpm test:e2e
pnpm format:check
```

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
