# @agentforge/loom-core

The deterministic, dependency-free core of **Loom** — the native agentic
version-control substrate proposed in [`docs/loom/loom-detailed-design.md`](../../docs/loom/loom-detailed-design.md)
and [`docs/loom/reapply-merge-engine.md`](../../docs/loom/reapply-merge-engine.md).

This package is a pure library: no network, no infrastructure, no I/O. It exists
to prove — with executable, tested code — the parts of the design that are
genuinely defensible and buildable today.

## What is implemented (and tested)

- **Addressing** (`addressing.ts`) — deterministic canonical encoding + SHA-256
  content addresses (`Cid`), `verifyAddress`.
- **Object model** (`types.ts`) — `Cell` (typed, stable-identity unit of state),
  `State` (whole-tree snapshot), `Op`, `Transform`, `Line`, `Grant`.
- **Stable identity** (`identity.ts`) — `NodeIdent` minting + identity index;
  moves/renames preserve identity **and** content address (no similarity guess).
- **Transform algebra** (`algebra.ts`) — `applyOps` with preconditions,
  `impliedEffects`, and `verifyEffects` (declared effects must be a superset).
- **Merge / reapply engine** (`merge.ts`, `reapply.ts`) — LCA over a lineage
  DAG, node-granular conflict classification, diff3 text 3-way (the mandatory
  safety floor), and `reapply` (recompute a pinned recipe over a moved base) with
  the honest outcome set `{ CleanReapply, Divergence, HardFailure }`.
- **Capability authorization** (`grant.ts`) — `authorize` over an attenuating
  Grant chain rooted at a Line controller (replaces CODEOWNERS/OAuth authority).
- **Determinism boundary** (`determinism.ts`) — `factCacheKey`,
  `isReplayableRecipe`, `determinismConfidence`.

## Honest non-goals (deliberately NOT here)

Per the design's kill-gated verdict, this package is **not** a VCS and makes no
git-elimination claims. Out of scope (and tracked as kill-gated remaining work):
the networked ledger + witnesses, RSP sync, DID/PKI, DSSE/in-toto provenance
envelopes, the git bridge, working-copy materialization, and the semantic
(AST) lane. The **text lane is authoritative** and provenance would be
**attested, not proven**.

## Design honesty baked into the code

- `reapply` wins only for **mechanical, `pinned`-recipe** transforms; anything
  uncertain returns `HardFailure`, and the caller falls back to text 3-way. The
  determinism self-check tests _determinism_ (same input → same output), **not**
  idempotence — a codemod that adds an argument is deterministic but not a
  fixpoint of itself and must remain reapply-able.
- The merge engine never silently drops a change: unresolved disagreements
  surface as typed `Conflict`s.

## Develop

```bash
pnpm --filter @agentforge/loom-core typecheck
pnpm --filter @agentforge/loom-core test
```
