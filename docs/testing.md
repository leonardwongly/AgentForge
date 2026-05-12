# Testing Strategy

Test layers:

- Unit tests for policy parsing, validation, mode resolution, detectors, evidence, reviewer routing, status mapping, redaction, overrides, and records.
- Integration tests for webhook ingestion, duplicate delivery handling, policy preview, evidence updates, override flow, and export flow.
- End-to-end tests for dashboard rendering and primary navigation.
- Performance sanity tests for large changed-file lists and repeated synchronize events.
- Security tests for webhook signature validation, redaction, LLM disabled mode, unauthorized override rejection, and source-excluding exports.

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
```
