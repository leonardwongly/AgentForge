import { createHmac, timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
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
  return {
    deliveryId: input.deliveryId,
    event: input.event,
    action: stringValue(input.payload.action),
    installationId: numberValue(
      (input.payload.installation as Record<string, unknown> | undefined)?.id
    ),
    repository,
    pullRequest,
    receivedAt: input.receivedAt ?? new Date().toISOString()
  };
}

export function shouldEnqueueEvaluation(envelope: GithubWebhookEnvelope): boolean {
  if (!envelope.pullRequest || !envelope.repository) {
    return false;
  }
  if (envelope.event === "pull_request") {
    return ["opened", "synchronize", "reopened", "edited", "ready_for_review", "closed"].includes(
      envelope.action ?? ""
    );
  }
  if (envelope.event === "pull_request_review") {
    return ["submitted", "edited", "dismissed"].includes(envelope.action ?? "");
  }
  return false;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
