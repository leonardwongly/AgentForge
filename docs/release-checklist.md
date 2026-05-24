# Public OSS Release Checklist

Use this checklist before making the repository public or cutting a tagged release.

## Repository Metadata

- [ ] `LICENSE` is present and matches Apache-2.0.
- [ ] `NOTICE` is present.
- [ ] `README.md` describes setup, architecture, configuration, testing, GitHub App setup, and security posture.
- [ ] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md` are present.
- [ ] Issue templates, PR template, CODEOWNERS, Dependabot, CodeQL, dependency review, and CI workflows are enabled.
- [ ] `.gitignore` excludes local metadata, logs, build output, coverage, Playwright output, and `.env` files.

## Secret And Data Hygiene

- [ ] `git ls-files | grep -E '(^|/)\.DS_Store$|(^|/)\.env($|\.)|(^|/)playwright-report/|(^|/)test-results/'` returns no committed local artifacts.
- [ ] `git grep -nE 'ghp_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN .*PRIVATE KEY-----' -- . ':!**/*.test.ts' ':!fixtures/repos/secret-like-token.json' ':!packages/security/src/redaction.ts' ':!.github/workflows/security.yml'` returns no real secrets.
- [ ] `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false`, `SOURCE_CODE_STORAGE=false`, and `REDACT_SECRETS=true` are documented as production defaults.
- [ ] Exports and dashboard views are verified to exclude raw source code and secrets under the default storage policy.

## Auth And GitHub App Readiness

- [ ] Trusted proxy auth is documented and requires signed API actor forwarding.
- [ ] Built-in GitHub OAuth is documented and requires `SESSION_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`.
- [ ] `GITHUB_APP_SLUG` creates an in-dashboard install link.
- [ ] Installations remain `pending_approval` until a platform admin approves them.
- [ ] Installation removal archives/disables repository records instead of deleting history.
- [ ] Team reviewer approval behavior documents the `Members: read` permission requirement.

## Validation

Run:

```bash
pnpm db:generate
pnpm prisma:validate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm fixtures:run
pnpm build
pnpm audit --audit-level high
```

With local services:

```bash
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
```

Manual browser QA:

- [ ] Fresh database starts with no repository connected.
- [ ] Onboarding offers GitHub App installation or local sample preview.
- [ ] Sample preview creates a repository, a Change Control Record, and a matching active policy pack.
- [ ] Settings can save repository mode, policy pack, owner mappings, and retention controls.
- [ ] GitHub installation can be recorded manually, approved, and shown as verified.
- [ ] Dashboard action queues distinguish open evidence from approved evidence.
- [ ] Record detail, evidence, reviewer, override, export, policy preview, and policy settings pages load without framework or console errors.
