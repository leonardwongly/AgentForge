# AgentForge Merge Guard v1.0.0

AgentForge Merge Guard v1.0.0 is the first public release candidate for the self-hosted GitHub pull request governance service.

Deterministic checks decide. AI explains and assists. Humans approve risk.

## Unreleased Since v1.0.0

Security-hardening work in progress on top of the v1.0.0 baseline. Not yet tagged.

### Highlights

- Mandatory signature nonce enforcement for trusted-proxy identity on both the API and dashboard, closing a replay window that the optional-nonce legacy payload shape left open.
- Header-stripping attestation is now enforced at request time, not just at config load: the API rejects requests carrying raw actor headers alongside or instead of the signed header set when proxy trust is enabled.
- Weak production secrets (`SESSION_SECRET`, `GITHUB_WEBHOOK_SECRET`, `AGENTFORGE_API_PROXY_SECRET`, `AGENTFORGE_DASHBOARD_PROXY_SECRET`) are now rejected below a 32-character minimum or against a common-placeholder denylist.
- Postgres Row-Level Security tenant binding now sets the `agentforge.current_org` session GUC inside the same interactive transaction as the scoped query, closing a pooled-connection gap. See [docs/tenant-isolation-rls.md](docs/tenant-isolation-rls.md).
- Retention-sweep deletes and their audit-event write are now atomic, so a crash mid-sweep can no longer leave an undocumented deletion.
- Detector precision fixes for `coverage_threshold_reduced` and `test_skipped` to reduce false-positive blocking findings.

### Security Posture

- Trusted-proxy identity replay protection now requires a nonce on every signed request on both the dashboard and API paths; the pre-nonce legacy signing scheme is no longer accepted.
- Header-stripping is verified per-request, not only attested at startup.
- Production secret strength is enforced with a minimum length and placeholder denylist.
- Tenant isolation via Postgres RLS is bound within the same transaction as the query it scopes.

See [docs/self-hosting.md](docs/self-hosting.md) for the current production security contract.

## Highlights

- GitHub App webhook ingestion with signed webhook verification, durable delivery records, queue handoff, replay controls, and GitHub check publication.
- Policy-as-code evaluation with built-in policy packs, YAML validation, policy previews, required evidence, reviewer routing, CODEOWNERS support, and repository-level policy settings.
- Change Control Records with lifecycle state, decision trails, evidence and reviewer requirements, overrides, audit events, exports, and compliance evidence packages.
- Next.js dashboard for first-user onboarding, repositories, settings, records, policy insights, policy violations, evidence completion, overrides, and GitHub installation approval.
- GitHub App installation linking that keeps installations pending until a `platform_admin` approves them.
- GitHub OAuth dashboard sessions and trusted-proxy identity support. Password login is intentionally not part of v1.0.
- Production fail-closed configuration for webhook signing, proxy identity, local actor fallbacks, source-code storage, secret redaction, and session/OAuth settings.
- Redis-backed worker queue with bounded retries, safe failure summaries, readiness checks, and platform-admin replay controls.

## Deployment Scope

This release is intended for self-hosted deployments. A production deployment needs:

- Node.js 22.13 or newer.
- pnpm 11.1.1.
- Postgres.
- Redis.
- GitHub App credentials.
- `GITHUB_WEBHOOK_SECRET`.
- GitHub OAuth credentials or a trusted authenticated proxy.
- `AGENTFORGE_API_PROXY_SECRET` when forwarding dashboard identity to the API.
- `SESSION_SECRET` when built-in GitHub OAuth is enabled.

See:

- [README.md](README.md)
- [docs/auth.md](docs/auth.md)
- [docs/github-app-setup.md](docs/github-app-setup.md)
- [docs/runbook.md](docs/runbook.md)
- [docs/railway-deployment.md](docs/railway-deployment.md)

## Validation

The release candidate commit passed:

- `pnpm format:check`
- `pnpm lint`
- `pnpm test`
- `pnpm test:integration`
- `pnpm test:e2e`
- `pnpm typecheck`
- `pnpm build`
- `pnpm release:check`
- `git diff --check`
- GitHub CI
- GitHub Security workflow
- GitHub CodeQL workflow

## Security Posture

- GitHub webhooks fail closed in production unless signed with the configured secret.
- Raw local actor headers are local-development only and are rejected in production.
- Trusted proxy mode requires ingress to strip spoofable identity headers before injecting trusted identity.
- Dashboard-to-API trusted identity forwarding is signed with `AGENTFORGE_API_PROXY_SECRET`.
- GitHub OAuth sessions are signed and use secure cookies in production.
- Source-code storage is disabled by default.
- Secret redaction is enabled by default.
- Queue inspection and replay are platform-admin-only because queue state is platform-wide.

Security reports should follow [SECURITY.md](SECURITY.md).

## Known Limitations

- This release does not include username/password authentication.
- This release is not an npm package publication; workspace packages remain private to npm while the repository can be public on GitHub.
- Object-storage exports are not productionized in v1.0; exports are delivered through authorized API jobs.
- AI/LLM features are advisory only and disabled by default.
- Live GitHub App smoke validation requires a disposable repository in an owned organization and valid GitHub App credentials.

## Upgrade And Rollback

This is the first public release, so there is no public upgrade path from an earlier tagged version.

Rollback options:

- Revert the deployment to the previous application image or commit.
- Restore the database from backup if migrations were applied and rollback is not schema-compatible.
- Remove or replace the `v1.0.0` GitHub Release if publication metadata is incorrect.

Do not rewrite public git history after making the repository public unless a secret exposure requires coordinated credential rotation and history remediation.
