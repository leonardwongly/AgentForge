# AgentForge Security Remediation Plan - 2026-05-28

Source assessment: `SECURITY_ASSESSMENT_2026-05-28.md`

This plan converts the nine findings from the 2026-05-28 security assessment
into prioritized, executable remediation work. It is intended to be used as a
tracking artifact for implementation, review, and validation.

## Executive Summary

The highest-priority work is to close two control-plane authorization risks:

1. `/api/policies/preview` must not use stored repository policy or repository
   settings for unauthenticated callers.
2. Dashboard/API local actor fallback must become explicit-only and
   localhost-only, with a non-admin default identity.

After those are closed, the next tranche should harden browser containment,
secret/dependency gates, repository hygiene for mobile clients, local service
exposure, and operational endpoint visibility. No finding requires a large
architecture rewrite, but several fixes touch security-sensitive contracts and
must be implemented with focused regression tests before broad validation.

## Execution Rules

- Fix one finding at a time unless two findings share the same file and test
  surface.
- Keep each pull request or commit reviewable and independently revertible.
- Do not weaken production fail-closed checks to preserve development
  convenience.
- Preserve unauthenticated developer utilities only when they do not read stored
  tenant, repository, policy, mode, audit, or installation state.
- Treat local-only security exceptions as explicit, documented, tested, and
  blocked from non-localhost exposure.
- Run the targeted validation gate for each finding before moving to the next.
- Run the full security release gate after the P0 and P1 work is complete.

## Priority And Dependency Order

| Priority | Finding         | Reason                                                                        | Dependencies                                                |
| -------- | --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| P0       | AF-SEC-001      | Public policy oracle against stored repository governance state               | None                                                        |
| P0       | AF-SEC-002      | Privileged local identity can become a remote privilege escalation if exposed | None                                                        |
| P1       | AF-SEC-003      | CSP does not currently contain future browser-side compromise                 | AF-SEC-002 helps reduce mutation impact but is not required |
| P1       | AF-SEC-006      | Current secret scanning can miss real release-blocking credentials            | None                                                        |
| P1       | AF-SEC-007      | Private-repo dependency review is non-blocking                                | AF-SEC-006 may share CI edits                               |
| P1       | AF-SEC-004      | Mobile/generated artifact hygiene can pollute supply-chain review             | None                                                        |
| P2       | AF-SEC-009      | Public operational endpoints aid reconnaissance                               | AF-SEC-002 for auth/proxy posture alignment                 |
| P2       | AF-SEC-008      | Local compose defaults are unsafe if reused outside developer machines        | None                                                        |
| P2       | AF-SEC-005      | Android defaults are acceptable now but unsafe before production distribution | AF-SEC-004 cleanup first                                    |
| P2       | Monitoring gaps | Detection and containment gaps reduce incident response quality               | AF-SEC-001, AF-SEC-002, AF-SEC-009 provide event sources    |

## Phase Matrix

| Phase | Task                                 | Subtasks                                                                                              | Owner           | Parallelizable                                     | Branch/Worktree                         | Validation Gate                                                | Commit                                                 |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| 0     | Baseline and tracking                | Confirm current status, keep assessment and plan as artifacts, avoid generated/mobile junk in commits | AppSec/Platform | Yes                                                | `codex/security-remediation-2026-05-28` | `git status --short --ignored`, review staged files            | `docs(security): add remediation plan`                 |
| 1     | Close stored-policy preview exposure | Implement AF-SEC-001 route authorization, tenant checks, audit events, and tests                      | API             | No                                                 | Same branch or focused branch           | Targeted integration tests plus policy preview fixture command | `fix(api): require auth for stored policy previews`    |
| 2     | Lock down local actor fallback       | Implement AF-SEC-002 web/API fallback changes, preflight locality checks, docs, tests                 | Web/API         | Can follow Phase 1 in parallel after design review | Focused branch acceptable               | Web unit tests, API auth tests, integration security tests     | `fix(auth): require explicit local actor fallback`     |
| 3     | Browser containment                  | Implement production-enforced CSP and tighten script/connect directives                               | Web             | Yes after Phase 2 tests are green                  | Focused branch acceptable               | Header tests, build, browser smoke                             | `fix(web): enforce production CSP`                     |
| 4     | Supply-chain gates                   | Add dedicated secret scan, history scan workflow/docs, and blocking dependency review alternative     | CI/Security     | Yes                                                | Focused branch acceptable               | CI workflow lint, local scanner dry run, `pnpm audit`          | `ci(security): strengthen secret and dependency gates` |
| 5     | Repo and mobile hygiene              | Clean mobile generated outputs, update ignores and release checks, harden Android release defaults    | Mobile/Build    | Yes after Phase 0                                  | Focused branch acceptable               | Release check, Android build/test when available               | `chore(mobile): harden source hygiene`                 |
| 6     | Runtime exposure and detection       | Protect readiness/metrics, bind local compose ports, add alerting/audit backlog items                 | API/Ops         | Partly parallel                                    | Focused branch acceptable               | API route tests, compose config review, runbook update         | `fix(ops): reduce operational endpoint exposure`       |
| 7     | Full validation and review           | Run full validation ladder, update checklist/evidence, prepare PR summary                             | AppSec/Platform | No                                                 | Final branch                            | Full gate listed below                                         | Final review commit only if docs/evidence changed      |

Full validation ladder after P0/P1 changes:

```sh
pnpm format:check
pnpm lint
pnpm --filter @agentforge/api typecheck
pnpm --filter @agentforge/web typecheck
pnpm test
pnpm test:integration -- apps/api/test/security-hardening.test.ts apps/api/test/proxy-auth.test.ts apps/api/test/route-contracts.test.ts
pnpm prisma:validate
pnpm messaging:validate
pnpm policy:validate fixtures/policies/fintech.yaml
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
pnpm release:check
pnpm audit --audit-level moderate
```

Run `pnpm db:generate` before TypeScript or integration validation if Prisma
client generation is stale.

## AF-SEC-001 - Unauthenticated Policy Preview Can Use Stored Repository Policy

Severity: High

Impacted areas:

- `apps/api/src/routes/api-routes.ts`
- API actor and tenant authorization helpers
- Policy preview API contract
- Audit events for policy preview usage
- Integration tests in `apps/api/test/security-hardening.test.ts` or a focused
  preview route test file

Issue:

`POST /api/policies/preview` currently requires an API actor only when
`persist=true`. The route can still resolve a stored repository by
`repositoryFullName`, fall back to the active stored policy when `contentYaml`
is omitted, apply repository mode overrides, and return the preview result to an
unauthenticated caller.

Root cause:

The route treats non-persisted preview as public because it does not mutate
state. It misses that reading and evaluating stored tenant policy is sensitive
control-plane behavior even when no database write occurs.

Impact:

- Private policy behavior can be inferred by unauthenticated callers.
- Reviewer requirements, blocking rules, and mode behavior can be probed.
- A tenant boundary can be confused because public preview defaults to
  `org_local` while still using a real repository's stored state.
- Attackers can use the oracle to craft pull requests that avoid controls.

Required actions:

- Split the route into public and stored-state paths.
- Define public preview as: caller supplies `contentYaml` and fixture PR input,
  and the server does not read stored repository policy, mode overrides,
  organization settings, installation records, or reviewer state.
- Require `requireApiActor` before any repository lookup result is used to read
  active policy or mode overrides.
- Enforce `requireOrganizationAccess` for the resolved repository's
  organization before `getRepositoryPolicy`, repository mode override lookup, or
  persisted preview creation.
- Decide and document behavior when an unauthenticated request supplies both
  `contentYaml` and a `repositoryFullName` that exists:
  - Preferred: treat it as public fixture mode and do not apply stored
    repository state.
  - Alternative: require authentication because an existing repository was
    referenced.
- Add an audit event for authenticated stored-policy preview, even when
  `persist=false`.
- Return consistent `401` for missing actor and `403` for cross-tenant actor.
- Update API route contract documentation if preview semantics change.

Validation scenarios:

- Unauthenticated request with known configured `repositoryFullName` and no
  `contentYaml` returns `401`.
- Unauthenticated request with guessed configured `repositoryFullName` and
  supplied `contentYaml` does not use stored policy or mode override.
- Authenticated same-organization actor can preview stored policy.
- Authenticated cross-organization actor receives `403`.
- Persisted preview still requires an actor and still records the correct
  tenant/repository metadata.
- Audit event is written for stored-policy preview.
- Caller-supplied public YAML preview remains available only if product wants
  that utility.

Regression checks:

```sh
pnpm test:integration -- apps/api/test/security-hardening.test.ts apps/api/test/route-contracts.test.ts
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
pnpm lint -- apps/api/src/routes/api-routes.ts
```

Acceptance criteria:

- No unauthenticated request can cause evaluation against stored repository
  policy or repository mode settings.
- Tenant authorization is checked before stored preview state is read.
- Tests prove unauthenticated, same-tenant, and cross-tenant behavior.

## AF-SEC-002 - Local Actor Fallback Can Become Privilege Escalation If Exposed

Severity: High when exposed outside localhost; Medium in local-only development

Impacted areas:

- `apps/web/app/settings/actor-context.ts`
- `apps/web/app/settings/api-actor-headers.ts`
- `apps/api/src/auth.ts`
- Runtime/preflight configuration scripts
- `.env.example`, `docs/auth.md`, `docs/runbook.md`, and launch checklist
- Web and API auth tests

Issue:

The dashboard can synthesize a local `platform_admin` actor in non-production
environments without an explicit allow flag. If the dashboard is exposed through
a tunnel, LAN host, or staging URL while the API accepts local actor headers,
unauthenticated visitors can trigger privileged server actions.

Root cause:

Development convenience is coupled to `NODE_ENV !== "production"` and the
fallback role defaults to `platform_admin`. The current controls rely on
production config validation rather than enforcing explicit opt-in and locality
for every environment.

Impact:

- Unauthorized policy, repository mode, installation, evidence, and export
  operations.
- Audit records can appear to be performed by a trusted local actor.
- A staging or preview deployment can accidentally become an admin console.

Required actions:

- Change dashboard fallback to require
  `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true` in every environment.
- Change the default fallback role from `platform_admin` to `developer`.
- Require explicit `AGENTFORGE_DASHBOARD_ROLE=platform_admin` only for local
  admin smoke testing.
- Add a shared locality helper that accepts only loopback URLs and hostnames for
  local fallback mode:
  - `localhost`
  - `127.0.0.1`
  - `[::1]` or `::1`
- Fail startup or preflight when local actor fallback or raw local API actor
  headers are enabled with non-loopback `APP_BASE_URL`, `NEXT_PUBLIC_APP_URL`,
  `API_BASE_URL`, or equivalent configured origins.
- Keep API raw local actor headers disabled by default outside tests.
- Add a visible development/local-mode banner or response marker so reviewers
  can identify fallback mode during QA.
- Update docs and `.env.example` to make admin fallback opt-in and local-only.

Validation scenarios:

- `NODE_ENV=development` without explicit allow flag does not create a local
  actor.
- Explicit local allow flag works on loopback URLs.
- Explicit local allow flag fails preflight on a tunnel or non-localhost URL.
- Default fallback actor role is `developer`.
- Admin fallback requires explicit role override.
- API rejects raw local actor headers unless test mode or explicit API allow
  flag is set.
- Trusted proxy signed-header flow remains unchanged.

Regression checks:

```sh
pnpm --filter @agentforge/web test
pnpm test:integration -- apps/api/test/proxy-auth.test.ts apps/api/test/security-hardening.test.ts
pnpm lint -- apps/web/app/settings/actor-context.ts apps/web/app/settings/api-actor-headers.ts apps/api/src/auth.ts
```

Acceptance criteria:

- Development no longer silently grants platform-admin dashboard access.
- Local fallback cannot start successfully against non-loopback origins.
- Existing production fail-closed validation remains intact.

## AF-SEC-003 - CSP Is Report-Only And Permits Unsafe Script Sources

Severity: Medium

Impacted areas:

- `apps/web/next.config.mjs`
- Web runtime headers
- Next.js build/runtime compatibility
- Browser smoke tests and release checks

Issue:

The web app currently emits CSP as `Content-Security-Policy-Report-Only` and
allows `unsafe-inline`, `unsafe-eval`, and broad `https:` connections.

Root cause:

The policy is staged for observation and development compatibility rather than
production containment. This leaves the app without browser-enforced mitigation
if an XSS bug appears later.

Impact:

- Future XSS would not be blocked by CSP.
- Broad script allowances reduce defense-in-depth.
- Broad `connect-src` can make malicious browser-side exfiltration easier.

Required actions:

- Split CSP generation by environment:
  - Development: allow only what Next.js development needs, preferably
    report-only.
  - Production: emit enforcing `Content-Security-Policy`.
- Remove `unsafe-eval` from production.
- Remove `unsafe-inline` from production where feasible. If Next.js requires a
  nonce-based implementation, implement nonces centrally rather than preserving
  broad inline allowance.
- Replace broad `connect-src https:` with explicit API, GitHub OAuth/API, and
  telemetry/report endpoints required by the app.
- Keep `frame-ancestors 'none'` or the existing clickjacking defense.
- Add tests or a release check that fails if production headers are report-only
  or include `unsafe-eval`.
- Document any temporary exception with a removal date.

Validation scenarios:

- Production response includes `Content-Security-Policy`, not only
  `Content-Security-Policy-Report-Only`.
- Production `script-src` does not include `unsafe-eval`.
- Production `connect-src` contains only expected origins.
- Dashboard pages still render and server actions/API calls still work.
- Development mode remains usable without weakening production policy.

Regression checks:

```sh
pnpm --filter @agentforge/web typecheck
pnpm --filter @agentforge/web test
pnpm build
pnpm release:check
```

Acceptance criteria:

- CSP is enforced in production.
- Unsafe script allowances are removed or tightly documented with an explicit
  technical blocker.
- Header behavior is covered by automated validation.

## AF-SEC-004 - Untracked Mobile App Tree Contains Generated Artifacts And Local Config

Severity: Medium

Impacted areas:

- `apps/android/`
- `apps/ios/`
- `artifacts/`
- `.gitignore`
- `scripts/check-release-readiness.ts`
- CI/release hygiene workflows

Issue:

The mobile app trees and artifact directory are untracked while generated
Android outputs and local machine configuration exist in the same tree. A broad
add or archive step could accidentally include local paths, build outputs, APKs,
or generated reports.

Root cause:

Mobile source was added locally before source hygiene was finalized. The root
ignore and release checks do not yet explicitly defend against nested mobile
generated artifacts.

Impact:

- Accidental commit of local paths or generated outputs.
- Larger, noisier, and less trustworthy code reviews.
- Generated files can hide stale dependencies or tampered outputs.
- Supply-chain hygiene becomes harder once mobile clients are tracked.

Required actions:

- Delete generated local directories before staging mobile code:
  - `apps/android/.gradle/`
  - `apps/android/**/build/`
  - `apps/android/local.properties`
  - Xcode `DerivedData`, `.xcuserdata`, and local simulator artifacts if
    present.
- Add root `.gitignore` entries for Android, Gradle, APK/AAB, Xcode, and local
  artifact outputs.
- Update `scripts/check-release-readiness.ts` to fail if generated mobile
  outputs or local config files are tracked.
- Decide whether `artifacts/` is a durable evidence directory or local scratch:
  - If durable, document allowed file types and retention.
  - If scratch, ignore it and keep it out of commits.
- Commit only mobile source, manifests, build definitions, wrapper metadata, and
  tests that are intentionally part of the product.

Validation scenarios:

- `git status --short --ignored` shows generated mobile outputs ignored or
  removed.
- `git ls-files` does not include `local.properties`, `.gradle`, build outputs,
  `.apk`, `.aab`, `.xcuserdata`, or `DerivedData`.
- Release check fails on a deliberately tracked generated path in a temporary
  test fixture or unit test.
- Mobile source remains buildable after cleanup.

Regression checks:

```sh
pnpm release:check
git status --short --ignored
git ls-files | rg '(^|/)(local\.properties|\.gradle|build/outputs|DerivedData|\.xcuserdata|.*\.(apk|aab)$)' || true
```

Acceptance criteria:

- No generated mobile output or local mobile config can be committed silently.
- Mobile source hygiene is enforced by both ignore rules and release checks.

## AF-SEC-005 - Android Release Defaults Need Hardening Before Distribution

Severity: Low currently; Medium if the app stores tokens or operator state

Impacted areas:

- `apps/android/app/src/main/AndroidManifest.xml`
- `apps/android/app/build.gradle.kts`
- Android release build configuration
- Mobile QA/release checklist

Issue:

The Android app currently keeps default release posture: backup is enabled and
release minification is disabled. The launcher activity is exported as expected,
but it must remain non-privileged.

Root cause:

The mobile app is early-stage and currently stores no secrets. Android defaults
are permissive enough for a prototype but not for an operator-facing production
client.

Impact:

- Future OAuth/session/config data could be included in device/cloud backups.
- Release code is easier to inspect and tamper with.
- Privileged deep links could become an attack surface if added later without
  exact host/path validation.

Required actions:

- Set `android:allowBackup="false"` unless a reviewed backup strategy exists.
- If backup must remain enabled, add explicit `dataExtractionRules` and
  `fullBackupContent` that exclude credentials, caches, configuration, logs, and
  operator state.
- Enable R8/minification for release builds once dependencies are compatible.
- Keep only the launcher activity exported unless a deep-link threat model is
  completed.
- Add a mobile release checklist section covering backup rules, deep links,
  network security config, token storage, and release signing.

Validation scenarios:

- Manifest release configuration disables backup or references reviewed
  exclusion rules.
- Release build succeeds with minification enabled, or a documented blocker
  exists with an owner and target date.
- No exported non-launcher components exist without explicit tests.
- App still performs current health/readiness/OAuth entrypoint workflows.

Regression checks:

```sh
./gradlew -p apps/android test
./gradlew -p apps/android assembleRelease
rg -n 'allowBackup="true"|android:exported="true"' apps/android/app/src/main/AndroidManifest.xml
```

Acceptance criteria:

- Android release defaults are safe before distribution.
- Any remaining mobile release exception is documented and tracked.

## AF-SEC-006 - Secret Scanning Is Too Narrow For Public-Release Confidence

Severity: Medium

Impacted areas:

- `.github/workflows/security.yml`
- `docs/release-checklist.md`
- `scripts/check-release-readiness.ts`
- Intentional detector fixtures in `packages/detectors/src/detectors.test.ts`
- Local ignored `.env` and `.env.backup.*` handling guidance

Issue:

The current CI secret scan is a small grep pattern set. It can miss many real
secret formats and does not provide robust entropy checks, allowlists, or
history scanning.

Root cause:

The lightweight grep gate was sufficient as a first pass but is not equivalent
to a dedicated scanner. The repo also contains ignored local env files with
secret-bearing key names, increasing the importance of broad history and
working-tree hygiene.

Impact:

- Real OAuth, webhook, database, npm, cloud, or high-entropy secrets could be
  committed without CI blocking.
- Public release could expose credentials in current files or git history.
- Remediation after exposure can require rotation and history rewriting.

Required actions:

- Add `gitleaks` or `trufflehog` to CI as a blocking job.
- Add a committed allowlist for intentional secret-shaped detector fixtures.
- Scan tracked files, staged changes, and git history before visibility changes
  or release tags.
- Keep the existing lightweight grep as a fast supplemental check if useful.
- Update `docs/release-checklist.md` with exact local history-scan commands.
- Update `scripts/check-release-readiness.ts` to fail on tracked `.env*`,
  `.pem`, key files, backup env files, and generated local artifacts.
- Document rotation procedure if a real credential is found.

Validation scenarios:

- Scanner passes with current intentional test fixtures allowlisted.
- Scanner fails on a temporary synthetic secret in a test branch or fixture.
- Release check fails if `.env.backup.*` is tracked.
- Documentation includes history scan and rotation steps.

Regression checks:

```sh
pnpm release:check
pnpm audit --audit-level moderate
# plus the selected scanner command, for example:
gitleaks detect --source . --redact --config .gitleaks.toml
```

Acceptance criteria:

- Dedicated secret scanning blocks PRs and releases.
- Intentional detector fixtures are explicitly allowlisted, not ignored by broad
  path exclusions.
- Release checklist includes current-tree and history scans.

## AF-SEC-007 - Dependency Review Is Non-Blocking While Repository Is Private

Severity: Medium

Impacted areas:

- `.github/workflows/dependency-review.yml`
- `.github/dependabot.yml`
- Security workflow dependency audit
- Release checklist

Issue:

Dependency Review uses `continue-on-error` for private repositories. A PR that
introduces a high-severity advisory or denied license can pass while the repo is
private.

Root cause:

The workflow appears designed to avoid failing when GitHub's dependency review
features are limited for private repositories, but that leaves no equivalent
blocking PR-diff gate.

Impact:

- Vulnerable dependencies can reach `main`.
- License policy enforcement can become advisory-only.
- Public-release readiness depends on manual review of non-blocking warnings.

Required actions:

- Check whether GitHub Dependency Review is available for the private repo.
- If available, remove `continue-on-error`.
- If unavailable, add a blocking alternate gate:
  - `pnpm audit --audit-level moderate` or `high`.
  - License allow/deny check if licensing policy is required.
  - Optional package diff review with lockfile-focused reporting.
- Document accepted advisory threshold and escalation process.
- Add release checklist item requiring dependency gate success.

Validation scenarios:

- Private-repo PR fails on a simulated high-severity vulnerable dependency or
  scanner fixture.
- Clean dependency state passes.
- Dependabot PRs still run the same gate.
- Lockfile-only changes are reviewed by CI.

Regression checks:

```sh
pnpm audit --audit-level moderate
pnpm release:check
```

Acceptance criteria:

- Dependency and license risk cannot be silently non-blocking in private repo
  development.
- The chosen gate is documented and reproducible locally.

## AF-SEC-008 - Local Docker Services Use Default Credentials And Broad Port Publishing

Severity: Low for local-only use; High if reused in shared/staging environments

Impacted areas:

- `docker-compose.yml`
- `README.md`
- `docs/runbook.md`
- Local setup documentation
- Staging/deployment manifests if introduced later

Issue:

Local Postgres, Redis, and MinIO use known default credentials and publish
ports on all interfaces. This is acceptable only when the compose file is
strictly local and not reachable by untrusted networks.

Root cause:

The compose file optimizes for developer setup and does not bind ports to
loopback or require generated local secrets.

Impact:

- Shared-host or LAN attackers can connect to local services.
- Redis queue tampering could alter worker behavior.
- Postgres or MinIO data could be read or modified in non-local environments.

Required actions:

- Bind published ports to loopback:
  - `127.0.0.1:15432:5432`
  - `127.0.0.1:6379:6379`
  - `127.0.0.1:9000:9000`
  - `127.0.0.1:9001:9001`
- Add comments in `docker-compose.yml` that credentials are local-only.
- Update docs to prohibit reuse for staging/production.
- Add separate staging/prod deployment guidance requiring secrets, private
  networking, Redis auth/TLS, and managed database credentials.
- Consider env-file driven local credentials if the developer experience remains
  simple.

Validation scenarios:

- `docker compose config` shows loopback-bound ports.
- API can still connect to local Postgres/Redis through localhost.
- Docs clearly distinguish local compose from production deployment.

Regression checks:

```sh
docker compose config
pnpm test:integration -- apps/api/test/security-hardening.test.ts
```

Acceptance criteria:

- Local service ports are not bound to all interfaces.
- The compose file cannot reasonably be mistaken for staging/prod deployment
  configuration.

## AF-SEC-009 - Public Health, Readiness, And Metrics Leak Operational State

Severity: Low

Impacted areas:

- `apps/api/src/routes/api-routes.ts`
- Metrics scraping configuration
- Runtime deployment docs
- API route tests

Issue:

`/health`, `/ready`, and `/metrics` are public and include operational state
such as database/queue/runtime-store state, unsigned webhook mode, version, and
Prometheus metrics.

Root cause:

The API exposes operational endpoints for ease of local and deployment checks
without separating public liveness from internal readiness and metrics.

Impact:

- Attackers can fingerprint deployment configuration.
- Metrics can reveal activity volumes.
- Readiness details can support targeted recon during incidents.

Required actions:

- Keep `/health` public but minimal:
  - service name
  - status
  - version only if intentionally public
- Move database, queue, runtime-store, and unsigned-webhook details to `/ready`.
- Protect `/ready` in production via one of:
  - API actor role
  - static readiness token
  - trusted internal network/proxy
- Protect `/metrics` in production via scrape token or trusted network.
- Keep local development behavior simple with explicit opt-out or local-only
  bypass.
- Add docs for configuring health checks and metrics scrapes.

Validation scenarios:

- Public `/health` does not reveal detailed backend state.
- Unauthenticated production-like `/ready` request returns `401` or `403`.
- Valid readiness token or trusted actor can access `/ready`.
- Unauthenticated production-like `/metrics` request returns `401` or `403`.
- Prometheus scrape path still works with the configured token/network.

Regression checks:

```sh
pnpm test:integration -- apps/api/test/route-contracts.test.ts apps/api/test/security-hardening.test.ts
pnpm lint -- apps/api/src/routes/api-routes.ts
```

Acceptance criteria:

- Public liveness remains available.
- Readiness and metrics details are not publicly exposed in production.

## Cross-Cutting Monitoring, Auditing, And Defense-In-Depth

Severity: Medium program risk

Impacted areas:

- API audit events
- Worker/webhook processing
- Export and policy mutation paths
- Metrics dashboards and alerting rules
- Runbook incident response sections

Issue:

The assessment found strong audit coverage for many governance actions, but
production alerting and containment rules are not visible for repeated auth
failures, webhook signature failures, replay attempts, export spikes, or policy
and retention changes.

Root cause:

The product has focused first on deterministic governance records and release
readiness. Detection engineering has not yet been turned into visible,
testable operational rules.

Impact:

- Abuse may be logged but not alerted.
- Incident responders may lack clear thresholds and runbook steps.
- Recon against public endpoints or repeated failed auth attempts could go
  unnoticed.

Required actions:

- Add structured audit events for:
  - authenticated stored-policy preview
  - denied stored-policy preview
  - local actor fallback activation
  - readiness/metrics auth failures
  - export creation and export download
  - repository mode and policy changes
- Add metric counters for:
  - 401/403 by route family
  - webhook signature failures
  - webhook replay attempts
  - policy preview denied/allowed counts
  - export creation/download counts
- Add alerting guidance in `docs/runbook.md`:
  - burst of auth failures
  - webhook signature failure spike
  - repeated replay attempts
  - unexpected export spike
  - policy/mode changes outside deployment window
- Add retention guidance for audit events and metrics.
- Add an incident checklist for suspected local fallback exposure.

Validation scenarios:

- Tests assert audit event creation on sensitive allow/deny paths.
- Metrics counters increment on representative failures.
- Runbook contains thresholds, owner, and first-response steps.
- Redaction still prevents secrets from appearing in logs, metrics labels, or
  audit event payloads.

Regression checks:

```sh
pnpm test:integration -- apps/api/test/security-hardening.test.ts
pnpm --filter @agentforge/security test
pnpm lint
```

Acceptance criteria:

- Security-relevant abuse paths have visible logs or metrics.
- Runbook makes detection and containment actionable for operators.

## Review Workflow

Use this iterative workflow for every finding:

1. Confirm the current behavior with a failing or missing test.
2. Implement the smallest safe code/config/doc change.
3. Run the finding-specific validation gate.
4. Review the diff for tenant boundary changes, auth behavior, and accidental
   weakening of production fail-closed checks.
5. Update this plan's checkbox/status in the PR description or issue tracker.
6. Run broader regression checks before merging a batch.
7. After merge, confirm CI and release gates are green.

## Suggested Tracking Checklist

- [x] AF-SEC-001 fixed and covered by unauthenticated/same-tenant/cross-tenant
      preview tests.
- [x] AF-SEC-002 fixed and covered by local fallback, role default, localhost,
      and trusted proxy tests.
- [x] AF-SEC-003 fixed with production-enforced CSP and header checks.
- [x] AF-SEC-004 fixed with mobile generated outputs removed/ignored and
      release hygiene checks.
- [x] AF-SEC-005 fixed or formally deferred until Android distribution with a
      release blocker.
- [x] AF-SEC-006 fixed with dedicated secret scanning and history-scan release
      gate.
- [x] AF-SEC-007 fixed with blocking dependency/license review for private repo
      development.
- [x] AF-SEC-008 fixed with loopback-bound local compose ports and local-only
      documentation.
- [x] AF-SEC-009 fixed with public liveness split from protected readiness and
      metrics.
- [x] Monitoring and alerting gaps converted into metrics, audit events, and
      runbook thresholds.

## Definition Of Done

The remediation program is complete when:

- P0 findings are fixed, tested, and merged.
- P1 findings are fixed, tested, and merged or have explicit risk acceptance
  with owners and dates.
- P2 findings are fixed or scheduled before the relevant release/distribution
  milestone.
- `pnpm release:check`, `pnpm audit --audit-level moderate`, integration
  security tests, and web/API type checks pass.
- CI includes blocking secret and dependency gates.
- No generated mobile artifacts, local env files, or build outputs are tracked.
- The runbook documents detection and containment for the abuse paths identified
  in this assessment.
