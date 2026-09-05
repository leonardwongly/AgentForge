import type {
  EvidenceKind,
  EvidenceRequirement,
  ManualEvidenceInput,
  PolicyHit,
  PullRequestInput
} from "@agentforge/core";
import { summarizeSafeSnippet } from "@agentforge/security";

const evidenceHeadings: Record<EvidenceKind, string[]> = {
  rollback_plan: ["rollback plan", "rollback"],
  migration_dry_run: ["migration dry run", "dry run"],
  dependency_justification: ["dependency justification", "dependency rationale"],
  deleted_test_explanation: [
    "deleted test explanation",
    "test skip justification",
    "test explanation"
  ],
  benchmark_before_after: [
    "benchmark before after",
    "before/after benchmark",
    "performance benchmark"
  ],
  security_note: ["security note", "security review note"],
  ci_change_reason: ["ci change reason", "workflow change reason", "deployment change reason"],
  manual_attestation: ["manual attestation", "attestation"]
};

export function deriveEvidenceRequirements(
  policyHits: PolicyHit[],
  pr: Pick<PullRequestInput, "body" | "manualEvidence" | "authorLogin">
): EvidenceRequirement[] {
  const requirements = new Map<string, EvidenceRequirement>();

  for (const hit of policyHits) {
    for (const kind of hit.requiredEvidence) {
      const key = `${hit.finding.id}:${kind}`;
      if (!requirements.has(key)) {
        requirements.set(key, buildRequirement(kind, hit, pr));
      }
    }
  }

  return [...requirements.values()];
}

export function findEvidenceInPrBody(
  kind: EvidenceKind,
  body = ""
):
  | {
      contentSummary: string;
    }
  | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  const headings = evidenceHeadings[kind];
  if (!headings) {
    return undefined;
  }
  for (const heading of headings) {
    const pattern = new RegExp(
      `(?:^|\\n)\\s*${escapeRegExp(heading)}\\s*:\\s*(?<content>[^\\n][\\s\\S]*?)(?=\\n\\s*[A-Za-z][A-Za-z /-]{2,40}\\s*:|$)`,
      "i"
    );
    const match = pattern.exec(body);
    const content = match?.groups?.content?.trim();
    if (content) {
      return { contentSummary: summarizeSafeSnippet(content) };
    }
  }
  return undefined;
}

export function addManualEvidence(
  current: EvidenceRequirement[],
  manualEvidence: ManualEvidenceInput[]
): EvidenceRequirement[] {
  if (!Array.isArray(manualEvidence)) {
    return current;
  }
  return current.map((requirement) => {
    // Select the first usable item, not merely the first matching kind. A
    // blank duplicate from a malformed/replayed request must not suppress a
    // later valid attestation for the same requirement.
    const provided = manualEvidence.find(
      (item) =>
        item?.kind === requirement.kind &&
        typeof item.content === "string" &&
        item.content.trim().length > 0
    );
    if (!provided) {
      return requirement;
    }

    const providedAt = provided.providedAt ?? new Date().toISOString();
    const approvedAt = provided.approvedAt ?? (provided.approved ? providedAt : undefined);
    const approvedBy = provided.approvedBy ?? (provided.approved ? provided.actor : undefined);
    const next: EvidenceRequirement = {
      ...requirement,
      status: provided.approved ? "approved" : "provided",
      source: provided.linkedArtifact ? "linked_artifact" : "manual_attestation",
      providedBy: provided.actor,
      providedAt,
      contentSummary: summarizeSafeSnippet(provided.content)
    };
    if (approvedBy) {
      next.approvedBy = approvedBy;
    }
    if (approvedAt) {
      next.approvedAt = approvedAt;
    }
    return next;
  });
}

function buildRequirement(
  kind: EvidenceKind,
  hit: PolicyHit,
  pr: Pick<PullRequestInput, "body" | "manualEvidence" | "authorLogin">
): EvidenceRequirement {
  const fromBody = findEvidenceInPrBody(kind, pr.body);
  const fromManual = pr.manualEvidence?.find(
    (item) =>
      item?.kind === kind && typeof item.content === "string" && item.content.trim().length > 0
  );
  const id = `evidence:${hit.finding.id}:${kind}`;

  if (fromManual) {
    const providedAt = fromManual.providedAt ?? new Date().toISOString();
    const requirement: EvidenceRequirement = {
      id,
      kind,
      status: fromManual.approved ? "approved" : "provided",
      source: fromManual.linkedArtifact ? "linked_artifact" : "manual_attestation",
      requiredByFindingId: hit.finding.id,
      providedBy: fromManual.actor,
      providedAt,
      contentSummary: summarizeSafeSnippet(fromManual.content)
    };
    if (fromManual.approved) {
      requirement.approvedBy = fromManual.approvedBy ?? fromManual.actor;
      requirement.approvedAt = fromManual.approvedAt ?? providedAt;
    }
    return requirement;
  }

  if (fromBody) {
    return {
      id,
      kind,
      status: "provided",
      source: "pr_body",
      requiredByFindingId: hit.finding.id,
      providedBy: pr.authorLogin,
      providedAt: new Date().toISOString(),
      contentSummary: fromBody.contentSummary
    };
  }

  return {
    id,
    kind,
    status: "missing",
    requiredByFindingId: hit.finding.id
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}
