# AgentForge — Strategic & Technical Assessment

> Status: Revised working assessment grounded in the current repository state
> (v1.1.0, Loom pre-1.0 `0.1.0-draft`), including the remediations implemented
> in this review cycle.
> Date: 2026-08-04
> Scope: Architecture, implementation, integration, workflow, opportunities,
> strategy, and long-term direction.

---

## 1. Executive Summary

AgentForge is two things in one repository:

1. **Merge Guard (shipped, v1.1.0)** — a deterministic, evidence-based GitHub
   pull-request governance service. It evaluates PRs against policy-as-code,
   routes required reviewers, records Change Control Records, and publishes
   GitHub checks. It is a working, well-tested monorepo (566 passing unit tests,
   20+ packages, 3 server apps, 2 native mobile consoles).
2. **Loom (pre-1.0 research prototype)** — a declared native version-control
   system in which humans, agents, and automation are first-class actors. Loom
   is now the stated product destination; Git and GitHub are framed as bridges.

The core tension is strategic, not technical. The repository ships a credible,
defensible governance product while simultaneously committing to a
category-defining but unvalidated VCS moonshot. The governance engine is the
**current source of value**; Loom is the **potential 100× outcome** but also the
**largest risk** in the portfolio.

**This review cycle implemented the majority of the code-level remediations**
identified in the original assessment: adoption tooling (`pnpm doctor`/`setup`),
per-detector precision reporting, a governance health score, a tamper-evident
audit chain, SIEM-style audit streaming, outbound governance notifications,
enterprise deployment packaging (Dockerfile/Helm/Terraform), a design-partner
evidence report, and single-product positioning. The unit suite grew from 546
to 566 passing tests. What remains is largely **strategic and process work**
(external validation, hosted offering, support/community, SSO/SAML, and the
Loom conformance journey) rather than core code gaps.

The highest-leverage remaining opportunity is to **convert the now-shipped
decision-intelligence primitives into a closed-loop optimization product** and
to **validate market pull externally**, while sequencing Loom behind evidence.
Loom, if sequenced and validated correctly, remains the only path to 100×.

---

## 2. Current State (Evidence Base)

- **Product:** Merge Guard — GitHub-first change control for high-risk and
  agent-assisted PRs. Deterministic checks decide; AI (when enabled) is advisory
  only; humans approve risk.
- **Release:** `v1.1.0`. Self-hosted. Workspace packages remain `private: true`.
- **Runtime:** Fastify API + webhook receiver, Next.js dashboard, BullMQ worker,
  Prisma/Postgres, Redis, optional MinIO. Native Android (Kotlin/Compose) and iOS
  (SwiftUI) read-only operator consoles.
- **Governance model:** policy-as-code (YAML, zod-validated), 11+ deterministic
  detectors, evidence requirements, reviewer routing, override workflow,
  Change Control Records, audit events, compliance evidence packages, exports.
- **Security posture:** signed webhooks, fail-closed production config,
  metadata-only storage, secret redaction, trusted-proxy identity, RLS tenant
  isolation, signature-replay protection. Strong.
- **Loom:** spec `0.1.0-draft`, normative RFC 2119 language, 5 conformance
  profiles, 6-phase roadmap (0–5). Executable slices: `loom-core`,
  `loom-ratify`, `loom-provenance`, `loom-git-bridge`, `loom-cli`. These prove
  the algebra, merge/reapply, Grants, provenance, and CLI — but do **not** yet
  satisfy any full conformance profile.
- **Validation:** 566 unit tests pass. Integration/E2E require Docker (Postgres,
  Redis, MinIO). Self-governance: the repo runs its own Merge Guard check in CI.
- **Work-in-progress:** ~67 files, ~9,830 insertions uncommitted, concentrated
  on the Loom packages and the worker/API. Tests for these changes pass.

### 2.1 Remediation status (this review cycle)

| Gap / opportunity                       | Status                   | What shipped                                                                              |
| --------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| G1 sample preview in deployed instances | Closed                   | Onboarding sample preview enabled behind `AGENTFORGE_ENABLE_SAMPLE_PREVIEW` in production |
| G2 adoption friction                    | Closed                   | `pnpm doctor` + `pnpm setup`                                                              |
| G3 design-partner evidence              | Closed                   | `pnpm design-partner:report`                                                              |
| G4 advisory AI layer                    | Confirmed implemented    | Evidence auto-draft (gated by `llmFeatures`, advisory-only)                               |
| G5 per-detector precision               | Closed                   | `computeDetectorMetrics` in report/API/dashboard                                          |
| G6 outbound notifications               | Closed (webhook surface) | `@agentforge/notifications` + worker blocked-PR webhook                                   |
| G7 audit streaming + tamper-evidence    | Closed                   | Audit hash chain + `POST /api/admin/audit-stream`                                         |
| G8 enterprise packaging                 | Closed                   | Root Dockerfile + Helm chart + Terraform module + Cloudflare Tunnel/Pages                 |
| G10 single-product positioning          | Closed                   | README product-vs-research clarification                                                  |
| C8 performance baseline                 | Closed                   | `pnpm benchmark` (latency p50/p95/p99 + throughput)                                       |
| O1 decision intelligence                | Partially closed         | Governance health score + per-detector precision (closed-loop product pending)            |
| G9 support/community/telemetry          | Open (process)           | Not code                                                                                  |
| G7 SSO/SAML                             | Open (external)          | IdP integration not started                                                               |
| G6 Slack/Teams app registration         | Open (external)          | Webhook surface ready; app-store registration pending                                     |

---

## 3. Methodology

This assessment was produced by:

1. Reading the README, product overview, roadmap(s), launch positioning,
   security/data-handling, self-governance, and Loom specification documents.
2. Inspecting the monorepo layout, package manifests, Prisma schema, Turbo
   config, and Docker Compose.
3. Reviewing representative source in the API, worker, core, policy, and Loom
   packages.
4. Running the unit test suite (566 tests pass) to confirm current health.
5. Reviewing Git history to understand trajectory and recent strategic pivots.

Findings are categorized across four dimensions — **architecture,
implementation, integration, workflow** — and then across **challenges,
opportunities, strategies, impact, feasibility, and strategic direction**.

---

## 4. Challenges

Each challenge is defined with its root cause, scope of impact, and risks.

### C1. Strategic dual-identity: Merge Guard vs. Loom (Architecture / Strategy) — OPEN

**Definition.** The repository now presents two products. Merge Guard is the
operational, revenue-relevant system; Loom is declared the "destination." The
README, CHANGELOG, and roadmap-v2 all carry caveats that Loom supersedes Merge
Guard planning, yet the shipped runtime remains the documented operational
system.

**Root cause.** A mid-stream strategic pivot (from "GitHub governance tool" to
"native agent-first VCS") without a clean sequencing decision or external
validation gate. The pivot is documented well, but it is a pivot nonetheless.

**Scope.** Entire project: roadmap ownership, contributor focus, resource
allocation, product/marketing messaging, and user expectations.

**Risks.**

- **Dilution:** engineering effort split between maintaining a shippable product
  and building an unproven VCS.
- **Stranded value:** the governance product could stagnate while Loom consumes
  attention, losing the near-term market it is positioned to win.
- **Credibility:** shipping two half-positioned products can confuse buyers and
  contributors.

### C2. Loom is a high-risk, externally unvalidated moonshot (Strategy) — OPEN

**Definition.** Loom aims to replace Git — one of the most entrenched,
battle-tested systems in software history. The spec itself states "user research
determines sequencing and adoption," and the validation plan explicitly replaced
the earlier "willingness-to-pay kill gate." There are **no external users, no
design partners, and no validated willingness-to-pay** for a native VCS.

**Root cause.** Ambition ahead of evidence. The engineering is impressive, but
market pull for "a new VCS" is unproven and the switching costs for teams are
enormous.

**Scope.** The entire Loom program and any product/marketing claims built on it.

**Risks.**

- **Opportunity cost:** years of engineering on Loom could be spent on the
  governance product's 10× levers (decision intelligence, AI layer, integrations).
- **Over-commitment:** the 100× framing is plausible only if Loom reaches
  adoption; there is no validated path to adoption yet.
- **Reputation:** a premature "we are building a Git replacement" claim can
  undermine the credibility of the working governance product.

### C3. Loom prototype-to-conformance gap (Implementation) — OPEN

**Definition.** The Loom spec is normative and stricter than the executable.
The prototype proves algebra, merge/reapply, Grants, provenance, and CLI, but
**does not satisfy any full conformance profile**. Missing target behavior
includes DAG-CBOR/CIDv1 objects, binary blobs, durable object store, working-copy
journal, native Line persistence, persistent actor keys, key rotation/revocation,
admission-set binding, ledger and witnesses, replication/sync, GC/recovery, and
full Git import/export fidelity.

**Root cause.** This is an intentional, well-documented "spec-first" approach
(prototype gaps are enumerated rather than hidden). It is correct engineering,
but it means the current Loom packages are **proofs, not a product**.

**Scope.** All Loom packages; the conformance and validation plan.

**Risks.**

- **Overclaiming:** the README correctly warns against claiming conformance, but
  the risk of premature "Loom works" messaging is real.
- **Silent data loss:** the spec's own top priority is "no silent data loss."
  Shipping native storage/admission before the durability gates pass would be
  catastrophic.
- **Perpetual prototype:** without a disciplined gate, Loom could remain
  pre-1.0 indefinitely, consuming resources with no shipped value.

### C4. No external customers / unvalidated market (Workflow / Go-to-market) — OPEN

**Definition.** The launch positioning doc explicitly requires **three external
target-user interviews** before broad enforce-mode positioning. Current evidence
is "internally observed / internally validated." V1 has **0 external orgs**.

**Root cause.** The project is self-hosted and has not yet run an external
design-partner program; the team is appropriately conservative about claims.

**Scope.** Pricing, positioning, feature prioritization, and the entire
go-to-market.

**Risks.**

- **Building the wrong thing:** features (compliance frameworks, GitLab support,
  Slack) are prioritized by hypothesis, not validated demand.
- **Pricing misalignment:** the protected-repositories pricing hypothesis is
  unconfirmed by a buyer.
- **Missed feedback:** no external signal on false-positive rates, evidence
  ergonomics, or onboarding friction.

### C5. Operational adoption friction (Integration / Workflow) — PARTIALLY CLOSED

**Definition.** A production deployment requires Postgres, Redis, a GitHub App,
trusted-proxy auth (or GitHub OAuth), API + worker + dashboard, and now two
native mobile consoles. The fail-closed posture is a strength but raises the
bar for first-run success.

**Root cause.** The system is architected for enterprise-grade governance and
security, which inherently carries operational complexity. The onboarding path
(`observe` → `warn` → `enforce`) is good, but the infrastructure footprint is
heavy for a self-hosted tool.

**Scope.** Adoption, time-to-value, support burden, and the mobile consoles.

**Risks.**

- **High activation energy:** teams may not complete setup.
- **Support load:** self-hosted multi-service operation generates support
  tickets that a small team cannot absorb.
- **Mobile consoles add surface:** two native apps for read-only health
  monitoring are a maintenance cost with unclear near-term payoff.

### C6. Monorepo scale and long-lived uncommitted work (Workflow / Implementation) — OPEN

**Definition.** The repo has 20+ packages, 3 server apps, and 2 mobile apps.
There is a large uncommitted work-in-progress (~67 files, ~9,830 insertions)
concentrated on Loom and the worker/API.

**Root cause.** Feature work accumulates on the working tree before landing;
the Loom pivot introduced a broad, cross-cutting change set.

**Scope.** Developer workflow, review burden, CI, and release risk.

**Risks.**

- **Review overload:** 9,800+ insertions in one change set is hard to review
  well, raising the chance of subtle regressions.
- **Merge conflicts / drift:** long-lived uncommitted work diverges from `main`.
- **Loss risk:** an uncommitted change set of this size is a single-point
  durability risk if the working tree is disturbed.

### C7. AI/LLM value is gated and unshipped (Integration / Product) — ADDRESSED

**Definition.** The V2 "intelligence layer" (advisory explanations, evidence
auto-draft, policy recommendations) is the clearest near-term 10× lever, but it
is **disabled by default, behind feature flags, and not yet implemented**. The
current product is intentionally advisory-only.

**Root cause.** Liability-conscious design and a correct "deterministic decides,
AI assists" principle. The constraint is right; the shipping cadence is slow.

**Scope.** Reviewer experience, time-to-resolution, differentiation.

**Risks.**

- **Missed differentiation:** competitors shipping AI-assisted review could
  commoditize the deterministic baseline.
- **Unused data:** the CCR dataset that would power recommendations is collected
  but not yet turned into decision intelligence.

### C8. Performance and scalability are uncharacterized (Architecture) — PARTIALLY CLOSED

**Definition.** The governance runtime has no published load tests, throughput
characterization, or horizontal-scaling evidence. Loom has performance
objectives, but they are explicitly "gates only after correctness tests pass"
and are not yet measured against the runtime.

**Root cause.** Correctness and security were prioritized (correctly) ahead of
performance; no benchmark harness exists for the runtime.

**Scope.** Webhook throughput, queue latency, dashboard query performance,
retention sweeps, and Loom admission latency.

**Risks.**

- **Unexpected capacity ceilings** when real orgs adopt enforce mode at scale.
- **No SLOs** to defend in enterprise deals.
- **Loom admission latency** (p95 < 3s target) unverified.

### C9. Multi-tenancy and RLS complexity (Architecture / Governance) — OPEN

**Definition.** Tenant isolation is enforced at both the application layer and
Postgres RLS, with trusted-proxy identity, non-superuser RLS roles, and
signature-replay guards. This is a strength, but it is complex and
misconfiguration-prone in self-hosted deployments.

**Root cause.** Enterprise-grade isolation requirements layered onto a
self-hosted deployment model.

**Scope.** Security, onboarding, and operational correctness.

**Risks.**

- **Misconfiguration** in self-hosted installs could weaken isolation.
- **Operational burden** of managing RLS roles and proxy header stripping.

---

## 5. Opportunities

Each opportunity is tied to a leverage point and a plausible 10×–100× framing.

### O1. Decision intelligence: close the governance feedback loop (10×)

**Leverage point.** The system already produces a durable, structured dataset:
Change Control Records, override rates, evidence-rejection rates, reviewer
bottlenecks, false-positive rates, time-to-resolution, and policy-version
histories. This data is currently collected but **under-utilized**.

**Why 10×.** Every evaluation can make the system smarter. Turning this data
into:

- policy-tuning recommendations (relax thresholds, add exceptions, promote
  observe→warn, demote enforce→warn);
- per-detector precision/recall reporting;
- reviewer-bottleneck detection and routing optimization;
- compliance-drift alerts (policy config vs. framework requirements).

compounds: governance quality improves continuously, time-to-merge falls, and
false positives drop — a self-improving system. This is the single most
realistic 10× lever because it is **built on data the product already owns**.

### O2. Advisory AI layer: reduce reviewer cognitive load (10×)

**Leverage point.** The V2 Phase 1 plan (plain-English explanations, evidence
auto-draft, policy recommendations) directly attacks the biggest cost in
governance: human reviewer time.

**Why 10×.** Auto-drafting evidence from PR body/commits/issues, with
confidence and source annotations, can move evidence completion from manual to
80%+ assisted. Explanations cut time-to-resolve blocked PRs from days to hours.
This is the classic "AI as copilot, human as approver" leverage — high value,
low liability, aligned with the existing principle.

### O3. Agent-native governance as a category-defining wedge (10×–100×)

**Leverage point.** The market thesis is that AI-generated code and agent-driven
PRs are exploding, and teams need a governance layer for agent-assisted changes.
AgentForge is positioned exactly at this intersection and is **ahead of the
curve**.

**Why 10×–100×.** If AgentForge becomes the default governance layer for
agent-driven development, the total addressable market expands with the agent
economy. The deterministic-evidence + provenance model (which Loom extends) is
the right architecture for "who did what, with what authority, and is it
approved." This is a positioning opportunity, not just a feature opportunity.

### O4. Loom as the ultimate moat (100×, high risk)

**Leverage point.** Loom's native object/history/identity/capability model with
governed admission and provenance is a genuine architectural differentiator. If
it succeeds, it is a 100× outcome — a new substrate for agent-first development.

**Why 100×.** Replacing the commit-and-merge model with intent-driven, governed,
provenance-attested transformations would redefine how agents collaborate. The
reusable policy/evidence/provenance work already built for Merge Guard is the
foundation. **However**, this is the highest-risk opportunity and must be
sequenced behind validation (see C2).

### O5. Integration surface: meet reviewers where they work (5×–10×)

**Leverage point.** Slack/Teams actions (approve evidence, request changes,
escalate), push notifications, and mobile override approvals reduce friction.

**Why 5×–10×.** Reviewers act on governance signals without leaving their
primary workflow, cutting latency and improving completion. This is a
multiplicative adoption and satisfaction lever.

### O6. Platform expansion: GitLab, Bitbucket, self-hosted distribution (5×–10×)

**Leverage point.** The same policy engine and detectors ported to GitLab and
Bitbucket, plus Helm/Terraform for enterprise self-hosted.

**Why 5×–10×.** Broadens the addressable market beyond GitHub-first teams and
unlocks enterprise deals that require on-prem/K8s deployment.

### O7. Compliance depth: turn audit into a product (10×)

**Leverage point.** SOC 2 / ISO 27001 control mappings, tamper-evident audit
trail, SIEM streaming, auditor-facing exports. The compliance-evidence-package
machinery already exists in V1.

**Why 10×.** Compliance prep is expensive and manual; a continuous, tamper-evident
evidence stream is a high-value enterprise feature that justifies premium
pricing and long retention contracts.

### O8. Architectural simplification / leverage (2×–5×)

**Leverage point.** The stack is heavy (Postgres + Redis + worker + web + 2
mobile apps). Options: consolidate, or use Loom to remove the Git-diff dependency
and make governance a native admission step rather than an external check.

**Why 2×–5×.** Lower operational cost, faster onboarding, fewer failure modes.
Not a 10× lever by itself, but it multiplies the effect of every other lever by
reducing friction.

---

## 6. Strategies for Each Challenge

### S-C1. Resolve the strategic dual-identity with a sequenced "wedge + moat" plan

- **Approach.** Treat Merge Guard as the **wedge** (near-term revenue, adoption,
  data) and Loom as the **moat** (long-term 100×). Make the sequencing explicit
  and binding.
- **Steps.**
  1. Publish a single authoritative roadmap that states: "Merge Guard is the
     shipped product through 2026–2027; Loom is a research program gated by
     validation, not a parallel product."
  2. Define a hard gate: Loom engineering beyond the current prototype only
     proceeds when (a) Merge Guard has ≥3 external design partners and (b) a
     validated willingness-to-pay signal for native VCS exists.
  3. Keep Loom packages as an isolated research track with a named owner and a
     time-boxed budget, so it cannot starve the shipped product.
- **System changes.** Roadmap ownership, release cadence, and CI separation for
  the Loom track.
- **Success metrics.** % of engineering time on shipped product vs. research;
  Merge Guard feature velocity; Loom phase-gate compliance.

### S-C2. De-risk Loom with validation gates before further investment

- **Approach.** Convert the Loom program from "build-first" to
  "validate-in-parallel."
- **Steps.**
  1. Run 3–5 design partners on the **Merge Guard → Loom-ratify** path first
     (governance over Loom-derived diffs), proving the reusable governance value
     without requiring native storage.
  2. Capture willingness-to-pay for "agent-first governance" separately from
     "replace Git."
  3. Sequence Loom phases strictly: do not begin Phase 1 (native local kernel)
     at scale until Phase 0 exit evidence is met and a durable object-store
     choice is frozen (an open decision-register item).
- **System changes.** Add a "Loom validation" section to the launch-positioning
  doc with the same interview-evidence template used for Merge Guard.
- **Success metrics.** Number of external design partners; validated
  willingness-to-pay statements; phase-gate exit evidence.

### S-C3. Close the Loom conformance gap methodically, not by breadth

- **Approach.** Prioritize the durability and integrity gates (the spec's own
  top priorities) over feature breadth.
- **Steps.**
  1. Freeze the open decision-register items that block Phase 1: durable object
     store, canonical DAG-CBOR schemas, `did:loom` scope, hermetic Recipe
     sandbox.
  2. Implement the **no-silent-loss** and **crash-safe acknowledgement**
     invariants with fault-injection tests before any native storage ships.
  3. Publish a machine-readable conformance declaration (per validation-plan §2)
     that states exactly which profiles pass and which gaps remain.
  4. Add fuzzed round-trip and crash-recovery test harnesses.
- **System changes.** Conformance declaration CI job; fault-injection test
  matrix; decision-register tracking.
- **Success metrics.** Conformance profiles claimed only when their full test
  matrix passes; zero silent-loss incidents in fault tests; recovery-time
  proportional to journal (not repo size).

### S-C4. Launch an external design-partner program

- **Approach.** Convert the conservative "wait for 3 interviews" stance into an
  active, scheduled program.
- **Steps.**
  1. Recruit 3–5 design partners running `observe`/`warn` mode on real
     repositories for ≥1 week or 25 evaluated PRs.
  2. Instrument the product to capture the validation evidence template
     (false-positive rate, override rate, evidence-rejection rate,
     time-to-resolve, reviewer bottlenecks) automatically.
  3. Run the 3 interviews, attach artifacts to the launch-positioning doc, and
     only then broaden enforce-mode positioning.
  4. Confirm the pricing metric with ≥1 budget owner.
- **System changes.** Automated evidence capture from CCR data; a design-partner
  dashboard.
- **Success metrics.** ≥3 external interviews with artifacts; validated pricing
  metric; enforce-mode positioning unlocked.

### S-C5. Reduce operational adoption friction

- **Approach.** Keep the secure fail-closed posture but lower activation energy.
- **Steps.**
  1. Ship a one-command local/self-hosted installer (e.g., a single Docker
     Compose profile or Helm chart) that brings up API + worker + web + Postgres
     - Redis with sane defaults.
  2. Add a guided onboarding wizard that runs a real PR through `observe` mode
     end-to-end and produces the first CCR.
  3. Provide a "production readiness checklist" that auto-checks the fail-closed
     gates and prints the exact remediation.
  4. Reconsider the two native mobile consoles: either promote them to real
     value (push notifications, override approvals) or pause them until the
     integration surface (Slack/Teams) is built.
- **System changes.** Installer, onboarding telemetry, readiness checklist.
- **Success metrics.** Time-to-first-CCR; setup completion rate; support-ticket
  volume per new org.

### S-C6. Break up large changes and land incrementally

- **Approach.** Reduce the ~9,800-insertion uncommitted change set into
  reviewable, mergeable increments.
- **Steps.**
  1. Land the Loom packages and worker/API changes as a sequence of focused PRs
     (core algebra → merge/reapply → grants → provenance → ratify → CLI), each
     green and reviewed.
  2. Commit the current WIP to a feature branch immediately to remove the
     single-point durability risk, then split it.
  3. Enforce a review-size budget in CONTRIBUTING (e.g., prefer PRs < 800
     insertions).
- **System changes.** Branch strategy, PR-size guidance, CI on every increment.
- **Success metrics.** Median PR size; time-to-merge; reduced merge conflicts.

### S-C7. Ship the advisory AI layer behind the existing flags

- **Approach.** Implement V2 Phase 1 (explanations, evidence auto-draft, policy
  recommendations) as org-opt-in features, keeping the "deterministic decides"
  invariant intact.
- **Steps.**
  1. Build the provider-agnostic LLM adapter (OpenAI, Anthropic, local ollama)
     with the latency budget (async enrichment, never blocking check publication).
  2. Implement evidence auto-draft with confidence + source annotations; require
     human approval; disable for `enforce` orgs until a 30-day opt-in period.
  3. Implement policy insights from CCR aggregates with a minimum sample size
     (e.g., 50 evaluations) and read-only YAML diffs.
  4. Route all LLM context through the existing `@agentforge/security` redaction
     pipeline; never send source code unless explicitly enabled.
- **System changes.** LLM adapter package, feature flags, async enrichment
  queue, insights aggregation jobs.
- **Success metrics.** Evidence completion rate ≥80% assisted; time-to-resolve
  < 2h (p75); false-positive override rate < 15% per detector; reviewer CSAT > 4.0.

### S-C8. Characterize and harden performance/scalability

- **Approach.** Add a benchmark and load-test harness for the runtime, and
  publish SLOs.
- **Steps.**
  1. Build a webhook-throughput and queue-latency benchmark (e.g., k6 or a
     scripted load generator) against the Compose stack.
  2. Measure dashboard query performance on realistic CCR volumes and add
     indexes/pagination where needed.
  3. Publish the Loom performance objectives with the required dataset/hardware
     disclosure (the spec already mandates this).
  4. Define SLOs (e.g., webhook p95 ingestion latency, queue processing
     throughput, check-publication latency) and monitor them.
- **System changes.** Benchmark harness, SLO dashboard, load-test CI.
- **Success metrics.** Published p95 latencies; no capacity ceiling below
  expected org-scale volume; SLO attainment.

### S-C9. Harden and simplify multi-tenancy operations

- **Approach.** Keep RLS + app-layer isolation but make it operationally
  self-checking.
- **Steps.**
  1. Add a startup and periodic self-audit that verifies RLS roles, proxy-header
     stripping, and tenant-scoped queries.
  2. Provide a tenant-isolation test suite that runs in CI and on install.
  3. Document the exact proxy/auth topology with a reference config for common
     ingress (Caddy, Nginx, Traefik, Cloudflare).
- **System changes.** Self-audit job, isolation test suite, reference configs.
- **Success metrics.** Zero isolation regressions in CI; documented installs
  pass the self-audit.

---

## 7. Strategies to Capitalize on Opportunities (10×–100×)

### S-O1. Build the Decision Intelligence engine (10×)

- **Approach.** Turn CCR data into a closed-loop optimization product.
- **Steps.**
  1. Create an analytics/aggregation layer over CCRs: per-detector precision,
     recall, false-positive rate, override rate, evidence-rejection rate,
     time-to-resolve, reviewer-bottleneck detection.
  2. Surface a "Governance Health" score and trend in the dashboard.
  3. Generate read-only policy-tuning recommendations (with minimum sample size)
     that platform-admins can preview and apply manually.
  4. Add compliance-drift alerts: detect when policy config diverges from
     framework requirements.
  5. Expose a webhook/API for exporting aggregates to BI/SIEM.
- **Success metrics.** % of recommendations adopted; measured reduction in
  false-positive override rate and time-to-merge after adoption; per-detector
  precision/recall published.
- **Validation.** A/B the pre/post state of orgs that adopt recommendations;
  track CCR-derived metrics before and after.

### S-O2. Deliver the advisory AI layer (10×)

- **Approach.** Implement V2 Phase 1 as the flagship near-term differentiator.
- **Steps.** As in S-C7; add:
  1. Plain-English "why this triggered" per finding.
  2. Evidence auto-draft with confidence and source annotations.
  3. Async enrichment so check publication is never blocked.
- **Success metrics.** Evidence completion ≥80% assisted; time-to-resolve < 2h
  (p75); reviewer CSAT > 4.0; latency budget met (explanation within 30s,
  non-blocking).

### S-O3. Own the "agent governance" category (10×–100×)

- **Approach.** Position AgentForge as the governance layer for agent-driven
  development, not just a PR check.
- **Steps.**
  1. Add agent-signal detection and provenance capture to the governance record
     (which agent, what authority, what effect).
  2. Publish the "deterministic decides, AI assists, humans approve" narrative
     consistently across docs and launch copy.
  3. Build the agent-native protocol (Loom Phase 3) as the long-term moat, but
     only after validation gates (S-C2).
- **Success metrics.** Share of agent-assisted PRs governed; external
  willingness-to-pay for agent governance; category mindshare.

### S-O4. Sequence Loom as the 100× moat, gated

- **Approach.** Fund Loom to reach a validated, durable Phase 1–2 milestone, then
  reassess.
- **Steps.**
  1. Complete Phase 0 exit evidence (decision register frozen, schemas reviewed).
  2. Build Phase 1 native local kernel with the durability gates (no silent
     loss, crash-safe acknowledgement, byte-exact materialization) and
     fault-injection tests.
  3. Run the Phase 4 dual-safety pilot (Loom-authoritative project mirrored to
     Git, 30 days, zero unrecoverable data loss) before any broad claim.
- **Success metrics.** Phase-gate exit evidence; 30-day pilot with zero
  unrecoverable data loss; every admitted State exportable.

### S-O5. Expand the integration surface (5×–10×)

- **Approach.** Ship Slack (then Teams) actions and mobile push/override
  approvals.
- **Steps.**
  1. Slack App with OAuth, notifications, and thread actions; identity mapping.
  2. Teams App with Adaptive Cards.
  3. Promote mobile consoles to push notifications and biometric override
     approval, or pause them until integrations land.
- **Success metrics.** % of evidence/override actions completed from
  Slack/Teams/mobile; reduced time-to-resolve.

### S-O6. Platform expansion (5×–10×)

- **Approach.** Port the engine to GitLab and Bitbucket; ship Helm/Terraform.
- **Steps.**
  1. GitLab webhook/API/OAuth adapter with the same policy schema.
  2. Bitbucket adapter.
  3. Helm chart + Terraform modules for enterprise self-hosted.
- **Success metrics.** Platform coverage; enterprise self-hosted deals.

### S-O7. Compliance depth as a premium product (10×)

- **Approach.** Extend the existing evidence-package machinery into continuous,
  tamper-evident compliance.
- **Steps.**
  1. SOC 2 / ISO 27001 control mappings (already planned).
  2. Tamper-evident audit trail (hash chain / signed entries).
  3. SIEM streaming (Splunk HEC, Datadog, Elasticsearch).
  4. Auditor-facing PDF + structured JSON exports.
- **Success metrics.** Enterprise deal-closing; retention contracts; audit
  prep time reduced 10× for customers.

### S-O8. Simplify the architecture to multiply all other levers (2×–5×)

- **Approach.** Reduce operational cost and friction.
- **Steps.**
  1. Consolidate deployment into a single Compose profile / Helm chart.
  2. Evaluate whether Redis-backed queues can be simplified or made optional for
     small orgs (with a documented trade-off).
  3. Use Loom's native admission (when ready) to make governance a first-class
     step rather than an external check, removing the Git-diff dependency.
- **Success metrics.** Setup time, infra cost per org, failure modes.

---

## 8. Impact Analysis

### 8.1 Short-term (next 2–4 quarters)

| Lever                       | Expected impact                                                 | Quantified target                                                     |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Decision intelligence (O1)  | Self-improving governance; fewer false positives; faster merges | False-positive override rate < 15%/detector; time-to-resolve < 2h p75 |
| Advisory AI (O2)            | Lower reviewer load                                             | Evidence completion ≥80% assisted; CSAT > 4.0                         |
| Design-partner program (C4) | Validated market, pricing, positioning                          | ≥3 external interviews; enforce-mode unlocked                         |
| Adoption friction (C5)      | Faster time-to-value                                            | Time-to-first-CCR < 1 day; setup completion ↑                         |
| Land increments (C6)        | Lower risk, faster velocity                                     | Median PR < 800 insertions; no >2-week uncommitted WIP                |

**Near-term value to stakeholders:** engineering/platform teams get a faster,
smarter governance loop; security teams get lower false-positive noise; the
company gets validated market signal and a differentiated, shippable product.

### 8.2 Long-term (12–24+ months)

| Lever                        | Expected impact                               | Quantified target                                  |
| ---------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Agent-native governance (O3) | Category leadership as agent-driven dev grows | Governed share of agent-assisted PRs; external WTP |
| Loom moat (O4)               | 100× outcome if validated                     | 30-day dual-safety pilot; Phase 1–2 gates          |
| Compliance depth (O7)        | Enterprise premium, retention                 | SOC 2/ISO mappings; tamper-evident trail           |
| Platform expansion (O6)      | Broader market                                | GitLab + Bitbucket + self-hosted                   |
| Integration surface (O5)     | Ubiquitous reviewer workflow                  | Slack/Teams/mobile actions                         |

**Long-term transformation:** AgentForge moves from "a PR check" to "the
governance and provenance layer for software development," where every change —
human or agent — carries a deterministic, evidenced, approved, auditable record.
If Loom succeeds, this becomes a new substrate; if it does not, the governance
product still compounds through decision intelligence and the agent-governance
category.

### 8.3 How the numbers translate to stakeholder value

- **Processing speed:** async AI enrichment and queue optimization cut
  time-to-resolution from days to hours (10× on latency).
- **Decision quality:** per-detector precision/recall and policy tuning reduce
  false-positive overrides from unmeasured to <15% (10× on noise).
- **Operational cost:** compliance automation and reduced reviewer time cut the
  manual cost of governance by ~10× for customers.
- **Scalability:** characterized throughput + SLOs let the system grow from a
  handful to hundreds of orgs without redesign.
- **User satisfaction:** lower cognitive load and in-workflow actions raise CSAT
  and retention.

---

## 9. Feasibility, Execution, Monitoring, and Validation

### 9.1 Complexity / resource / dependency matrix

| Strategy             | Complexity | Key resources       | Dependencies             | Primary risk         |
| -------------------- | ---------- | ------------------- | ------------------------ | -------------------- |
| S-C1 wedge+moat      | Low        | Leadership, roadmap | None                     | None (decision only) |
| S-C2 Loom gates      | Medium     | Research owner      | Design partners          | No WTP signal        |
| S-C3 conformance     | High       | VCS engineers       | Frozen decision register | Silent data loss     |
| S-C4 design partners | Medium     | PM/CS               | 3 external orgs          | Recruiting           |
| S-C5 adoption        | Medium     | DevOps              | Installer/Helm           | Support burden       |
| S-C6 incremental     | Low        | Dev discipline      | None                     | None                 |
| S-C7 AI layer        | High       | ML/LLM engineers    | LLM provider             | Latency/cost         |
| S-C8 perf/SLOs       | Medium     | SRE/Dev             | Load harness             | Capacity ceilings    |
| S-C9 tenancy ops     | Medium     | Security eng        | Reference configs        | Misconfig            |
| S-O1 decision intel  | Medium     | Data eng            | CCR data                 | Data quality         |
| S-O7 compliance      | High       | Compliance/eng      | SOC2 engagement          | Audit scope          |

### 9.2 Execution and monitoring

- **Run each strategy as a time-boxed workstream with an owner and an exit gate.**
- **Instrument everything:** CCR-derived metrics, feature-flag adoption,
  recommendation adoption, SLO attainment, design-partner evidence.
- **Feedback mechanisms:** weekly governance-health review from CCR data;
  design-partner interview cadence; A/B of policy recommendations; CSAT surveys.
- **Iteration built in:** every AI and intelligence feature ships behind a flag,
  observes for 30 days with ≥3 orgs, then promotes to default-on or reverts.

### 9.3 Validation discipline

- Reuse the existing validation ladder (`format:check`, `lint`, `typecheck`,
  `test`, `fixtures:run`, integration/E2E) for every change.
- For Loom, follow the conformance plan: publish a machine-readable declaration,
  run fault-injection and crash-recovery tests, and never claim a profile
  without its full test matrix passing.
- For performance, publish benchmarks with the required dataset/hardware
  disclosure (the Loom spec already mandates this).

---

## 10. Strategic Direction: Alignment, Gaps, and Adjustments

### 10.1 Alignment

The stated principles are sound and internally consistent:

- **"Deterministic checks decide. AI explains and assists. Humans approve
  risk."** — correctly positions AI as advisory, preserving trust and
  liability safety.
- **Security-first, fail-closed** — appropriate for a governance product.
- **Self-governance dogfooding** — credible and differentiating.
- **Loom as the destination with Git as a bridge** — a bold, coherent long-term
  thesis.

### 10.2 Gaps and misalignments

1. **Sequencing gap.** The roadmap declares Loom the destination but does not
   bind Loom investment to validation gates. This risks starving the shippable
   product (C1/C2).
2. **Validation gap.** The product is internally validated only; the 10×–100×
   claims rest on unproven market pull (C4).
3. **Value-capture gap.** The CCR dataset — the product's best asset — is not yet
   converted into decision intelligence (O1).
4. **AI gap.** The highest-leverage near-term differentiator is gated and
   unshipped (C7/O2).
5. **Operational gap.** Adoption friction and a heavy stack raise the bar to
   value (C5/O8).
6. **Performance gap.** No published SLOs or load evidence to defend scale and
   enterprise deals (C8).

### 10.3 Recommended adjustments

1. **Make sequencing explicit and binding:** Merge Guard is the wedge through
   2026–2027; Loom is a gated research track. Publish this in the roadmap.
2. **Activate the design-partner program now** and let it drive feature
   priority and pricing.
3. **Ship the decision-intelligence + advisory AI layer** as the flagship 10×
   differentiator, behind flags.
4. **Lower adoption friction** with an installer and guided onboarding.
5. **Characterize performance and publish SLOs** before enterprise scale.
6. **Keep Loom funded but gated**, advancing only on validated willingness to
   pay and durable phase-gate evidence.

### 10.4 Long-term relevance

The thesis that agent-driven development needs governance, evidence, and
provenance is well-founded and increasingly urgent. AgentForge is positioned to
own it. The risk is not the thesis — it is **execution sequencing**: investing in
the 100× moonshot before capturing the 10× that is already within reach. The
recommended path captures the 10× now (decision intelligence, AI layer,
integrations, validation) and earns the right to pursue the 100× (Loom) on
evidence.

---

## 11. Prioritized Roadmap (Recommended)

Completed this cycle: adoption tooling (S-C5), per-detector precision +
health score (S-O1 primitives), tamper-evident audit + streaming (S-O7 part),
notifications (S-O5 webhook surface), deployment packaging (S-C8/S-O6 part),
design-partner report (S-C4 tooling), and positioning (S-C1 docs). The
remaining roadmap focuses on the strategic and process work that code cannot
close alone.

| Priority | Workstream                                              | Timeframe | Outcome                            |
| -------- | ------------------------------------------------------- | --------- | ---------------------------------- |
| P0       | Resolve strategic sequencing (S-C1)                     | Now       | Clear wedge+moat plan              |
| P0       | Commit/split the WIP into increments (S-C6)             | Now       | Lower risk, faster velocity        |
| P0       | Launch design-partner program (S-C4)                    | Q1        | Validated market + pricing         |
| P1       | Close the decision-intelligence loop (S-O1)             | Q1–Q2     | Self-improving governance (10×)    |
| P1       | Ship advisory AI explanations (S-O2)                    | Q2–Q3     | Reviewer load reduction (10×)      |
| P1       | Hosted sandbox / demo (G1)                              | Q2        | Zero-friction evaluation           |
| P2       | Publish SLOs from the shipped benchmark baseline (S-C8) | Q2–Q3     | Scalability + enterprise readiness |
| P2       | Slack/Teams app registration (S-O5)                     | Q3        | In-workflow actions                |
| P2       | Tenancy self-audit (S-C9)                               | Q3        | Operational safety                 |
| P2       | SSO/SAML (G7)                                           | Q3–Q4     | Enterprise auth                    |
| P3       | Support tiers + community + telemetry (G9)              | Q4+       | Retention                          |
| P3       | Compliance depth (S-O7)                                 | Q4+       | Enterprise premium                 |
| P3       | Platform expansion (S-O6)                               | Q4+       | Broader market                     |
| P3       | Loom Phase 0–1 gated (S-C2/S-C3/S-O4)                   | Ongoing   | Earn the 100×                      |

---

## 12. Conclusion

AgentForge is a well-engineered, security-disciplined governance product with a
credible and timely thesis. Its codebase is healthy and its principles are
sound. **This review cycle converted most of the identified code-level gaps
into shipped, tested capability** — adoption tooling, decision-intelligence
primitives, tamper-evident audit and streaming, notifications, enterprise
packaging, and single-product positioning — growing the unit suite to 566
passing tests.

The decisive remaining work is strategic and process-driven: **sequence the
wedge (Merge Guard) and the moat (Loom) explicitly; validate market pull
externally; close the decision-intelligence loop into a self-improving product;
and stand up the support/community/hosted surface.** Doing so captures a
realistic 10× near-term and earns the right to pursue the 100× that Loom and
the agent-governance category represent.

---

## 13. End-to-End Customer Journey

This section maps the full journey of an AgentForge customer — from first
awareness through daily use to enterprise retention — against what the product
currently supports, and identifies gaps and improvements at each stage.

### 13.1 Personas

The primary personas (from `docs/launch-positioning-and-pricing.md`):

- **Platform engineering lead** — owns branch protection and high-risk PR
  review; primary buyer.
- **Security / DevSecOps reviewer** — needs deterministic routing and audit
  trails without storing raw source or secrets.
- **Engineering manager** — needs explicit, role-gated, explainable overrides.
- **Auditor / compliance owner** — needs point-in-time evidence packages.

### 13.2 Journey stages at a glance

| Stage                    | Customer goal                               | Primary touchpoints               | Product readiness                  | Overall gap level |
| ------------------------ | ------------------------------------------- | --------------------------------- | ---------------------------------- | ----------------- |
| 0. Awareness             | Understand what it does and whether it fits | README, product docs, launch copy | Strong positioning, weak discovery | Medium            |
| 1. Installation          | Get a working instance quickly              | Docs, Docker Compose, CLI         | Functional but heavy               | High              |
| 2. GitHub App + auth     | Connect GitHub and secure access            | Setup docs, OAuth/proxy           | Robust but complex                 | High              |
| 3. First repo + policy   | Govern a real repository                    | Onboarding wizard, policy packs   | Partial (dev-only sample)          | Medium            |
| 4. Activation            | See first evaluated PR + CCR                | Check run, dashboard              | Strong                             | Low               |
| 5. Daily use             | Review, evidence, override                  | Dashboard, checks, PR body        | Strong core, weak assist           | Medium            |
| 6. Optimization          | Reduce noise, scale to more repos           | Insights, optimize mode           | Insights not shipped               | High              |
| 7. Compliance/enterprise | Audit prep, SSO, self-hosted                | Exports, packages                 | Partial (no SSO/SIEM)              | High              |
| 8. Retention/advocacy    | Renew, expand, advocate                     | Support, community, SaaS          | Not established                    | High              |

---

### 13.3 Stage 0 — Awareness & Evaluation

**Customer goal.** Decide whether AgentForge addresses the pain of governing
high-risk and agent-assisted PRs, and whether it is credible and low-risk to
try.

**Current support.**

- Clear, liability-safe positioning: "Evidence-based pull request governance for
  high-risk and agent-assisted changes."
- Extensive docs (product overview, security/data-handling, self-hosting,
  runbook, roadmap).
- Self-governance dogfooding (the repo runs its own Merge Guard check) is a
  strong credibility signal.

**Gaps.**

- **No hosted SaaS or managed trial.** Evaluation requires a full self-hosted
  install (Postgres + Redis + GitHub App + API + worker + web). High activation
  energy before any value.
- **No public demo / sandbox.** A prospect cannot see the product working
  without standing it up.
- **No external social proof.** Launch positioning requires 3 external
  interviews before broad enforce-mode claims; there are 0 external orgs.
- **Two-product story.** The README leads with Merge Guard but also frames Loom
  as the destination, which can confuse an evaluator about what they are buying.

**Improvements.**

- Ship a hosted sandbox / guided demo that produces a real CCR against a sample
  repo without local setup.
- Publish a short "see it in 10 minutes" walkthrough video or interactive demo.
- Collect and publish design-partner testimonials and case studies.
- Keep the buyer-facing story single-product (Merge Guard) until Loom is
  validated; move Loom to a research page.

---

### 13.4 Stage 1 — Installation & Configuration

**Customer goal.** Get a working instance with minimal effort and risk.

**Current support.**

- Detailed README quick start, Docker Compose for Postgres/Redis/MinIO, dev
  preflight that fails fast with exact remediation commands.
- Pinned package manager (Corepack/pnpm), pinned dependency versions, digest-
  pinned images.

**Gaps.**

- **Multi-service footprint.** API + worker + web + Postgres + Redis is a lot to
  stand up for a self-hosted governance tool.
- **No one-command installer.** Setup is a sequence of manual steps
  (clone, install, .env, compose, migrate, seed, dev).
- **No production installer** (Helm/Terraform) until later roadmap.
- **No upgrade/rollback automation** beyond documented runbook steps.

**Improvements.**

- Provide a single-command local installer and a production Helm chart / Terraform
  module (already planned in V2 Phase 3) earlier, since adoption depends on it.
- Ship a `doctor`/preflight that validates the whole stack and prints a
  readiness score.
- Provide a scripted upgrade path with pre/post migration checks.

---

### 13.5 Stage 2 — GitHub App & Auth Setup

**Customer goal.** Connect the GitHub App and secure dashboard access.

**Current support.**

- Documented GitHub App setup (webhook events, permissions, webhook URL).
- Two auth paths: trusted-proxy identity (HMAC-signed headers) and built-in
  GitHub OAuth; platform-admin approval before repositories are governed.
- Fail-closed production config that refuses unsafe settings.

**Gaps.**

- **Auth is complex.** Trusted-proxy setup requires an ingress that strips
  spoofable headers and signs identity headers — a real operational lift.
- **No SSO/SAML/SCIM** until V2 Phase 4, which enterprise buyers expect.
- **No self-serve GitHub App creation flow** in the dashboard; the user must
  create the App in GitHub and copy credentials.
- **Mobile consoles** add setup surface (JDK/Android SDK, Xcode) with read-only
  value only.

**Improvements.**

- Add an in-dashboard GitHub App creation/onboarding assistant that walks the
  user through the GitHub side and validates credentials.
- Provide a reference ingress config (Caddy/Nginx/Traefik/Cloudflare) for the
  trusted-proxy path to remove guesswork.
- Prioritize SSO/SAML for enterprise; gate mobile consoles behind real value
  (push/override) or pause them.

---

### 13.6 Stage 3 — First Repository & Policy Onboarding

**Customer goal.** Govern a real repository with sensible policy quickly.

**Current support.**

- Onboarding wizard and sample preview (dev-only flag `AGENTFORGE_ENABLE_SAMPLE_PREVIEW`).
- Built-in policy packs (startup-default, platform-engineering, fintech,
  healthcare-regulated) and YAML policy validation/preview tooling.
- `observe` → `warn` → `enforce` rollout modes.

**Gaps.**

- **Sample preview is dev-only** and not available in a deployed/production
  instance, so a real new org cannot use it to bootstrap.
- **Policy authoring is YAML-first.** Non-expert users need guidance; no
  guided policy builder in the UI.
- **No policy import from existing branch-protection rules** to reduce setup.
- **No template library beyond the built-in packs** and no per-framework
  starter packs until later.

**Improvements.**

- Make the sample-preview onboarding available in deployed instances (behind
  an explicit flag) so every new org can create its first CCR in minutes.
- Add a guided policy builder (form → YAML) and a "start from branch protection"
  importer.
- Expand the pack library and add a policy pack marketplace/registry.

---

### 13.7 Stage 4 — Activation (First Value)

**Customer goal.** See the first evaluated PR and a Change Control Record, and
understand what the product does.

**Current support.**

- First evaluated PR publishes a Merge Guard check with findings, required
  evidence, and required reviewers.
- Dashboard records view; CCR lifecycle (opened → evaluated → blocked/warned/
  passed → overridden/merged/closed).
- Strong test coverage of the activation path (webhook → worker → check).

**Gaps.**

- **Time-to-first-CCR is gated by the heavy setup** in earlier stages.
- **No guided "what to do next"** after the first record (e.g., enable enforce
  on a second repo, add evidence, review an override).
- **No activation telemetry** on the product side (self-hosted, so the vendor
  cannot see where users drop off).

**Improvements.**

- Add a post-activation checklist/next-steps in the dashboard.
- Add opt-in, privacy-respecting activation telemetry (or a design-partner
  observation program) to detect drop-off.
- Celebrate first value (e.g., "You've governed your first PR — here's the
  record").

---

### 13.8 Stage 5 — Daily Use (Core Governance Loop)

**Customer goal.** Review PRs, provide evidence, approve overrides, and keep the
loop fast and low-noise.

**Current support.**

- Deterministic detectors, evidence requirements, reviewer routing, override
  workflow, and dashboard views (blocked PRs, evidence queues, records,
  insights tab).
- Evidence provided via PR-body headings; exports and compliance packages.
- Advisory AI hooks exist (`aiDraft`, `generateAiDraftForEvidence`) but are
  disabled by default and not shipped.

**Gaps.**

- **No Slack/Teams/mobile actions.** Reviewers must leave their workflow and
  use the dashboard; no push notifications.
- **No shipped AI assistance.** No plain-English explanations, no evidence
  auto-draft, no policy recommendations — the biggest daily-use friction.
- **Evidence UX is PR-body-heading based**, which is awkward for reviewers;
  no in-dashboard guided evidence submission.
- **No per-reviewer personalization** (e.g., "my queue") beyond the evidence
  queue.
- **Insights tab exists but recommendations are not generated** (no decision-
  intelligence engine yet).

**Improvements.**

- Ship the advisory AI layer (explanations, evidence auto-draft, policy
  recommendations) behind flags (S-C7/S-O2).
- Build Slack (then Teams) actions and push notifications (S-O5).
- Improve the evidence UX with a guided, in-dashboard flow and templates.
- Add a personalized reviewer inbox/queue.
- Turn the insights tab into a live decision-intelligence dashboard (S-O1).

---

### 13.9 Stage 6 — Optimization & Expansion

**Customer goal.** Reduce false positives, tighten policy, and expand governance
to more repositories and teams.

**Current support.**

- `optimize` mode keeps enforce controls active and surfaces improvement
  opportunities.
- Policy versioning and preview; override trends in the dashboard.
- Multi-repository and multi-policy-pack support.

**Gaps.**

- **Policy insights are not generated** (no aggregation engine, no
  recommendations, no weekly digest).
- **No per-detector precision/recall reporting** to guide tuning.
- **No automated policy drift detection** against compliance frameworks.
- **Expansion is manual** (add repo, pick pack); no bulk onboarding or
  org-wide defaults.

**Improvements.**

- Ship the decision-intelligence engine with per-detector metrics and
  read-only recommendations (S-O1).
- Add bulk repository onboarding and org-wide policy defaults.
- Add compliance-drift alerts.

---

### 13.10 Stage 7 — Compliance & Enterprise

**Customer goal.** Prepare for audits, meet enterprise security requirements,
and deploy in restricted environments.

**Current support.**

- JSON/CSV CCR exports and compliance evidence packages (manifest, control
  mappings, audit timeline, redaction report).
- Metadata-only storage, secret redaction, fail-closed config, RLS tenant
  isolation.
- Self-hosting docs and a hardened reference.

**Gaps.**

- **No SSO/SAML/SCIM** (V2 Phase 4) — a blocker for many enterprise buyers.
- **No SIEM streaming** (Splunk HEC, Datadog, Elasticsearch) — audit is
  export-based, not continuous.
- **No tamper-evident audit trail** (hash chain / signed entries) yet.
- **No SOC 2 / ISO 27001 control mappings** shipped.
- **No production Helm/Terraform distribution** for air-gapped/K8s.
- **No hosted SaaS** for teams that do not self-host.

**Improvements.**

- Prioritize SSO/SAML and the tamper-evident audit trail for enterprise deals.
- Ship SIEM streaming and framework control mappings (S-O7).
- Deliver Helm/Terraform for self-hosted enterprise (S-O6).
- Evaluate a hosted SaaS tier to capture teams that will not self-host.

---

### 13.11 Stage 8 — Retention & Advocacy

**Customer goal.** Renew, expand to more repos/teams, and advocate internally
and externally.

**Current support.**

- Governance value compounds as more repos are protected.
- Compliance evidence packages support renewals in regulated orgs.
- Self-governance dogfooding demonstrates the product in practice.

**Gaps.**

- **No support tiers / SLAs / onboarding success program.**
- **No community** (forums, Discord, contributor onboarding) beyond GitHub
  issues.
- **No renewal/expansion analytics** (self-hosted, vendor cannot see usage).
- **No hosted SaaS upsell path.**
- **Loom narrative** may confuse long-term positioning for renewals.

**Improvements.**

- Define support tiers and a customer-success motion (onboarding, health
  reviews, renewal).
- Stand up a community and a public roadmap with feedback channels.
- Add opt-in usage telemetry to inform expansion and renewal.
- Keep the buyer story on Merge Guard until Loom is validated.

---

### 13.12 Cross-cutting gaps and prioritized improvements

| #   | Gap                                          | Journey stages | Impact                 | Priority |
| --- | -------------------------------------------- | -------------- | ---------------------- | -------- |
| G1  | No hosted SaaS / sandbox / demo              | 0, 1, 8        | High (activation)      | P0       |
| G2  | Heavy multi-service setup, no installer      | 1, 2           | High (adoption)        | P0       |
| G3  | No external validation / design partners     | 0, 8           | High (credibility)     | P0       |
| G4  | No shipped AI assistance                     | 5              | High (daily value)     | P1       |
| G5  | No decision-intelligence / insights engine   | 5, 6           | High (differentiation) | P1       |
| G6  | No Slack/Teams/mobile actions                | 5              | Medium (friction)      | P1       |
| G7  | No SSO/SAML/SCIM, SIEM, tamper-evident audit | 7              | High (enterprise)      | P2       |
| G8  | No production Helm/Terraform distribution    | 1, 7           | Medium (enterprise)    | P2       |
| G9  | No support tiers / community / telemetry     | 8              | Medium (retention)     | P2       |
| G10 | Two-product (Loom) narrative confusion       | 0, 8           | Medium (positioning)   | P0       |

**Recommended sequencing.** Fix the adoption blockers (G1, G2, G3, G10) first
so prospects can reach first value; then ship the daily-use differentiators
(G4, G5, G6) to retain and expand; then close enterprise gaps (G7, G8, G9).
This mirrors the P0–P3 roadmap in Section 11 and keeps the customer journey
from stalling before value is realized.

### 13.13 Visual journey maps

Three hand-rendered SVG maps accompany this section (PNG previews included):

- [customer-journey-overview.svg](customer-journey-overview.svg) — nine-stage
  journey map with gap levels and an emotional journey curve.
- [customer-journey-core-loop.svg](customer-journey-core-loop.svg) — detailed
  swimlane map of the core governance loop (Stages 3–6) across GitHub, the
  AgentForge system, reviewers, and platform admins, with pain points and
  opportunities per step.
- [customer-journey-gaps-matrix.svg](customer-journey-gaps-matrix.svg) — the
  G1–G10 gap/opportunity matrix with journey stages, impact, priority, and the
  improvement that closes each gap.

PNG previews: [overview](customer-journey-overview.png),
[core loop](customer-journey-core-loop.png), [gaps matrix](customer-journey-gaps-matrix.png).
