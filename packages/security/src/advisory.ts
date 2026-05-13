import { sanitizeForMetadataStorage, type MetadataStoragePolicy } from "./storage.js";

export type AdvisoryPromptInput = {
  llmFeatures: boolean;
  findings: Array<{
    id: string;
    type: string;
    evidence: string;
    confidence: string;
    severity?: string | undefined;
  }>;
  requiredEvidence: Array<{ kind: string; status: string }>;
  requiredReviewers: Array<{ reviewer: string; tier: string; approved: boolean }>;
  storagePolicy?: MetadataStoragePolicy | undefined;
};

export type AdvisoryPromptResult =
  | {
      enabled: false;
      advisoryOnly: true;
      promptGenerated: false;
      deterministicFindingIds: string[];
    }
  | {
      enabled: true;
      advisoryOnly: true;
      promptGenerated: true;
      prompt: string;
      deterministicFindingIds: string[];
    };

export function buildLlmAdvisoryPrompt(input: AdvisoryPromptInput): AdvisoryPromptResult {
  const deterministicFindingIds = input.findings.map((finding) => finding.id);
  if (!input.llmFeatures) {
    return {
      enabled: false,
      advisoryOnly: true,
      promptGenerated: false,
      deterministicFindingIds
    };
  }

  const sanitized = sanitizeForMetadataStorage(
    {
      findings: input.findings,
      requiredEvidence: input.requiredEvidence,
      requiredReviewers: input.requiredReviewers
    },
    input.storagePolicy
  );

  return {
    enabled: true,
    advisoryOnly: true,
    promptGenerated: true,
    deterministicFindingIds,
    prompt: [
      "AI-assisted explanation, advisory only.",
      "Deterministic checks decide; do not change blocking status.",
      JSON.stringify(sanitized, null, 2)
    ].join("\n")
  };
}
