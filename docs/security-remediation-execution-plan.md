# AgentForge Security Findings — Remediation Execution Plan

> Generated: 2026-06-02
> Scope: 9 security findings (AF-SEC-001 through AF-SEC-009) + 4 hygiene gaps
> Status: Remediation plan claims all complete; code inspection reveals 7 items remain open

---

## Executive Summary

The security assessment of 2026-05-28 identified 9 findings across authentication, content
security, CI/CD, container configuration, and mobile client hygiene. The remediation checklist
marks all items complete, but code inspection confirms **7 findings remain unresolved or
partially addressed**. This document defines the precise work required to close each gap.

---

## Priority Matrix

| Priority | Finding    | Severity | Status     | Risk                                            |
| -------- | ---------- | -------- | ---------- | ----------------------------------------------- |
| P0       | AF-SEC-001 | High     | Verify fix | Unauthenticated policy evaluation oracle        |
| P0       | AF-SEC-002 | High     | Verify fix | System-role privilege escalation fallback       |
| P0       | HYG-001    | Critical | Open       | Live secrets in `.env.backup` at repo root      |
| P1       | AF-SEC-003 | Medium   | Open       | CSP report-only with unsafe-eval permits XSS    |
| P1       | AF-SEC-006 | Medium   | Open       | Secret scanning covers only 3 patterns          |
| P1       | AF-SEC-007 | Medium   | Open       | Dependency review non-blocking on private repos |
| P1       | AF-SEC-008 | High     | Open       | Docker services exposed on all interfaces       |
| P2       | AF-SEC-004 | Medium   | Partial    | iOS missing .gitignore, artifacts/ untracked    |
| P2       | AF-SEC-005 | Low      | Open       | Android has no release signing config           |
| P2       | AF-SEC-009 | Low      | Open       | Operational endpoints expose internal state     |
| P2       | HYG-002    | Low      | Open       | artifacts/ directory not gitignored             |

---

## Finding Details and Action Plans

---

### HYG-001 — Live Secrets in Repository (CRITICAL)

**Description:**
File `.env.backup.20260525220450` exists at the repository root containing a real GitHub App
RSA private key, webhook secret, and installation ID. Although `.env.*` is in `.gitignore`,
this file is listed as untracked (not committed), but its presence on disk is a credential
exposure risk if the working directory is shared or backed up.

**Root Cause:**
Manual backup created during configuration; no automated cleanup or rotation.

**Impact:**

- Credential compromise if file is committed, shared, or captured in disk backup
- GitHub App impersonation if private key is exposed
- Webhook forgery if webhook secret is exposed

**Actions:**

| Step | Action                                                                      | Owner          |
| ---- | --------------------------------------------------------------------------- | -------------- |
| 1    | Delete `.env.backup.20260525220450` from disk                               | Developer      |
| 2    | Rotate the GitHub App private key via GitHub Developer Settings             | Platform Admin |
| 3    | Rotate the webhook secret in the GitHub App configuration                   | Platform Admin |
| 4    | Update deployed environment with new credentials                            | Platform Admin |
| 5    | Add explicit `.env.backup*` pattern to `.gitignore` (belt-and-suspenders)   | Developer      |
| 6    | Add `*.pem` and `*.key` to `.gitignore`                                     | Developer      |
| 7    | Add pre-commit hook or CI check that rejects files matching secret patterns | Developer      |

**Validation:**

- `git status` no longer shows the backup file
- `grep -r "BEGIN RSA PRIVATE KEY" .` returns zero results outside fixtures
- New credentials work in production (health endpoint returns `ok`)
- CI secret scan catches any future `.env.backup*` files

---

### AF-SEC-001 — Unauthenticated Policy Preview Oracle (HIGH)

**Description:**
`POST /api/policies/preview` with `persist: false` (the default) requires no authentication.
Any network-reachable actor can submit arbitrary YAML policy configurations and observe
evaluation results, learning which detectors exist, how thresholds work, and what patterns
the system flags.

**Root Cause:**
Design decision to allow quick policy experimentation; auth was only added to the persist path.

**Impact:**

- Information disclosure: attacker learns detector logic and thresholds
- Abuse vector: high-volume requests to map the entire policy surface
- Compliance gap: unauthenticated access to a governance tool

**Current State (verify):**
The security assessment claims this is fixed. The code at `apps/api/src/routes/api-routes.ts:1408-1530`
must be inspected post-remediation to confirm authentication is now required for all invocations.

**Actions:**

| Step | Action                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 1    | Verify `requireApiActor()` is called unconditionally at the top of the handler (not gated by `body.persist`) |
| 2    | If not fixed: move auth check before the `if (body.persist)` branch                                          |
| 3    | Return 401 for unauthenticated requests regardless of persist flag                                           |
| 4    | Add rate limiting (10 req/min per actor) to prevent threshold-mapping attacks                                |
| 5    | Add integration test: unauthenticated POST to `/api/policies/preview` returns 401                            |
| 6    | Add integration test: authenticated POST with valid policy returns 200                                       |

**Testing:**

```bash
# Must return 401 (not 200)
curl -X POST http://localhost:4000/api/policies/preview \
  -H "Content-Type: application/json" \
  -d '{"policy": "mode: observe\ndetectors:\n  sensitive_paths:\n    enabled: true"}'
```

**Regression:**

- Existing E2E test `dashboard.spec.ts` policy preview flow must still pass with authentication
- Integration test `route-contracts.test.ts` must include negative auth test

---

### AF-SEC-002 — Local Actor Fallback Privilege Escalation (HIGH)

**Description:**
`actorOrSystem()` in `apps/api/src/auth.ts:133-141` falls back to a `system` actor with
`system` role when no authenticated identity is found. The `system` role is not in the
`allowedRoles` set but may bypass role checks depending on how downstream code handles
unknown roles.

**Root Cause:**
Convenience function for internal/worker callers that should never be reachable from
external HTTP requests.

**Impact:**

- If any HTTP route uses `actorOrSystem()` instead of `requireApiActor()`, unauthenticated
  requests receive system-level identity
- System role may bypass tenant isolation checks

**Current State (verify):**
The remediation plan claims this is fixed. Verify that:

1. `actorOrSystem()` is never called in HTTP route handlers
2. Or that it has been removed/restricted to internal-only callers (worker, queue processors)

**Actions:**

| Step | Action                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------- |
| 1    | Grep all usages of `actorOrSystem` in HTTP route code paths                                       |
| 2    | If used in routes: replace with `requireApiActor()` and handle the auth failure                   |
| 3    | If used only internally (worker/queue): add JSDoc marking it internal-only                        |
| 4    | Add eslint rule or code comment prohibiting `actorOrSystem` in route files                        |
| 5    | Add integration test: request without auth headers to any route using `actorOrSystem` returns 401 |
| 6    | Verify `system` role cannot access role-gated endpoints (overrides, queue admin, exports)         |

**Testing:**

- `pnpm --filter @agentforge/api test` — security-hardening tests must pass
- Manual: `curl http://localhost:4000/api/admin/queue/status` without auth → 401
- Grep verification: `grep -rn "actorOrSystem" apps/api/src/routes/` returns zero results

---

### AF-SEC-003 — CSP Report-Only with unsafe-eval (MEDIUM)

**Description:**
The Next.js web app at `apps/web/next.config.mjs` sets `Content-Security-Policy-Report-Only`
(not enforced) with `'unsafe-eval'` in `script-src` and `'unsafe-inline'` in both `script-src`
and `style-src`. This provides zero XSS protection.

**Root Cause:**
Next.js development mode requires `unsafe-eval` for hot reload; the CSP was never tightened
for production builds.

**Impact:**

- XSS attacks are not mitigated by CSP
- Report-only mode means violations are logged but not blocked
- Compliance frameworks (SOC 2 CC6.6) expect enforced CSP

**Actions:**

| Step | Action                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------- |
| 1    | Split CSP into development (report-only, permissive) and production (enforced, strict)              |
| 2    | Production CSP: remove `'unsafe-eval'` from `script-src`                                            |
| 3    | Production CSP: replace `'unsafe-inline'` in `script-src` with nonce-based approach                 |
| 4    | Production CSP: keep `'unsafe-inline'` in `style-src` only if Next.js requires it (document why)    |
| 5    | Change header from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in production |
| 6    | Add CSP violation reporting endpoint or external service                                            |
| 7    | Test all dashboard pages render correctly under enforced CSP                                        |

**Testing:**

- Browser DevTools → Console → zero CSP violation errors on all dashboard routes
- Playwright E2E suite passes with enforced CSP
- `curl -I https://agentforge-web-production.up.railway.app` shows `Content-Security-Policy` (not Report-Only)

**Caveats:**

- Next.js may require `'unsafe-inline'` for `style-src` due to styled-jsx; document this if retained
- Nonce generation requires `next.config.mjs` middleware; follow Next.js 16 CSP docs

---

### AF-SEC-006 — Secret Scanning Too Narrow (MEDIUM)

**Description:**
The CI secret scanning grep in `.github/workflows/security.yml:43` only matches 3 patterns:

- GitHub PATs (`ghp_`)
- AWS Access Keys (`AKIA`)
- PEM private keys (`-----BEGIN.*PRIVATE KEY-----`)

This misses many common secret formats.

**Root Cause:**
Initial implementation covered the most common patterns; never expanded.

**Impact:**

- Slack tokens (`xoxb-`, `xoxp-`), Stripe keys (`sk_live_`, `rk_live_`), generic API keys,
  JWTs, database connection strings, and other provider tokens can be committed undetected

**Actions:**

| Step | Action                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Expand the grep pattern to cover additional providers                                                                                                          |
| 2    | Add patterns for: Slack (`xox[bpras]-`), Stripe (`sk_live_`, `rk_live_`), SendGrid (`SG\\.`), npm (`npm_`), PyPI (`pypi-`), generic high-entropy base64 tokens |
| 3    | Consider replacing custom grep with `trufflehog` or `gitleaks` for comprehensive coverage                                                                      |
| 4    | Add the tool to pre-commit hooks (not just CI) for shift-left detection                                                                                        |
| 5    | Test against `fixtures/repos/secret-like-token.json` to confirm fixtures are still excluded                                                                    |

**Recommended pattern expansion:**

```bash
ghp_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|\
AKIA[0-9A-Z]{16}|-----BEGIN .*PRIVATE KEY-----|\
xox[bpras]-[0-9]{10,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|\
SG\.[A-Za-z0-9_-]{22,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|\
sk-[A-Za-z0-9]{20,}
```

**Testing:**

- Create a test file with dummy tokens matching each pattern; verify CI catches them
- Verify existing excluded fixtures don't trigger false positives
- Run `pnpm security` locally and confirm zero false positives on clean repo

---

### AF-SEC-007 — Dependency Review Non-Blocking (MEDIUM)

**Description:**
`.github/workflows/dependency-review.yml:18` uses `continue-on-error: ${{ github.event.repository.private }}`
which allows vulnerable dependency introductions to pass CI on private repositories.

**Root Cause:**
GitHub's dependency review action had limited private repo support when initially configured;
`continue-on-error` was a workaround.

**Impact:**

- Known-vulnerable dependencies can be merged without review on private repos
- Undermines the "fail-closed" philosophy of the project

**Actions:**

| Step | Action                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Remove `continue-on-error` line entirely                                                                                                                      |
| 2    | If the action fails on private repos due to GitHub API limitations, use `actions/dependency-review-action@v4` which supports private repos via `GITHUB_TOKEN` |
| 3    | Verify the action has `fail-on-severity: high` and license deny list (`GPL-3.0, AGPL-3.0, LGPL-3.0`)                                                          |
| 4    | Test by creating a PR that introduces a dependency with a known high-severity CVE                                                                             |

**Testing:**

- Create test branch adding `lodash@4.17.20` (known prototype pollution CVE) → CI must fail
- Merge a clean PR → CI must pass
- Verify action output shows license check results

---

### AF-SEC-008 — Docker Compose Broad Port Binding (HIGH for dev environments)

**Description:**
`docker-compose.yml` binds all services to `0.0.0.0` (all network interfaces):

- PostgreSQL: `15432:5432`
- Redis: `6379:6379`
- MinIO: `9000:9000`, `9001:9001`

**Root Cause:**
Default Docker Compose port syntax binds to all interfaces.

**Impact:**

- On shared networks (office WiFi, co-working spaces), databases are reachable by any device
- PostgreSQL with default credentials is directly attackable
- Redis without auth accepts unauthenticated commands from any host

**Actions:**

| Step | Action                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 1    | Prefix all port mappings with `127.0.0.1:` to bind to loopback only                                     |
| 2    | Add `requirepass` to Redis configuration or use `command: redis-server --requirepass ${REDIS_PASSWORD}` |
| 3    | Change PostgreSQL default password from any hardcoded value to environment variable reference           |
| 4    | Add comment in `docker-compose.yml` explaining the loopback binding requirement                         |
| 5    | Add CI check that greps `docker-compose.yml` for port patterns without `127.0.0.1:` prefix              |

**Target state:**

```yaml
ports:
  - "127.0.0.1:15432:5432" # PostgreSQL
  - "127.0.0.1:6379:6379" # Redis
  - "127.0.0.1:9000:9000" # MinIO API
  - "127.0.0.1:9001:9001" # MinIO Console
```

**Testing:**

- `docker compose up -d` → services start successfully
- `curl http://192.168.x.x:15432` from another device on LAN → connection refused
- `curl http://127.0.0.1:15432` from host → connection accepted
- All integration tests pass with loopback-bound services

---

### AF-SEC-009 — Public Operational Endpoints Leak State (LOW)

**Description:**
`/health`, `/ready`, and `/metrics` expose internal system state without authentication:

- Whether GitHub App is configured
- Unsigned webhook mode status
- Queue job counts and retry policies
- Database/Redis backend type
- Application version

**Root Cause:**
Standard practice for Kubernetes probes and Prometheus scraping; auth would complicate
infrastructure integration.

**Impact:**

- Low: information useful for targeted attacks (version → known CVEs, queue state → timing attacks)
- Does not expose credentials or PII

**Actions:**

| Step | Action                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 1    | `/health`: Remove `unsignedWebhookMode` field; keep only `status` and `version`                              |
| 2    | `/ready`: Remove `runtimeStore` and `workerQueue` implementation details; return only `status` and HTTP code |
| 3    | `/metrics`: Add optional bearer token auth (`AGENTFORGE_METRICS_TOKEN` env var); skip auth if not configured |
| 4    | Move detailed diagnostics to `/api/admin/diagnostics` behind `platform_admin` role                           |
| 5    | Document the reduced health endpoint contract for Railway/Kubernetes probe configuration                     |

**Testing:**

- `curl /health` returns `{"status":"ok","version":"1.0.0"}` and nothing else
- `curl /ready` returns `{"status":"ready"}` with 200 or `{"status":"not_ready"}` with 503
- `curl /metrics` without token returns 401 (when token is configured)
- Railway health check still works with minimal response
- Integration tests updated to match new response shapes

---

### AF-SEC-004 — Mobile/Generated Artifact Hygiene (MEDIUM)

**Description:**

- iOS app directory (`apps/ios/`) has no `.gitignore`; Xcode generates build artifacts, DerivedData,
  `.xcuserstate`, and signing certificates that should never be committed
- `artifacts/` directory at repo root is not gitignored; may accumulate screenshots and build outputs

**Root Cause:**
Mobile apps are early prototypes added without standard platform hygiene.

**Impact:**

- Risk of committing Xcode DerivedData (gigabytes), user state files (merge conflicts),
  provisioning profiles (credential exposure)
- `artifacts/` pollution in version control

**Actions:**

| Step | Action                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | Create `apps/ios/.gitignore` with standard Xcode exclusions (DerivedData, xcuserstate, xcworkspace, build/, Pods/) |
| 2    | Create `apps/ios/AgentForge/.gitignore` if the Xcode project lives there                                           |
| 3    | Add `artifacts/` to root `.gitignore`                                                                              |
| 4    | Verify `apps/android/.gitignore` covers `*.jks`, `*.keystore`, `local.properties`, `build/`                        |
| 5    | Add CI hygiene check: reject PRs that add files matching `*.xcuserstate`, `DerivedData/`, `*.jks`                  |

**iOS .gitignore template:**

```gitignore
# Xcode
build/
DerivedData/
*.xcuserstate
*.xcworkspace/xcuserdata/
*.pbxuser
*.mode1v3
*.mode2v3
*.perspectivev3
xcuserdata/

# CocoaPods / SPM
Pods/
.build/

# Signing
*.mobileprovision
*.p12
*.cer

# Generated
project.xcworkspace/
```

**Testing:**

- `git status` shows no untracked Xcode artifacts after build
- `git check-ignore artifacts/test-file` confirms the directory is ignored
- Android build does not leave `*.keystore` files trackable

---

### AF-SEC-005 — Android Release Defaults (LOW/MEDIUM)

**Description:**
`apps/android/app/build.gradle.kts` has no `signingConfigs` block. Release builds will fail
or use debug signing, which is unacceptable for Play Store distribution.

**Root Cause:**
Prototype stage; release signing deferred.

**Impact:**

- Cannot produce Play Store-distributable APK/AAB
- Risk of hardcoding keystore credentials if done hastily later

**Actions:**

| Step | Action                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 1    | Add `signingConfigs` block referencing environment variables (not hardcoded paths)                    |
| 2    | Reference keystore path via `System.getenv("AGENTFORGE_KEYSTORE_PATH")`                               |
| 3    | Reference passwords via `System.getenv("AGENTFORGE_KEYSTORE_PASSWORD")` and `AGENTFORGE_KEY_PASSWORD` |
| 4    | Add `keystore.properties.example` documenting required variables                                      |
| 5    | Add `*.jks` and `*.keystore` to `apps/android/.gitignore` (verify existing)                           |
| 6    | Add `signingConfig = signingConfigs.getByName("release")` to `release` buildType                      |

**Testing:**

- `./gradlew assembleRelease` succeeds when environment variables are set
- `./gradlew assembleRelease` fails gracefully (clear error) when variables are missing
- No keystore files appear in `git status`

---

### HYG-002 — Artifacts Directory Not Gitignored (LOW)

**Description:**
`artifacts/` contains a screenshot (`agentforge-android-readiness.png`) and is not in `.gitignore`.
Its purpose is undecided — if it's for local scratch, it should be ignored; if it's for
durable evidence, it should be committed intentionally with a README.

**Actions:**

| Step | Action                                                                          |
| ---- | ------------------------------------------------------------------------------- |
| 1    | Decide purpose: scratch (gitignore) or durable evidence (commit with README)    |
| 2    | If scratch: add `artifacts/` to root `.gitignore` and delete contents           |
| 3    | If durable: add `artifacts/README.md` explaining purpose and naming conventions |
| 4    | Either way: add size limit CI check (reject files > 5MB in `artifacts/`)        |

---

## Execution Workflow

### Iteration Model

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Analyze → Implement → Test → Review → Verify → Close │
│       ↑                                     │           │
│       └─────── Regression? ←────────────────┘           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Phase Execution Order

| Phase   | Findings                                                 | Estimated Effort | Gate                                                  |
| ------- | -------------------------------------------------------- | ---------------- | ----------------------------------------------------- |
| Phase 0 | HYG-001 (secret deletion + rotation)                     | 1 hour           | Credentials rotated and verified                      |
| Phase 1 | AF-SEC-001, AF-SEC-002 (verify/fix auth)                 | 2-4 hours        | Integration tests pass, manual curl verification      |
| Phase 2 | AF-SEC-008 (Docker ports)                                | 30 minutes       | Integration tests pass with loopback binding          |
| Phase 3 | AF-SEC-003, AF-SEC-006, AF-SEC-007 (CSP, scanning, deps) | 4-6 hours        | CI pipeline passes, Playwright E2E clean              |
| Phase 4 | AF-SEC-004, AF-SEC-005, AF-SEC-009, HYG-002 (hygiene)    | 2-3 hours        | No sensitive files in git status, endpoints minimized |

### Branch Strategy

Each phase gets an independent PR:

- `fix/hyg-001-secret-rotation`
- `fix/af-sec-001-002-auth-hardening`
- `fix/af-sec-008-docker-loopback`
- `fix/af-sec-003-006-007-csp-scanning`
- `fix/af-sec-004-005-009-hygiene`

### Validation Gates (per phase)

| Check             | Command                                   | Expected    |
| ----------------- | ----------------------------------------- | ----------- |
| Unit tests        | `pnpm test`                               | All pass    |
| Integration tests | `pnpm --filter @agentforge/api test`      | All pass    |
| E2E tests         | `pnpm --filter @agentforge/web e2e`       | All pass    |
| Security tests    | `pnpm --filter @agentforge/security test` | All pass    |
| Type check        | `pnpm typecheck`                          | Zero errors |
| Lint              | `pnpm lint`                               | Zero errors |
| Security scan     | CI `security.yml` workflow                | Green       |
| Policy validation | `pnpm policy:validate`                    | Green       |
| Release readiness | `pnpm release:check`                      | Green       |

---

## Regression Checklist

After all phases complete, verify no regressions across the full system:

- [ ] GitHub webhook ingestion still works (signature verification)
- [ ] PR evaluation produces correct check runs
- [ ] Dashboard loads all routes without CSP violations
- [ ] Policy preview requires authentication
- [ ] Evidence workflow (submit → approve) functions correctly
- [ ] Override workflow (request → approve) functions correctly
- [ ] Export generation produces valid JSON/CSV
- [ ] Docker Compose local development environment starts cleanly
- [ ] All CI workflows pass on a clean PR
- [ ] Health/readiness probes work with Railway deployment
- [ ] No secrets in git history (`git log --all -p | grep "BEGIN.*PRIVATE KEY"`)

---

## Definition of Done

The remediation program is complete when:

1. All P0/P1/P2 findings have merged PRs with passing CI
2. No finding remains in "verify" status — each is confirmed fixed in code
3. Integration test coverage exists for every authentication boundary change
4. Secret rotation is complete and production is healthy on new credentials
5. `pnpm release:check` passes
6. Security assessment re-scan confirms zero open findings
7. Remediation checklist in `docs/security-remediation-plan-2026-05-28.md` accurately reflects actual code state (not aspirational)
