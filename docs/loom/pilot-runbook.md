# Loom Phase 4 Dual-Safety Pilot Runbook

> Status: operational runbook (not code)
> Applies to: [Loom VCS Core Specification](loom-detailed-design.md) §21 Phase 4
> and [Validation Plan](validation-plan.md) §7 Phase 4 / §11.

The Phase 4 dual-safety pilot runs a real project with Loom as the authoring
authority while a git mirror is continuously checked for equivalence. This
runbook describes the operational procedure, the supporting `loom pilot`
commands, and the evidence template a completed pilot must publish.

## 1. Objective and exit gate

The pilot passes only when, over at least **30 consecutive days**:

- Loom is the authoring authority (all changes admitted through Loom).
- **Zero unrecoverable data loss.**
- **Zero undetected admitted divergence** between Loom and the git mirror.
- Every admitted State is exportable to the recoverable git mirror.
- At least **two restore drills** recover the complete authoritative history.
- Rollback to the mirrored git projection is rehearsed before pilot start.
- Every integrity or availability incident has a written root-cause record.

## 2. Prerequisites

- A Loom repository initialized with `loom init` (see `loom-cli`).
- A git mirror repository (can be empty; `git init`).
- A backup location for object-store snapshots.
- The `@agentforge/loom-cli` package built and on `PATH`.

## 3. Daily operation

### 3.1 Mirror each admission

After every Loom admission, export the current head State to the git mirror and
verify byte-exact equivalence:

```bash
loom pilot mirror --repo <loom-dir> --git <git-repo> --message "mirror <seq>"
```

This command:

1. Exports the Loom head State to the git mirror working copy and commits it.
2. Verifies the git HEAD tree matches the Loom head State byte-for-byte.
3. Records the equivalence digest in `.loom/mirror.jsonl` (tamper-evident).
4. Returns a non-zero exit and **stops** if the mirror diverged, preserving
   both histories for investigation (LOOM-GIT-006).

### 3.2 Verify on demand

```bash
loom pilot verify --repo <loom-dir> --git <git-repo>
```

Prints whether the mirror is currently equivalent to the Loom head State and
the equivalence digest.

### 3.3 Restore drills

Run a clean-room restore drill at least twice during the pilot:

```bash
loom pilot restore --repo <loom-dir> --backup <backup-dir>
```

This command backs up the object store, restores it into a fresh store, and
verifies the head State, every Line head, and the admission ledger are
reproduced (LOOM-STORE-007).

## 4. Divergence handling

If `loom pilot mirror` or `loom pilot verify` reports divergence:

1. **Stop automatic cutover immediately.** Do not admit further changes until
   the cause is understood.
2. Preserve both histories: the Loom store and the git mirror remain untouched.
3. Determine whether the divergence is in the mirror (git) or the authoritative
   Loom history.
4. Record the incident in the incident log with root cause.
5. Only resume after the mirror is restored to equivalence or the divergence is
   formally accepted and documented.

## 5. Evidence template

A completed pilot MUST publish a report in the §11 format. Fill in every field:

```text
Specification version:       0.1.0-draft
Implementation version:      @agentforge/loom-cli <version>
Implementation commit:       <source revision>
Claimed profiles:             LOOM-CORE (single-authority trust profile)
Environment:                  <OS, filesystem, storage, hardware>
Commands executed:            <the loom pilot commands run, with dates>
Required test IDs passed:     LOOM-GIT-005, LOOM-GIT-006, LOOM-STORE-007, ...
Failed tests:                 <none, or list with cause>
Skipped or unsupported tests: <list>
Fault-injection scenarios:    <restore drills, mirror tampering, partition tests>
Security review status:       <status>
Performance dataset/results:  <dataset, hardware, percentiles>
Migration/interoperability limits: <git import/export limitations, filters>
Trust and witness topology:   <single-authority; witnesses if any>
Known risks:                  <list>
External/manual evidence still required: <independent review, pilot evidence>
Artifact locations and digests: <mirror ledger, backup digests>
```

### 5.1 Pilot metrics to record

- Agent concurrency and abandoned-work rate.
- Conflict rate and conflict-resolution time.
- Percentage of changes represented by pinned Recipes.
- Clean-reapply and divergence rates.
- Time from Intent to admitted State.
- Approval and evidence latency.
- Authorization failures and Grant usability.
- Restore, mirror, and verification success.
- Number of mirror-divergence events and their root causes.

## 6. Honest claims

Per validation-plan §10, the pilot may claim only what its evidence supports.
A successful pilot demonstrates durable, recoverable, byte-exact Loom history
with a continuously-verified git mirror. It does **not** by itself prove
host-independent history, model authorship, or software correctness.
