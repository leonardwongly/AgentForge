# Roadmap

## Sprint 0: Validation

- Customer interviews
- Design partners
- Top policy list
- Initial policy schema

## Sprint 1: Foundation

- GitHub App
- Webhook receiver
- PR fact extractor
- Policy engine
- Check publisher

## Sprint 2: Deterministic Checks

- Sensitive paths
- CI/deploy
- Tests
- Dependencies
- Migrations

## Sprint 3: Evidence + Reviewers

- Evidence engine
- Reviewer routing
- Override workflow
- Enforce mode

## Sprint 4: Policy Packs + Dashboard

- Policy templates
- Onboarding
- Blocked PR dashboard
- Override trends

## Sprint 5: Beta Hardening

- Audit exports
- Compliance evidence packages with manifest, control mappings, audit timeline, and redaction report
- Retention settings
- Data handling docs
- Design partner feedback
- Advisory policy tuning insights from override rate, evidence rejection, repeated findings,
  reviewer bottlenecks, and observe/warn open requirements
- Liability-safe launch messaging, protected-asset pricing hypothesis, and validation gate

Policy tuning remains deterministic and read-only in V1. Insights cite Change Control Records
and help platform owners decide where to narrow rules, improve evidence instructions, add reviewer
fallbacks, or preview mode changes. Generated YAML diffs should only be produced after an explicit
authorized platform-admin request; insights must never block, unblock, or mutate policy on their own.

Launch positioning remains evidence-backed in V1. The pricing hypothesis is protected repositories
as the primary metric, protected PR volume bands for usage alignment, and enterprise packaging for
audit exports, retention, SSO/auth proxy requirements, and support. Broad enforce-mode sales
positioning should wait until at least three external target-user observations or interviews are
captured in `docs/launch-positioning-and-pricing.md`.

## V2 Or Later Backlog

- Full agent orchestration
- Autonomous merge decisions
- Full semantic architecture review
- Prompt/session replay
- IDE extension
- Agentic blame
- Line-by-line AI authorship labeling
- Multi-agent work graph
- Semantic duplicate detection
- Full provenance SDK
- LLM-based blocking
- Numeric risk-score-centered workflows
