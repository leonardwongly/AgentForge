# Change Control Records

A Change Control Record is the authoritative structured state for a governed PR.

It captures:

- repository
- PR number
- head SHA
- base branch
- mode
- policy version
- policy pack version
- verified findings
- required evidence
- required reviewers
- check status
- lifecycle state
- decision details
- override details
- timestamps

Normalized runtime tables mirror the record into policy-version, evaluation, verified-fact, evidence-requirement, reviewer-requirement, check-run, and override rows. The JSON Change Control Record remains the authoritative export shape; normalized rows make audit queries and dashboard aggregation deterministic.

Lifecycle states:

- `opened`
- `evaluated`
- `blocked`
- `warned`
- `passed`
- `overridden`
- `merged`
- `closed`

Exports:

- JSON: complete structured record, redacted.
- CSV: audit-friendly row summary without source code or full diff content.

Audit use cases:

- reconstruct why a PR was blocked
- show which evidence was missing
- show which evidence was provided but not approved
- show which reviewer was required
- prove which policy version was applied
- record authorized override actor, role, reason, scope, and timestamp
