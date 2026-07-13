# @agentforge/loom-ratify

Re-homes the existing AgentForge **governance engine** onto **Loom** Transforms —
proving the reusable upper-half plugs onto the new substrate with **zero changes**
to `@agentforge/policy` or `@agentforge/detectors`.

## What it does

- **`fabricDiffView(base, result)`** — reconstructs a git-`ChangedFile`-shaped
  diff view from two Loom `State`s. Rename detection is **exact** (by stable
  `NodeIdent`), not heuristic. It emits a 2-way unified `patch` so the existing
  detectors (which parse `filename`/`status`/`patch`/content — the authoritative
  TEXT lane) run unchanged.
- **`evaluateTransformSet(input)`** — synthesizes the `PullRequestInput` shape the
  engine expects from Loom concepts (Space→repo, Line→branch, State address→head,
  Intent→title), runs `extractVerifiedFacts` + `evaluateMergeGuard`, and returns
  the `PolicyResult` (pass/warn/block with findings, evidence, reviewers). This is
  the native admission "derive facts → evaluate" step (core spec §13).

## Proven by test

A Loom Transform that touches a sensitive path is **blocked** under `enforce`,
**passes** once the required reviewer approves, and merely **records the finding**
under `observe` — all via the unchanged governance engine. See
`src/evaluate.test.ts`.

## Honest scope

This is the governance/authoritative-text re-homing prototype only. It reuses a
Git-`ChangedFile`-shaped adapter to exercise the existing detector engine; it
does not yet implement native Proposal/admission inputs, semantic facets,
provenance sets, a ledger, durable Lines, or synchronization. Those are required
by later Loom conformance phases in `docs/loom/loom-detailed-design.md`.

## Develop

```bash
pnpm --filter @agentforge/loom-ratify typecheck
pnpm --filter @agentforge/loom-ratify test
```
