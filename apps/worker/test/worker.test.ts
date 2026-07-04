import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@agentforge/config";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
import type { GithubAdapterClient, GithubWebhookEnvelope } from "@agentforge/github";
import {
  classifyMergeGuardEvaluationFailure,
  computeBackoffDelay,
  processMergeGuardEvaluationJob,
  recordMergeGuardEvaluationFailure,
  RepositoryNotConfiguredError,
  resolveRuntimeEvaluationContext
} from "../src/index.js";

const mockPrismaUpsert = vi.fn();
const mockWebhookDeliveryFindUnique = vi.fn();
const mockWebhookDeliveryUpdateMany = vi.fn();
const mockEvaluationUpsert = vi.fn();
const mockCheckRunUpsert = vi.fn();
vi.mock("@agentforge/db", () => {
  class MockPrismaClient {
    organization = { upsert: vi.fn().mockResolvedValue({ id: "org" }) };
    repository = {
      findFirst: vi.fn().mockResolvedValue({
        id: "repo",
        organizationId: "org",
        enabled: true,
        currentPolicyVersion: { contentYaml: "..." },
        settings: { llmFeatures: true },
        ownerMappings: []
      }),
      upsert: vi.fn().mockResolvedValue({ id: "repo" })
    };
    pullRequest = { upsert: vi.fn().mockResolvedValue({ id: "pr" }) };
    changeControlRecord = {
      upsert: mockPrismaUpsert
    };
    evaluation = { upsert: mockEvaluationUpsert };
    verifiedFactRecord = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({})
    };
    evidenceRequirementRecord = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({})
    };
    reviewerRequirementRecord = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({})
    };
    checkRun = {
      upsert: mockCheckRunUpsert
    };
    policyVersion = { findFirst: vi.fn().mockResolvedValue({ id: "pol" }) };
    auditEvent = { upsert: vi.fn().mockResolvedValue({}) };
    webhookDelivery = {
      findUnique: mockWebhookDeliveryFindUnique,
      updateMany: mockWebhookDeliveryUpdateMany
    };
    $transaction = vi.fn(async (callback: (tx: MockPrismaClient) => Promise<unknown>) =>
      callback(this)
    );
  }
  return {
    PrismaClient: MockPrismaClient,
    createPrismaClient: () => new MockPrismaClient(),
    runWithOrgContext: <T>(_organizationId: string, callback: () => Promise<T> | T) =>
      Promise.resolve(callback())
  };
});

const mutableEnvKeys = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID"
] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);

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
    for (const key of mutableEnvKeys) {
      process.env[key] = "";
    }
    process.env.NODE_ENV = "test";
    mockPrismaUpsert.mockReset();
    mockWebhookDeliveryFindUnique.mockReset();
    mockWebhookDeliveryUpdateMany.mockReset();
    mockEvaluationUpsert.mockReset();
    mockCheckRunUpsert.mockReset();
    mockWebhookDeliveryFindUnique.mockResolvedValue(null);
    mockWebhookDeliveryUpdateMany.mockResolvedValue({ count: 1 });
    mockEvaluationUpsert.mockResolvedValue({ id: "eval" });
    mockCheckRunUpsert.mockResolvedValue({});
  });

  afterEach(() => {
    for (const key of mutableEnvKeys) {
      const originalValue = originalEnv.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
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

  it("rejects DB-backed runtime fallback when a repository has no configured policy", async () => {
    const pr = await loadPr("billing-path.json");
    const config = loadConfig();
    const prisma = {
      repository: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    };

    await expect(
      resolveRuntimeEvaluationContext({
        prisma: prisma as never,
        pr,
        config
      })
    ).rejects.toThrow(RepositoryNotConfiguredError);
  });

  it("allows DB-backed runtime evaluation only with an explicit job policy for unknown repositories", async () => {
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const config = loadConfig();
    const prisma = {
      repository: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    };

    const runtime = await resolveRuntimeEvaluationContext({
      prisma: prisma as never,
      pr,
      config,
      policyYaml
    });

    expect(runtime).toMatchObject({
      organizationId: "org_explicit_policy",
      policyYaml,
      modeOverride: undefined,
      ownerMappings: []
    });
  });

  it("resolves llmFeatures from the repository settings if prisma is defined", async () => {
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const config = loadConfig();
    const prisma = {
      repository: {
        findFirst: vi.fn().mockResolvedValue({
          id: "repo-123",
          organizationId: "org-123",
          fullName: pr.repositoryFullName,
          enabled: true,
          currentPolicyVersion: {
            contentYaml: policyYaml
          },
          settings: {
            sourceCodeStorage: true,
            fullDiffRetention: "30d",
            redactSecrets: true,
            llmFeatures: true
          },
          ownerMappings: []
        })
      }
    };

    const runtime = await resolveRuntimeEvaluationContext({
      prisma: prisma as never,
      pr,
      config
    });

    expect(runtime).toMatchObject({
      organizationId: "org-123",
      policyYaml,
      llmFeatures: true
    });
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

  it("reuses recorded check publication state when retrying the same delivery", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const published = vi.fn(async () => ({ id: 99, conclusion: "neutral" as const }));
    mockWebhookDeliveryFindUnique.mockResolvedValue({
      publishedCheckRunId: BigInt(42),
      checkConclusion: "neutral",
      checkPublishedAt: new Date("2026-05-26T00:00:00.000Z")
    });
    mockPrismaUpsert.mockResolvedValue({
      id: "record-123",
      pullRequestId: "pr"
    });

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr),
      githubCheckPublisher: published
    });

    expect(result.checkPublished).toBe(true);
    expect(result.publishedCheckRunId).toBe(42);
    expect(published).not.toHaveBeenCalled();
    expect(mockEvaluationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expect.stringMatching(/^eval_[a-f0-9]{32}$/u) }
      })
    );
    expect(mockCheckRunUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { evaluationId: expect.stringMatching(/^eval_[a-f0-9]{32}$/u) },
        update: expect.objectContaining({
          githubCheckRunId: BigInt(42)
        }),
        create: expect.objectContaining({
          githubCheckRunId: BigInt(42)
        })
      })
    );
  });

  it("lets exactly one of two truly concurrent publish attempts for the same delivery win the claim", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const policyYaml = await loadPolicy("fintech.yaml");
    mockPrismaUpsert.mockResolvedValue({
      id: "record-123",
      pullRequestId: "pr"
    });

    // Shared mutable "row" standing in for the single webhook_delivery record both
    // concurrent calls contend over. Prisma's `updateMany` performs the WHERE match
    // and the write atomically inside a single database statement, so no other
    // transaction can observe or interleave with a half-applied update. A vi.fn mock
    // body runs to completion without ever yielding to the event loop (no `await`
    // inside the check-and-set below), which reproduces that same atomicity: once a
    // call enters `mockWebhookDeliveryUpdateMany`, it evaluates the WHERE clause
    // against `row` and mutates `row` before returning, with no possibility of the
    // other concurrent call's invocation interleaving mid-check. This is what makes
    // "whichever call's updateMany executes first wins" a faithful model of Postgres
    // row-level locking rather than a JS-scheduling artifact.
    let row: {
      publishedCheckRunId: bigint | null;
      checkConclusion: string | null;
      checkPublishedAt: Date | null;
    } | null = null;
    let updateManyCallCount = 0;
    const updateManyCallOrder: string[] = [];

    mockWebhookDeliveryFindUnique.mockImplementation(async () => {
      if (!row) {
        return null;
      }
      return { ...row };
    });
    mockWebhookDeliveryUpdateMany.mockImplementation(
      async (args: {
        where: {
          deliveryId: string;
          checkPublishedAt?: Date | null;
          publishedCheckRunId?: null;
        };
        data: {
          checkConclusion?: string;
          checkPublishedAt?: Date | null;
          publishedCheckRunId?: bigint | null;
        };
      }) => {
        updateManyCallCount += 1;
        const callIndex = updateManyCallCount;

        // Claim attempt: WHERE requires checkPublishedAt to still be null (the
        // fresh-claim path publishCheckOnce takes when no previous row exists).
        if (args.where.checkPublishedAt === null && row === null) {
          row = {
            publishedCheckRunId: null,
            checkConclusion: args.data.checkConclusion ?? null,
            checkPublishedAt: args.data.checkPublishedAt ?? new Date()
          };
          updateManyCallOrder.push(`call-${callIndex}:claimed`);
          return { count: 1 };
        }
        // A second claim attempt against an already-claimed row loses the race.
        if (args.where.checkPublishedAt === null && row !== null) {
          updateManyCallOrder.push(`call-${callIndex}:lost-race`);
          return { count: 0 };
        }
        // Finalize/rollback updateMany after publish() resolves: matches by the
        // claimant's own claimTime, so only the claim owner's finalize call can
        // apply it.
        if (
          args.where.checkPublishedAt instanceof Date &&
          row &&
          row.checkPublishedAt?.getTime() === args.where.checkPublishedAt.getTime()
        ) {
          row = {
            publishedCheckRunId:
              args.data.publishedCheckRunId !== undefined
                ? args.data.publishedCheckRunId
                : row.publishedCheckRunId,
            checkConclusion: args.data.checkConclusion ?? row.checkConclusion,
            checkPublishedAt:
              args.data.checkPublishedAt !== undefined
                ? args.data.checkPublishedAt
                : row.checkPublishedAt
          };
          updateManyCallOrder.push(`call-${callIndex}:finalized`);
          return { count: 1 };
        }
        updateManyCallOrder.push(`call-${callIndex}:no-match`);
        return { count: 0 };
      }
    );

    const publishedRunIds: number[] = [];
    const githubCheckPublisher = vi.fn(async () => {
      // Simulate real GitHub API latency so both racers are genuinely in flight
      // together rather than one completing before the other starts.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const id = 500 + publishedRunIds.length;
      publishedRunIds.push(id);
      return { id, conclusion: "neutral" as const };
    });

    const [resultA, resultB] = await Promise.all([
      processMergeGuardEvaluationJob({
        deliveryId: envelope.deliveryId,
        envelope,
        policyYaml,
        githubClient: githubClientForPr(pr),
        githubCheckPublisher
      }),
      processMergeGuardEvaluationJob({
        deliveryId: envelope.deliveryId,
        envelope,
        policyYaml,
        githubClient: githubClientForPr(pr),
        githubCheckPublisher
      })
    ]);

    // Neither concurrent call throws/rejects; both resolve to a valid result shape.
    expect(resultA.recordId).toBeDefined();
    expect(resultB.recordId).toBeDefined();

    // The correctness property that matters: exactly one actual GitHub publish
    // happened across both racing calls.
    expect(githubCheckPublisher).toHaveBeenCalledTimes(1);
    expect(publishedRunIds).toHaveLength(1);

    // Exactly one of the two job results reflects a real, freshly published check;
    // the other reflects the lost-race outcome from publishCheckOnce: `published:
    // false` with no id, because the loser observed `claim.count === 0`, re-read the
    // row via findUnique, found the winner's claim already taken but not yet
    // finalized with a publishedCheckRunId (winner was still inside its `publish()`
    // await), and therefore returned `{ published: false, id: undefined, reused:
    // true }` without attempting its own publish.
    const results = [resultA, resultB];
    const winners = results.filter((r) => r.checkPublished === true);
    const losers = results.filter((r) => r.checkPublished === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.publishedCheckRunId).toBe(publishedRunIds[0]);
    expect(losers[0]?.publishedCheckRunId).toBeUndefined();

    // Exactly one updateMany call actually claimed the row; confirms the WHERE
    // clause's mutual exclusivity was exercised by both racers, not skipped by one.
    expect(updateManyCallOrder.filter((entry) => entry.endsWith(":claimed"))).toHaveLength(1);
    expect(updateManyCallOrder.filter((entry) => entry.endsWith(":lost-race"))).toHaveLength(1);
  });

  it("does not re-attempt publish when retrying within the claim TTL after a crash between claim and GitHub call", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);

    // Simulates a worker that claimed the row (checkPublishedAt set) and then
    // crashed before the GitHub API call completed, so publishedCheckRunId was
    // never written. The claim timestamp is well inside CHECK_PUBLICATION_CLAIM_TTL_MS
    // (5 minutes), so a retry landing now must treat the claim as still "in flight"
    // rather than reclaimable.
    mockWebhookDeliveryFindUnique.mockResolvedValue({
      publishedCheckRunId: null,
      checkConclusion: "neutral",
      checkPublishedAt: new Date(Date.now() - 30_000)
    });
    mockPrismaUpsert.mockResolvedValue({
      id: "record-123",
      pullRequestId: "pr"
    });

    const published = vi.fn(async () => ({ id: 999, conclusion: "neutral" as const }));

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr),
      githubCheckPublisher: published
    });

    // Pins publishCheckOnce's actual current behavior: a retry that observes an
    // unfinished claim inside the TTL window returns without publishing at all
    // (not "reused with a real check-run id" — there is no id yet, since the
    // original claimant never finished). This documents the silent-skip-publish
    // window: the PR check the retry represents will not be published by this
    // call, and nothing else in this retry attempt re-triggers it either.
    expect(published).not.toHaveBeenCalled();
    expect(result.checkPublished).toBe(false);
    expect(result.publishedCheckRunId).toBeUndefined();
    // The retry still completes cleanly rather than throwing.
    expect(result.recordId).toBeDefined();
    expect(result.checkConclusion).toBe("neutral");

    // updateMany (the claim/finalize write path) is never reached on this branch,
    // since publishCheckOnce returns immediately after the TTL check.
    expect(mockWebhookDeliveryUpdateMany).not.toHaveBeenCalled();
  });

  it("ignores stale check_run webhooks without publishing a Merge Guard check", async () => {
    const pr = await loadPr("billing-path.json");
    const published = vi.fn();

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-stale-check-run",
      pr,
      envelope: {
        ...webhookEnvelope(pr),
        deliveryId: "delivery-stale-check-run",
        event: "check_run",
        action: "completed",
        checkRun: {
          id: 99,
          name: "ci",
          status: "completed",
          conclusion: "success",
          headSha: "stale-sha",
          pullRequests: [{ number: pr.pullRequestNumber, headSha: "stale-sha" }]
        }
      },
      policyYaml: await loadPolicy("fintech.yaml"),
      githubCheckPublisher: published
    });

    expect(result).toMatchObject({
      recordId: "stale_check_run:delivery-stale-check-run",
      repositoryFullName: pr.repositoryFullName,
      pullRequestNumber: pr.pullRequestNumber,
      checkConclusion: "neutral",
      checkPublished: false
    });
    expect(published).not.toHaveBeenCalled();
  });

  it("skips publishing a superseded synchronize evaluation when GitHub's head_sha has advanced since this job's evaluation ran", async () => {
    const olderPush = await loadPr("billing-path.json");
    const newerPush = { ...olderPush, headSha: "newer-push-sha" };
    const published: Array<{ pr: PullRequestInput }> = [];

    // Job B (newer push) is processed first: GitHub already reflects `newerPush.headSha`,
    // matches its own evaluated headSha, and it publishes successfully.
    const newerResult = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-push-2-newer",
      pr: newerPush,
      envelope: webhookEnvelope(newerPush, { action: "synchronize" }),
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(newerPush),
      githubCheckPublisher: async (input) => {
        published.push({ pr: input.pr });
        return { id: 100, conclusion: "neutral" };
      }
    });

    expect(newerResult.checkPublished).toBe(true);

    // Job A (older push) is picked up late (e.g. Redis scheduling/worker restart timing).
    // It evaluated `olderPush` (headSha frozen at whatever this job's evaluation used),
    // but by the time it is about to publish, GitHub's live PR state (the mocked client's
    // `pulls.get`) already reflects `newerPush.headSha` because push 2 has since landed.
    const olderResult = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-push-1-older",
      pr: olderPush,
      envelope: webhookEnvelope(olderPush, { action: "synchronize" }),
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(newerPush),
      githubCheckPublisher: async (input) => {
        published.push({ pr: input.pr });
        return { id: 101, conclusion: "neutral" };
      }
    });

    expect(olderResult).toMatchObject({
      repositoryFullName: olderPush.repositoryFullName,
      pullRequestNumber: olderPush.pullRequestNumber,
      checkConclusion: "neutral",
      checkPublished: false
    });
    // Only the newer push's check-run was published; the stale job never overwrote it.
    expect(published).toHaveLength(1);
    expect(published[0]?.pr.headSha).toBe(newerPush.headSha);
  });

  it("still publishes normally for a single synchronize job when the PR head_sha has not moved (regression guard)", async () => {
    const pr = await loadPr("billing-path.json");
    const published: Array<{ pr: PullRequestInput }> = [];

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-single-synchronize",
      pr,
      envelope: webhookEnvelope(pr, { action: "synchronize" }),
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr),
      githubCheckPublisher: async (input) => {
        published.push({ pr: input.pr });
        return { id: 200, conclusion: "neutral" };
      }
    });

    expect(result).toMatchObject({
      repositoryFullName: pr.repositoryFullName,
      pullRequestNumber: pr.pullRequestNumber,
      checkConclusion: "neutral",
      checkPublished: true,
      publishedCheckRunId: 200
    });
    expect(published).toHaveLength(1);
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

  it("classifies transient GitHub failures as bounded retryable summaries", () => {
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error("GitHub API timeout while fetching files"),
      deliveryId: "delivery-transient",
      attemptsMade: 2,
      maxAttempts: 3,
      failedAt: "2026-05-19T00:00:00.000Z"
    });

    expect(summary).toEqual({
      errorClass: "Error",
      message: "GitHub API timeout while fetching files",
      retryable: true,
      terminalFailure: false,
      attemptsMade: 2,
      maxAttempts: 3,
      failedAt: "2026-05-19T00:00:00.000Z",
      correlationId: "delivery-transient"
    });
  });

  it("treats invalid payload failures as terminal and redacts unsafe error text", () => {
    const githubToken = ["gh", "p_", "1234567890", "1234567890", "1234567890", "123456"].join("");
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error(
        `Merge Guard evaluation job requires a pull request payload. token=${githubToken}`
      ),
      deliveryId: "delivery-terminal",
      attemptsMade: 1,
      maxAttempts: 3
    });

    expect(summary.retryable).toBe(false);
    expect(summary.terminalFailure).toBe(true);
    expect(summary.message).toContain("requires a pull request payload");
    expect(summary.message).not.toContain("ghp_123456");
    expect(summary.message).not.toContain(githubToken);
  });

  it("records failed evaluation summaries without storing job payloads", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error("GitHub API timeout"),
      deliveryId: "delivery-record-failure",
      attemptsMade: 3,
      maxAttempts: 3,
      failedAt: "2026-05-19T00:00:00.000Z"
    });

    await recordMergeGuardEvaluationFailure({
      prisma: { webhookDelivery: { updateMany } } as never,
      deliveryId: "delivery-record-failure",
      summary
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { deliveryId: "delivery-record-failure" },
      data: expect.objectContaining({
        evaluationAttemptsMade: 3,
        evaluationTerminalFailure: true,
        lastFailureClass: "Error",
        lastFailureMessage: "GitHub API timeout",
        lastFailureCorrelationId: "delivery-record-failure",
        lastFailedAt: new Date("2026-05-19T00:00:00.000Z")
      })
    });
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain("envelope");
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain("payload");
  });

  it("generates AI pre-drafts and persists them inside requiredEvidenceJson when llmFeatures is enabled", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    process.env.LLM_FEATURES = "true";

    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);

    mockPrismaUpsert.mockResolvedValue({
      id: "record-123",
      pullRequestId: "pr"
    });

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr)
    });

    expect(result.status).toBe("warn");
    expect(mockPrismaUpsert).toHaveBeenCalled();

    const upsertCall = mockPrismaUpsert.mock.calls[0];
    const updateData = upsertCall[0].update;
    const createData = upsertCall[0].create;

    expect(updateData.requiredEvidenceJson[0]).toMatchObject({
      kind: "rollback_plan",
      status: "missing",
      aiDraft: expect.stringContaining("### Rollback Plan for Database Migration")
    });
    expect(createData.requiredEvidenceJson[0]).toMatchObject({
      kind: "rollback_plan",
      status: "missing",
      aiDraft: expect.stringContaining("### Rollback Plan for Database Migration")
    });
  });

  describe("computeBackoffDelay", () => {
    function rateLimitedError(headers: Record<string, string>): Error {
      const error = new Error("secondary rate limit") as Error & {
        status: number;
        response: { headers: Record<string, string> };
      };
      error.status = 403;
      error.response = { headers };
      return error;
    }

    it("uses GitHub's retry-after header directly instead of exponential backoff", () => {
      const err = rateLimitedError({ "retry-after": "5" });
      const delay = computeBackoffDelay(3, "exponentialWithJitter", err, {
        opts: { backoff: { delay: 30000 } }
      });

      // 5s base + up to 2s jitter, never below the 1s floor.
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(7000);
    });

    it("uses GitHub's x-ratelimit-reset header when retry-after is absent", () => {
      const resetEpochSeconds = Math.floor(Date.now() / 1000) + 30;
      const err = rateLimitedError({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpochSeconds)
      });
      const delay = computeBackoffDelay(1, "exponentialWithJitter", err, {
        opts: { backoff: { delay: 30000 } }
      });

      expect(delay).toBeGreaterThanOrEqual(28000);
      expect(delay).toBeLessThanOrEqual(32000);
    });

    it("caps a GitHub-directed wait at the maximum backoff bound", () => {
      const err = rateLimitedError({ "retry-after": String(60 * 60) }); // 1 hour
      const delay = computeBackoffDelay(1, "exponentialWithJitter", err, {
        opts: { backoff: { delay: 30000 } }
      });

      expect(delay).toBe(15 * 60 * 1000);
    });

    it("falls back to exponential-with-jitter when the error carries no GitHub rate-limit signal", () => {
      const delay = computeBackoffDelay(2, "exponentialWithJitter", new Error("boom"), {
        opts: { backoff: { delay: 1000 } }
      });

      // attemptsMade=2 -> base delay 2000ms, jittered between 1000ms and 3000ms.
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(3000);
    });

    it("falls back to the generic delay calculation for unknown backoff types", () => {
      const delay = computeBackoffDelay(1, "unknown-type", new Error("boom"), {
        opts: { backoff: { delay: 5000 } }
      });

      expect(delay).toBe(5000);
    });

    it("uses the default base delay when the job has no explicit backoff options", () => {
      const delay = computeBackoffDelay(1, "exponentialWithJitter", new Error("boom"), {
        opts: {}
      });

      expect(delay).toBeGreaterThan(0);
    });
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
