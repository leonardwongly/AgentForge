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
