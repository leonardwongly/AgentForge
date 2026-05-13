import { z } from "zod";
import type { EvidenceKind, PolicyMode } from "@agentforge/core";

export const policyModeSchema = z.enum(["observe", "warn", "enforce", "optimize"]);

const evidenceKindSchema = z.enum([
  "rollback_plan",
  "migration_dry_run",
  "dependency_justification",
  "deleted_test_explanation",
  "benchmark_before_after",
  "security_note",
  "ci_change_reason",
  "manual_attestation"
]);

const actionSchema = z.enum(["block", "require_review", "warn", "suggest"]);

const pathRuleSchema = z.object({
  paths: z.array(z.string().min(1)),
  required_reviewers: z.array(z.string().min(1)).default([]),
  required_evidence: z.array(evidenceKindSchema).default([]),
  action: actionSchema.optional(),
  mode: policyModeSchema.optional(),
  block_for_agent_assisted: z.boolean().default(false)
});

const testRuleSchema = z.object({
  action: actionSchema.default("block"),
  patterns: z.array(z.string()).optional(),
  required_reviewers: z.array(z.string()).default([]),
  required_evidence: z.array(evidenceKindSchema).default([]),
  mode: policyModeSchema.optional()
});

const dependencyRuleSchema = z.object({
  action: actionSchema.default("require_review"),
  required_reviewers: z.array(z.string()).default([]),
  required_evidence: z.array(evidenceKindSchema).default([]),
  mode: policyModeSchema.optional()
});

const databaseRuleSchema = z.object({
  paths: z.array(z.string()).default(["db/migrations/**", "migrations/**"]),
  required_reviewers: z.array(z.string()).default([]),
  required_evidence: z.array(evidenceKindSchema).default([]),
  action: actionSchema.default("block"),
  mode: policyModeSchema.optional()
});

export const policyConfigSchema = z.object({
  version: z.number().int().positive(),
  policy_pack_id: z.string().optional(),
  policy_pack_version: z.string().optional(),
  agentforge: z.object({
    mode: policyModeSchema.default("observe"),
    apply_to: z.array(z.string()).default(["all_pull_requests"])
  }),
  agent_assisted: z
    .object({
      stricter_controls: z.boolean().default(true),
      detection_signals: z.array(z.string()).default([])
    })
    .default({
      stricter_controls: true,
      detection_signals: [
        "bot_author",
        "branch_pattern",
        "ai_label",
        "commit_metadata",
        "pr_body_marker"
      ]
    }),
  sensitive_paths: z.record(z.string(), pathRuleSchema).default({}),
  tests: z
    .object({
      deleted_tests: testRuleSchema.default({
        action: "block",
        required_reviewers: [],
        required_evidence: ["deleted_test_explanation"]
      }),
      skipped_tests: testRuleSchema.default({
        action: "block",
        required_reviewers: [],
        required_evidence: ["deleted_test_explanation"]
      }),
      coverage_threshold_reduced: testRuleSchema.default({
        action: "block",
        required_reviewers: [],
        required_evidence: ["deleted_test_explanation"]
      }),
      suspicious_test_change: testRuleSchema.default({
        action: "warn",
        required_reviewers: [],
        required_evidence: []
      })
    })
    .default({
      deleted_tests: {
        action: "block",
        required_reviewers: [],
        required_evidence: ["deleted_test_explanation"]
      },
      skipped_tests: {
        action: "block",
        required_reviewers: [],
        required_evidence: ["deleted_test_explanation"]
      },
      coverage_threshold_reduced: {
        action: "block",
        required_reviewers: [],
        required_evidence: ["deleted_test_explanation"]
      },
      suspicious_test_change: {
        action: "warn",
        required_reviewers: [],
        required_evidence: []
      }
    }),
  dependencies: z
    .object({
      new_package: dependencyRuleSchema.default({
        action: "require_review",
        required_reviewers: ["security-team"],
        required_evidence: ["dependency_justification"]
      }),
      major_version_bump: dependencyRuleSchema.default({
        action: "require_review",
        required_reviewers: ["security-team"],
        required_evidence: []
      })
    })
    .default({
      new_package: {
        action: "require_review",
        required_reviewers: ["security-team"],
        required_evidence: ["dependency_justification"]
      },
      major_version_bump: {
        action: "require_review",
        required_reviewers: ["security-team"],
        required_evidence: []
      }
    }),
  database: z
    .object({
      migrations: databaseRuleSchema.default({
        paths: ["db/migrations/**", "migrations/**"],
        required_reviewers: ["database-owner"],
        required_evidence: ["rollback_plan", "migration_dry_run"],
        action: "block"
      })
    })
    .default({
      migrations: {
        paths: ["db/migrations/**", "migrations/**"],
        required_reviewers: ["database-owner"],
        required_evidence: ["rollback_plan", "migration_dry_run"],
        action: "block"
      }
    }),
  overrides: z
    .object({
      allowed_roles: z.array(z.string()).default(["engineering_manager", "platform_admin"]),
      require_reason: z.boolean().default(true),
      visible_in_pr: z.boolean().default(true),
      audit: z.boolean().default(true)
    })
    .default({
      allowed_roles: ["engineering_manager", "platform_admin"],
      require_reason: true,
      visible_in_pr: true,
      audit: true
    }),
  data_retention: z
    .object({
      source_code_storage: z.boolean().default(false),
      full_diff_retention: z.enum(["disabled", "7d", "30d", "custom"]).default("disabled"),
      redact_secrets: z.boolean().default(true),
      llm_features: z.boolean().default(false),
      audit_record_retention: z.string().default("365d")
    })
    .default({
      source_code_storage: false,
      full_diff_retention: "disabled",
      redact_secrets: true,
      llm_features: false,
      audit_record_retention: "365d"
    })
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type PolicyAction = "block" | "require_review" | "warn" | "suggest";

export function normalizeEvidenceKinds(values: EvidenceKind[] | undefined): EvidenceKind[] {
  return [...new Set(values ?? [])];
}

export function strictestMode(modes: PolicyMode[]): PolicyMode {
  if (modes.includes("optimize")) {
    return "optimize";
  }
  if (modes.includes("enforce")) {
    return "enforce";
  }
  if (modes.includes("warn")) {
    return "warn";
  }
  return "observe";
}
