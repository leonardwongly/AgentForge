# Self-Governance: AgentForge guards its own repository

AgentForge governs this repository with its own engine. Every pull request is
evaluated by the deterministic detectors + policy and reported as the
**AgentForge Merge Guard** check (`.github/workflows/merge-guard.yml`, running
`pnpm merge-guard`). This is the project dogfooding the product it ships.

## How it works

1. On each pull request, the Merge Guard workflow builds a PR input from the
   live git diff + PR metadata and runs `extractVerifiedFacts` +
   `evaluateMergeGuard` against [`.agentforge/policy.yml`](../.agentforge/policy.yml).
2. The decision is published as the **AgentForge Merge Guard** check with a
   summary of findings, required evidence, required reviewers, and the
   explanation trail.
3. The job exits non-zero only on a `block` decision (enforce mode). In `warn`
   mode it surfaces findings without blocking.

## Mode: why `warn` (for now)

The committed policy runs in `warn` mode. CI can _detect_ findings and show what
_would_ block, but evidence can only be moved to the `approved` state through
the AgentForge dashboard (which needs the deployed API + Postgres). Until that
is running, `warn` evaluates and reports without an unsatisfiable hard block.

To make the gate hard-blocking, run the full service (API + worker + dashboard),
then flip `agentforge.mode` to `enforce` in `.agentforge/policy.yml`.

## Providing evidence in a PR

Findings can require evidence. In CI you provide it as headings in the PR body,
for example:

```
Security note: reads GITHUB_TOKEN from the environment; no hardcoded secret.
CI change reason: adds the Merge Guard workflow.
Rollback plan: revert this PR.
Deleted test explanation: <why a test was removed>
```

Recognized headings include `Rollback plan`, `Security note`, `CI change reason`,
`Dependency justification`, `Deleted test explanation`, `Migration dry run`, and
`Manual attestation`. In `warn` mode these are recorded as `provided`; in
`enforce` mode a human still approves them via the dashboard before they clear.

## Contributor expectations

- Land changes through pull requests, not direct pushes to `main`.
- Let the **AgentForge Merge Guard** check run; address or justify its findings.
- Do not bypass the required check with admin merges except for a genuine
  incident — the whole point is that the product governs its own `main`.

## Run it locally

```bash
pnpm merge-guard --base main --head HEAD
```

This prints the same decision + summary you get in CI for the current branch.
