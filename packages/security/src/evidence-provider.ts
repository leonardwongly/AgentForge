import type { EvidenceKind, PullRequestInput, VerifiedFact } from "@agentforge/core";
import { generateAiDraftForEvidence } from "./draft.js";

export type EvidenceDraftRequest = {
  kind: EvidenceKind;
  finding: VerifiedFact;
  pr: PullRequestInput;
};

// Drafts are always advisory: they help a human satisfy an evidence requirement
// and can never change a blocking decision. `egress` records whether producing
// the draft sent data off-box, so it can be audited per the trust model.
export type EvidenceDraft = {
  kind: EvidenceKind;
  content: string;
  advisoryOnly: true;
  source: string;
  egress: boolean;
};

export interface EvidenceDraftProvider {
  readonly id: string;
  readonly egress: boolean;
  draftEvidence(request: EvidenceDraftRequest): EvidenceDraft | Promise<EvidenceDraft>;
}

// Default provider: deterministic, redacted, and never leaves the process.
// A real LLM provider would implement this interface with `egress: true` and
// must only be enabled with explicit per-organization consent.
export const deterministicEvidenceDraftProvider: EvidenceDraftProvider = {
  id: "deterministic",
  egress: false,
  draftEvidence(request: EvidenceDraftRequest): EvidenceDraft {
    return {
      kind: request.kind,
      content: generateAiDraftForEvidence(request),
      advisoryOnly: true,
      source: "deterministic",
      egress: false
    };
  }
};
