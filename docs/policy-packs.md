# Policy Packs

Built-in policy packs keep teams from starting with blank YAML.

Policy packs are governance starting points, not certifications. Teams should
begin in `observe` or `warn`, review real Change Control Records, tune noisy
rules, and only move selected repositories to `enforce` after evidence and
reviewer workflows are proven.

## Startup Default

Intended for small teams that want visibility without too much enforcement. Default mode is `warn`. It detects CI changes, deleted/skipped tests, dependency additions, and migrations with easy overrides and minimal reviewer routing.

## Platform Engineering

Intended for platform teams managing infrastructure, CI/CD, deployment, and production reliability. Default mode is `warn`. It includes strict workflow, deployment script, production infra path checks, platform reviewer routing, and rollback evidence for deployment changes.

## Fintech

Intended for billing, checkout, payment, auditability, and controlled release workflows. Default mode is `warn`. It requires billing owner review, rollback plans, dependency justification, migration dry-run evidence, and structured overrides.

## Healthcare / Regulated

Intended for regulated engineering environments. Default mode is `warn` with selected `enforce` rules. It emphasizes audit retention, auth/identity security notes, required sensitive-domain reviewers, strict override reasons, no full diff retention, and LLM disabled by default.

## Open Source Maintainer

Intended for maintainers who want contributor-friendly warnings. Default mode is `warn`. It warns on deleted tests, dependency additions, CI changes, and suggests maintainers without heavy blocking.

## Enterprise Strict

Intended for larger organizations with mature security and platform workflows. Default mode is `enforce`. It includes strict sensitive path checks, required reviewers, required evidence, override role restrictions, export-ready records, long audit retention, and LLM disabled unless explicitly enabled.

Enterprise Strict should be sold and enabled as a mature-control posture, not as
a blanket promise that every unsafe, vulnerable, or non-compliant change will be
detected. The control promise is deterministic enforcement of configured policy
requirements plus exportable evidence for human review.
