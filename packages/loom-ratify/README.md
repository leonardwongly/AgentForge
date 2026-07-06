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
  the RATP "derive facts → evaluate" step (design §4).

## Proven by test

A Loom Transform that touches a sensitive path is **blocked** under `enforce`,
**passes** once the required reviewer approves, and merely **records the finding**
under `observe` — all via the unchanged governance engine. See
`src/evaluate.test.ts`.

## Honest scope

This is the governance/text-lane re-homing only. It reuses the git-`ChangedFile`
adapter deliberately (text lane is authoritative); it does not add a semantic
lane, provenance envelopes, the ledger, or any networked substrate. Those remain
kill-gated per `docs/loom/loom-detailed-design.md`.

## Develop

```bash
pnpm --filter @agentforge/loom-ratify typecheck
pnpm --filter @agentforge/loom-ratify test
```
