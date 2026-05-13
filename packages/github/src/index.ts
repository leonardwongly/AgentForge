import { createHmac, timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type {
  ChangedFile,
  PolicyResult,
  PullRequestInput,
  PullRequestReview
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
  output: {
    title: string;
    summary: string;
    text: string;
  };
};

type GithubRequest<TData> = (params: Record<string, unknown>) => Promise<{ data: TData }>;

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
  paginate?: <TData>(
    method: GithubRequest<Array<TData>>,
    params: Record<string, unknown>
  ) => Promise<TData[]>;
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
    reviews: pr.reviews?.map((review) => ({ ...review })),
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
    stringValue(recordValue(head?.repo)?.full_name) ?? `${input.owner}/${input.repo}`;
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
        maxManifestBytes: input.maxManifestBytes ?? 200_000
      })
    )
  );

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
    reviews: reviews.map((review) => ({
      reviewer: stringValue(recordValue(review.user)?.login) ?? "",
      reviewerType: "user",
      state: pullRequestReviewState(stringValue(review.state)),
      submittedAt: stringValue(review.submitted_at) ?? new Date().toISOString()
    })),
    changedFiles
  };
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
  const summary =
    result.mode === "observe"
      ? "Findings recorded; observe mode does not block merge."
      : result.mode === "warn"
        ? "Non-blocking warning; this shows what would block in enforce mode."
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
  result: PolicyResult
): CheckRunPayload {
  return {
    name: "AgentForge Merge Guard",
    headSha: pr.headSha,
    status: "completed",
    conclusion: githubConclusionForPolicyResult(result),
    output: formatMergeGuardCheck(result)
  };
}

export async function publishMergeGuardCheck(input: {
  token: string;
  owner: string;
  repo: string;
  pr: Pick<PullRequestInput, "headSha">;
  result: PolicyResult;
}): Promise<{ id: number | undefined; conclusion: CheckRunPayload["conclusion"] }> {
  const octokit = new Octokit({ auth: input.token });
  const payload = buildCheckRunPayload(input.pr, input.result);
  const response = await octokit.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: payload.name,
    head_sha: payload.headSha,
    status: payload.status,
    conclusion: payload.conclusion,
    output: payload.output
  });
  return { id: response.data.id, conclusion: payload.conclusion };
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
        maxBytes: input.maxManifestBytes
      });
    }
    if (status !== "removed") {
      changedFile.currentContent = await fetchTextContent({
        client: input.client,
        owner: input.owner,
        repo: input.repo,
        path: filename,
        ref: input.headSha,
        maxBytes: input.maxManifestBytes
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
}): Promise<string | undefined> {
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
  return bounded.toString("utf8");
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
