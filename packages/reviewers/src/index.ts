import type {
  PolicyHit,
  PullRequestInput,
  PullRequestReview,
  ReviewerRequirement
} from "@agentforge/core";

export type ReviewerRoutingOptions = {
  maxRequiredReviewersWithoutCritical?: number;
};

export type CodeownersRule = {
  lineNumber: number;
  pattern: string;
  owners: string[];
  negated: boolean;
  valid: boolean;
  reason?: string | undefined;
};

export type CodeownersOwnerSuggestion = {
  ownerKey: string;
  reviewer: string;
  reviewerType: ReviewerRequirement["reviewerType"];
  pattern: string;
  matchedPaths: string[];
};

export type CodeownersPreview = {
  rules: CodeownersRule[];
  suggestions: CodeownersOwnerSuggestion[];
  diagnostics: string[];
};

const MAX_CODEOWNERS_PATTERN_LENGTH = 200;
const MAX_CODEOWNERS_GLOBSTARS = 3;
const neverMatchPattern = /a^/u;

const defaultOptions: Required<ReviewerRoutingOptions> = {
  maxRequiredReviewersWithoutCritical: Number.POSITIVE_INFINITY
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
      const approval = latestApproval(pr.reviews ?? [], reviewer, reviewerType);
      const approved = approval !== undefined;
      const candidate: ReviewerRequirement = {
        id: `reviewer:${hit.finding.id}:${reviewer}`,
        reviewer,
        reviewerType,
        tier,
        reason: reviewerReason(hit, reviewer, reviewerType, approved, pr.reviews ?? []),
        triggeredByFindingId: hit.finding.id,
        approved
      };
      if (tier === "conditional") {
        candidate.clearsWhen = "path_removed";
      }

      if (!current || reviewerTierRank(candidate.tier) > reviewerTierRank(current.tier)) {
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

export function previewCodeowners(content: string, changedPaths: string[] = []): CodeownersPreview {
  const rules = parseCodeowners(content);
  return {
    rules,
    suggestions: suggestOwnerMappingsFromCodeowners(rules, changedPaths),
    diagnostics: rules
      .filter((rule) => !rule.valid)
      .map((rule) => `CODEOWNERS line ${rule.lineNumber}: ${rule.reason ?? "ignored"}`)
  };
}

export function parseCodeowners(content: string): CodeownersRule[] {
  return content
    .split(/\r?\n/u)
    .map((line, index): CodeownersRule | undefined => {
      const withoutComment = line.replace(/\s+#.*$/u, "").trim();
      if (!withoutComment || withoutComment.startsWith("#")) {
        return undefined;
      }
      const [rawPattern, ...owners] = withoutComment.split(/\s+/u);
      if (!rawPattern) {
        return undefined;
      }
      if (rawPattern.startsWith("!")) {
        return {
          lineNumber: index + 1,
          pattern: rawPattern,
          owners,
          negated: true,
          valid: false,
          reason: "negated CODEOWNERS patterns are not supported by GitHub and are ignored"
        };
      }
      if (owners.length === 0) {
        return {
          lineNumber: index + 1,
          pattern: rawPattern,
          owners,
          negated: false,
          valid: true
        };
      }
      const patternRejectionReason = codeownersPatternRejectionReason(rawPattern);
      if (patternRejectionReason) {
        return {
          lineNumber: index + 1,
          pattern: rawPattern,
          owners,
          negated: false,
          valid: false,
          reason: patternRejectionReason
        };
      }
      const ownerRejectionReason = codeownersOwnersRejectionReason(owners);
      if (ownerRejectionReason) {
        return {
          lineNumber: index + 1,
          pattern: rawPattern,
          owners,
          negated: false,
          valid: false,
          reason: ownerRejectionReason
        };
      }
      return {
        lineNumber: index + 1,
        pattern: rawPattern,
        owners,
        negated: false,
        valid: true
      };
    })
    .filter((rule): rule is CodeownersRule => Boolean(rule));
}

export function suggestOwnerMappingsFromCodeowners(
  rules: CodeownersRule[],
  changedPaths: string[] = []
): CodeownersOwnerSuggestion[] {
  const sourcePaths = changedPaths.map(normalizePath).filter(Boolean);
  const suggestions = new Map<string, CodeownersOwnerSuggestion>();

  if (sourcePaths.length === 0) {
    for (const rule of rules.filter((item) => item.valid)) {
      for (const owner of rule.owners) {
        addSuggestion(suggestions, owner, rule.pattern, []);
      }
    }
    return [...suggestions.values()];
  }

  const rulesByPrecedence = [...rules].reverse();
  for (const path of sourcePaths) {
    const rule = rulesByPrecedence.find((item) => item.valid && codeownersRuleMatches(item, path));
    if (!rule) {
      continue;
    }
    for (const owner of rule.owners) {
      addSuggestion(suggestions, owner, rule.pattern, [path]);
    }
  }

  return [...suggestions.values()];
}

export function codeownersRuleMatches(
  rule: Pick<CodeownersRule, "pattern" | "valid">,
  path: string
) {
  if (!rule.valid) {
    return false;
  }
  return codeownersPatternToRegExp(rule.pattern).test(normalizePath(path));
}

function reviewerReason(
  hit: PolicyHit,
  reviewer: string,
  reviewerType: ReviewerRequirement["reviewerType"],
  approved: boolean,
  reviews: PullRequestReview[]
): string {
  const routeDetail = `Reviewer route: ${reviewer} (${reviewerType}) from ${hit.ruleId}.`;
  if (reviewerType !== "team" || approved) {
    return `${hit.explanation} ${routeDetail}`;
  }
  const diagnostics = teamVerificationDiagnostics(reviews, reviewer);
  return diagnostics.length > 0
    ? `${hit.explanation} ${routeDetail} ${diagnostics.join(" ")}`
    : `${hit.explanation} ${routeDetail}`;
}

function teamVerificationDiagnostics(reviews: PullRequestReview[], reviewer: string): string[] {
  const requiredTeam = normalizeTeamSlug(reviewer);
  if (!requiredTeam) {
    return [];
  }
  return reviews
    .filter(
      (review) =>
        review.state === "APPROVED" &&
        (review.reviewerType ?? "user") === "user" &&
        !reviewMatchesTeam(review, reviewer) &&
        review.teamVerification &&
        review.teamVerification.checkedTeamSlugs.includes(requiredTeam)
    )
    .map(
      (review) =>
        `Team verification ${review.teamVerification?.status}: ${review.teamVerification?.reason} Approval by ${review.reviewer} remains pending for ${requiredTeam}.`
    );
}

function addSuggestion(
  suggestions: Map<string, CodeownersOwnerSuggestion>,
  owner: string,
  pattern: string,
  matchedPaths: string[]
): void {
  const normalizedOwner = normalizeCodeownersOwner(owner);
  if (!normalizedOwner) {
    return;
  }
  const key = `${normalizedOwner.reviewerType}:${normalizedOwner.reviewer}`;
  const existing =
    suggestions.get(key) ??
    ({
      ownerKey: ownerKeyFromReviewer(normalizedOwner.reviewer),
      reviewer: normalizedOwner.reviewer,
      reviewerType: normalizedOwner.reviewerType,
      pattern,
      matchedPaths: []
    } satisfies CodeownersOwnerSuggestion);
  for (const matchedPath of matchedPaths) {
    if (!existing.matchedPaths.includes(matchedPath)) {
      existing.matchedPaths.push(matchedPath);
    }
  }
  suggestions.set(key, existing);
}

function normalizeCodeownersOwner(
  owner: string
): Pick<CodeownersOwnerSuggestion, "reviewer" | "reviewerType"> | undefined {
  const trimmed = owner.trim();
  if (!trimmed.startsWith("@")) {
    return undefined;
  }
  const normalized = trimmed.slice(1);
  if (!normalized || normalized.includes("@")) {
    return undefined;
  }
  if (normalized.includes("/")) {
    const parts = normalized.split("/");
    if (parts.length !== 2) {
      return undefined;
    }
    const [org, team] = parts;
    if (!githubSlug(org) || !teamSlug(team)) {
      return undefined;
    }
    return { reviewer: `${org.toLowerCase()}/${team.toLowerCase()}`, reviewerType: "team" };
  }
  if (!githubLogin(normalized)) {
    return undefined;
  }
  return { reviewer: normalized.toLowerCase(), reviewerType: "user" };
}

function ownerKeyFromReviewer(reviewer: string): string {
  return (
    reviewer
      .split("/")
      .at(-1)
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "") ?? "owner"
  );
}

function codeownersPatternToRegExp(pattern: string): RegExp {
  if (codeownersPatternRejectionReason(pattern)) {
    return neverMatchPattern;
  }
  const normalizedPattern = normalizePath(pattern).replace(/^\/+/u, "");
  const anchored = pattern.startsWith("/");
  const directoryPattern = normalizedPattern.endsWith("/");
  const withoutTrailingSlash = directoryPattern
    ? normalizedPattern.replace(/\/+$/u, "")
    : normalizedPattern;
  const body = globToRegexBody(withoutTrailingSlash || "**");
  const slashQualified = withoutTrailingSlash.includes("/");
  const prefix = anchored || (!directoryPattern && slashQualified) ? "^" : "^(?:.*/)?";
  if (directoryPattern) {
    return new RegExp(`${prefix}${body}(?:/.*)?$`, "u");
  }
  return new RegExp(`${prefix}${body}(?:/.*)?$`, "u");
}

function codeownersPatternRejectionReason(pattern: string): string | undefined {
  if (pattern.length > MAX_CODEOWNERS_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_CODEOWNERS_PATTERN_LENGTH} characters`;
  }
  if (pattern.startsWith("\\#")) {
    return "escaped leading # patterns are ignored by GitHub CODEOWNERS";
  }
  if (/\[[^\]]*\]/u.test(pattern)) {
    return "unsupported bracket patterns are ignored by GitHub CODEOWNERS";
  }
  const globstarCount = pattern.match(/\*\*/gu)?.length ?? 0;
  if (globstarCount > MAX_CODEOWNERS_GLOBSTARS || /\*{3,}/u.test(pattern)) {
    return "pattern uses too many wildcard groups for safe preview matching";
  }
  return undefined;
}

function codeownersOwnersRejectionReason(owners: string[]): string | undefined {
  const malformedOwner = owners.find(
    (owner) => !normalizeCodeownersOwner(owner) && !codeownersEmailOwner(owner)
  );
  return malformedOwner ? `malformed owner "${malformedOwner}"` : undefined;
}

function codeownersEmailOwner(owner: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner.trim());
}

const GLOBSTAR_SEGMENTS = "(?:[^/]+/)*";
const GLOBSTAR_ANY = ".*";

function globToRegexBody(glob: string): string {
  const tokens: string[] = [];
  const push = (token: string): void => {
    // Collapse consecutive identical unbounded star groups. A pattern like
    // "**/**/foo" would otherwise emit adjacent "(?:[^/]+/)*(?:[^/]+/)*foo" — the
    // classic ambiguous-partition gadget that makes a non-matching path backtrack
    // super-linearly (cubic). Collapsing is exactly semantics-preserving because
    // R*R* === R* and .*.* === .* (AF-SEC ReDoS hardening; the globstar count and
    // pattern-length caps remain as defense-in-depth).
    if (
      (token === GLOBSTAR_SEGMENTS || token === GLOBSTAR_ANY) &&
      tokens[tokens.length - 1] === token
    ) {
      return;
    }
    tokens.push(token);
  };
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      if (glob[index + 2] === "/") {
        push(GLOBSTAR_SEGMENTS);
        index += 2;
      } else {
        push(GLOBSTAR_ANY);
        index += 1;
      }
    } else if (char === "*") {
      push("[^/]*");
    } else if (char === "?") {
      push("[^/]");
    } else {
      push(escapeRegex(char ?? ""));
    }
  }
  return tokens.join("");
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\.?\//u, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
}

function githubLogin(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u.test(value));
}

function githubSlug(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value));
}

function teamSlug(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value));
}

function latestApproval(
  reviews: PullRequestReview[],
  reviewer: string,
  reviewerType: ReviewerRequirement["reviewerType"]
): PullRequestReview | undefined {
  return [...reviews]
    .filter(
      (review) =>
        review.state === "APPROVED" && reviewMatchesReviewer(review, reviewer, reviewerType)
    )
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
}

function reviewMatchesReviewer(
  review: PullRequestReview,
  reviewer: string,
  reviewerType: ReviewerRequirement["reviewerType"]
): boolean {
  if (reviewerType === "team") {
    return reviewMatchesTeam(review, reviewer);
  }
  return (
    (review.reviewerType ?? "user") === "user" &&
    review.reviewer.toLowerCase() === reviewer.toLowerCase()
  );
}

function reviewMatchesTeam(review: PullRequestReview, reviewer: string): boolean {
  const requiredTeam = normalizeTeamSlug(reviewer);
  if (!requiredTeam) {
    return false;
  }
  if (
    (review.reviewerType ?? "user") === "team" &&
    normalizeTeamSlug(review.reviewer) === requiredTeam
  ) {
    return true;
  }
  return (review.teamSlugs ?? []).some((teamSlug) => normalizeTeamSlug(teamSlug) === requiredTeam);
}

function normalizeTeamSlug(value: string): string {
  return value.trim().replace(/^@/u, "").split("/").at(-1)?.toLowerCase() ?? "";
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
