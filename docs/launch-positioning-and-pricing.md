# Launch Positioning And Pricing

This document records the V1 go-to-market boundaries for AgentForge Merge Guard.
It exists to keep launch copy tied to observed workflow pain, protected customer
value, and liability-conscious claims.

## Positioning

AgentForge Merge Guard is deterministic pull request governance for high-risk
and agent-assisted changes. It helps platform, security, and engineering teams
turn configured policy requirements into GitHub checks, required evidence,
reviewer routing, audit events, and Change Control Records.

Approved short positioning:

> Evidence-based pull request governance for high-risk and agent-assisted
> changes.

Use this language consistently:

- deterministic policy evaluation;
- configured change-control requirements;
- required evidence and reviewer routing;
- observe, warn, enforce, and optimize rollout modes;
- redacted audit records and compliance evidence packages;
- humans approve or override risk.

Do not use absolute safety language. Merge Guard reports whether configured
policy requirements are satisfied. It does not certify that a pull request is
secure, correct, compliant, or vulnerability-free.

## Current Customer-Pain Evidence

The table below separates observed workflow evidence from hypotheses that still
need design-partner validation. This is intentionally conservative: external
customer interviews should be captured before positioning enforce mode as a
broad default.

| Target user                   | Pain hypothesis                                                                                                                                                                 | Current evidence                                                                                                                                                              | Validation status                                    | Next proof needed                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform engineering lead     | Branch protection is too coarse for high-risk paths, migrations, CI changes, and agent-assisted changes. Teams need policy-specific evidence and reviewer routing before merge. | Local first-user setup, dashboard E2E flow, branch-protection smoke, policy packs, reviewer routing, and live Merge Guard check publication.                                  | Internally observed; needs external confirmation.    | Observe at least one platform lead using `observe` or `warn` mode on a real repository and capture which requirements are useful versus noisy.    |
| Security / DevSecOps reviewer | Security-sensitive findings need deterministic routing and audit trails without storing raw source or secrets.                                                                  | Secret-like detector redaction tests, security hardening tests, metadata-only exports, compliance evidence package redaction report, and production fail-closed config gates. | Internally verified; needs user validation.          | Observe a security reviewer triaging a blocked or warned PR and record whether the evidence and reviewer requirements reduce manual coordination. |
| Engineering manager           | Overrides need to be explicit, role-gated, explainable, and visible enough to avoid silent bypasses.                                                                            | Override authorization tests, dashboard override trend view, audit events, and Change Control Record lifecycle state.                                                         | Internally verified; needs buyer validation.         | Interview one engineering manager about current exception handling and whether protected-repository pricing matches perceived value.              |
| Auditor / compliance owner    | Audit prep needs point-in-time evidence packages that show policy versions, findings, evidence status, reviewer activity, and redaction boundaries.                             | JSON/CSV Change Control Record exports and compliance evidence packages with manifest, control mappings, audit timeline, and redaction report.                                | Product artifact exists; buyer workflow unvalidated. | Observe one audit-prep workflow and compare exported package contents against the control evidence normally assembled manually.                   |

Launch copy may claim the workflow is implemented and test-covered. It must not
claim market pull is proven until at least three external target-user
observations or interviews are attached to this document or a linked customer
validation artifact.

## Pricing Metric Candidates

Primary V1 pricing hypothesis:

> Price by protected repositories, with protected PR volume bands for usage
> alignment and enterprise packaging for audit exports, retention, SSO/auth
> proxy requirements, and support.

| Metric                              | Customer value signal                                                                                               | Internal cost driver                                                             | V1 recommendation                                                     | Risk                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Protected repositories              | Maps directly to assets under governance and branch protection. Easy for platform teams to estimate.                | Repository settings, policy evaluation volume, dashboard records, support scope. | Primary packaging metric.                                             | Large monorepos may produce high PR volume under one repo; pair with volume bands.   |
| Protected PR volume                 | Aligns with evaluation, check publication, worker, record, and export load.                                         | Webhook volume, queue throughput, database writes, dashboard/export queries.     | Use as fair-use or tier band, not the headline metric.                | Pure usage pricing can punish adoption and make governance budgeting harder.         |
| Policy packs                        | Maps to governance sophistication by domain: startup, platform, fintech, regulated, open source, enterprise strict. | Policy support, templates, customer success, pack-specific docs.                 | Include advanced packs in higher tiers.                               | Can create artificial friction if basic coverage requires add-ons.                   |
| Audit exports / compliance packages | Maps to auditor and compliance value.                                                                               | Export generation, storage, retention, support review.                           | Enterprise feature or metered add-on after design-partner validation. | Export count alone may not reflect protected value.                                  |
| Enterprise seats                    | Maps to dashboard viewers and administrators.                                                                       | Auth, permissions, support, audit access.                                        | Secondary limit for enterprise administration, not core price metric. | Seat pricing undervalues automated governance and can discourage broader visibility. |

Pricing sanity rule: a customer should be able to explain the bill as paying to
protect specific repositories and high-risk PR workflows, not as paying for a
generic AI scanner.

## Liability-Safe Claims

Allowed:

- Merge Guard evaluates configured pull requests against deterministic policy
  rules.
- Merge Guard can block a GitHub check when configured requirements are unmet in
  `enforce` mode.
- Change Control Records capture policy version, findings, evidence, reviewer
  requirements, decisions, overrides, and audit events.
- Exports and compliance packages intentionally exclude raw source code and
  secrets by default.
- AI/LLM output, when enabled, is advisory and cannot decide blocking status.

Disallowed:

- "guaranteed safe";
- "prevents all vulnerable code";
- "complete security coverage";
- "AI firewall";
- "replaces code review";
- "autonomously approves or merges PRs";
- "certifies compliance";
- "detects every risky agent change".

Preferred replacement patterns:

| Avoid                         | Use                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- |
| AI firewall for pull requests | deterministic governance for configured high-risk pull requests           |
| guarantees safe merges        | records whether configured policy requirements are satisfied before merge |
| replaces security review      | routes required reviewers and captures their approval state               |
| complete audit automation     | exports structured evidence for human audit review                        |
| autonomous merge approval     | human-approved overrides and deterministic check conclusions              |

## V1 Boundaries

V1 supports:

- GitHub webhook ingestion and check publication;
- deterministic policy packs and repository policies;
- evidence and reviewer requirements;
- role-gated overrides;
- dashboard inspection;
- JSON/CSV Change Control Record exports;
- compliance evidence packages;
- fail-closed production configuration;
- observe-first rollout.

V1 does not support:

- autonomous merging;
- LLM-based blocking;
- vulnerability completeness claims;
- legal compliance certification;
- full semantic architecture review;
- prompt/session replay;
- full agent orchestration;
- customer-specific control attestations without human review.

## Validation Workflow

Before broad enforce-mode positioning:

1. Run a design-partner repository in `observe` mode for at least one week or 25
   evaluated PRs.
2. Review false-positive, override, evidence-rejection, and pending-reviewer
   rates.
3. Interview or observe at least three target users across platform,
   security/DevSecOps, engineering management, or compliance.
4. Attach one quote or workflow artifact per claimed pain.
5. Confirm the pricing metric with at least one buyer or budget owner.
6. Re-run the messaging validator and remove any absolute safety claims.

Evidence capture template:

```text
Date:
Target user role:
Repository/workflow observed:
Current workaround:
Pain observed:
AgentForge workflow tested:
Value signal:
Pricing reaction:
Liability-sensitive wording to avoid:
Follow-up:
```

## Launch Gate

V1 launch messaging is ready when:

- README and product docs keep deterministic governance as the central promise;
- pricing is framed around protected repositories and protected PR volume bands;
- external validation evidence is attached before aggressive enforce-mode sales
  positioning;
- non-goals are explicit in README, product overview, roadmap, and demo material;
- `pnpm messaging:validate` passes.
