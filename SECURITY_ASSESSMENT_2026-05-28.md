# AgentForge Security Assessment - 2026-05-28

## Executive Summary

Overall posture is materially stronger than a typical early-stage control-plane application. The current codebase has production fail-closed configuration checks, signed GitHub webhook verification, HMAC-signed dashboard-to-API identity forwarding, role and tenant checks on most sensitive API surfaces, bounded request sizes, Zod validation, log redaction, source/diff redaction controls, audit events, pinned GitHub Actions, Dependabot, CodeQL, and dependency-audit coverage.

No critical remote-code-execution, SQL injection, command injection, unsafe deserialization, obvious SSRF, committed tracked secret, or intentionally malicious backdoor pattern was identified in this pass. The highest-risk issue found is an unauthenticated policy-preview path that can evaluate against an existing repository's active policy when the caller knows or guesses `repositoryFullName`, exposing governance behavior as an oracle. The second major risk is the intentionally convenient local actor fallback: safe for local-only development, but dangerous if a development/staging dashboard and API are exposed with local actor headers enabled.

Immediate priorities:

1. Require authentication and tenant authorization before `/api/policies/preview` can use stored active policy or repository settings.
2. Make local dashboard/API actor fallback opt-in even outside production, and fail preflight if it is enabled on non-localhost URLs.
3. Move CSP from report-only to enforced production policy and remove `unsafe-eval`/broad `https:` allowances where possible.
4. Harden repository hygiene around untracked mobile app outputs, `.env` backups, and generated artifacts before committing mobile clients.
5. Expand secret scanning and make dependency review blocking for private repositories.

## Scope And Method

Reviewed source, config, infrastructure, CI/CD, env handling, web/API auth, webhook paths, worker paths, Prisma schema/migrations, mobile clients, dependency manifests, and suspicious-code patterns across:

- `apps/api`, `apps/web`, `apps/worker`
- `packages/*`, especially `github`, `records`, `security`, `policy`, `detectors`, `db`
- `.github/workflows/*`, `.github/dependabot.yml`
- `docker-compose.yml`, `.env.example`, ignored local `.env*` inventory
- untracked `apps/android/`, `apps/ios/`, and `artifacts/`

Validation commands run:

- `pnpm audit --audit-level moderate` - passed, no known vulnerabilities
- `pnpm release:check` - passed
- tracked secret grep from `.github/workflows/security.yml` - passed, no matches
- `semgrep scan --config p/owasp-top-ten --config p/secrets --config p/javascript --error ...` - 3 findings; two intentional secret-shaped test fixtures, one Android launcher export warning
- `pnpm --filter @agentforge/security test` - passed, 15 tests
- `pnpm db:generate` - passed, generated Prisma client for local tests
- `pnpm test:integration -- apps/api/test/security-hardening.test.ts apps/api/test/proxy-auth.test.ts apps/api/test/route-contracts.test.ts` - passed after Prisma generation, 92 tests
- focused `pnpm lint -- ...` over reviewed security-sensitive files - passed

The initial focused API security test run failed before `pnpm db:generate` with `@prisma/client did not initialize yet`; rerun passed after generating the Prisma client.

## Findings

### AF-SEC-001 - Unauthenticated Policy Preview Can Use Stored Repository Policy

Severity: High

Affected component:

- `apps/api/src/routes/api-routes.ts:1408-1491`

Evidence:

- The route only requires an API actor when `body.persist` is truthy at lines 1421-1435.
- It resolves a stored repository by `body.pr.repositoryFullName` at lines 1445-1452.
- It falls back to `activePolicy?.contentYaml` when the caller omits `contentYaml` at line 1453.
- It applies repository mode override at lines 1483-1487.
- It returns the full evaluation output for non-persisted previews at lines 1489-1491.

Exploitation scenario:

An unauthenticated remote caller sends `POST /api/policies/preview` with a guessed or observed private `repositoryFullName` and an attacker-controlled PR object. If the repository exists and has an active policy, the API evaluates against that stored policy without checking the caller's organization. The response can be used as a policy oracle to infer policy pack/version behavior, blocking conditions, reviewer requirements, and mode behavior.

Potential impact:

- Reconnaissance against private governance policy.
- Abuse of preview as a side-channel to learn how to craft PRs that avoid blocking controls.
- Leakage of reviewer routing expectations or sensitive path policy behavior.
- Possible tenant boundary confusion because non-persisted previews default to `org_local` while still using a resolved repository policy/mode.

Root cause:

The route intentionally treats preview as read-only and only protects persistence, but using stored tenant policy is still a sensitive read. Read-only does not mean public when private repository configuration influences the result.

Remediation:

1. Require `requireApiActor` when `repositoryId` resolves or when `contentYaml` is omitted.
2. Enforce `requireOrganizationAccess` for the resolved repository before reading active policy or repository mode.
3. Keep unauthenticated preview only for caller-supplied `contentYaml` plus caller-supplied fixture PR, or restrict it to built-in policy packs that are already public.
4. Add regression tests: unauthenticated preview with configured `repositoryFullName` returns 401; cross-tenant preview returns 403; public caller-supplied YAML preview still works if that public utility is desired.
5. Audit-log authenticated previews that use stored repository policy, even when `persist=false`.

### AF-SEC-002 - Local Actor Fallback Can Become Privilege Escalation If Exposed

Severity: High when exposed outside localhost; Medium in local-only development

Affected components:

- `apps/web/app/settings/actor-context.ts:50-51`
- `apps/web/app/settings/actor-context.ts:90-99`
- `apps/web/app/settings/api-actor-headers.ts:4-10`
- `apps/api/src/auth.ts:76-85`

Evidence:

- Dashboard actor resolution falls back when `input.nodeEnv !== "production"` at lines 50-51.
- The local dashboard role defaults to `platform_admin` at line 94.
- Dashboard-to-API forwarding uses raw local actor headers when `AGENTFORGE_API_TRUST_PROXY_HEADERS !== "true"` at lines 4-10.
- The API accepts raw local actor headers when `NODE_ENV === "test"` or `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS === "true"` at lines 76-85.

Exploitation scenario:

A development or staging dashboard is exposed through a tunnel, LAN, preview URL, or misconfigured host while the API accepts local actor headers. An unauthenticated visitor submits server-action forms through the dashboard. The dashboard resolves a default `platform_admin` actor and forwards raw actor headers to the API, allowing policy changes, GitHub installation approval/rejection, repository setting changes, evidence approval, exports, and other governance mutations.

Potential impact:

- Unauthorized platform-admin actions.
- Governance bypass through policy/mode changes.
- Unauthorized GitHub installation approval.
- Evidence/reviewer approvals that unblock merges.
- Audit trail polluted with a trusted-looking local actor.

Root cause:

Convenience defaults are tied to `NODE_ENV !== "production"` rather than an explicit opt-in flag plus a locality check. The fallback identity is privileged by default.

Existing mitigating controls:

- Production config validation rejects local actor fallback and requires trusted proxy headers.
- Docs warn that local actor headers are local-only.
- API raw-header fallback is not enabled by default outside tests.

Remediation:

1. Require `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true` for dashboard local fallback in all environments, including development.
2. Default `AGENTFORGE_DASHBOARD_ROLE` to `developer`, not `platform_admin`; require explicit admin role in `.env` for admin smoke tests.
3. Add startup/preflight checks that fail when local actor fallback is enabled and `APP_BASE_URL` or `API_BASE_URL` is not localhost/127.0.0.1.
4. Add response headers or visible environment banners for local fallback mode.
5. Add tests proving `NODE_ENV=development` without explicit allow flag does not create a privileged actor.

### AF-SEC-003 - CSP Is Report-Only And Permits Unsafe Script Sources

Severity: Medium

Affected component:

- `apps/web/next.config.mjs:6-17`
- `apps/web/next.config.mjs:47`

Evidence:

- `script-src 'self' 'unsafe-inline' 'unsafe-eval'` is configured at line 15.
- `connect-src` includes broad `https:` at line 14.
- The policy is delivered as `Content-Security-Policy-Report-Only` at line 47, so browsers do not enforce it.

Exploitation scenario:

If an XSS bug is later introduced through dashboard content, third-party script behavior, React escape hatches, or unsafe link handling, the current CSP will not block execution because it is report-only. Even if enforced later as-is, `unsafe-inline` and `unsafe-eval` would materially reduce protection.

Potential impact:

- Session compromise for GitHub-OAuth-authenticated dashboard users.
- Unauthorized dashboard mutations via stolen session context.
- Sensitive governance metadata and export access through the victim browser.

Root cause:

CSP is currently staged as observability rather than enforcement and keeps broad script allowances likely for development compatibility.

Remediation:

1. Split development and production CSP.
2. In production, emit an enforcing `Content-Security-Policy` header.
3. Remove `unsafe-eval` in production.
4. Replace broad `https:` in `connect-src` with explicit API origin(s).
5. Keep report-only as a canary in staging, but add a release gate that verifies production headers.

### AF-SEC-004 - Untracked Mobile App Tree Contains Generated Artifacts And Local Config

Severity: Medium

Affected component:

- Untracked `apps/android/`
- Untracked `apps/ios/`
- Untracked `artifacts/`

Evidence:

- `git status --short --ignored` shows `?? apps/android/`, `?? apps/ios/`, `?? artifacts/`.
- Ignored/generated paths under the untracked Android tree include `apps/android/.gradle/`, `apps/android/app/build/`, `apps/android/build/`, and `apps/android/local.properties`.
- `apps/android/local.properties` contains a machine-local SDK path by key and should not be committed.

Exploitation scenario:

A future broad `git add apps/android` or archive operation could include Gradle caches, build reports, local machine paths, test results, APK metadata, or other generated artifacts. Generated files can also hide stale dependencies or tampered build outputs that reviewers do not expect in source diffs.

Potential impact:

- Supply-chain review noise and accidental local metadata leakage.
- Accidental commit of build artifacts or local paths.
- Harder detection of malicious generated content.

Root cause:

The mobile apps are currently untracked workspace additions with generated build directories present inside the tree. Root `.gitignore` does not explicitly cover all nested mobile build/cache paths if the directory is added later.

Remediation:

1. Before committing mobile clients, delete generated `apps/android/.gradle`, `apps/android/**/build`, and local `apps/android/local.properties`.
2. Add root ignore entries for Android/Gradle generated outputs and local properties.
3. Keep only source, manifests, wrapper files, version catalogs, and tests.
4. Add CI hygiene checks for `local.properties`, `.gradle/`, `**/build/outputs`, `.apk`, `.aab`, `.xcuserdata`, `DerivedData`, and local screenshots unless intentionally stored.

### AF-SEC-005 - Android Release Defaults Need Hardening Before Distribution

Severity: Low currently; Medium if the app later stores tokens/session data

Affected components:

- `apps/android/app/src/main/AndroidManifest.xml:6-16`
- `apps/android/app/build.gradle.kts:18-21`

Evidence:

- `android:allowBackup="true"` is set at line 7.
- `MainActivity` is exported at lines 14-16. This is expected for a launcher activity, but should remain non-privileged.
- Release minification is disabled at lines 18-21.

Exploitation scenario:

If the Android app later stores OAuth sessions, API tokens, configured tenant URLs, or other sensitive operator state, cloud/device backup could copy it unless explicit backup/data-extraction rules exclude it. Disabled minification also leaves release code easier to inspect and tamper with.

Potential impact:

- Future local data exposure through backup/restore.
- Easier reverse engineering of production mobile client behavior.
- Increased blast radius if the mobile app grows beyond public health/readiness probes.

Root cause:

The mobile client is currently a lightweight operator client and uses permissive default Android project settings. Those defaults are acceptable for a prototype that stores no secrets, but not for a production operator app.

Remediation:

1. Set `android:allowBackup="false"` unless a reviewed encrypted backup plan exists.
2. Add explicit `dataExtractionRules` and `fullBackupContent` if backup must remain enabled.
3. Keep exported activity limited to the launcher; do not add privileged deep links without exact host/path validation.
4. Enable R8/minification for release once the app is ready for distribution.

### AF-SEC-006 - Secret Scanning Is Too Narrow For Public-Release Confidence

Severity: Medium

Affected components:

- `.github/workflows/security.yml:41-45`
- local ignored `.env` and `.env.backup.20260525220450`

Evidence:

- CI secret scan only checks GitHub PAT pattern, AWS access-key pattern, and private-key headers.
- Local ignored `.env` files exist and contain secret-bearing key names such as `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, and `SESSION_SECRET` by key inventory. Values were not printed in this assessment.

Exploitation scenario:

A future secret shape outside the narrow grep list, such as OAuth client secret formats, webhook secrets, database credentials, npm tokens, Railway/Cloudflare tokens, or generic high-entropy strings, could be committed without being blocked by the current CI grep.

Potential impact:

- Credential exposure in public history.
- Unauthorized GitHub App/OAuth/webhook access if a real secret lands in git.
- Costly key rotation and history remediation.

Root cause:

The current secret scan is a lightweight grep with a small pattern set. It is useful but not equivalent to a dedicated secret scanner with entropy checks, allowlists, and history scanning.

Remediation:

1. Add `gitleaks` or `trufflehog` to CI with an allowlist for intentional test fixtures.
2. Add a git-history secret scan before any visibility change or release tag.
3. Expand release hygiene to block tracked `.env*`, local backups, build reports, and generated mobile outputs.
4. Rotate any real credentials if an ignored local env file was ever shared, copied into an artifact, or committed in prior history.

### AF-SEC-007 - Dependency Review Is Non-Blocking While Repository Is Private

Severity: Medium

Affected component:

- `.github/workflows/dependency-review.yml:17-20`

Evidence:

- The workflow sets `continue-on-error: ${{ github.event.repository.private }}` at line 18.
- It otherwise requests `fail-on-severity: high` at line 20.

Exploitation scenario:

While the repository is private, a pull request that introduces a high-severity dependency advisory or denied license can pass this job as non-blocking. `pnpm audit --audit-level high` still runs in the security workflow, but dependency-review coverage includes PR-diff context and license policy that may not be equivalently enforced elsewhere.

Potential impact:

- Vulnerable dependency or denied license reaches main before repository visibility changes.
- Supply-chain review depends on human inspection of a non-blocking result.

Root cause:

The workflow appears configured to avoid failing private-repo dependency-review limitations, but that weakens the gate during private development.

Remediation:

1. Remove `continue-on-error` if dependency-review is available for the repository.
2. If GitHub dependency review is unavailable privately, add an alternate blocking gate for advisories and licenses.
3. Keep `pnpm audit --audit-level moderate` or `high` blocking in CI and document the accepted threshold.

### AF-SEC-008 - Local Docker Services Use Default Credentials And Broad Port Publishing

Severity: Low for local-only use; High if reused in shared/staging environments

Affected component:

- `docker-compose.yml:1-39`

Evidence:

- Postgres uses `POSTGRES_USER=agentforge` and `POSTGRES_PASSWORD=agentforge` at lines 5-7 and publishes `15432:5432` at lines 8-9.
- Redis has no password and publishes `6379:6379` at lines 18-22.
- MinIO uses `MINIO_ROOT_USER=agentforge` and `MINIO_ROOT_PASSWORD=agentforge-local` at lines 31-39.

Exploitation scenario:

If the local compose file is run on a shared host, exposed LAN interface, CI runner with reachable service ports, or copied into staging, attackers on the same network could connect to Postgres, Redis, or MinIO using known defaults.

Potential impact:

- Data access or manipulation in local/shared environments.
- Queue tampering through Redis.
- Export/object storage access if MinIO becomes active.

Root cause:

The compose file is optimized for local developer convenience and publishes services without loopback-only binding or random secrets.

Remediation:

1. Bind ports to loopback, for example `127.0.0.1:15432:5432`, `127.0.0.1:6379:6379`, `127.0.0.1:9000:9000`.
2. Keep this compose file explicitly documented as local-only.
3. Add a separate staging/prod compose or deployment manifest that requires secrets and private networking.
4. Require Redis auth/TLS in any non-local deployment.

### AF-SEC-009 - Public Health, Readiness, And Metrics Leak Operational State

Severity: Low

Affected component:

- `apps/api/src/routes/api-routes.ts:571-600`

Evidence:

- `/health` returns database/queue/runtime store state, unsigned webhook mode, and version.
- `/ready` returns queue details and runtime state.
- `/metrics` returns Prometheus metrics without authentication.

Exploitation scenario:

An unauthenticated internet caller can fingerprint the deployment, determine whether Postgres/Redis are configured, discover unsigned-webhook mode state, and observe operational counts. This is not a direct compromise, but it helps targeted reconnaissance.

Potential impact:

- Increased reconnaissance value for attackers.
- Possible leakage of governance activity volumes through metrics.

Root cause:

Operational endpoints are public and include more than bare liveness.

Remediation:

1. Keep `/health` minimal and public.
2. Protect `/ready` and `/metrics` behind trusted network, auth proxy, or a metrics-specific token in production.
3. Split public liveness from internal readiness/metrics.

## Positive Controls Observed

- GitHub webhook signatures use HMAC-SHA256 and timing-safe comparison.
- Production config fails closed for missing webhook secrets, unsigned webhooks, source storage, disabled redaction, local actor fallback, and missing trusted proxy posture.
- API actor headers are HMAC-signed with timestamp when trusted proxy mode is enabled.
- Most sensitive routes use `requireApiActor`, role checks, and tenant checks.
- Request bodies are bounded by Fastify `bodyLimit` and route-level Zod max sizes.
- Policy YAML is capped at 200 KB.
- Exports are bounded and tenant-scoped.
- Source-code/full-diff storage is disabled by default and redaction is enabled by default.
- CSV export neutralization and redaction tests are present.
- GitHub API calls use fixed GitHub origins and timeouts; no generic server-side URL fetcher was found.
- No dynamic `eval`, `new Function`, shell execution in runtime request paths, unsafe SQL string building, or dangerous HTML sinks were identified in runtime app code.
- GitHub Actions are pinned by commit SHA and use least-privilege default permissions.
- `pnpm audit --audit-level moderate` returned no known vulnerabilities at assessment time.

## Suspicious Or Malicious Code Review

No evidence was found of intentionally malicious backdoors, hidden admin accounts, persistence implants, covert command-and-control, obfuscated payloads, unauthorized telemetry, logic bombs, or hardcoded production credentials in tracked source.

Suspicious-pattern review notes:

- Runtime code does not use `eval`, `new Function`, `vm`, request-path shell execution, or dynamic remote script loading.
- External network calls are limited to GitHub OAuth/API and user-entered mobile client URLs.
- Secret-shaped strings found by Semgrep are intentional detector test fixtures in `packages/detectors/src/detectors.test.ts:147-168`.
- Android launcher `MainActivity` export is expected for an app launcher and has no privileged deep-link or data-handling behavior today.
- Ignored local `.env` and `.env.backup.20260525220450` files exist and contain secret-bearing key names; their values were not displayed or copied into this report.

## Monitoring, Auditing, And Defense-In-Depth Gaps

- No visible production alerting rules for repeated 401/403 auth failures, webhook signature failures, replay attempts, export creation spikes, or policy/mode changes.
- Audit events are strong for governance actions, but unauthenticated preview calls are not audited.
- Metrics are unauthenticated; a private scrape path or token would reduce reconnaissance.
- Secret scanning should move from grep to dedicated scanner with history support.
- CSP is not enforced, reducing browser-side containment if XSS appears.
- Mobile release hardening is not complete.

## Prioritized Action Plan

1. Fix AF-SEC-001 with auth/tenant checks around stored-policy previews.
2. Fix AF-SEC-002 by making local actor fallback explicit-only and localhost-only.
3. Promote CSP enforcement in production and remove unsafe script allowances.
4. Clean mobile trees before commit and add root ignore/hygiene gates.
5. Add dedicated secret scanning and history scanning.
6. Make dependency review blocking or add an equivalent private-repo supply-chain gate.
7. Bind local compose service ports to loopback and document local-only credentials.
8. Protect `/metrics` and consider splitting public health from internal readiness.
9. Add alerting for auth failures, webhook verification failures, replay attempts, export jobs, and policy/retention changes.

## Residual Risk

Residual risk is moderate after remediation of AF-SEC-001 and AF-SEC-002. The application handles a security-sensitive governance control plane, so the main risk is not classic injection; it is abuse of legitimate control-plane functions: previewing policy behavior, approving installations, changing repository mode, approving evidence, replaying webhooks, exporting audit records, or weakening data retention. Those functions are mostly well-controlled today, but the public preview oracle and development identity fallback deserve immediate tightening before any broader exposure.
