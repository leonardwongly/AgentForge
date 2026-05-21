import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import {
  type ChangedFile,
  type PolicyResult,
  type PullRequestInput,
  type PullRequestReview,
  type RedisCacheManager,
  getMembershipCacheKey,
  getFileContentCacheKey
} from "@agentforge/core";
import { redactSecrets } from "@agentforge/security";

export type GithubWebhookEnvelope = {
  deliveryId: string;
  event: string;
  action?: string | undefined;
  installationId?: number | undefined;
  repository?:
    | {
        id: number;
        fullName: string;
        owner: string;
        name: string;
        defaultBranch: string;
      }
    | undefined;
  pullRequest?:
    | {
        id: number;
        number: number;
        title: string;
        authorLogin: string;
        baseBranch: string;
        headBranch: string;
        headSha: string;
        body?: string | undefined;
        state: string;
        merged: boolean;
      }
    | undefined;
  review?: PullRequestReview | undefined;
  checkRun?:
    | {
        id: number;
        name: string;
        status: string;
        conclusion?: string | undefined;
        headSha: string;
        pullRequests: Array<{ number: number; headSha?: string | undefined }>;
      }
    | undefined;
  installation?:
    | {
        id: number;
        accountLogin: string;
        accountType: string;
        repositoriesAdded: Array<{ id: number; fullName: string }>;
        repositoriesRemoved: Array<{ id: number; fullName: string }>;
      }
    | undefined;
  receivedAt: string;
};

export type CheckRunPayload = {
  name: string;
  headSha: string;
  status: "completed";
  conclusion: "success" | "neutral" | "failure";
  detailsUrl?: string | undefined;
  output: {
    title: string;
    summary: string;
    text: string;
  };
};

export const MERGE_GUARD_CHECK_NAME = "AgentForge Merge Guard";

type GithubRequest<TData> = (params: Record<string, unknown>) => Promise<{ data: TData }>;
type TeamMembershipCheck =
  | { status: "verified"; teamSlug: string; active: boolean }
  | { status: "failed"; teamSlug: string; reason: string };

export type GithubAdapterClient = {
  pulls: {
    get: GithubRequest<Record<string, unknown>>;
    listFiles: GithubRequest<Array<Record<string, unknown>>>;
    listReviews: GithubRequest<Array<Record<string, unknown>>>;
    listCommits: GithubRequest<Array<Record<string, unknown>>>;
  };
  repos?: {
    getContent: GithubRequest<Record<string, unknown> | Array<Record<string, unknown>>>;
  };
  teams?: {
    getMembershipForUserInOrg: GithubRequest<Record<string, unknown>>;
  };
  paginate?: <TData>(
    method: GithubRequest<Array<TData>>,
    params: Record<string, unknown>
  ) => Promise<TData[]>;
};

export type GithubCheckPublisherClient = {
  checks: {
    create: GithubRequest<Record<string, unknown>>;
  };
};

export function verifyGithubSignature(input: {
  secret: string;
  rawBody: string | Buffer;
  signatureHeader?: string | undefined;
}): boolean {
  const signature = input.signatureHeader;
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const actual = signature.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function normalizeGithubWebhook(input: {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}): GithubWebhookEnvelope {
  const repository = readRepository(input.payload.repository);
  const pullRequest = readPullRequest(input.payload.pull_request);
  const checkRun = readCheckRun(input.payload.check_run);
  const installation = readInstallation(
    input.payload.installation,
    input.payload.repositories_added,
    input.payload.repositories_removed,
    input.payload.repositories
  );
  return {
    deliveryId: input.deliveryId,
    event: input.event,
    action: stringValue(input.payload.action),
    installationId: installation?.id,
    repository,
    pullRequest,
    review: readReview(input.payload.review),
    checkRun,
    installation,
    receivedAt: input.receivedAt ?? new Date().toISOString()
  };
}

export function shouldEnqueueEvaluation(envelope: GithubWebhookEnvelope): boolean {
  if (!envelope.repository) {
    return false;
  }
  if (envelope.event === "pull_request" && envelope.pullRequest) {
    return ["opened", "synchronize", "reopened", "edited", "ready_for_review", "closed"].includes(
      envelope.action ?? ""
    );
  }
  if (envelope.event === "pull_request_review" && envelope.pullRequest) {
    return ["submitted", "edited", "dismissed"].includes(envelope.action ?? "");
  }
  if (envelope.event === "check_run" && envelope.checkRun) {
    return (
      envelope.checkRun.name !== MERGE_GUARD_CHECK_NAME &&
      envelope.checkRun.pullRequests.length > 0 &&
      ["completed", "rerequested", "requested_action"].includes(envelope.action ?? "")
    );
  }
  return false;
}

export function pullRequestInputFromFixture(pr: PullRequestInput): PullRequestInput {
  return {
    ...pr,
    labels: [...(pr.labels ?? [])],
    commits: pr.commits?.map((commit) => ({ ...commit })),
    reviews: pr.reviews?.map((review) => ({
      ...review,
      teamSlugs: review.teamSlugs ? [...review.teamSlugs] : undefined
    })),
    manualEvidence: pr.manualEvidence?.map((evidence) => ({ ...evidence })),
    changedFiles: pr.changedFiles.map((file) => ({ ...file }))
  };
}

export async function fetchPullRequestInputFromGithub(input: {
  client: GithubAdapterClient;
  owner: string;
  repo: string;
  pullNumber: number;
  includeManifestContents?: boolean | undefined;
  maxManifestBytes?: number | undefined;
  requiredReviewerTeams?: string[] | undefined;
  cache?: RedisCacheManager | undefined;
}): Promise<PullRequestInput> {
  const params = { owner: input.owner, repo: input.repo, pull_number: input.pullNumber };
  const prResponse = await input.client.pulls.get(params);
  const pr = prResponse.data;
  const files = await paginateOrRequest(input.client, input.client.pulls.listFiles, {
    ...params,
    per_page: 100
  });
  const reviews = await paginateOrRequest(input.client, input.client.pulls.listReviews, {
    ...params,
    per_page: 100
  });
  const commits = await paginateOrRequest(input.client, input.client.pulls.listCommits, {
    ...params,
    per_page: 100
  });

  const base = recordValue(pr.base);
  const head = recordValue(pr.head);
  const baseSha = stringValue(recordValue(base?.commit)?.sha) ?? stringValue(base?.sha);
  const headSha = stringValue(recordValue(head?.commit)?.sha) ?? stringValue(head?.sha) ?? "";
  const repositoryFullName =
    stringValue(recordValue(base?.repo)?.full_name) ?? `${input.owner}/${input.repo}`;
  const changedFiles = await Promise.all(
    files.map((file) =>
      githubChangedFileToInput({
        client: input.client,
        owner: input.owner,
        repo: input.repo,
        file,
        baseSha,
        headSha,
        includeManifestContents: input.includeManifestContents ?? true,
        maxManifestBytes: input.maxManifestBytes ?? 200_000,
        cache: input.cache
      })
    )
  );
  const mappedReviews = reviews.map(githubReviewToInput);
  const enrichedReviews = await enrichPullRequestReviewsWithTeamMemberships({
    client: input.client,
    org: input.owner,
    reviews: mappedReviews,
    teamSlugs: input.requiredReviewerTeams ?? [],
    cache: input.cache
  });

  return {
    repositoryFullName,
    pullRequestNumber: numberValue(pr.number) ?? input.pullNumber,
    title: stringValue(pr.title) ?? "",
    authorLogin: stringValue(recordValue(pr.user)?.login) ?? "",
    baseBranch: stringValue(base?.ref) ?? "",
    headBranch: stringValue(head?.ref) ?? "",
    headSha,
    body: stringValue(pr.body),
    labels: labelsFromGithub(pr.labels),
    commits: commits.map((commit) => ({
      sha: stringValue(commit.sha) ?? "",
      message: stringValue(recordValue(commit.commit)?.message) ?? "",
      authorLogin: stringValue(recordValue(commit.author)?.login)
    })),
    reviews: enrichedReviews,
    changedFiles
  };
}

export async function enrichPullRequestReviewsWithTeamMemberships(input: {
  client: GithubAdapterClient;
  org: string;
  reviews: PullRequestReview[];
  teamSlugs: string[];
  cache?: RedisCacheManager | undefined;
}): Promise<PullRequestReview[]> {
  const requiredTeamSlugs = uniqueNormalizedTeamSlugs(input.teamSlugs);
  if (requiredTeamSlugs.length === 0) {
    return input.reviews.map(normalizeReviewTeamSlugs);
  }
  if (!input.client.teams?.getMembershipForUserInOrg) {
    return input.reviews.map((review) =>
      annotateUnverifiedApprovedUserReview(
        normalizeReviewTeamSlugs(review),
        requiredTeamSlugs,
        "GitHub Members: read permission is required to verify team reviewer membership."
      )
    );
  }

  const membershipChecks = new Map<string, Promise<TeamMembershipCheck>>();
  const cachedMembershipCheck = (teamSlug: string, username: string) => {
    const key = `${username.toLowerCase()}:${teamSlug}`;
    let check = membershipChecks.get(key);
    if (!check) {
      check = checkActiveTeamMember({
        client: input.client,
        org: input.org,
        teamSlug,
        username,
        cache: input.cache
      });
      membershipChecks.set(key, check);
    }
    return check;
  };

  return Promise.all(
    input.reviews.map(async (review) => {
      const existing = uniqueNormalizedTeamSlugs(review.teamSlugs ?? []);
      if (
        review.state !== "APPROVED" ||
        !review.reviewer ||
        (review.reviewerType ?? "user") !== "user"
      ) {
        return applyReviewTeamSlugs(review, existing);
      }

      const memberships = await Promise.all(
        requiredTeamSlugs.map(
          async (teamSlug) => await cachedMembershipCheck(teamSlug, review.reviewer)
        )
      );
      const failedMemberships = memberships.filter((membership) => membership.status === "failed");
      const verifiedTeamSlugs = memberships
        .filter((membership) => membership.status === "verified" && membership.active)
        .map((membership) => membership.teamSlug);
      if (failedMemberships.length > 0) {
        return applyReviewTeamVerification(
          applyReviewTeamSlugs(review, [...existing, ...verifiedTeamSlugs]),
          "failed",
          `GitHub team membership verification failed for ${failedMemberships
            .map((membership) => membership.teamSlug)
            .join(", ")}.`,
          requiredTeamSlugs
        );
      }

      return applyReviewTeamSlugs(review, [...existing, ...verifiedTeamSlugs]);
    })
  );
}

export function githubConclusionForPolicyResult(
  result: Pick<PolicyResult, "mode" | "status">
): CheckRunPayload["conclusion"] {
  if (result.mode === "observe") {
    return "success";
  }
  if (result.mode === "warn") {
    return "neutral";
  }
  return result.status === "block" ? "failure" : "success";
}

export function formatMergeGuardCheck(result: PolicyResult): CheckRunPayload["output"] {
  const title = `AgentForge Merge Guard: ${capitalize(result.status === "block" ? "blocked" : result.status)}`;
  const findings = result.findings
    .filter((finding) => finding.type !== "agent_signal_detected")
    .map((finding) => `- ${finding.evidence}`)
    .join("\n");
  const agentSignals = result.findings
    .filter((finding) => finding.type === "agent_signal_detected")
    .map((finding) => `- ${finding.evidence}`)
    .join("\n");
  const evidence = result.requiredEvidence
    .map((item) => `- ${humanize(item.kind)}: ${item.status}`)
    .join("\n");
  const reviewers = result.requiredReviewers
    .map((item) => `- ${item.reviewer}: ${item.approved ? "approved" : "pending"} (${item.tier})`)
    .join("\n");
  const missingEvidence = result.requiredEvidence.filter((item) => item.status !== "approved");
  const pendingRequiredReviewers = result.requiredReviewers.filter(
    (item) => item.tier === "required" && !item.approved
  );
  const openRequirements = missingEvidence.length + pendingRequiredReviewers.length;
  const summary =
    result.mode === "observe"
      ? openRequirements > 0
        ? `${openRequirements} requirement(s) remain open; observe mode records them without blocking merge.`
        : "Findings recorded; observe mode does not block merge."
      : result.mode === "warn"
        ? "Non-blocking warning; this shows what would block in enforce mode."
        : result.mode === "optimize"
          ? result.status === "block"
            ? "Optimize mode keeps enforce controls active; this check blocks because required policy evidence or approvals are missing."
            : "Optimize mode keeps enforce controls active while surfacing improvement opportunities."
          : result.status === "block"
            ? "This check blocks merge because required policy evidence or approvals are missing."
            : "Configured policy requirements are satisfied.";

  return {
    title,
    summary: redactSecrets(summary),
    text: redactSecrets(
      [
        `Mode: ${capitalize(result.mode)}`,
        `Policy version: ${result.policyVersion}`,
        result.policyPackVersion ? `Policy pack version: ${result.policyPackVersion}` : "",
        "",
        "Policy findings:",
        findings || "- None",
        agentSignals ? "\nAgent-assistance signals:\n" + agentSignals : "",
        "",
        "Required evidence:",
        evidence || "- None",
        "",
        "Required reviewers:",
        reviewers || "- None",
        "",
        summary
      ]
        .filter(Boolean)
        .join("\n")
    )
  };
}

export function buildCheckRunPayload(
  pr: Pick<PullRequestInput, "headSha">,
  result: PolicyResult,
  options: { detailsUrl?: string | undefined } = {}
): CheckRunPayload {
  return {
    name: MERGE_GUARD_CHECK_NAME,
    headSha: pr.headSha,
    status: "completed",
    conclusion: githubConclusionForPolicyResult(result),
    detailsUrl: options.detailsUrl,
    output: formatMergeGuardCheck(result)
  };
}

export function createGithubClient(
  token: string
): GithubAdapterClient & GithubCheckPublisherClient {
  return new Octokit({ auth: token }) as unknown as GithubAdapterClient &
    GithubCheckPublisherClient;
}

export async function createGithubInstallationToken(input: {
  appId: string | number;
  privateKey: string;
  installationId: string | number;
}): Promise<string> {
  const auth = createAppAuth({
    appId: input.appId,
    privateKey: normalizePrivateKey(input.privateKey),
    installationId: input.installationId
  });
  const installationAuth = await auth({
    type: "installation",
    installationId: input.installationId
  });
  return installationAuth.token;
}

export async function publishMergeGuardCheck(input: {
  token: string;
  owner: string;
  repo: string;
  pr: Pick<PullRequestInput, "headSha">;
  result: PolicyResult;
  detailsUrl?: string | undefined;
}): Promise<{ id: number | undefined; conclusion: CheckRunPayload["conclusion"] }> {
  return publishMergeGuardCheckWithClient({
    client: createGithubClient(input.token),
    owner: input.owner,
    repo: input.repo,
    pr: input.pr,
    result: input.result,
    detailsUrl: input.detailsUrl
  });
}

export async function publishMergeGuardCheckWithClient(input: {
  client: GithubCheckPublisherClient;
  owner: string;
  repo: string;
  pr: Pick<PullRequestInput, "headSha">;
  result: PolicyResult;
  detailsUrl?: string | undefined;
}): Promise<{ id: number | undefined; conclusion: CheckRunPayload["conclusion"] }> {
  const payload = buildCheckRunPayload(input.pr, input.result, { detailsUrl: input.detailsUrl });
  const response = await input.client.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: payload.name,
    head_sha: payload.headSha,
    status: payload.status,
    conclusion: payload.conclusion,
    details_url: payload.detailsUrl,
    output: payload.output
  });
  return { id: numberValue(response.data.id), conclusion: payload.conclusion };
}

function readRepository(value: unknown): GithubWebhookEnvelope["repository"] {
  const repo = value as Record<string, unknown> | undefined;
  if (!repo) {
    return undefined;
  }
  const fullName = stringValue(repo.full_name) ?? "";
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id: numberValue(repo.id) ?? 0,
    fullName,
    owner,
    name,
    defaultBranch: stringValue(repo.default_branch) ?? "main"
  };
}

function readPullRequest(value: unknown): GithubWebhookEnvelope["pullRequest"] {
  const pr = value as Record<string, unknown> | undefined;
  if (!pr) {
    return undefined;
  }
  const base = pr.base as Record<string, unknown> | undefined;
  const head = pr.head as Record<string, unknown> | undefined;
  const user = pr.user as Record<string, unknown> | undefined;
  return {
    id: numberValue(pr.id) ?? 0,
    number: numberValue(pr.number) ?? 0,
    title: stringValue(pr.title) ?? "",
    authorLogin: stringValue(user?.login) ?? "",
    baseBranch: stringValue(base?.ref) ?? "",
    headBranch: stringValue(head?.ref) ?? "",
    headSha: stringValue(head?.sha) ?? "",
    body: stringValue(pr.body),
    state: stringValue(pr.state) ?? "open",
    merged: Boolean(pr.merged)
  };
}

function readReview(value: unknown): PullRequestReview | undefined {
  const review = value as Record<string, unknown> | undefined;
  if (!review) {
    return undefined;
  }
  return {
    reviewer: stringValue((review.user as Record<string, unknown> | undefined)?.login) ?? "",
    reviewerType: "user",
    state: pullRequestReviewState(stringValue(review.state)),
    submittedAt: stringValue(review.submitted_at) ?? new Date().toISOString()
  };
}

function githubReviewToInput(review: Record<string, unknown>): PullRequestReview {
  return {
    reviewer: stringValue(recordValue(review.user)?.login) ?? "",
    reviewerType: "user",
    state: pullRequestReviewState(stringValue(review.state)),
    submittedAt: stringValue(review.submitted_at) ?? new Date().toISOString()
  };
}

function readCheckRun(value: unknown): GithubWebhookEnvelope["checkRun"] {
  const checkRun = value as Record<string, unknown> | undefined;
  if (!checkRun) {
    return undefined;
  }
  return {
    id: numberValue(checkRun.id) ?? 0,
    name: stringValue(checkRun.name) ?? "",
    status: stringValue(checkRun.status) ?? "",
    conclusion: stringValue(checkRun.conclusion),
    headSha: stringValue(checkRun.head_sha) ?? "",
    pullRequests: arrayValue(checkRun.pull_requests).map((item) => ({
      number: numberValue(item.number) ?? 0,
      headSha: stringValue(item.head_sha)
    }))
  };
}

function readInstallation(
  value: unknown,
  repositoriesAdded: unknown,
  repositoriesRemoved: unknown,
  repositories: unknown
): GithubWebhookEnvelope["installation"] {
  const installation = value as Record<string, unknown> | undefined;
  if (!installation) {
    return undefined;
  }
  const account = installation.account as Record<string, unknown> | undefined;
  return {
    id: numberValue(installation.id) ?? 0,
    accountLogin: stringValue(account?.login) ?? "",
    accountType: stringValue(account?.type) ?? "",
    repositoriesAdded: reposFromPayload(repositoriesAdded ?? repositories),
    repositoriesRemoved: reposFromPayload(repositoriesRemoved)
  };
}

function reposFromPayload(value: unknown): Array<{ id: number; fullName: string }> {
  return arrayValue(value).map((repo) => ({
    id: numberValue(repo.id) ?? 0,
    fullName: stringValue(repo.full_name) ?? stringValue(repo.name) ?? ""
  }));
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function pullRequestReviewState(value: string | undefined): PullRequestReview["state"] {
  const normalized = value?.toUpperCase();
  if (normalized === "APPROVED" || normalized === "CHANGES_REQUESTED") {
    return normalized;
  }
  return "COMMENTED";
}

async function checkActiveTeamMember(input: {
  client: GithubAdapterClient;
  org: string;
  teamSlug: string;
  username: string;
  cache?: RedisCacheManager | undefined;
}): Promise<TeamMembershipCheck> {
  const cacheKey = getMembershipCacheKey(input.org, input.teamSlug, input.username);
  if (input.cache) {
    try {
      const cached = await input.cache.get(cacheKey);
      if (cached === "active") {
        return {
          status: "verified",
          teamSlug: input.teamSlug,
          active: true
        };
      } else if (cached === "inactive") {
        return {
          status: "verified",
          teamSlug: input.teamSlug,
          active: false
        };
      }
    } catch (err) {
      console.warn("Error reading membership cache:", err);
    }
  }

  try {
    const response = await input.client.teams?.getMembershipForUserInOrg({
      org: input.org,
      team_slug: input.teamSlug,
      username: input.username
    });
    const active = stringValue(response?.data.state)?.toLowerCase() === "active";
    if (input.cache) {
      await input.cache.set(cacheKey, active ? "active" : "inactive", 3600); // 1 hour TTL
    }
    return {
      status: "verified",
      teamSlug: input.teamSlug,
      active
    };
  } catch (error) {
    if (githubErrorStatus(error) === 404) {
      if (input.cache) {
        await input.cache.set(cacheKey, "inactive", 3600);
      }
      return {
        status: "verified",
        teamSlug: input.teamSlug,
        active: false
      };
    }
    return {
      status: "failed",
      teamSlug: input.teamSlug,
      reason: `GitHub team membership API rejected the verification request${githubErrorMessage(error)}.`
    };
  }
}

function githubErrorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function githubErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `: ${error.message.trim()}`;
  }
  return "";
}

function normalizeReviewTeamSlugs(review: PullRequestReview): PullRequestReview {
  return applyReviewTeamSlugs(review, uniqueNormalizedTeamSlugs(review.teamSlugs ?? []));
}

function applyReviewTeamSlugs(review: PullRequestReview, teamSlugs: string[]): PullRequestReview {
  const normalizedTeamSlugs = uniqueNormalizedTeamSlugs(teamSlugs);
  if (normalizedTeamSlugs.length === 0) {
    return { ...review, teamSlugs: undefined };
  }
  return { ...review, teamSlugs: normalizedTeamSlugs };
}

function annotateUnverifiedApprovedUserReview(
  review: PullRequestReview,
  checkedTeamSlugs: string[],
  reason: string
): PullRequestReview {
  if (
    review.state !== "APPROVED" ||
    !review.reviewer ||
    (review.reviewerType ?? "user") !== "user"
  ) {
    return review;
  }
  return applyReviewTeamVerification(review, "unavailable", reason, checkedTeamSlugs);
}

function applyReviewTeamVerification(
  review: PullRequestReview,
  status: NonNullable<PullRequestReview["teamVerification"]>["status"],
  reason: string,
  checkedTeamSlugs: string[]
): PullRequestReview {
  return {
    ...review,
    teamVerification: {
      status,
      reason,
      checkedTeamSlugs
    }
  };
}

function uniqueNormalizedTeamSlugs(values: string[]): string[] {
  return [
    ...new Set(
      values.map(normalizeTeamSlug).filter((teamSlug): teamSlug is string => Boolean(teamSlug))
    )
  ];
}

function normalizeTeamSlug(value: string): string | undefined {
  const teamSlug = value.trim().replace(/^@/u, "").split("/").at(-1)?.toLowerCase();
  if (!teamSlug || !/^[a-z0-9][a-z0-9-]*$/u.test(teamSlug)) {
    return undefined;
  }
  return teamSlug;
}

async function paginateOrRequest<TData>(
  client: GithubAdapterClient,
  method: GithubRequest<Array<TData>>,
  params: Record<string, unknown>
): Promise<TData[]> {
  if (client.paginate) {
    return client.paginate(method, params);
  }
  return (await method(params)).data;
}

async function githubChangedFileToInput(input: {
  client: GithubAdapterClient;
  owner: string;
  repo: string;
  file: Record<string, unknown>;
  baseSha?: string | undefined;
  headSha: string;
  includeManifestContents: boolean;
  maxManifestBytes: number;
  cache?: RedisCacheManager | undefined;
}): Promise<ChangedFile> {
  const filename = stringValue(input.file.filename) ?? "";
  const status = changedFileStatus(stringValue(input.file.status));
  const changedFile: ChangedFile = {
    filename,
    status,
    additions: numberValue(input.file.additions),
    deletions: numberValue(input.file.deletions),
    changes: numberValue(input.file.changes),
    patch: stringValue(input.file.patch),
    previousFilename: stringValue(input.file.previous_filename)
  };

  if (
    input.includeManifestContents &&
    input.client.repos?.getContent &&
    isSupportedManifest(filename)
  ) {
    if (status !== "added" && input.baseSha) {
      changedFile.previousContent = await fetchTextContent({
        client: input.client,
        owner: input.owner,
        repo: input.repo,
        path: changedFile.previousFilename ?? filename,
        ref: input.baseSha,
        maxBytes: input.maxManifestBytes,
        cache: input.cache
      });
    }
    if (status !== "removed") {
      changedFile.currentContent = await fetchTextContent({
        client: input.client,
        owner: input.owner,
        repo: input.repo,
        path: filename,
        ref: input.headSha,
        maxBytes: input.maxManifestBytes,
        cache: input.cache
      });
    }
  }

  return changedFile;
}

function changedFileStatus(value: string | undefined): ChangedFile["status"] {
  if (
    value === "added" ||
    value === "modified" ||
    value === "removed" ||
    value === "renamed" ||
    value === "copied" ||
    value === "changed" ||
    value === "unchanged"
  ) {
    return value;
  }
  return "modified";
}

function labelsFromGithub(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((label) => (typeof label === "string" ? label : stringValue(recordValue(label)?.name)))
    .filter((label): label is string => Boolean(label));
}

function isSupportedManifest(filename: string): boolean {
  return [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock"
  ].some((suffix) => filename.endsWith(suffix));
}

async function fetchTextContent(input: {
  client: GithubAdapterClient;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  maxBytes: number;
  cache?: RedisCacheManager | undefined;
}): Promise<string | undefined> {
  const isImmutableSha = /^[a-fA-F0-9]{40}$/.test(input.ref);
  const cacheKey = getFileContentCacheKey(input.owner, input.repo, input.ref, input.path);

  if (isImmutableSha && input.cache) {
    try {
      const cached = await input.cache.get(cacheKey);
      if (cached !== null) {
        return cached;
      }
    } catch (err) {
      console.warn("Error reading file content cache:", err);
    }
  }

  let response: { data: Record<string, unknown> | Array<Record<string, unknown>> } | undefined;
  try {
    response = await input.client.repos?.getContent({
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      ref: input.ref
    });
  } catch {
    return undefined;
  }
  const data = response?.data;
  if (!data || Array.isArray(data)) {
    return undefined;
  }
  const content = stringValue(data.content);
  if (stringValue(data.encoding) !== "base64" || !content) {
    return undefined;
  }
  const decoded = Buffer.from(content, "base64");
  const bounded = decoded.length > input.maxBytes ? decoded.subarray(0, input.maxBytes) : decoded;
  const text = bounded.toString("utf8");

  if (isImmutableSha && input.cache) {
    try {
      await input.cache.set(cacheKey, redactSecrets(text), 7 * 24 * 3600); // 7 days TTL for immutable commits
    } catch (err) {
      console.warn("Error writing file content cache:", err);
    }
  }

  return text;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}
