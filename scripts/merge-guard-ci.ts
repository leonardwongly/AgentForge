/**
 * AgentForge Merge Guard - CI entrypoint.
 *
 * Runs AgentForge's own deterministic engine (detectors + policy) against a
 * pull request and reports the result as the "AgentForge Merge Guard" check.
 * This is AgentForge governing its own repository directly in CI.
 *
 * Inputs:
 *   - A GitHub Actions `pull_request` event (GITHUB_EVENT_PATH) for PR metadata,
 *     or `--base <ref> --head <ref>` for local runs.
 *   - The live git diff for changed files + patches.
 *   - Optional PR reviews via the REST API (GITHUB_TOKEN) so reviewer
 *     requirements reflect real approvals.
 *
 * Output: a Markdown summary appended to $GITHUB_STEP_SUMMARY (when set) and
 * printed to stdout. Exit code is 1 only when the policy decision is `block`
 * (i.e. enforce mode with unresolved requirements); `warn`/`pass` exit 0.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import type {
  ChangedFile,
  PullRequestInput,
  PullRequestReview
} from "../packages/core/src/index.ts";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "../packages/detectors/src/index.ts";
import {
  evaluateMergeGuard,
  getPolicyPack,
  parsePolicyYaml
} from "../packages/policy/src/index.ts";
import { createChangeControlRecord } from "../packages/records/src/index.ts";
import type { MetadataStoragePolicy } from "../packages/security/src/index.ts";

const COMMENT_MARKER = "<!-- agentforge-merge-guard -->";

interface GhReview {
  user?: { login?: string };
  state?: string;
  submitted_at?: string;
}

interface GhPull {
  number?: number;
  title?: string;
  body?: string | null;
  user?: { login?: string };
  base?: { ref?: string; sha?: string };
  head?: { ref?: string; sha?: string };
  labels?: Array<{ name?: string }>;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function safeGit(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: MAX_BUFFER }).trim();
  } catch {
    return undefined;
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readEvent(): GhPull | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: GhPull };
    return parsed.pull_request;
  } catch {
    return undefined;
  }
}

function mapStatus(code: string): ChangedFile["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "changed";
    default:
      return "modified";
  }
}

function patchFor(range: string, file: string): string | undefined {
  const raw = safeGit(["diff", range, "--", file]);
  if (!raw) {
    return undefined;
  }
  const hunkStart = raw.indexOf("@@");
  return hunkStart === -1 ? undefined : raw.slice(hunkStart);
}

function buildChangedFiles(range: string): ChangedFile[] {
  const out = safeGit(["diff", "--name-status", range]);
  if (!out) {
    return [];
  }
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const status = mapStatus(code);
    if ((status === "renamed" || status === "copied") && parts[2]) {
      files.push({
        filename: parts[2],
        status,
        previousFilename: parts[1],
        patch: patchFor(range, parts[2])
      });
    } else if (parts[1]) {
      files.push({
        filename: parts[1],
        status,
        patch: status === "removed" ? undefined : patchFor(range, parts[1])
      });
    }
  }
  return files;
}

function buildCommits(range: string): PullRequestInput["commits"] {
  const out = safeGit(["log", range, "--format=%H%x1f%an%x1f%s"]);
  if (!out) {
    return [];
  }
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, authorLogin, message] = line.split("\x1f");
      return { sha: sha ?? "", message: message ?? "", authorLogin: authorLogin ?? undefined };
    });
}

async function fetchReviews(repo: string, prNumber: number): Promise<PullRequestReview[]> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token || !prNumber) {
    return [];
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "agentforge-merge-guard"
        }
      }
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as GhReview[];
    return data
      .filter((review): review is GhReview & { user: { login: string } } =>
        Boolean(review.user?.login)
      )
      .map((review) => ({
        reviewer: review.user.login,
        state: (review.state ?? "commented").toLowerCase() as PullRequestReview["state"],
        submittedAt: review.submitted_at ?? new Date().toISOString()
      }));
  } catch {
    return [];
  }
}

/** Create or update a single sticky PR comment carrying the Merge Guard verdict. */
async function upsertPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token || !prNumber) {
    return;
  }
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "agentforge-merge-guard",
    "content-type": "application/json"
  };
  const base = `https://api.github.com/repos/${repo}`;
  const payload = JSON.stringify({ body: `${COMMENT_MARKER}\n${body}` });
  try {
    const listRes = await fetch(`${base}/issues/${prNumber}/comments?per_page=100`, { headers });
    if (listRes.ok) {
      const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
      const existing = comments.find((comment) => (comment.body ?? "").includes(COMMENT_MARKER));
      if (existing) {
        await fetch(`${base}/issues/comments/${existing.id}`, {
          method: "PATCH",
          headers,
          body: payload
        });
        return;
      }
    }
    await fetch(`${base}/issues/${prNumber}/comments`, { method: "POST", headers, body: payload });
  } catch (error) {
    console.error("AgentForge Merge Guard: failed to post PR comment:", error);
  }
}

function normalizeRepo(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) {
    return fromEnv;
  }
  const remote = safeGit(["config", "--get", "remote.origin.url"]) ?? "local/repo";
  return remote.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}

function statusBadge(status: string): string {
  return status === "block" ? "BLOCK" : status === "warn" ? "WARN" : "PASS";
}

/** Escape a value for a Markdown table cell (backslash, pipe, newlines) and cap length. */
function mdCell(value: string, max = 200): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  return escaped.length > max ? `${escaped.slice(0, max - 3)}...` : escaped;
}

function buildSummary(pr: PullRequestInput, result: ReturnType<typeof evaluateMergeGuard>): string {
  const lines: string[] = [];
  lines.push("## AgentForge Merge Guard");
  lines.push("");
  lines.push(`**Decision:** ${statusBadge(result.status)} - **Mode:** \`${result.mode}\``);
  lines.push(
    `**PR:** ${pr.repositoryFullName}#${pr.pullRequestNumber || "(local)"} - **Files changed:** ${pr.changedFiles.length} - **Policy:** \`${result.policyPackId ?? "n/a"}@${result.policyVersion}\``
  );
  lines.push("");

  if (result.findings.length === 0) {
    lines.push("No deterministic findings.");
  } else {
    lines.push(`### Findings (${result.findings.length})`);
    lines.push("");
    lines.push("| Type | Path | Severity | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const finding of result.findings) {
      lines.push(
        `| \`${finding.type}\` | ${mdCell(finding.path ?? "-")} | ${finding.severity ?? "-"} | ${mdCell(finding.evidence, 160)} |`
      );
    }
  }
  lines.push("");

  if (result.requiredEvidence.length > 0) {
    lines.push("### Required evidence");
    lines.push("");
    for (const item of result.requiredEvidence) {
      lines.push(`- [${item.status}] \`${item.kind}\``);
    }
    lines.push("");
  }

  if (result.requiredReviewers.length > 0) {
    lines.push("### Required reviewers");
    lines.push("");
    for (const item of result.requiredReviewers) {
      lines.push(
        `- [${item.approved ? "approved" : "pending"}] \`${item.reviewer}\` (${item.tier}) - ${item.reason}`
      );
    }
    lines.push("");
  }

  if (result.explanation.length > 0) {
    lines.push("### Explanation");
    lines.push("");
    for (const reason of result.explanation) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  if (result.status === "warn") {
    lines.push(
      "> Mode is `warn`: findings are surfaced but do not block. Approving evidence and flipping the policy to `enforce` (with the dashboard running) makes these hard requirements."
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const pr = readEvent();
  const repositoryFullName = normalizeRepo();

  let base: string;
  let head: string;
  const input: Partial<PullRequestInput> = { repositoryFullName };

  if (pr) {
    base = pr.base?.sha ?? "HEAD~1";
    head = pr.head?.sha ?? "HEAD";
    input.pullRequestNumber = pr.number ?? 0;
    input.title = pr.title ?? "(no title)";
    input.body = pr.body ?? "";
    input.authorLogin = pr.user?.login ?? "unknown";
    input.baseBranch = pr.base?.ref ?? "main";
    input.headBranch = pr.head?.ref ?? "HEAD";
    input.headSha = pr.head?.sha ?? head;
    input.labels = (pr.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => Boolean(name));
  } else {
    base = flag("base") ?? "origin/main";
    head = flag("head") ?? "HEAD";
    input.pullRequestNumber = Number(flag("pr") ?? 0);
    input.title = safeGit(["log", "-1", "--format=%s"]) ?? "(local)";
    input.body = safeGit(["log", "-1", "--format=%b"]) ?? "";
    input.authorLogin = safeGit(["log", "-1", "--format=%an"]) ?? "local";
    input.baseBranch = base.replace(/^origin\//, "");
    input.headBranch = safeGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
    input.headSha = safeGit(["rev-parse", "HEAD"]) ?? head;
    input.labels = [];
  }

  const range = `${base}...${head}`;
  input.changedFiles = buildChangedFiles(range);
  input.commits = buildCommits(`${base}..${head}`);
  input.reviews = pr ? await fetchReviews(repositoryFullName, input.pullRequestNumber ?? 0) : [];

  const policyPath = flag("policy") ?? ".agentforge/policy.yml";
  let policyYaml: string | undefined;
  try {
    policyYaml = readFileSync(policyPath, "utf8");
  } catch {
    policyYaml = getPolicyPack("fintech")?.contentYaml;
  }
  if (!policyYaml) {
    console.error(`AgentForge Merge Guard: no policy at ${policyPath} and no fallback pack.`);
    process.exit(2);
  }
  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    console.error(`AgentForge Merge Guard: invalid policy: ${parsed.errors.join("; ")}`);
    process.exit(2);
  }

  const fullInput = input as PullRequestInput;
  const facts = extractVerifiedFacts(fullInput, detectorConfigFromPolicy(parsed.config));
  const result = evaluateMergeGuard(fullInput, facts, parsed.config, undefined, {
    sourceContentHash: parsed.contentHash
  });

  const summary = buildSummary(fullInput, result);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `${summary}\n`);
    } catch {
      // best-effort summary
    }
  }
  console.log(summary);

  // Durable, redacted Change Control Record - the product's core auditable output.
  const storagePolicy: MetadataStoragePolicy = {
    sourceCodeStorage: false,
    fullDiffRetention: "disabled",
    redactSecrets: true
  };
  const record = createChangeControlRecord({
    organizationId: `github:${repositoryFullName.split("/")[0] ?? "local"}`,
    repositoryId: repositoryFullName,
    pr: fullInput,
    policyResult: result,
    storagePolicy
  });
  const recordPath = process.env.MERGE_GUARD_RECORD_PATH ?? "merge-guard-record.json";
  try {
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Change Control Record written to ${recordPath}`);
  } catch (error) {
    console.error("AgentForge Merge Guard: failed to write Change Control Record:", error);
  }

  if (pr) {
    await upsertPrComment(repositoryFullName, input.pullRequestNumber ?? 0, summary);
  }

  console.log(
    `\nAgentForge Merge Guard decision: ${result.status.toUpperCase()} (mode=${result.mode}, findings=${result.findings.length})`
  );
  process.exit(result.status === "block" ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("AgentForge Merge Guard failed:", error);
  process.exit(1);
});
