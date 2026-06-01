# Security And Data Handling

Default posture:

- Store metadata, file paths, findings, policy results, reviewer state, evidence state, and override state.
- Do not store full source code.
- Do not retain full diffs unless explicitly configured.
- Redact secrets from logs, snippets, stored artifacts, check summaries, dashboard display, exports, and advisory prompts.

Diff retention options:

- `disabled`
- `7d`
- `30d`
- `custom`

When full diff retention is disabled, diffs are fetched for evaluation, processed in memory, and only safe facts or redacted summaries are retained.

LLM controls:

- `LLM_FEATURES=false` by default.
- When disabled, no prompts are generated and no snippets are sent to model services.
- When enabled later, advisory findings remain separate from verified facts.
- LLM output cannot set a blocking status.
- Prompts must be redacted.
- Customer code is not used for model training by this V1 implementation.

Exports exclude full source code by default and are redacted before output.
Current export delivery is `api_job_download`: the API creates a bounded export
job, stores the sanitized artifact with the job record, and serves it through
authorized API reads. Object-storage variables are reserved for a future
delivery adapter and are not treated as active storage configuration.

Audit readiness:

- Every evaluated PR has an exportable Change Control Record with policy version, findings, evidence, reviewers, decision, and lifecycle state.
- Override records include actor, role, reason, timestamp, scope, policy version, and PR-visible setting.
- Policy previews are read-only by default; persisting preview output requires `persist: true` and an authorized server-resolved actor.
- Evidence is not considered complete until approval. Provided evidence without approval remains an open governance requirement.
- State-changing governance routes resolve actors from server-side request context headers, not from request-body role claims.
- In production, the API accepts trusted proxy identity headers (`x-agentforge-authenticated-actor`, `x-agentforge-authenticated-role`, and `x-agentforge-authenticated-organization`) only when `AGENTFORGE_API_TRUST_PROXY_HEADERS=true` and `AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS=true`. Raw local actor headers (`x-agentforge-actor`, `x-agentforge-role`, and `x-agentforge-organization`) require `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true` outside tests, are rejected in production, and are blocked by config/preflight checks when app or API URLs are not loopback.
- Policy and repository settings changes require `platform_admin` or `engineering_manager`.
- Dashboard onboarding and settings forms submit through Next.js server actions. Development/test can use `AGENTFORGE_DASHBOARD_ACTOR`, `AGENTFORGE_DASHBOARD_ROLE`, and `AGENTFORGE_DASHBOARD_ORGANIZATION` only when `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true`; the default local role is `developer`, so admin smoke tests must explicitly set `platform_admin` or `engineering_manager`. Deployed environments should set `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true` only behind a trusted auth proxy that injects actor, role, and organization identity headers; otherwise dashboard mutations fail closed.
- Deployed self-hosted dashboards can alternatively use built-in GitHub OAuth. OAuth sessions are signed with `SESSION_SECRET`; API calls are still forwarded with signed proxy identity headers and must pass API role checks.
- GitHub App installations are stored as pending until a platform admin explicitly approves and links them to an AgentForge organization. Repository removal events disable and archive repository records rather than deleting historical records.
- Change Control Record exports and audit-event access require `auditor`, `platform_admin`, or `engineering_manager` and are filtered to the authenticated actor organization.
- Dashboard record APIs default to 50 records per page and reject page sizes above 100. Query filters are server-validated for status, lifecycle, mode, repository, policy version, and sort order.
- Change Control Record exports default to 500 records and reject `maxRecords` values above 1,000. Export responses report `totalMatchingRecords` and `truncated` so operators can page exports deliberately instead of allocating an unbounded dataset.
- Compliance evidence packages are JSON-only export jobs for `auditor` and `platform_admin` roles. They default to 250 records, reject `maxRecords` values above 500, and can be filtered by repository id, policy pack id, policy version, and updated-at time range.
- GitHub webhooks fail closed when `GITHUB_WEBHOOK_SECRET` is not configured. Unsigned fixture replay requires explicit local-only `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true`.
- Production configuration fails closed if unsigned webhooks, source-code storage, unredacted secrets, missing trusted proxy auth, local actor fallbacks, or missing ingress header-stripping acknowledgement are detected.
- Audit events are emitted for policy changes, repository settings changes, owner mapping changes, overrides, evidence updates, reviewer approvals, check publishing, exports, and retention changes.
- Audit events use schema version `1` and expose actor role, source, request id, correlation id, and policy identity as first-class fields when available. The same values are repeated in sanitized metadata for export compatibility.
- JSON and CSV Change Control Record exports include the matching append-only audit event trail so auditors can reconstruct evidence, reviewer, override, check-publication, and settings lifecycle changes without relying on mutable record snapshots alone.
- JSON and CSV exports are sanitized through the same metadata-only storage policy used for dashboard/API output.
- Compliance evidence packages include a manifest, deterministic control-family mappings, sanitized record summaries, an audit timeline, and a redaction report. Control mappings are governance aids for audit preparation; they do not replace human auditor judgment and do not mutate policy.

Current compliance limitations and non-goals:

- Exports are point-in-time artifacts, not a legal-hold archive or WORM storage layer.
- `requestId` is available for API-originated events; worker-originated events use webhook delivery ids as correlation ids when available.
- Source code, raw patches, private keys, webhook secrets, OAuth secrets, and installation tokens remain intentionally excluded from records and exports.
