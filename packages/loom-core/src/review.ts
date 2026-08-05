/**
 * @agentforge/loom-core — native review and evidence (Phase 3, spec §13).
 *
 * Derives the review requirements (required evidence kinds and reviewers) that
 * a change's declared effects imply, so an agent session's consequences are
 * routed to the right human review before admission. This is the native
 * counterpart to the policy engine's required-evidence routing, driven directly
 * by the Loom effect vocabulary.
 */

import type { Effect } from "./types.js";

export interface ReviewRequirement {
  readonly effect: Effect;
  /** Required evidence kinds for this effect. */
  readonly evidence: readonly string[];
  /** Required reviewers for this effect. */
  readonly reviewers: readonly string[];
}

const EFFECT_REVIEW: Readonly<Record<string, ReviewRequirement>> = {
  adds_migration: { effect: "adds_migration", evidence: ["rollback_plan", "migration_dry_run"], reviewers: ["database-owner"] },
  deletes_migration: { effect: "deletes_migration", evidence: ["rollback_plan"], reviewers: ["database-owner"] },
  adds_dependency: { effect: "adds_dependency", evidence: ["dependency_justification"], reviewers: [] },
  bumps_dependency_major: { effect: "bumps_dependency_major", evidence: ["dependency_justification"], reviewers: [] },
  bumps_dependency_minor: { effect: "bumps_dependency_minor", evidence: [], reviewers: [] },
  deletes_test: { effect: "deletes_test", evidence: ["deleted_test_explanation"], reviewers: [] },
  skips_test: { effect: "skips_test", evidence: ["deleted_test_explanation"], reviewers: [] },
  changes_ci: { effect: "changes_ci", evidence: ["ci_change_reason"], reviewers: [] },
  touches_sensitive_path: { effect: "touches_sensitive_path", evidence: ["security_note"], reviewers: ["security-team"] },
  adds_secret_like_value: { effect: "adds_secret_like_value", evidence: ["security_note"], reviewers: ["security-team"] }
};

/** The review requirement an effect implies, or undefined if none. */
export function reviewRequirementForEffect(effect: Effect): ReviewRequirement | undefined {
  return EFFECT_REVIEW[effect];
}

/** Derive all review requirements for a set of effects (deduplicated). */
export function reviewRequirementsForEffects(effects: readonly Effect[]): ReviewRequirement[] {
  const seen = new Set<string>();
  const requirements: ReviewRequirement[] = [];
  for (const effect of effects) {
    const requirement = EFFECT_REVIEW[effect];
    if (requirement === undefined || seen.has(effect)) {
      continue;
    }
    seen.add(effect);
    requirements.push(requirement);
  }
  return requirements;
}
