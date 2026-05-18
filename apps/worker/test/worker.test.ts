import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
import type { GithubAdapterClient, GithubWebhookEnvelope } from "@agentforge/github";
import { processMergeGuardEvaluationJob } from "../src/index.js";

async function loadPr(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

async function loadPolicy(name: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), "fixtures", "policies", name), "utf8");
}

describe("Merge Guard worker evaluation jobs", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("processes a high-risk PR fixture into a Change Control Record result", async () => {
    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-billing",
      pr: await loadPr("billing-path.json"),
      policyYaml: await loadPolicy("fintech.yaml")
    });

    expect(result.repositoryFullName).toBe("acme/payments");
    expect(result.pullRequestNumber).toBe(2);
    expect(result.status).toBe("warn");
    expect(result.checkConclusion).toBe("neutral");
    expect(result.recordId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("keeps agent signals as additional scrutiny instead of the only governance gate", async () => {
    const policyYaml = await loadPolicy("enterprise-strict.yaml");
    const human = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-human-billing",
      pr: await loadPr("billing-path.json"),
      policyYaml
    });
    const agent = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-agent-billing",
      pr: await loadPr("billing-agent.json"),
      policyYaml
    });

    expect(human.status).toBe("block");
    expect(agent.status).toBe("block");
    expect(human.checkConclusion).toBe("failure");
    expect(agent.checkConclusion).toBe("failure");
  });

  it("fetches live GitHub PR facts before evaluating webhook jobs and publishing checks", async () => {
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const published: Array<{
      owner: string;
      repo: string;
      result: PolicyResult;
      detailsUrl?: string | undefined;
    }> = [];

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr),
      githubCheckPublisher: async (input) => {
        published.push({
          owner: input.owner,
          repo: input.repo,
          result: input.result,
          detailsUrl: input.detailsUrl
        });
        return { id: 42, conclusion: "neutral" };
      }
    });

    expect(result).toMatchObject({
      repositoryFullName: "acme/payments",
      pullRequestNumber: 2,
      status: "warn",
      checkConclusion: "neutral",
      checkPublished: true,
      publishedCheckRunId: 42
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ owner: "acme", repo: "payments" });
    expect(published[0]?.detailsUrl).toBeUndefined();
    expect(published[0]?.result.findings.map((finding) => finding.type)).toContain(
      "sensitive_path_changed"
    );
  });

  it("uses verified GitHub team membership to clear required team reviewers", async () => {
    const pr = {
      ...(await loadPr("billing-path.json")),
      body: "Rollback plan: revert the checkout change and redeploy the previous release.",
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user" as const,
          state: "APPROVED" as const,
          submittedAt: "2026-05-14T00:00:00.000Z"
        }
      ]
    };
    const envelope = webhookEnvelope(pr);
    const published: PolicyResult[] = [];

    await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr, { alice: ["billing-owner"] }),
      githubCheckPublisher: async (input) => {
        published.push(input.result);
        return { id: 43, conclusion: "neutral" };
      }
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.requiredReviewers[0]).toMatchObject({
      reviewer: "billing-owner",
      reviewerType: "team",
      approved: true,
      approvedBy: "alice"
    });
  });

  it("records merged lifecycle decisions from closed pull request webhooks", async () => {
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr, { action: "closed", merged: true });

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      pr,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml")
    });

    expect(result.lifecycle).toBe("merged");
  });

  it("fails closed for webhook jobs when GitHub PR files cannot be fetched", async () => {
    const pr = await loadPr("billing-path.json");
    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: "delivery-worker-webhook-without-github",
        envelope: webhookEnvelope(pr),
        policyYaml: await loadPolicy("fintech.yaml")
      })
    ).rejects.toThrow("required to inspect pull request files");
  });

  it("rejects queued jobs that do not contain a pull request payload", async () => {
    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: "delivery-worker-non-pr"
      })
    ).rejects.toThrow("requires a pull request payload");
  });
});

function webhookEnvelope(
  pr: PullRequestInput,
  options: { action?: string; merged?: boolean } = {}
): GithubWebhookEnvelope {
  const [owner = "acme", name = "payments"] = pr.repositoryFullName.split("/");
  return {
    deliveryId: `delivery-${pr.pullRequestNumber}`,
    event: "pull_request",
    action: options.action ?? "opened",
    installationId: 99,
    repository: {
      id: 1,
      fullName: pr.repositoryFullName,
      owner,
      name,
      defaultBranch: pr.baseBranch
    },
    pullRequest: {
      id: pr.pullRequestNumber,
      number: pr.pullRequestNumber,
      title: pr.title,
      authorLogin: pr.authorLogin,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      body: pr.body,
      state: options.action === "closed" ? "closed" : "open",
      merged: options.merged ?? false
    },
    receivedAt: "2026-05-13T00:00:00.000Z"
  };
}

function githubClientForPr(
  pr: PullRequestInput,
  teamMemberships: Record<string, string[]> = {}
): GithubAdapterClient {
  const [owner = "acme", repo = "payments"] = pr.repositoryFullName.split("/");
  return {
    pulls: {
      get: async () => ({
        data: {
          id: pr.pullRequestNumber,
          number: pr.pullRequestNumber,
          title: pr.title,
          body: pr.body,
          user: { login: pr.authorLogin },
          base: { ref: pr.baseBranch, sha: "base-sha" },
          head: {
            ref: pr.headBranch,
            sha: pr.headSha,
            repo: { full_name: `${owner}/${repo}` }
          },
          labels: pr.labels?.map((name) => ({ name })) ?? []
        }
      }),
      listFiles: async () => ({
        data: pr.changedFiles.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch,
          previous_filename: file.previousFilename
        }))
      }),
      listReviews: async () => ({
        data:
          pr.reviews?.map((review) => ({
            state: review.state.toLowerCase(),
            submitted_at: review.submittedAt,
            user: { login: review.reviewer }
          })) ?? []
      }),
      listCommits: async () => ({
        data:
          pr.commits?.map((commit) => ({
            sha: commit.sha,
            commit: { message: commit.message },
            author: commit.authorLogin ? { login: commit.authorLogin } : undefined
          })) ?? []
      })
    },
    teams: {
      getMembershipForUserInOrg: async ({ team_slug, username }) => {
        if (
          typeof username === "string" &&
          typeof team_slug === "string" &&
          teamMemberships[username]?.includes(team_slug)
        ) {
          return { data: { state: "active" } };
        }
        throw new Error("not found");
      }
    }
  };
}
