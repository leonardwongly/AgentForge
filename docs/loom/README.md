# Loom VCS Specification

This directory contains the authoritative pre-1.0 specification for **Loom**, a
native version-control system designed for software development in which humans,
agents, and automation collaborate as first-class actors.

Loom is the product name. Git and GitHub are interoperability surfaces and
migration tools; they are not the normative Loom object model, history model,
identity system, authorization system, or admission path.

## Specification status

| Field                         | Value                                               |
| ----------------------------- | --------------------------------------------------- |
| Specification version         | `0.1.0-draft`                                       |
| Product maturity              | Pre-1.0 research and implementation                 |
| Wire compatibility            | Not yet guaranteed                                  |
| Normative language            | RFC 2119 / RFC 8174 keywords                        |
| Last major direction decision | Native Loom VCS is the destination; Git is a bridge |

The specification is intentionally stricter than the current executable
implementation. A requirement marked `MUST` is a target conformance requirement
even when the current TypeScript packages have an implementation slice for it.
Implementation status, required independent evidence, and remaining operational
gaps are recorded explicitly rather than weakening the target model.

## Authoritative documents

Read these documents in order:

1. [Core specification](loom-detailed-design.md) — vision, terminology,
   object/state/change model, working copies, Lines, admission, identity,
   provenance, storage, synchronization, security, interoperability, and roadmap.
2. [Merge and reapply specification](reapply-merge-engine.md) — LCA selection,
   operation classification, text three-way safety floor, deterministic recipe
   reapplication, conflicts, approval invalidation, and concurrency behavior.
3. [Conformance and validation plan](validation-plan.md) — profiles, test IDs,
   phase gates, fault-injection requirements, pilot evidence, and permitted
   product claims.

If these documents conflict, the following precedence applies:

1. The core specification controls the object model, security invariants, and
   protocol-wide semantics.
2. The merge and reapply specification controls merge and reapply algorithms.
3. The conformance plan controls validation evidence and release gates.
4. Executable code demonstrates current behavior but does not silently override
   a normative requirement. A mismatch is an implementation gap that must be
   fixed or resolved through a specification change.

## Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be
interpreted as described by RFC 2119 and RFC 8174 when, and only when, they
appear in all capitals.

Informative examples, implementation notes, and roadmap estimates are not
normative unless they restate an explicit requirement.

## Current implementation mapping

The repository currently contains these executable Loom slices. The detailed
design's phase table is the source of truth for implementation evidence; this
table highlights the remaining conformance and operational work.

| Package                       | Current proof                                                                                                                                                 | Important remaining evidence or boundary                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@agentforge/loom-core`       | Canonical DAG-CBOR/CIDv1, binary blobs, durable store/journal, Lines, working copies, merge/reapply, Grants, admission, ledger, sync, GC, recovery, witnesses | Full cross-implementation conformance vectors and long-running operational evidence           |
| `@agentforge/loom-ratify`     | Deterministic policy evaluation over Loom-derived diffs and native effect facts                                                                               | Native governance schemas still adapt to the existing policy engine's synthesized PR envelope |
| `@agentforge/loom-provenance` | DSSE/in-toto attestations, subject pinning, actor keys, revocation, admission binding, and verification bundles                                               | External deployment and independent-implementation verification                               |
| `@agentforge/loom-git-bridge` | Git import/export fidelity, binary and rename handling, filters, submodules, streaming, and mirror divergence evidence                                        | Phase 4's real-project dual-safety pilot                                                      |
| `@agentforge/loom-cli`        | `ratify`, `verify`, `init`, `status`, `propose`, `log`, and `pilot` (`mirror`, `verify`, `restore`)                                                           | Durable user-facing distribution and production operations                                    |

The `@agentforge` package namespace is a transitional implementation detail. It
does not change the product or protocol name: **Loom**.

## Specification change process

Changes to a normative invariant MUST include:

1. the requirement being changed;
2. the compatibility and migration impact;
3. the security and data-loss impact;
4. new or updated conformance tests;
5. an explicit decision in the core specification's decision register.

Changes to encoding, hashing, object identity, path rules, history semantics,
admission atomicity, or signature verification are breaking until the
specification defines a compatible negotiation or migration mechanism.

## Design priorities

When requirements compete, Loom prioritizes them in this order:

1. no silent data loss or history corruption;
2. deterministic and independently verifiable state transitions;
3. least-privilege authorization and governed admission;
4. recoverability under crashes, partitions, and operator error;
5. interoperability and migration safety;
6. agent concurrency and automation ergonomics;
7. performance and convenience.

Performance optimizations MUST NOT weaken the first four priorities.
