# Loom VCS Conformance and Validation Plan

> Specification: `0.1.0-draft`
>
> Status: normative validation companion
>
> Applies to: [Loom VCS Core Specification](loom-detailed-design.md) and
> [Merge and Reapply Specification](reapply-merge-engine.md)

This document defines the evidence required to claim that a Loom implementation
is correct, durable, secure, and compatible with a declared conformance profile.
It replaces the earlier willingness-to-pay kill gate. Native Loom VCS is the
chosen destination; user research now informs sequencing, ergonomics, and
commercialization rather than deciding whether Loom remains a Git layer.

## 1. Validation principles

1. **Data-loss safety comes first.** No performance, automation, or adoption
   result can compensate for lost or silently corrupted history.
2. **Executable evidence beats prose.** Every normative invariant needs a test,
   proof vector, fault-injection scenario, or documented manual procedure.
3. **Current and target truth remain separate.** Prototype tests demonstrate
   implemented slices; they do not prove a complete conformance profile,
   independent interoperability, or the operational Phase 4 pilot.
4. **Failures remain visible.** Skipped, flaky, quarantined, unsupported, and
   externally blocked checks are reported separately from passes.
5. **Independent implementations matter.** Canonical encoding, proof formats,
   and protocol behavior require cross-implementation vectors before `1.0`.
6. **Claims match topology.** A single authority cannot claim host-independent
   history merely because it runs multiple components.

## 2. Conformance declaration

Every tested build MUST publish a machine-readable declaration containing:

```json
{
  "product": "Loom",
  "specification": "0.1.0-draft",
  "implementation": "name-and-version",
  "commit": "source-revision",
  "profiles": ["LOOM-CORE"],
  "storageProfile": "local-durable",
  "trustProfile": "single-authority",
  "supportedSchemas": [1],
  "supportedHashes": ["sha2-256"],
  "knownGaps": []
}
```

An implementation MUST NOT include a profile unless every REQUIRED test for that
profile passes or the specification explicitly permits a documented exception.

## 3. Current prototype baseline

The current repository should continue to run these checks while native
capabilities are added:

```bash
pnpm --filter './packages/loom-*' typecheck
pnpm --filter './packages/loom-*' test
pnpm typecheck
pnpm test
pnpm build
pnpm release:check
git diff --check
```

The targeted Loom suites now cover the core algebra, merge/reapply, Grants,
durable storage and recovery, canonical encoding, Git bridge, ratification,
provenance, witnessed trust, agent workflows, and CLI pilot tooling. These are
**implementation baseline checks**, not a `LOOM-CORE` conformance claim.

Current implementation boundaries that MUST remain visible in test reports
include:

- no complete `LOOM-CORE` profile declaration or independently implemented
  interoperability vectors;
- the Loom-to-governance adapter still supplies a synthesized pull-request
  envelope to the existing policy engine;
- the Phase 4 dual-safety pilot is tooling and a runbook, not an executed
  30-day operational pilot; and
- production distribution, external witness operations, and long-running
  deployment evidence remain outside the repository test suites.

## 4. Required conformance suites

### 4.1 Encoding and object integrity (`LOOM-ENC`)

| ID             | Requirement                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-ENC-001` | At least two independent processes encode every canonical vector to byte-identical DAG-CBOR.                                 |
| `LOOM-ENC-002` | CIDv1 text and bytes match published reference vectors for structured and raw objects.                                       |
| `LOOM-ENC-003` | Non-canonical integers, lengths, duplicate keys, unsupported floats, and unknown same-version fields are rejected.           |
| `LOOM-ENC-004` | A one-bit object mutation produces `HashMismatch` and never enters the reachable store.                                      |
| `LOOM-ENC-005` | Domain-separated node IDs, signatures, and cache keys cannot be substituted for object CIDs.                                 |
| `LOOM-ENC-006` | Chunked and unchunked representations reconstruct identical logical bytes; manifest size and chunk order are enforced.       |
| `LOOM-ENC-007` | Decoder allocation and nesting limits reject object, stack, and decompression bombs before unsafe allocation.                |
| `LOOM-ENC-008` | ReapplyWriteSet DAG-CBOR/CID vectors cover every Operation variant, operation ordering, path swaps, and create/delete cases. |

`LOOM-ENC-001` through `008` are REQUIRED for `LOOM-CORE`.

### 4.2 Paths, Cells, and States (`LOOM-STATE`)

| ID               | Requirement                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `LOOM-STATE-001` | Arbitrary permitted path bytes round-trip without Unicode or case normalization.                  |
| `LOOM-STATE-002` | Empty, NUL, slash-containing, `.`, and `..` segments are rejected.                                |
| `LOOM-STATE-003` | Case-fold and Unicode-normalization collisions fail before working-copy mutation.                 |
| `LOOM-STATE-004` | Every reachable Cell has one unique NodeIdent and the identity index exactly matches the Weave.   |
| `LOOM-STATE-005` | A pure move preserves NodeIdent and content CID; a copy creates a new NodeIdent.                  |
| `LOOM-STATE-006` | Concurrent sessions mint distinct NodeIdents without needing a Transform CID.                     |
| `LOOM-STATE-007` | Semantic facet projection must reproduce authoritative bytes or the facet is rejected/unverified. |
| `LOOM-STATE-008` | State addressing excludes timestamps and other non-state metadata.                                |
| `LOOM-STATE-009` | File bytes, executable mode, symlink target, and opaque content round-trip exactly.               |
| `LOOM-STATE-010` | SpaceId and LineId construction is non-circular, domain-separated, and collision-tested.          |

### 4.3 Transform algebra (`LOOM-TX`)

| ID            | Requirement                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `LOOM-TX-001` | Applying a valid operation list to the declared base reproduces the declared result CID.                                |
| `LOOM-TX-002` | Missing selector, occupied move target, invalid byte range, identity collision, and facet mismatch return typed errors. |
| `LOOM-TX-003` | Under-declared effects reject admission; over-declared effects remain visible to policy and authorization.              |
| `LOOM-TX-004` | Operation order is deterministic and serialization order changes are detected.                                          |
| `LOOM-TX-005` | A linear Transform's base equals its parent's result; reconciliation bases equal the recorded deterministic LCA.        |
| `LOOM-TX-006` | Transform addressing has no dependency cycle with signatures, attestations, Proposals, or AdmissionRecords.             |
| `LOOM-TX-007` | A reapply uses the new history head as parent and records the original through `derivedFrom`.                           |
| `LOOM-TX-008` | Removing unverified semantic facets cannot lower or clear a blocking byte-derived fact.                                 |

### 4.4 Merge and reapply (`LOOM-MERGE`)

The companion merge specification defines detailed cases. The minimum suite is:

| ID               | Requirement                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-MERGE-001` | LCA selection is deterministic on linear, criss-cross, and multiple-best-ancestor DAGs.                                                                          |
| `LOOM-MERGE-002` | Random operation pairs satisfy no-silent-loss: every change appears in the result or a typed conflict.                                                           |
| `LOOM-MERGE-003` | Move/edit over the same NodeIdent composes when content and destination constraints permit.                                                                      |
| `LOOM-MERGE-004` | Delete/edit, divergent moves, binary changes, and overlapping text edits produce deterministic results or conflicts.                                             |
| `LOOM-MERGE-005` | Text three-way vectors match the published Loom reference behavior and preserve newline/encoding evidence.                                                       |
| `LOOM-MERGE-006` | Only a hermetic pinned Recipe may return a verified `CleanReapply`.                                                                                              |
| `LOOM-MERGE-007` | Write-scope escape, missing input, toolchain mismatch, failed invariant, or nondeterminism never auto-admits.                                                    |
| `LOOM-MERGE-008` | Reapply executes against the new base and can transform newly introduced matching content.                                                                       |
| `LOOM-MERGE-009` | Unrelated base changes do not invalidate an effect fingerprint; affected unexpected changes cause `Divergence`.                                                  |
| `LOOM-MERGE-010` | Every newly constructed merge/reapply Transform re-derives facts and invalidates prior approvals, even with an identical result State.                           |
| `LOOM-MERGE-011` | Unresolved conflicts cannot advance a Shared Line.                                                                                                               |
| `LOOM-MERGE-012` | A multi-Cell Recipe result is installed as one complete verified write set or not at all; partial per-node grafts never land.                                    |
| `LOOM-MERGE-013` | Overlapping Recipe units without a history-defined order fall back or conflict instead of using incidental iteration order.                                      |
| `LOOM-MERGE-014` | Original-base Recipe output must be byte-identical to Transform.operations; alternate, reordered, net-zero, partial, or mixed programs hard-fail.                |
| `LOOM-MERGE-015` | ReapplyWriteSet preserves exact engine operation order; malformed, reordered, duplicate, failing-precondition, and swapped-path programs are rejected.           |
| `LOOM-MERGE-016` | ReapplyContext is identical across fresh runs and bound to output author/nonce/operations; global ordinals remain unique across multiple creation-bearing units. |

Comparison against Git SHOULD be retained as a regression corpus, but Git parity
is not a proof of Loom correctness. A conservative Loom conflict is acceptable;
silent loss or an unverified automatic resolution is not.

### 4.5 Working copy (`LOOM-WC`)

| ID            | Requirement                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-WC-001` | Materialization validates all paths, collisions, sizes, modes, and object hashes before mutation.                                         |
| `LOOM-WC-002` | Files are written without following workspace symlinks; symlinks are created only after safe regular entries.                             |
| `LOOM-WC-003` | Crash at every journal step restores the prior complete tree or resumes to the new complete tree.                                         |
| `LOOM-WC-004` | Untracked paths are never overwritten without an explicit recorded user decision.                                                         |
| `LOOM-WC-005` | Status distinguishes edits, deletes, moves, type/mode changes, untracked paths, ignored paths, and collisions.                            |
| `LOOM-WC-006` | Concurrent editor writes during capture either produce a stable snapshot or a typed retry; mixed reads are rejected.                      |
| `LOOM-WC-007` | Materializing malicious paths, symlinks, device files, and oversized trees cannot escape or corrupt the workspace root.                   |
| `LOOM-WC-008` | Concurrent ChangeSessions cannot capture or advance one another's journals, working copies, or Local Lines.                               |
| `LOOM-WC-009` | Seal binds and freezes the exact append sequence and journal digest; delayed seals or concurrent appends return a typed retry.            |
| `LOOM-WC-010` | Transform installation, Local Line tuple CAS, and seal idempotency commit atomically; one concurrent seal wins and stale/ABA tuples fail. |

### 4.6 Durable storage, recovery, GC, and backup (`LOOM-STORE`)

| ID               | Requirement                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `LOOM-STORE-001` | Kill the process after every object-write step; no invalid or partially reachable object survives recovery.             |
| `LOOM-STORE-002` | Acknowledged Local Line updates survive process and machine restart under the declared durability profile.              |
| `LOOM-STORE-003` | Recovery detects and reports missing reachable CIDs without fabricating data.                                           |
| `LOOM-STORE-004` | GC never deletes objects reachable from any declared root, sync lease, working-copy base, or grace period.              |
| `LOOM-STORE-005` | Concurrent reachability changes during GC are protected by snapshot/barrier semantics.                                  |
| `LOOM-STORE-006` | Interrupted GC is restartable and idempotent.                                                                           |
| `LOOM-STORE-007` | Backup followed by clean-room restore reproduces every Line head and verifies every configured ledger when present.     |
| `LOOM-STORE-008` | Disk-full, permission loss, torn write, checksum failure, and fsync failure never produce acknowledged partial history. |

These tests require real filesystem and storage fault injection; mocks alone are
insufficient for a `LOOM-CORE` claim.

### 4.7 Identity and Grants (`LOOM-AUTH`)

| ID              | Requirement                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-AUTH-001` | Transform signatures are domain-separated and subject-pinned to the exact Transform CID.                                                                                    |
| `LOOM-AUTH-002` | Historical signatures verify using the key valid at the admission position.                                                                                                 |
| `LOOM-AUTH-003` | Revoked or not-yet-valid keys cannot authorize later admissions.                                                                                                            |
| `LOOM-AUTH-004` | A Grant chain roots at the controller, follows exact parent CIDs and issuer/audience continuity, attenuates every hop, and ends at the authorized actor.                    |
| `LOOM-AUTH-005` | Operation, selector, effect, deletion, sensitive-path, cell-count, time, and custom caveats fail closed.                                                                    |
| `LOOM-AUTH-006` | Undecidable selector inclusion is rejected rather than broadened.                                                                                                           |
| `LOOM-AUTH-007` | An agent cannot expand its own Grant or approve its own change under default policy.                                                                                        |
| `LOOM-AUTH-008` | Key compromise and controller recovery drills preserve historical verification and stop future compromised authorization.                                                   |
| `LOOM-AUTH-009` | Space bootstrap rejects a descriptor without a valid initial-controller signature or configured trust root.                                                                 |
| `LOOM-AUTH-010` | Every introduced Transform has an author-matching signature; a missing signature or different actor's co-signature cannot substitute.                                       |
| `LOOM-AUTH-011` | Move authorization covers source identity/path and destination path; put operations cover creation paths, with out-of-scope targets rejected.                               |
| `LOOM-AUTH-012` | `approve` and `override` are distinct scoped actions; approval-only Grants confer no write power and signer/predicate/leaf actors must match.                               |
| `LOOM-AUTH-013` | Grant time/sequence intervals are half-open; exact lower/upper boundaries, malformed intervals, child subsets, clock rollback, and replay are deterministic.                |
| `LOOM-AUTH-014` | Replaying a Grant across another Line, Space, or ledger origin fails even when the same controller DID and selectors are otherwise valid.                                   |
| `LOOM-AUTH-015` | Grant keyId/algorithm substitution, unknown caveats, duplicate caveats, changed caveats, or caveat removal fail closed at every chain hop.                                  |
| `LOOM-AUTH-016` | One leaf chain covers every operation name, source/destination footprint member, aggregate effect, and bound; partial-chain unions and every Operation variant fail closed. |

### 4.8 Shared admission (`LOOM-ADMIT`)

| ID               | Requirement                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-ADMIT-001` | Structural validation, authorization, facts, policy, evidence, approvals, record, ledger, and head update form one logical transaction.                                |
| `LOOM-ADMIT-002` | Exactly one concurrent `(expectedHead, expectedSequence)` CAS wins; stale-head, stale-sequence, and ABA-tuple losers receive `RebaseRequired`.                         |
| `LOOM-ADMIT-003` | Replaying an idempotency key with the same request returns the original result; a different request gets `IdempotencyConflict`.                                        |
| `LOOM-ADMIT-004` | `block` and unresolved conflict decisions cannot advance the Line.                                                                                                     |
| `LOOM-ADMIT-005` | Override requires an authorized human, reason, exact result, and policy permission.                                                                                    |
| `LOOM-ADMIT-006` | Crash after every transaction step recovers to old-complete or new-complete state.                                                                                     |
| `LOOM-ADMIT-007` | Acknowledged admission remains reachable with its exact evidence, approval, Grant, and attestation sets.                                                               |
| `LOOM-ADMIT-008` | Fact cache changes when any result-affecting input changes and remains stable otherwise.                                                                               |
| `LOOM-ADMIT-009` | Rejection commits a complete RejectionRecord and ledger event while leaving the Line head and sequence unchanged.                                                      |
| `LOOM-ADMIT-010` | An unrelated/old proposed head or reconciliation omitting the current head is rejected; rollback requires a new descendant Transform.                                  |
| `LOOM-ADMIT-011` | The complete introduced Transform closure is traversed; omitting any intermediate/side Transform, signature, Grant, effect, or parent fails.                           |
| `LOOM-ADMIT-012` | Facts and policy cover the current-Line-State-to-candidate transition, exposing deletions or effects hidden by side-history bases.                                     |
| `LOOM-ADMIT-013` | Tuple mismatch atomically commits linked rejection/evidence/response; all invalid status-field combinations and non-null stale facts reject; replay is byte-identical. |
| `LOOM-ADMIT-014` | Proposal Line, LineRef Space, every closure Transform/State/parent, every Grant scope, and pending LedgerEvent origin must match exactly.                              |

### 4.9 Provenance, ledger, and witnesses (`LOOM-TRUST`)

| ID               | Requirement                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-TRUST-001` | DSSE PAE and in-toto statements match independent reference vectors.                                                                               |
| `LOOM-TRUST-002` | Signature, predicate, Transform subject, result State, facts digest, and policy binding are verified.                                              |
| `LOOM-TRUST-003` | Detaching, substituting, duplicating, or reordering the accepted attestation set is detected.                                                      |
| `LOOM-TRUST-004` | Agent-run provenance is labeled attested and cannot independently satisfy a deterministic blocking fact.                                           |
| `LOOM-TRUST-005` | Merkle inclusion and consistency proofs match independent RFC 6962 vectors.                                                                        |
| `LOOM-TRUST-006` | Ledger append positions are gap-free and duplicate requests are idempotent.                                                                        |
| `LOOM-TRUST-007` | Witnesses refuse inconsistent checkpoints and emit durable split-view evidence.                                                                    |
| `LOOM-TRUST-008` | Offline verification uses only the bundle and declared trust root and reports the exact trust topology.                                            |
| `LOOM-TRUST-009` | Single-authority deployments cannot pass tests or emit metadata claiming independent witness trust without a separate administrative trust domain. |
| `LOOM-TRUST-010` | An in-toto SHA-256 subject uses the verified Transform CID's multihash digest; hashing CID text/bytes again fails reference vectors.               |

### 4.10 Replication and synchronization (`LOOM-SYNC`)

| ID              | Requirement                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-SYNC-001` | Object transfer is idempotent, hash-verified, bounded, and restartable.                                                                                       |
| `LOOM-SYNC-002` | Missing dependencies remain quarantined until the reachable graph verifies.                                                                                   |
| `LOOM-SYNC-003` | Operation stream sequence numbers deduplicate retries and reject gaps or reordering.                                                                          |
| `LOOM-SYNC-004` | Offline Local Line objects remain protected from GC until sync acknowledgement or explicit abandonment.                                                       |
| `LOOM-SYNC-005` | Network partition and reconnect cannot roll back an acknowledged Shared Line head.                                                                            |
| `LOOM-SYNC-006` | Authentication, authorization, quota, and back-pressure failures are typed and do not partially mutate state.                                                 |
| `LOOM-SYNC-007` | Malicious peers cannot cause unbounded DAG walks, allocations, proof work, or connection fan-out.                                                             |
| `LOOM-SYNC-008` | Open, append, seal, and submit retries after response loss/restart return the byte-identical full result/evidence; conflicting key reuse never mutates.       |
| `LOOM-SYNC-009` | Seal retries bind Local Line tuple, append sequence, and journal digest; concurrent seal/append races cannot overwrite or mix journal prefixes.               |
| `LOOM-SYNC-010` | Local stale OpenChange/SealChange uses expectedHead as candidateHead, links identical evidence/response fields, and replays frozen CIDs after later advances. |

### 4.11 Git interoperability (`LOOM-GIT`)

| ID             | Requirement                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-GIT-001` | Snapshot import and export preserve bytes, executable bits, symlink targets, and supported external references.                  |
| `LOOM-GIT-002` | Full DAG import preserves parent topology and deterministic tree mapping.                                                        |
| `LOOM-GIT-003` | Imported rename, intent, provenance, and identity uncertainty is explicit; no missing fact is fabricated.                        |
| `LOOM-GIT-004` | Filters, sparse checkouts, submodules, LFS, unsafe paths, missing objects, and path collisions fail with actionable diagnostics. |
| `LOOM-GIT-005` | Every admitted pilot State exports to the Git mirror with a recorded equivalence digest.                                         |
| `LOOM-GIT-006` | Mirror divergence stops automatic continuation and preserves both histories for investigation.                                   |

## 5. Security validation

Before any real-project pilot, the implementation MUST complete:

- threat modeling for object ingestion, working copies, recipe sandbox,
  authority, synchronization, identity, Grants, ledger, and witnesses;
- static analysis and dependency review;
- secret scanning and artifact inspection;
- fuzzing for canonical decoders, path handling, merge, proof verification, and
  protocol frames;
- adversarial recipe and sandbox-escape testing;
- authorization property tests and privilege-escalation review;
- replay, downgrade, stale-approval, signature/key/algorithm confusion,
  cross-Line/Space/origin Grant substitution, unknown-caveat, clock-rollback,
  and approval/override capability-substitution tests;
- denial-of-service tests with deep DAGs, large objects, hot Lines, and proof
  requests; and
- an independent review before Loom becomes the sole authoritative history for
  valuable source code.

A security review MUST NOT claim that provenance proves model authorship or that
policy success proves software correctness.

## 6. Fault-injection matrix

The following fault points are REQUIRED where the component exists:

| Component      | Injected failures                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Object store   | process kill, machine restart, disk full, short write, corrupted temp object, failed flush, failed rename                                              |
| Working copy   | kill between every journal step, editor/concurrent-seal/delayed-seal race, journal append after request, permission loss, symlink swap, case collision |
| Admission      | kill before/after object promotion, record creation, ledger append, head CAS, idempotency commit, response write                                       |
| Database       | transaction abort, connection loss, primary failover, stale replica read, serialization retry                                                          |
| Sync           | disconnect/response loss before and after commit, duplicate/missing/reordered frame, conflicting idempotency reuse, malicious CID, quota exhaustion    |
| Ledger/witness | inconsistent checkpoint, unavailable quorum, stale checkpoint, forged signature, proof truncation                                                      |
| Backup/restore | missing segment, stale key metadata, partial object set, corrupt ledger, wrong configuration                                                           |

Each fault test records expected old/new state, actual recovery state, reachable
roots, and whether an acknowledgement had been issued.

## 7. Phase exit gates

### Phase 0 — Specification

- Every normative object has a non-circular address construction.
- ReapplyContext/WriteSet, closed RebaseEvidence/RebaseRequired variants, and
  Grant caveat/key/resource schemas have canonical cross-implementation vectors.
- The decision register is internally consistent.
- Test IDs cover every non-negotiable invariant.
- Current implementation gaps are explicit.
- The merge and core specifications agree on parent/base and approval semantics.

### Phase 1 — Native local kernel

- All `LOOM-ENC`, `LOOM-STATE`, `LOOM-TX`, `LOOM-MERGE`, `LOOM-WC`, and
  `LOOM-STORE` tests pass.
- Cross-process canonical vectors pass.
- A fuzzed Git corpus round-trips within declared interoperability limits.
- Crash recovery and clean-room restore pass.
- Local Line tuple-CAS, exact journal-prefix sealing, and concurrent-seal tests pass.
- Zero silent-loss findings remain open.

### Phase 2 — Shared authority

- All `LOOM-AUTH`, `LOOM-ADMIT`, and non-witness `LOOM-TRUST` tests pass.
- Concurrent tuple-CAS admission and request-bound idempotency tests pass under load.
- Byte-identical stale-record/evidence/response replay and
  decision-time/Grant-boundary/domain/caveat tests pass.
- Unrelated-head, incomplete-closure, unauthorized, and stale-approved proposals
  cannot advance a Shared Line.
- An acknowledged admission survives every declared fault.

### Phase 3 — Agent-native protocol

- Agent sessions use distinct identity and bounded delegated Grants.
- Intent, Recipe, effect, toolchain, and run provenance are complete.
- Concurrent-agent scenarios preserve every operation or conflict.
- Recipe sandbox escape and nondeterminism tests pass.
- Human review is bound to the exact result.

### Phase 4 — Dual-safety pilot

- One real project uses Loom as authoring authority for at least 30 consecutive days.
- Git mirror equivalence is continuously checked.
- There is zero unrecoverable data loss and zero undetected admitted divergence.
- At least two restore drills recover the complete authoritative history.
- Every integrity or availability incident has a written root-cause record.
- Rollback to the mirrored Git projection is rehearsed before pilot start.

### Phase 5 — Witnessed/federated trust

- All witness and federation `LOOM-TRUST` and `LOOM-SYNC` tests pass.
- Partitions, inconsistent authorities, witness loss, and reconciliation are
  exercised in a deterministic test environment.
- Split views are detected before additional admission.
- Offline verification succeeds against an independent implementation.

## 8. Pilot and user validation

Product research does not decide whether Loom is native, but it SHOULD determine
the first workflows and clients. Pilots should measure:

- agent concurrency and abandoned-work rate;
- conflict rate and conflict resolution time;
- percentage of changes represented by pinned Recipes;
- clean reapply and divergence rates;
- time from Intent to admitted State;
- approval and evidence latency;
- authorization failures and Grant usability;
- restore, mirror, and verification success;
- human comprehension of Intent, effects, provenance, and conflicts; and
- migration friction from existing repositories and tooling.

Positive user feedback cannot waive a correctness gate. Negative adoption
feedback should change ergonomics and sequencing without silently reverting the
native object model to Git.

## 9. Performance validation

Benchmarks MUST run only after correctness suites pass. Reports include:

- hardware, operating system, filesystem, and storage configuration;
- dataset generator and reproducible seed;
- number of objects, paths, Lines, actors, Grants, and ledger entries;
- object and file size distributions;
- cache state and warm-up;
- concurrency and network conditions;
- p50, p95, p99, maximum, and error rate; and
- comparison commit and specification version.

Performance regression budgets SHOULD be enforced in CI for stable local
microbenchmarks. Distributed and disk benchmarks SHOULD run in a controlled
scheduled environment rather than relying on noisy pull-request runners.

## 10. Permitted claims

An implementation MAY claim only what its evidence supports.

Allowed examples:

- "Content-addressed objects are verified before they become reachable."
- "This build conforms to `LOOM-CORE` version `0.1.0-draft`."
- "The admission record binds this exact Transform, State, policy, evidence,
  approval, and attestation set."
- "This pinned Recipe was deterministically reapplied under the recorded
  toolchain."
- "This history is externally witnessed under the documented quorum model."

Disallowed without stronger evidence:

- "The AI definitely authored this code."
- "This change is secure or correct because it passed Loom policy."
- "Loom automatically resolves all merge conflicts."
- "History is host-independent" for a single authority or common-control witnesses.
- "Zero data loss" based only on unit tests or a short demonstration.
- "Git-compatible" without publishing the exact import/export limitations.

## 11. Validation evidence report

Each milestone report MUST include:

```text
Specification version:
Implementation version and commit:
Claimed profiles:
Environment:
Commands executed:
Required test IDs passed:
Failed tests:
Skipped or unsupported tests:
Fault-injection scenarios:
Security review status:
Performance dataset and results:
Migration/interoperability limits:
Trust and witness topology:
Known risks:
External/manual evidence still required:
Artifact locations and digests:
```

The report MUST distinguish repository-owned proof from external pilot,
independent-review, witness, or operational evidence that has not yet occurred.
