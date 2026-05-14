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

Audit readiness:

- Every evaluated PR has an exportable Change Control Record with policy version, findings, evidence, reviewers, decision, and lifecycle state.
- Override records include actor, role, reason, timestamp, scope, policy version, and PR-visible setting.
- Policy previews are read-only by default; persisting preview output requires `persist: true` and an authorized server-resolved actor.
- Evidence is not considered complete until approval. Provided evidence without approval remains an open governance requirement.
- State-changing governance routes resolve actors from server-side request context headers, not from request-body role claims.
- In production, the API accepts trusted proxy identity headers (`x-agentforge-authenticated-actor` and `x-agentforge-authenticated-role`) only when `AGENTFORGE_API_TRUST_PROXY_HEADERS=true`. Raw local actor headers (`x-agentforge-actor` and `x-agentforge-role`) are rejected in production unless `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true` is explicitly set for local testing.
- Policy and repository settings changes require `platform_admin` or `engineering_manager`.
- Dashboard onboarding and settings forms submit through Next.js server actions. Development/test can use `AGENTFORGE_DASHBOARD_ACTOR` and `AGENTFORGE_DASHBOARD_ROLE` as a local actor fallback. Deployed environments should set `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true` only behind a trusted auth proxy that injects `x-agentforge-authenticated-actor` and `x-agentforge-authenticated-role`; otherwise dashboard mutations fail closed.
- Change Control Record exports and audit-event access require `auditor`, `platform_admin`, or `engineering_manager`.
- GitHub webhooks fail closed when `GITHUB_WEBHOOK_SECRET` is not configured. Unsigned fixture replay requires explicit local-only `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true`.
- Production configuration fails closed if unsigned webhooks, source-code storage, or unredacted secrets are enabled.
- Audit events are emitted for policy changes, repository settings changes, owner mapping changes, overrides, evidence updates, reviewer approvals, check publishing, exports, and retention changes.
- JSON and CSV exports are sanitized through the same metadata-only storage policy used for dashboard/API output.
