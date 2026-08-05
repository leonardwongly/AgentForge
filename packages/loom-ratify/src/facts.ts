/**
 * @agentforge/loom-ratify — native policy facts (Phase 2, spec §13.2).
 *
 * Derives deterministic governance facts (VerifiedFact) directly from a Loom
 * Transform's declared effect vocabulary, rather than re-inferring them from a
 * synthesized diff. This is the authoritative native path: the effects are the
 * declared, versioned semantic consequences of the change.
 */

import type { VerifiedFact } from "@agentforge/core";
import type { Effect } from "@agentforge/loom-core";

export interface NativeFactsInput {
  readonly effects: readonly Effect[];
  /** Paths the change touches, used to populate fact paths. */
  readonly paths: readonly string[];
}

/** Map a single Loom effect to a governance fact; undefined if not policy-relevant. */
export function factForEffect(effect: Effect, paths: readonly string[]): VerifiedFact | undefined {
  const path = paths[0];
  switch (effect) {
    case "adds_dependency":
      return {
        id: `fact:effect:${effect}`,
        type: "dependency_added",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    case "bumps_dependency_major":
    case "bumps_dependency_minor":
      return {
        id: `fact:effect:${effect}`,
        type: "dependency_bumped",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    case "adds_migration":
      return {
        id: `fact:effect:${effect}`,
        type: "migration_added",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    case "deletes_test":
      return {
        id: `fact:effect:${effect}`,
        type: "test_deleted",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    case "skips_test":
      return {
        id: `fact:effect:${effect}`,
        type: "test_skipped",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    case "changes_ci":
      return {
        id: `fact:effect:${effect}`,
        type: "ci_workflow_changed",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    case "touches_sensitive_path":
      return {
        id: `fact:effect:${effect}`,
        type: "sensitive_path_changed",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified",
        metadata: { ruleId: "sensitive_paths" }
      };
    case "adds_secret_like_value":
      return {
        id: `fact:effect:${effect}`,
        type: "secret_like_value_detected",
        source: "loom_effects",
        path,
        evidence: `declared effect: ${effect}`,
        confidence: "verified"
      };
    default:
      // edits_source, deletes_source, moves_cell, removes_dependency,
      // deletes_migration, adds_generated_artifact are not individually
      // policy-relevant facts in the current engine.
      return undefined;
  }
}

/** Derive all policy-relevant facts from a Transform's declared effects. */
export function factsFromEffects(input: NativeFactsInput): VerifiedFact[] {
  const facts: VerifiedFact[] = [];
  for (const effect of input.effects) {
    const fact = factForEffect(effect, input.paths);
    if (fact !== undefined) {
      facts.push(fact);
    }
  }
  return facts;
}
