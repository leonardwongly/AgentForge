import type { PolicyMode } from "@agentforge/core";

export type PolicyPack = {
  id: string;
  name: string;
  description: string;
  version: string;
  builtIn: boolean;
  defaultMode: PolicyMode;
  contentYaml: string;
};

const baseRetention = `overrides:
  allowed_roles:
    - "engineering_manager"
    - "platform_admin"
  require_reason: true
  visible_in_pr: true
  audit: true

data_retention:
  source_code_storage: false
  full_diff_retention: "disabled"
  redact_secrets: true
  llm_features: false
  audit_record_retention: "365d"`;

export const builtinPolicyPacks: PolicyPack[] = [
  {
    id: "startup-default",
    name: "Startup Default",
    description: "Lightweight visibility-first governance for small teams.",
    version: "1.0.0",
    builtIn: true,
    defaultMode: "warn",
    contentYaml: `version: 1
policy_pack_id: startup-default
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
  detection_signals:
    - bot_author
    - branch_pattern
    - ai_label
    - commit_metadata
    - pr_body_marker
sensitive_paths:
  ci_and_deploy:
    paths:
      - ".github/workflows/**"
      - "scripts/deploy/**"
      - "infra/prod/**"
    required_reviewers:
      - "platform-team"
    required_evidence:
      - "ci_change_reason"
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
  skipped_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
    required_evidence:
      - "dependency_justification"
database:
  migrations:
    paths:
      - "db/migrations/**"
      - "migrations/**"
    required_evidence:
      - "rollback_plan"
${baseRetention}`
  },
  {
    id: "platform-engineering",
    name: "Platform Engineering",
    description: "Infrastructure, CI/CD, deployment, and production reliability governance.",
    version: "1.0.0",
    builtIn: true,
    defaultMode: "warn",
    contentYaml: `version: 1
policy_pack_id: platform-engineering
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
  detection_signals:
    - bot_author
    - branch_pattern
    - ai_label
    - commit_metadata
    - pr_body_marker
sensitive_paths:
  ci_and_deploy:
    paths:
      - ".github/workflows/**"
      - "scripts/deploy/**"
      - "infra/prod/**"
      - "deployment/**"
      - "ci/**"
      - "buildkite/**"
      - ".circleci/**"
      - "Jenkinsfile"
    required_reviewers:
      - "platform-team"
    required_evidence:
      - "ci_change_reason"
      - "rollback_plan"
    block_for_agent_assisted: true
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
    required_reviewers:
      - "security-team"
    required_evidence:
      - "dependency_justification"
database:
  migrations:
    required_reviewers:
      - "database-owner"
    required_evidence:
      - "rollback_plan"
      - "migration_dry_run"
${baseRetention}`
  },
  {
    id: "fintech",
    name: "Fintech",
    description: "Billing, checkout, payment, auditability, and controlled release governance.",
    version: "1.0.0",
    builtIn: true,
    defaultMode: "warn",
    contentYaml: `version: 1
policy_pack_id: fintech
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
  detection_signals:
    - bot_author
    - branch_pattern
    - ai_label
    - commit_metadata
    - pr_body_marker
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
      - "src/checkout/**"
      - "services/payments/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
  auth:
    paths:
      - "src/auth/**"
      - "services/identity/**"
    required_reviewers:
      - "security-team"
    required_evidence:
      - "security_note"
  ci_and_deploy:
    paths:
      - ".github/workflows/**"
      - "scripts/deploy/**"
      - "infra/prod/**"
    required_reviewers:
      - "platform-team"
    required_evidence:
      - "ci_change_reason"
    block_for_agent_assisted: true
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
    required_reviewers:
      - "security-team"
    required_evidence:
      - "dependency_justification"
  major_version_bump:
    action: require_review
    required_reviewers:
      - "security-team"
database:
  migrations:
    required_reviewers:
      - "database-owner"
    required_evidence:
      - "rollback_plan"
      - "migration_dry_run"
${baseRetention}`
  },
  {
    id: "healthcare-regulated",
    name: "Healthcare / Regulated",
    description: "Regulated engineering governance with stricter audit and data controls.",
    version: "1.0.0",
    builtIn: true,
    defaultMode: "warn",
    contentYaml: `version: 1
policy_pack_id: healthcare-regulated
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
  detection_signals:
    - bot_author
    - branch_pattern
    - ai_label
    - commit_metadata
    - pr_body_marker
sensitive_paths:
  auth:
    paths:
      - "src/auth/**"
      - "services/identity/**"
    required_reviewers:
      - "security-team"
    required_evidence:
      - "security_note"
  regulated_data:
    paths:
      - "src/patient/**"
      - "services/identity/**"
      - "services/audit/**"
    required_reviewers:
      - "security-team"
      - "platform-team"
    required_evidence:
      - "rollback_plan"
      - "security_note"
tests:
  deleted_tests:
    action: block
    mode: enforce
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
    required_reviewers:
      - "security-team"
    required_evidence:
      - "dependency_justification"
database:
  migrations:
    required_reviewers:
      - "database-owner"
    required_evidence:
      - "rollback_plan"
      - "migration_dry_run"
overrides:
  allowed_roles:
    - "engineering_manager"
    - "platform_admin"
  require_reason: true
  visible_in_pr: true
  audit: true
data_retention:
  source_code_storage: false
  full_diff_retention: "disabled"
  redact_secrets: true
  llm_features: false
  audit_record_retention: "2555d"`
  },
  {
    id: "open-source-maintainer",
    name: "Open Source Maintainer",
    description: "Contributor-friendly warnings for maintainers.",
    version: "1.0.0",
    builtIn: true,
    defaultMode: "warn",
    contentYaml: `version: 1
policy_pack_id: open-source-maintainer
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
sensitive_paths:
  ci_and_deploy:
    paths:
      - ".github/workflows/**"
      - "scripts/deploy/**"
    required_reviewers:
      - "maintainers"
    required_evidence:
      - "ci_change_reason"
tests:
  deleted_tests:
    action: warn
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: warn
    required_evidence:
      - "dependency_justification"
database:
  migrations:
    action: warn
    required_evidence:
      - "rollback_plan"
${baseRetention}`
  },
  {
    id: "enterprise-strict",
    name: "Enterprise Strict",
    description: "Mature platform and security workflows with enforce-ready controls.",
    version: "1.0.0",
    builtIn: true,
    defaultMode: "enforce",
    contentYaml: `version: 1
policy_pack_id: enterprise-strict
policy_pack_version: 1.0.0
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
  detection_signals:
    - bot_author
    - branch_pattern
    - ai_label
    - commit_metadata
    - pr_body_marker
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
      - "src/checkout/**"
      - "services/payments/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
  auth:
    paths:
      - "src/auth/**"
      - "services/identity/**"
    required_reviewers:
      - "security-team"
    required_evidence:
      - "security_note"
  platform:
    paths:
      - ".github/workflows/**"
      - "scripts/deploy/**"
      - "infra/prod/**"
      - "deployment/**"
    required_reviewers:
      - "platform-team"
    required_evidence:
      - "ci_change_reason"
      - "rollback_plan"
    block_for_agent_assisted: true
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
  skipped_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
    required_reviewers:
      - "security-team"
    required_evidence:
      - "dependency_justification"
database:
  migrations:
    action: block
    required_reviewers:
      - "database-owner"
    required_evidence:
      - "rollback_plan"
      - "migration_dry_run"
overrides:
  allowed_roles:
    - "platform_admin"
  require_reason: true
  visible_in_pr: true
  audit: true
data_retention:
  source_code_storage: false
  full_diff_retention: "disabled"
  redact_secrets: true
  llm_features: false
  audit_record_retention: "2555d"`
  }
];

export function getPolicyPack(id: string): PolicyPack | undefined {
  return builtinPolicyPacks.find((pack) => pack.id === id);
}
