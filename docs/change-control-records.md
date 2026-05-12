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
- show which reviewer was required
- prove which policy version was applied
- record authorized override actor, role, reason, scope, and timestamp
