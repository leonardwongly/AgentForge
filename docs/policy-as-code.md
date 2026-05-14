# Policy As Code

Policies are YAML files parsed and validated by `packages/policy`.

Required top-level fields:

```yaml
version: 1
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
```

Modes:

- `observe`: records findings and always passes.
- `warn`: records what would block but does not block.
- `enforce`: blocks when required policy evidence, required reviewers, or blocking findings are unmet.
- `optimize`: preserves enforce-mode blocking while teams tune evidence quality, routing, overrides, and operational metrics.

Applicability scopes:

- `all_pull_requests`
- `repo:<glob>` or `repository:<glob>`
- `base:<glob>` or `base_branch:<glob>`
- `head:<glob>`, `head_branch:<glob>`, or `branch:<glob>`
- `label:<glob>`

Scopes are matched case-insensitively. If none match, Merge Guard returns a passing result with no findings, evidence, or reviewer requirements for that PR.

Supported V1 rule groups:

- `sensitive_paths`
- `tests`
- `dependencies`
- `database`
- `overrides`
- `data_retention`

Sensitive path example:

```yaml
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
```

Evidence kinds:

- `rollback_plan`
- `migration_dry_run`
- `dependency_justification`
- `deleted_test_explanation`
- `benchmark_before_after`
- `security_note`
- `ci_change_reason`
- `manual_attestation`

Override policy:

```yaml
overrides:
  allowed_roles:
    - engineering_manager
    - platform_admin
  require_reason: true
  visible_in_pr: true
  audit: true
```

Validation:

```bash
pnpm policy:validate fixtures/policies/fintech.yaml
```

Preview:

```bash
pnpm policy:preview fixtures/policies/fintech.yaml fixtures/repos/billing-agent.json
```

The API preview route is read-only unless the request includes `persist: true` and an authorized server-resolved actor. Use read-only previews for policy tuning and persisted previews only when intentionally creating audit/demo records.
