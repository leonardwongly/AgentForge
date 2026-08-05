import type {
  ChangedFile,
  ManualEvidenceInput,
  PolicyResult,
  PullRequestInput,
  PullRequestReview,
  VerifiedFact
} from "@agentforge/core";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import { stateAddress, type Effect, type State } from "@agentforge/loom-core";
import { evaluateMergeGuard, type PolicyConfig } from "@agentforge/policy";
import { fabricDiffView } from "./diff-view.js";
import { factsFromEffects } from "./facts.js";

/**
 * The Loom-native governance input: a base -> result Transform plus the
 * addressing/identity fields the existing engine expects. The git/GitHub shape
 * (`repositoryFullName`/`pullRequestNumber`/`headSha`/branches) is SYNTHESIZED
 * from Loom concepts, proving the governance upper-half plugs onto Loom with
 * zero changes to `@agentforge/policy` or `@agentforge/detectors`.
 */
export interface TransformEvaluationInput {
  readonly base: State;
  readonly result: State;
  readonly policy: PolicyConfig;
  /** Loom Space id -> synthesized repositoryFullName. */
  readonly space: string;
  /** Shared Line ref -> synthesized base/head branch. */
  readonly lineRef: string;
  /** Proposal id -> correlation; a stable number is derived for the engine. */
  readonly proposalId: string;
  readonly intent: { readonly title: string };
  readonly author: string;
  readonly reviews?: ReadonlyArray<PullRequestReview> | undefined;
  readonly manualEvidence?: ReadonlyArray<ManualEvidenceInput> | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  /**
   * The Transform's declared effects. When provided, native policy facts are
   * derived directly from these effects instead of re-inferred from the diff.
   */
  readonly effects?: ReadonlyArray<Effect> | undefined;
}

export interface TransformEvaluation {
  readonly diff: ChangedFile[];
  readonly facts: VerifiedFact[];
  readonly result: PolicyResult;
  /** The synthesized PullRequestInput actually handed to the engine (for audit). */
  readonly synthesizedInput: PullRequestInput;
}

/**
 * Ratify a Loom Transform against a policy by reusing the deterministic
 * governance engine verbatim (RATP step "derive facts -> evaluate", design §4).
 */
export function evaluateTransformSet(input: TransformEvaluationInput): TransformEvaluation {
  const diff = fabricDiffView(input.base, input.result);
  const headSha = stateAddress(input.result);

  const pr: PullRequestInput = {
    repositoryFullName: input.space,
    pullRequestNumber: deriveNumber(headSha),
    title: input.intent.title,
    authorLogin: input.author,
    baseBranch: input.lineRef,
    headBranch: input.lineRef,
    headSha,
    changedFiles: diff,
    ...(input.reviews ? { reviews: [...input.reviews] } : {}),
    ...(input.manualEvidence ? { manualEvidence: [...input.manualEvidence] } : {}),
    ...(input.labels ? { labels: [...input.labels] } : {})
  };

  const config = detectorConfigFromPolicy(input.policy);
  const facts =
    input.effects !== undefined
      ? factsFromEffects({ effects: input.effects, paths: diff.map((file) => file.filename) })
      : extractVerifiedFacts(pr, config);
  const result = evaluateMergeGuard(pr, facts, input.policy);

  return { diff, facts, result, synthesizedInput: pr };
}

/** Derive a stable non-negative correlation number from a State address. */
function deriveNumber(headSha: string): number {
  const hex = headSha.slice(headSha.lastIndexOf(":") + 1, headSha.lastIndexOf(":") + 9);
  const parsed = Number.parseInt(hex, 16);
  return Number.isNaN(parsed) ? 0 : parsed;
}
