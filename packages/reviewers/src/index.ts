import type {
  PolicyHit,
  PullRequestInput,
  PullRequestReview,
  ReviewerRequirement
} from "@agentforge/core";

export type ReviewerRoutingOptions = {
  maxRequiredReviewersWithoutCritical?: number;
};

const defaultOptions: Required<ReviewerRoutingOptions> = {
  maxRequiredReviewersWithoutCritical: 4
};

export function routeReviewers(
  policyHits: PolicyHit[],
  pr: Pick<PullRequestInput, "reviews">,
  options: ReviewerRoutingOptions = {}
): ReviewerRequirement[] {
  const merged = { ...defaultOptions, ...options };
  const requirements = new Map<string, ReviewerRequirement>();

  for (const hit of policyHits) {
    for (const reviewer of hit.requiredReviewers) {
      const reviewerType =
        reviewer.includes("/") || reviewer.includes("-team") || reviewer.includes("-owner")
          ? "team"
          : "user";
      const tier = hit.reviewerTier ?? (hit.action === "suggest" ? "suggested" : "required");
      const key = `${reviewerType}:${reviewer}`;
      const current = requirements.get(key);
      const candidate: ReviewerRequirement = {
        id: `reviewer:${hit.finding.id}:${reviewer}`,
        reviewer,
        reviewerType,
        tier,
        reason: hit.explanation,
        triggeredByFindingId: hit.finding.id,
        approved: hasApproval(pr.reviews ?? [], reviewer, reviewerType)
      };
      if (tier === "conditional") {
        candidate.clearsWhen = "path_removed";
      }

      if (!current || reviewerTierRank(candidate.tier) > reviewerTierRank(current.tier)) {
        const approval = latestApproval(pr.reviews ?? [], reviewer, reviewerType);
        if (approval) {
          candidate.approvedBy = approval.reviewer;
          candidate.approvedAt = approval.submittedAt;
        }
        requirements.set(key, candidate);
      }
    }
  }

  const all = [...requirements.values()];
  if (all.some((requirement) => requirement.tier !== "required")) {
    return all;
  }

  const hasCritical = policyHits.some((hit) => hit.severity === "critical");
  if (hasCritical || all.length <= merged.maxRequiredReviewersWithoutCritical) {
    return all;
  }

  const [required, ...rest] = all;
  if (!required) {
    return all;
  }
  return [
    required,
    ...rest.map((requirement) => ({
      ...requirement,
      tier: "conditional" as const,
      clearsWhen: "manual_clear" as const,
      reason: `${requirement.reason} Conditional because required reviewer groups were capped.`
    }))
  ];
}

export function clearConditionalReviewers(
  requirements: ReviewerRequirement[],
  activeFindingIds: Set<string>
): ReviewerRequirement[] {
  return requirements.filter(
    (requirement) =>
      requirement.tier !== "conditional" || activeFindingIds.has(requirement.triggeredByFindingId)
  );
}

function hasApproval(
  reviews: PullRequestReview[],
  reviewer: string,
  reviewerType: ReviewerRequirement["reviewerType"]
): boolean {
  return latestApproval(reviews, reviewer, reviewerType) !== undefined;
}

function latestApproval(
  reviews: PullRequestReview[],
  reviewer: string,
  reviewerType: ReviewerRequirement["reviewerType"]
): PullRequestReview | undefined {
  return [...reviews]
    .filter(
      (review) =>
        review.state === "APPROVED" &&
        review.reviewer.toLowerCase() === reviewer.toLowerCase() &&
        (review.reviewerType ?? reviewerType) === reviewerType
    )
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
}

function reviewerTierRank(tier: ReviewerRequirement["tier"]): number {
  if (tier === "required") {
    return 3;
  }
  if (tier === "conditional") {
    return 2;
  }
  return 1;
}
