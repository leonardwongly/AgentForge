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
- Audit events are emitted for policy changes, overrides, evidence updates, reviewer approvals, check publishing, exports, and retention changes.
- JSON and CSV exports are sanitized through the same metadata-only storage policy used for dashboard/API output.
