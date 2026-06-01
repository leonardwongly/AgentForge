# Public OSS Release Checklist

Use this checklist before making the repository public or cutting a tagged release.

## Repository Metadata

- [ ] `LICENSE` is present and matches Apache-2.0.
- [ ] `NOTICE` is present.
- [ ] `README.md` describes setup, architecture, configuration, testing, GitHub App setup, and security posture.
- [ ] `CHANGELOG.md` and `RELEASE_NOTES.md` include the intended `v1.0.0` release summary.
- [ ] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md` are present.
- [ ] Issue templates, PR template, CODEOWNERS, Dependabot, CodeQL, dependency review, and CI workflows are enabled.
- [ ] `.gitignore` excludes local metadata, logs, build output, coverage, Playwright output, and `.env` files.
- [ ] Workspace manifests intentionally keep `private: true` while reporting the release version.

## Secret And Data Hygiene

- [ ] `git ls-files | grep -E '(^|/)\.DS_Store$|(^|/)\.env($|\.)|(^|/)playwright-report/|(^|/)test-results/|(^|/)\.gradle/|(^|/)local\.properties$|(^|/)build/outputs/|(^|/)DerivedData/|\.xcuserdata/|\.(apk|aab)$|^artifacts/' | grep -v '^\.env\.example$'` returns no committed local artifacts.
- [ ] Run the secret-grep command from `.github/workflows/security.yml` locally and confirm it returns no real secrets.
- [ ] Run `gitleaks detect --source . --redact --config .gitleaks.toml` locally and confirm only explicitly allowlisted test fixtures are ignored.
- [ ] Run `pnpm release:check` and confirm it passes.
- [ ] Run a git-history secret scan before changing repository visibility to public, for example `gitleaks detect --source . --redact --config .gitleaks.toml --log-opts="--all"`. If a real secret is found, rotate it before deciding whether history remediation is required.
- [ ] `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false`, `SOURCE_CODE_STORAGE=false`, and `REDACT_SECRETS=true` are documented as production defaults.
- [ ] Exports and dashboard views are verified to exclude raw source code and secrets under the default storage policy.

## Auth And GitHub App Readiness

- [ ] Trusted proxy auth is documented and requires signed API actor forwarding.
- [ ] Built-in GitHub OAuth is documented and requires `SESSION_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`.
- [ ] `GITHUB_APP_SLUG` creates an in-dashboard install link.
- [ ] Installations remain `pending_approval` until a platform admin approves them.
- [ ] Installation removal archives/disables repository records instead of deleting history.
- [ ] Team reviewer approval behavior documents the `Members: read` permission requirement.
- [ ] A disposable repository is created under an owned GitHub organization for live GitHub App validation.
- [ ] Cloudflare Tunnel exposes the local API webhook endpoint at `https://<host>/webhooks/github`.
- [ ] OAuth sign-in, GitHub App installation, callback recording, admin approval, repository sync, and signed webhook delivery are validated against the disposable repository.
- [ ] `pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <id>` completes without printing source, patches, tokens, or credentials.
- [ ] The same smoke command with `--publish-check` publishes the `AgentForge Merge Guard` check run on the disposable pull request.

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
pnpm audit --audit-level moderate
pnpm release:check
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
- [ ] Built-in GitHub OAuth does not show a sign-out action unless the current actor came from a session.
- [ ] Owner-mapping validation preserves typed values and shows inline guidance for malformed team/user routes before submitting.
- [ ] Dashboard action queues distinguish open evidence from approved evidence.
- [ ] Record detail, evidence, reviewer, override, export, policy preview, and policy settings pages load without framework or console errors.

## Tag And Publication

- [ ] Merge release-readiness changes to `main`.
- [ ] Confirm `CI`, `Security`, `CodeQL`, blocking dependency review, and E2E workflows pass on `main`.
- [ ] Create and push the `v1.0.0` tag.
- [ ] Create the GitHub Release from `RELEASE_NOTES.md`.
- [ ] Set repository topics, homepage/docs URL, and description.
- [ ] Switch repository visibility to public only after secret/history scan and fresh-clone validation are complete.
- [ ] Verify the public anonymous repository page shows README, license, security policy, and the `v1.0.0` release.
