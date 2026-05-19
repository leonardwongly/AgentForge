# AgentForge Merge Guard Product Overview

AgentForge Merge Guard is a GitHub-first change-control service for high-risk and agent-assisted pull requests. It evaluates configured PRs with deterministic detectors, explicit policy-as-code rules, required evidence, reviewer routing, and a recorded merge decision.

The product is for engineering, platform, security, and DevSecOps teams that need consistent governance without relying on perfect AI-generated PR detection.

V1 is centered on evidence-based merge control:

- What policy was triggered?
- What evidence is missing?
- Which reviewer is required?
- What must happen before merge?
- Who approved or overrode the decision?
- Which policy version was applied?

Deterministic checks decide. LLM output, when enabled later, is advisory only. Human reviewers approve or override risk.

Merge Guard does not claim a PR is safe or unsafe. It reports whether configured policy requirements are satisfied.

Teams can adopt Merge Guard gradually: `observe` for visibility, `warn` for non-blocking readiness, `enforce` for merge protection, and `optimize` for mature teams that keep enforce controls active while improving evidence quality, reviewer routing, overrides, and operational metrics.

## Buyer And Pricing Hypothesis

The primary buyer hypothesis is a platform, security, or engineering leader who
owns branch protection, high-risk PR review, and audit preparation for protected
repositories. V1 pricing should lead with protected repositories, use protected
PR volume bands for usage alignment, and reserve audit exports, compliance
evidence packages, retention, SSO/auth proxy requirements, and support for
enterprise packaging.

The launch validation artifact is `docs/launch-positioning-and-pricing.md`.
Broad enforce-mode positioning should wait until at least three external
target-user interviews or observations confirm the pain, useful policy scope,
and pricing metric.

## Non-Goals

Merge Guard is not autonomous merge approval, an AI code review replacement, a
vulnerability scanner with complete coverage, or a compliance certification
system. It produces deterministic governance records and evidence packages for
human review.
