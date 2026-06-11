# AgentForge Merge Guard — V2.0 Roadmap

> V1 proved deterministic governance works. V2 makes it faster to act on.

## Guiding Principle

**Deterministic checks decide. AI explains and assists. Humans approve risk.**

V2 does not change this. AI features reduce reviewer cognitive load and time-to-resolution
without ever making autonomous merge or block decisions.

---

## Strategic Sequencing

| Phase   | Theme               | Rationale                                            |
| ------- | ------------------- | ---------------------------------------------------- |
| Phase 1 | Intelligence layer  | Differentiation; reduces friction for existing users |
| Phase 2 | Integration surface | Meet reviewers where they work (Slack, mobile)       |
| Phase 3 | Platform expansion  | New buyers: GitLab orgs, enterprise self-hosted      |
| Phase 4 | Compliance depth    | Enterprise deal requirements (SSO, SIEM, frameworks) |

---

## Phase 1 — Intelligence Layer (Sprints 6–8)

Goal: AI assists humans in understanding and resolving policy violations faster.

### Sprint 6: Advisory AI Explanations

- [ ] LLM summarization of policy violations on GitHub check run output
- [ ] Plain-English "why this triggered" explanation per detector finding
- [ ] Context window: PR diff + policy YAML + detector output (no repository-wide context)
- [ ] Provider-agnostic LLM adapter (OpenAI, Anthropic, local ollama)
- [ ] Feature flag: `llm.advisory_explanations` (off by default, opt-in per org)
- [ ] Latency budget: explanation generation must not block check run publication
- [ ] Async enrichment: check run publishes immediately, explanation appended within 30s

**Constraints:**

- Explanations are informational; they do not affect pass/fail/block status
- No repository source code sent to external LLM unless org explicitly enables `storage.allow_llm_context`
- Diff snippets redacted through existing `@agentforge/security` pipeline before LLM submission

### Sprint 7: Evidence Auto-Draft

- [ ] AI drafts evidence responses from PR description, commit messages, and linked issues
- [ ] Draft appears as suggestion in dashboard evidence queue; human must approve/edit/reject
- [ ] Confidence indicator (high/medium/low) based on source coverage
- [ ] "Sources" annotation showing which PR artifacts informed the draft
- [ ] Evidence auto-draft disabled for `enforce` mode orgs until 30-day opt-in observation period

### Sprint 8: Policy Insight Recommendations

- [ ] Aggregate analysis: override frequency, false-positive rate, time-to-resolution per detector
- [ ] Recommendations surfaced in dashboard Policy Insights tab (already exists in V1 UI)
- [ ] Suggested policy YAML diffs (read-only preview; platform-admin applies manually)
- [ ] Recommendation types: relax threshold, add exception path, promote observe→warn, demote enforce→warn
- [ ] Minimum sample size: 50 evaluations before generating recommendations
- [ ] Weekly digest option (email or webhook) for platform-admin

---

## Phase 2 — Integration Surface (Sprints 9–11)

Goal: Reviewers act on governance signals without leaving their primary workflow.

### Sprint 9: Slack Integration

- [ ] Slack App with OAuth installation flow
- [ ] Notifications: PR blocked, evidence required, override requested
- [ ] Actions: approve evidence, request changes, escalate to platform-admin
- [ ] Thread-based context: policy violation summary + link to dashboard record
- [ ] Channel routing rules (per-repository or per-policy-pack)
- [ ] Slack identity ↔ GitHub identity mapping (required for audit trail)

### Sprint 10: Microsoft Teams Integration

- [ ] Teams App with admin consent flow
- [ ] Feature parity with Slack: notifications, actions, thread context
- [ ] Adaptive Cards for evidence review and override approval

### Sprint 11: Mobile Operator Console (GA)

- [ ] Promote iOS app from prototype to production (SwiftUI, iOS 26+)
- [ ] Promote Android app from prototype to production (Jetpack Compose)
- [ ] Push notifications for blocked PRs and override requests
- [ ] Biometric authentication for override approvals
- [ ] Offline queue: actions sync when connectivity restored
- [ ] App Store / Play Store distribution

---

## Phase 3 — Platform Expansion (Sprints 12–14)

Goal: Same governance engine, broader ecosystem reach.

### Sprint 12: GitLab Support

- [ ] GitLab webhook adapter (push, merge request, note events)
- [ ] GitLab API client (merge request comments, pipeline status, approvals)
- [ ] GitLab OAuth for dashboard authentication
- [ ] CODEOWNERS equivalent: GitLab Code Owners file parsing
- [ ] Detector compatibility: all 11 detectors work against GitLab diff format
- [ ] Policy pack reuse: same YAML schema, platform-aware detector bindings

### Sprint 13: Bitbucket Support

- [ ] Bitbucket webhook adapter (pull request events)
- [ ] Bitbucket API client (PR comments, build status)
- [ ] Atlassian OAuth 2.0 for dashboard authentication
- [ ] Default reviewers / workspace permissions parsing

### Sprint 14: Self-Hosted Distribution

- [ ] Helm chart for Kubernetes deployment (API + Worker + Web + Redis + Postgres)
- [ ] Terraform modules for AWS (ECS/RDS/ElastiCache) and GCP (Cloud Run/Cloud SQL/Memorystore)
- [ ] Air-gapped installation guide (no external network dependencies at runtime)
- [ ] Upgrade migration tooling (database migrations, config schema evolution)
- [ ] Operational runbook expansion: backup/restore, horizontal scaling, failover

---

## Phase 4 — Compliance Depth (Sprints 15–17)

Goal: Enterprise deal-closing features.

### Sprint 15: SSO / SAML / SCIM

- [ ] SAML 2.0 IdP integration (Okta, Azure AD, OneLogin)
- [ ] SCIM user/group provisioning
- [ ] Role mapping from IdP groups to AgentForge roles (viewer, reviewer, engineering_manager, platform_admin)
- [ ] Session management: configurable timeout, forced re-auth for override actions

### Sprint 16: Audit & SIEM Integration

- [ ] Structured audit log export: S3, GCS, Azure Blob (object storage adapters already stubbed)
- [ ] Real-time event streaming: Splunk HEC, Datadog Logs, Elasticsearch
- [ ] Audit log retention policies (configurable per org, minimum 90 days)
- [ ] Tamper-evident audit trail (hash chain or signed entries)
- [ ] Audit log search and filter in dashboard

### Sprint 17: Compliance Framework Mappings

- [ ] SOC 2 Type II control mapping (CC6.1, CC6.2, CC6.6, CC7.1, CC7.2, CC8.1)
- [ ] ISO 27001 Annex A control mapping (A.8.25, A.8.26, A.8.27, A.8.28, A.8.32, A.8.33)
- [ ] Pre-built compliance evidence packages per framework
- [ ] Auditor-facing export format (PDF + structured JSON)
- [ ] Continuous compliance monitoring: alert when policy configuration drifts from framework requirements

---

## Explicitly Deferred (V3+)

These remain out of scope for V2. They require deeper research, customer validation,
or represent philosophical shifts that need board-level decisions:

- Autonomous merge decisions (AI blocks or approves without human)
- Full agent orchestration / multi-agent work graphs
- Line-by-line AI authorship labeling
- Prompt/session replay
- IDE extension (VS Code / JetBrains)
- Agentic blame
- Full provenance SDK
- Numeric risk-score-centered workflows
- LLM-based blocking (AI determines pass/fail)
- Semantic architecture review

---

## Success Metrics

| Metric                       | V1 Baseline | V2 Target            |
| ---------------------------- | ----------- | -------------------- |
| Time to resolve blocked PR   | Unmeasured  | < 2 hours (p75)      |
| Evidence completion rate     | Manual      | 80%+ with auto-draft |
| False-positive override rate | Unmeasured  | < 15% per detector   |
| Platform coverage            | GitHub only | GitHub + GitLab      |
| Active orgs                  | 0 external  | 25+ paying orgs      |
| Reviewer satisfaction (CSAT) | Unmeasured  | > 4.0 / 5.0          |

---

## Prerequisites & Dependencies

| Phase   | Prerequisite                                                             |
| ------- | ------------------------------------------------------------------------ |
| Phase 1 | External pilot customers (minimum 3 orgs on V1 `observe` or `warn` mode) |
| Phase 1 | LLM provider partnership or self-hosted model validated for code context |
| Phase 2 | Slack/Teams App directory approval (4–6 week lead time)                  |
| Phase 3 | GitLab Partner Program enrollment for API access and listing             |
| Phase 4 | SOC 2 Type II audit engagement (3–6 month timeline)                      |

---

## Release Cadence

- **Minor releases** (2.1, 2.2, ...): end of each sprint (~2 weeks)
- **Major release** (2.0.0): after Phase 1 completion (Sprint 8)
- **Patch releases**: security fixes and critical bugs, as needed
- **Feature flags**: all Phase 1 AI features ship behind org-level flags; promoted to default-on after 30-day observation period with minimum 3 orgs

---

## Open Questions

1. **LLM provider strategy**: Single provider (OpenAI) for speed, or multi-provider from day one?
2. **Pricing model for AI features**: Usage-based (per-explanation) or included in tier?
3. **GitLab priority**: Is there validated demand, or should Phase 3 start with Helm chart?
4. **Mobile distribution**: Public app stores or enterprise MDM-only for V2?
5. **Compliance framework priority**: SOC 2 first (startup buyers) or ISO 27001 (EU enterprise)?
