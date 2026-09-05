import { readFile } from "node:fs/promises";
import path from "node:path";
import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@agentforge/config";
import type { ChangeControlRecord, PolicyResult, PullRequestInput } from "@agentforge/core";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import { evaluateMergeGuard, parsePolicyYaml } from "@agentforge/policy";
import type {
  CheckRunPayload,
  GithubAdapterClient,
  GithubWebhookEnvelope
} from "@agentforge/github";

const githubModuleMocks = vi.hoisted(() => ({
  createGithubInstallationToken: vi.fn(),
  createGithubClient: vi.fn()
}));

vi.mock("@agentforge/github", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@agentforge/github");
  return {
    ...actual,
    createGithubInstallationToken: githubModuleMocks.createGithubInstallationToken,
    createGithubClient: githubModuleMocks.createGithubClient
  };
});

import {
  CheckPublicationClaimPendingError,
  classifyMergeGuardEvaluationFailure,
  computeBackoffDelay,
  GithubInstallationNotAuthorizedError,
  markWebhookDeliveryCompleted,
  markWebhookDeliveryProcessing,
  postWorkerFailureAlert,
  processMergeGuardEvaluationJob,
  processMergeGuardEvaluationQueueJob,
  publishTerminalFailureCheckRun,
  recordMergeGuardEvaluationFailure,
  RepositoryNotConfiguredError,
  resolveRuntimeEvaluationContext,
  UnsafeRepositoryStorageSettingsError
} from "../src/index.js";

const mockChangeControlRecordCreate = vi.fn();
const mockChangeControlRecordFindFirst = vi.fn();
const mockChangeControlRecordFindUnique = vi.fn();
const mockChangeControlRecordUpdateMany = vi.fn();
const mockWebhookDeliveryFindUnique = vi.fn();
const mockWebhookDeliveryUpdateMany = vi.fn();
const mockEvaluationUpsert = vi.fn();
const mockCheckRunUpsert = vi.fn();
const mockGithubInstallationFindUnique = vi.fn();
const mockOrganizationUpsert = vi.fn();
const mockRepositoryFindFirst = vi.fn();
const mockRepositoryUpsert = vi.fn();
const mockPullRequestUpsert = vi.fn();
const mockPolicyVersionFindFirst = vi.fn();
const mockPolicyVersionCreate = vi.fn();
const mockPolicyPackFindUnique = vi.fn();
// Captures each `tx.$executeRaw` call's raw template-tag arguments (see
// packages/db/src/index.ts's withUnmanagedOrgBinding doc comment: the RLS
// org-binding call is `tx.$executeRaw\`SELECT set_config('agentforge.current_org',
// ${orgId}, true)\``, a Prisma Sql template-tag invocation). `mockCallOrder`
// tracks this call relative to `evaluation.upsert` -- the first model write
// inside the same `persistWorkerEvaluationSnapshot` transaction -- following
// the same push-based call-order tracking pattern already used by
// `updateManyCallOrder` in the concurrent-publish test further down this file.
const mockExecuteRawCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
const mockCallOrder: string[] = [];
vi.mock("@agentforge/db", () => {
  class MockPrismaClient {
    gitHubInstallation = { findUnique: mockGithubInstallationFindUnique };
    organization = { upsert: mockOrganizationUpsert };
    repository = {
      findFirst: mockRepositoryFindFirst,
      upsert: mockRepositoryUpsert
    };
    pullRequest = { upsert: mockPullRequestUpsert };
    changeControlRecord = {
      create: mockChangeControlRecordCreate,
      findFirst: mockChangeControlRecordFindFirst,
      findUnique: mockChangeControlRecordFindUnique,
      updateMany: mockChangeControlRecordUpdateMany
    };
    evaluation = {
      upsert: vi.fn((...args: Parameters<typeof mockEvaluationUpsert>) => {
        mockCallOrder.push("evaluation.upsert");
        return mockEvaluationUpsert(...args);
      })
    };
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
    policyVersion = {
      findFirst: mockPolicyVersionFindFirst,
      create: mockPolicyVersionCreate
    };
    policyPack = { findUnique: mockPolicyPackFindUnique };
    auditEvent = { upsert: vi.fn().mockResolvedValue({}) };
    webhookDelivery = {
      findUnique: mockWebhookDeliveryFindUnique,
      updateMany: mockWebhookDeliveryUpdateMany
    };
    $executeRaw = vi.fn((strings: readonly string[], ...values: unknown[]) => {
      mockExecuteRawCalls.push({ strings, values });
      mockCallOrder.push("set_config");
      return Promise.resolve(0);
    });
    $transaction = vi.fn(async (callback: (tx: MockPrismaClient) => Promise<unknown>) =>
      callback(this)
    );
  }
  return {
    PrismaClient: MockPrismaClient,
    createPrismaClient: () => new MockPrismaClient(),
    runWithOrgContext: <T>(_organizationId: string, callback: () => Promise<T> | T) =>
      Promise.resolve(callback()),
    withUnmanagedOrgBinding: <T>(callback: () => Promise<T> | T) => Promise.resolve(callback())
  };
});

const mutableEnvKeys = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ALLOW_UNSIGNED_GITHUB_WEBHOOKS",
  "SOURCE_CODE_STORAGE",
  "REDACT_SECRETS",
  "SESSION_SECRET",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_PROXY_SECRET",
  "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS",
  "AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS",
  "AGENTFORGE_DASHBOARD_PROXY_SECRET",
  "AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR",
  "AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS",
  "AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL"
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

function setProductionWorkerEnv(): void {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://localhost:5432/db";
  process.env.REDIS_URL = "redis://redis.example.com:6379";
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  process.env.GITHUB_WEBHOOK_SECRET = "worker-production-webhook-key-1234567890";
  process.env.GITHUB_CLIENT_ID = "";
  process.env.GITHUB_CLIENT_SECRET = "";
  process.env.ALLOW_UNSIGNED_GITHUB_WEBHOOKS = "false";
  process.env.SOURCE_CODE_STORAGE = "false";
  process.env.REDACT_SECRETS = "true";
  process.env.SESSION_SECRET = "";
  process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
  process.env.AGENTFORGE_API_PROXY_SECRET = "worker-api-proxy-key-production-1234567890";
  process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS = "false";
  process.env.AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS = "true";
  process.env.AGENTFORGE_DASHBOARD_PROXY_SECRET =
    "worker-dashboard-proxy-key-production-1234567890";
  process.env.AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR = "false";
  process.env.AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS = "true";
}

function persistedRepositoryFixture(
  policyYaml: string,
  settings: Partial<{
    sourceCodeStorage: boolean;
    fullDiffRetention: string;
    redactSecrets: boolean;
    llmFeatures: boolean;
  }> = {}
) {
  return {
    id: "repo",
    organizationId: "org",
    fullName: "acme/payments",
    enabled: true,
    archivedAt: null,
    mode: null,
    currentPolicyVersion: { contentYaml: policyYaml },
    settings: {
      sourceCodeStorage: false,
      fullDiffRetention: "disabled",
      redactSecrets: true,
      llmFeatures: true,
      ...settings
    },
    ownerMappings: []
  };
}

type ExistingRecordFixture = {
  id: string;
  revision: number;
  headSha: string;
  policyVersion: string;
  requiredEvidenceJson: PolicyResult["requiredEvidence"];
  requiredReviewersJson: PolicyResult["requiredReviewers"];
  lifecycle: ChangeControlRecord["lifecycle"];
  decisionJson: ChangeControlRecord["decision"] | null;
  createdAt?: Date | undefined;
};

function evaluatePolicyForTest(pr: PullRequestInput, policyYaml: string): PolicyResult {
  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    throw new Error(`Test policy validation failed: ${parsed.errors.join("; ")}`);
  }
  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
  // Match the worker's policy identity (sourceContentHash) so the computed
  // policyVersion is identical; otherwise prior-state carry-forward compares
  // a different version string and never matches.
  return evaluateMergeGuard(pr, facts, parsed.config, undefined, {
    sourceContentHash: parsed.contentHash
  });
}

function existingRecordFor(
  pr: PullRequestInput,
  result: PolicyResult,
  overrides: Partial<ExistingRecordFixture> = {}
): ExistingRecordFixture {
  return {
    id: "record-existing",
    revision: 0,
    headSha: pr.headSha,
    policyVersion: result.policyVersion,
    requiredEvidenceJson: result.requiredEvidence,
    requiredReviewersJson: result.requiredReviewers,
    lifecycle:
      result.status === "block" ? "blocked" : result.status === "warn" ? "warned" : "passed",
    decisionJson: { status: result.status === "block" ? "blocked" : "passed" },
    ...overrides
  };
}

describe("Merge Guard worker evaluation jobs", () => {
  beforeEach(() => {
    for (const key of mutableEnvKeys) {
      process.env[key] = "";
    }
    process.env.NODE_ENV = "test";
    mockChangeControlRecordCreate.mockReset();
    mockChangeControlRecordFindFirst.mockReset();
    mockChangeControlRecordFindUnique.mockReset();
    mockChangeControlRecordUpdateMany.mockReset();
    mockWebhookDeliveryFindUnique.mockReset();
    mockWebhookDeliveryUpdateMany.mockReset();
    mockEvaluationUpsert.mockReset();
    mockCheckRunUpsert.mockReset();
    mockGithubInstallationFindUnique.mockReset();
    mockOrganizationUpsert.mockReset();
    mockRepositoryFindFirst.mockReset();
    mockRepositoryUpsert.mockReset();
    mockPullRequestUpsert.mockReset();
    mockPolicyVersionFindFirst.mockReset();
    mockPolicyVersionCreate.mockReset();
    mockPolicyPackFindUnique.mockReset();
    githubModuleMocks.createGithubInstallationToken.mockReset();
    githubModuleMocks.createGithubClient.mockReset();
    mockWebhookDeliveryFindUnique.mockResolvedValue({
      publishedCheckRunId: null,
      checkConclusion: null,
      checkPublishedAt: null,
      checkPublicationState: "pending",
      checkPublicationClaimId: null,
      checkPublicationClaimedAt: null,
      checkExternalId: null
    });
    mockWebhookDeliveryUpdateMany.mockResolvedValue({ count: 1 });
    mockEvaluationUpsert.mockResolvedValue({ id: "eval" });
    mockCheckRunUpsert.mockResolvedValue({});
    mockChangeControlRecordFindFirst.mockResolvedValue(null);
    mockChangeControlRecordCreate.mockResolvedValue({ id: "record", revision: 0 });
    mockChangeControlRecordFindUnique.mockImplementation(async (args) =>
      args?.where?.id ? { id: args.where.id, revision: 1 } : null
    );
    mockChangeControlRecordUpdateMany.mockResolvedValue({ count: 1 });
    mockPolicyVersionFindFirst.mockResolvedValue({ id: "pol" });
    mockPolicyVersionCreate.mockResolvedValue({ id: "pol-created" });
    mockPolicyPackFindUnique.mockResolvedValue(null);
    mockGithubInstallationFindUnique.mockResolvedValue({
      organizationId: "org",
      status: "approved",
      archivedAt: null
    });
    mockOrganizationUpsert.mockResolvedValue({ id: "org" });
    mockRepositoryFindFirst.mockResolvedValue(persistedRepositoryFixture("..."));
    mockRepositoryUpsert.mockResolvedValue({ id: "repo" });
    mockPullRequestUpsert.mockResolvedValue({ id: "pr" });
    githubModuleMocks.createGithubInstallationToken.mockResolvedValue("installation-token");
    mockExecuteRawCalls.length = 0;
    mockCallOrder.length = 0;
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

  it.each([
    [
      "sourceCodeStorage",
      { sourceCodeStorage: true },
      "Source code storage cannot be enabled in production."
    ],
    [
      "redactSecrets",
      { redactSecrets: false },
      "Secret redaction cannot be disabled in production."
    ]
  ] as const)(
    "fails closed before policy evaluation or persistence when production RepositorySetting.%s is unsafe",
    async (_flag, settings, expectedMessage) => {
      setProductionWorkerEnv();
      const pr = await loadPr("billing-path.json");
      const envelope = webhookEnvelope(pr);
      // Deliberately invalid: the persisted-settings invariant must win before
      // policy parsing/evaluation, not merely prevent the later database writes.
      const invalidPolicyYaml = "version: invalid\n";
      mockRepositoryFindFirst.mockResolvedValue(
        persistedRepositoryFixture(invalidPolicyYaml, settings)
      );
      const published = vi.fn(async () => ({ id: 901, conclusion: "neutral" as const }));

      let thrown: unknown;
      try {
        await processMergeGuardEvaluationJob({
          deliveryId: `delivery-unsafe-production-${_flag}`,
          pr,
          envelope,
          policyYaml: invalidPolicyYaml,
          githubCheckPublisher: published
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnsafeRepositoryStorageSettingsError);
      expect((thrown as Error).message).toContain(expectedMessage);
      expect((thrown as Error).message).toContain("refuses to evaluate or persist");
      expect(mockChangeControlRecordFindFirst).not.toHaveBeenCalled();
      expect(mockPullRequestUpsert).not.toHaveBeenCalled();
      expect(mockChangeControlRecordCreate).not.toHaveBeenCalled();
      expect(mockEvaluationUpsert).not.toHaveBeenCalled();
      expect(mockCheckRunUpsert).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
    }
  );

  it.each(["production", "development"] as const)(
    "evaluates and persists safe RepositorySetting values in %s",
    async (nodeEnv) => {
      if (nodeEnv === "production") {
        setProductionWorkerEnv();
      } else {
        process.env.NODE_ENV = "development";
        process.env.DATABASE_URL = "postgresql://localhost:5432/db";
      }
      const pr = await loadPr("billing-path.json");
      const policyYaml = await loadPolicy("fintech.yaml");
      const envelope = webhookEnvelope(pr);
      mockRepositoryFindFirst.mockResolvedValue(persistedRepositoryFixture(policyYaml));
      const published = vi.fn(async () => ({ id: 902, conclusion: "neutral" as const }));

      const result = await processMergeGuardEvaluationJob({
        deliveryId: `delivery-safe-settings-${nodeEnv}`,
        pr,
        envelope,
        policyYaml,
        githubCheckPublisher: published
      });

      expect(result).toMatchObject({ checkPublished: true, publishedCheckRunId: 902 });
      expect(mockChangeControlRecordFindFirst).toHaveBeenCalledTimes(1);
      expect(mockChangeControlRecordCreate).toHaveBeenCalledTimes(1);
      expect(mockEvaluationUpsert).toHaveBeenCalledTimes(1);
      expect(published).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["sourceCodeStorage", { sourceCodeStorage: true }],
    ["redactSecrets", { redactSecrets: false }]
  ] as const)("preserves non-production RepositorySetting.%s behavior", async (_flag, settings) => {
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const config = loadConfig();
    const findFirst = vi.fn().mockResolvedValue(persistedRepositoryFixture(policyYaml, settings));

    const runtime = await resolveRuntimeEvaluationContext({
      prisma: { repository: { findFirst } } as never,
      pr,
      config
    });

    expect(runtime.storagePolicy).toMatchObject(settings);
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

  it("rejects an unapproved persisted installation before GitHub access or evaluation", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const githubClient = githubClientForPr(pr);
    const pullsGet = vi.spyOn(githubClient.pulls, "get");
    mockGithubInstallationFindUnique.mockResolvedValue({
      organizationId: "org",
      status: "pending_approval",
      archivedAt: null
    });

    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: envelope.deliveryId,
        envelope,
        policyYaml: await loadPolicy("fintech.yaml"),
        githubClient
      })
    ).rejects.toBeInstanceOf(GithubInstallationNotAuthorizedError);

    expect(mockGithubInstallationFindUnique).toHaveBeenCalledWith({
      where: { githubInstallationId: BigInt(envelope.installationId ?? 0) },
      select: { organizationId: true, status: true, archivedAt: true }
    });
    expect(mockRepositoryFindFirst).not.toHaveBeenCalled();
    expect(pullsGet).not.toHaveBeenCalled();
    expect(githubModuleMocks.createGithubInstallationToken).not.toHaveBeenCalled();
    expect(mockChangeControlRecordCreate).not.toHaveBeenCalled();
  });

  it("binds envelope repositories by immutable GitHub id and approved installation organization", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const published = vi.fn(async () => ({ id: 84, conclusion: "neutral" as const }));

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      pr,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubCheckPublisher: published
    });

    expect(result.publishedCheckRunId).toBe(84);
    expect(mockRepositoryFindFirst).toHaveBeenCalledTimes(1);
    expect(mockRepositoryFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org",
        githubRepositoryId: BigInt(envelope.repository?.id ?? 0),
        archivedAt: null
      },
      include: {
        currentPolicyVersion: true,
        settings: true,
        ownerMappings: true
      }
    });
    expect(mockRepositoryFindFirst.mock.calls[0]?.[0].where).not.toHaveProperty("fullName");
    expect(mockOrganizationUpsert).not.toHaveBeenCalled();
    expect(mockRepositoryUpsert).not.toHaveBeenCalled();
    expect(mockPullRequestUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          repositoryId: "repo",
          githubPullRequestId: BigInt(envelope.pullRequest?.id ?? 0)
        })
      })
    );
  });

  it("fails closed instead of bootstrapping an envelope repository missing by immutable id", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    mockRepositoryFindFirst.mockResolvedValue(null);
    const published = vi.fn(async (input: { result: PolicyResult }) => ({
      id: 85,
      conclusion: input.result.status === "block" ? ("failure" as const) : ("neutral" as const)
    }));

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      pr,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubCheckPublisher: published
    });

    expect(result).toMatchObject({
      recordId: `not_configured:${envelope.deliveryId}`,
      status: "block",
      checkPublished: true,
      publishedCheckRunId: 85
    });
    expect(published).toHaveBeenCalledTimes(1);
    expect(mockRepositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org",
          githubRepositoryId: BigInt(envelope.repository?.id ?? 0),
          archivedAt: null
        }
      })
    );
    expect(mockOrganizationUpsert).not.toHaveBeenCalled();
    expect(mockRepositoryUpsert).not.toHaveBeenCalled();
    expect(mockPullRequestUpsert).not.toHaveBeenCalled();
  });

  it("preserves explicitly injected PR and policy jobs without an envelope", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-explicit-no-envelope",
      pr,
      policyYaml
    });

    expect(result.repositoryFullName).toBe(pr.repositoryFullName);
    expect(mockGithubInstallationFindUnique).not.toHaveBeenCalled();
    expect(mockRepositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fullName: pr.repositoryFullName } })
    );
  });

  it("preserves same-head, same-policy manual evidence and reviewer approvals", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const baseline = evaluatePolicyForTest(pr, policyYaml);
    const manualEvidence: PolicyResult["requiredEvidence"] = baseline.requiredEvidence.map(
      (requirement) => ({
        ...requirement,
        status: "approved",
        source: "manual_attestation",
        providedBy: "release-manager",
        providedAt: "2026-06-01T00:00:00.000Z",
        approvedBy: "security-reviewer",
        approvedAt: "2026-06-01T00:05:00.000Z"
      })
    );
    const manualReviewers: PolicyResult["requiredReviewers"] = baseline.requiredReviewers.map(
      (requirement) => ({
        ...requirement,
        approved: true,
        approvalSource: "manual",
        approvedBy: "platform-admin",
        approvedAt: "2026-06-01T00:06:00.000Z"
      })
    );
    mockChangeControlRecordFindFirst.mockResolvedValue(
      existingRecordFor(pr, baseline, {
        requiredEvidenceJson: manualEvidence,
        requiredReviewersJson: manualReviewers
      })
    );
    const published: PolicyResult[] = [];

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-preserve-manual-state",
      pr,
      envelope: webhookEnvelope(pr),
      policyYaml,
      githubCheckPublisher: async (input) => {
        published.push(input.result);
        return { id: 701, conclusion: "neutral" };
      }
    });

    expect(mockChangeControlRecordFindFirst).toHaveBeenCalledWith({
      where: { pullRequest: { repositoryId: "repo", number: pr.pullRequestNumber } },
      select: {
        id: true,
        revision: true,
        headSha: true,
        policyVersion: true,
        requiredEvidenceJson: true,
        requiredReviewersJson: true,
        lifecycle: true,
        decisionJson: true
      }
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.requiredEvidence[0]).toMatchObject({
      status: "approved",
      source: "manual_attestation",
      approvedBy: "security-reviewer"
    });
    expect(published[0]?.requiredReviewers[0]).toMatchObject({
      approved: true,
      approvalSource: "manual",
      approvedBy: "platform-admin"
    });
    expect(result).toMatchObject({ status: "pass", checkConclusion: "neutral" });
    const update = mockChangeControlRecordUpdateMany.mock.calls[0]?.[0].data;
    expect(update.requiredEvidenceJson[0]).toMatchObject({
      status: "approved",
      source: "manual_attestation"
    });
    expect(update.requiredReviewersJson[0]).toMatchObject({
      approved: true,
      approvalSource: "manual"
    });
  });

  it("does not preserve a dismissed GitHub reviewer approval", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const baseline = evaluatePolicyForTest(pr, policyYaml);
    const manualEvidence: PolicyResult["requiredEvidence"] = baseline.requiredEvidence.map(
      (requirement) => ({
        ...requirement,
        status: "approved",
        source: "linked_artifact",
        providedBy: "release-manager",
        providedAt: "2026-06-01T00:00:00.000Z"
      })
    );
    const priorGithubReviewers: PolicyResult["requiredReviewers"] = baseline.requiredReviewers.map(
      (requirement) => ({
        ...requirement,
        approved: true,
        approvalSource: "github_review",
        approvedBy: "alice",
        approvedAt: "2026-06-01T00:06:00.000Z"
      })
    );
    mockChangeControlRecordFindFirst.mockResolvedValue(
      existingRecordFor(pr, baseline, {
        requiredEvidenceJson: manualEvidence,
        requiredReviewersJson: priorGithubReviewers
      })
    );
    const published: PolicyResult[] = [];

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-dismissed-github-approval",
      pr,
      envelope: webhookEnvelope(pr),
      policyYaml,
      githubCheckPublisher: async (input) => {
        published.push(input.result);
        return { id: 702, conclusion: "neutral" };
      }
    });

    expect(published[0]?.requiredEvidence[0]).toMatchObject({
      status: "approved",
      source: "linked_artifact"
    });
    expect(published[0]?.requiredReviewers[0]).toMatchObject({ approved: false });
    expect(published[0]?.requiredReviewers[0]?.approvalSource).toBeUndefined();
    expect(result).toMatchObject({ status: "warn", checkConclusion: "neutral" });
  });

  it.each(["head", "policy"] as const)(
    "invalidates manual state and an active override when the %s changes",
    async (changedRevision) => {
      process.env.DATABASE_URL = "postgresql://localhost:5432/db";
      process.env.NODE_ENV = "development";
      const pr = await loadPr("billing-path.json");
      const policyYaml = await loadPolicy("fintech.yaml");
      const baseline = evaluatePolicyForTest(pr, policyYaml);
      const manualEvidence: PolicyResult["requiredEvidence"] = baseline.requiredEvidence.map(
        (requirement) => ({
          ...requirement,
          status: "approved",
          source: "manual_attestation"
        })
      );
      const manualReviewers: PolicyResult["requiredReviewers"] = baseline.requiredReviewers.map(
        (requirement) => ({
          ...requirement,
          approved: true,
          approvalSource: "manual"
        })
      );
      mockChangeControlRecordFindFirst.mockResolvedValue(
        existingRecordFor(pr, baseline, {
          headSha: changedRevision === "head" ? "superseded-head" : pr.headSha,
          policyVersion:
            changedRevision === "policy" ? "superseded-policy-version" : baseline.policyVersion,
          requiredEvidenceJson: manualEvidence,
          requiredReviewersJson: manualReviewers,
          lifecycle: "overridden",
          decisionJson: {
            status: "override_approved",
            decidedBy: "platform-admin",
            overrideBy: "platform-admin",
            overrideReason: "temporary exception"
          }
        })
      );
      const published: PolicyResult[] = [];

      const result = await processMergeGuardEvaluationJob({
        deliveryId: `delivery-invalidated-${changedRevision}`,
        pr,
        envelope: webhookEnvelope(pr),
        policyYaml,
        githubCheckPublisher: async (input) => {
          published.push(input.result);
          return { id: 703, conclusion: "neutral" };
        }
      });

      expect(published[0]?.requiredEvidence[0]).toMatchObject({ status: "missing" });
      expect(published[0]?.requiredReviewers[0]).toMatchObject({ approved: false });
      expect(result).toMatchObject({
        status: "warn",
        lifecycle: "warned",
        checkConclusion: "neutral"
      });
      const recordUpdate = mockChangeControlRecordUpdateMany.mock.calls[0]?.[0].data;
      expect(recordUpdate).toMatchObject({
        checkStatus: "warn",
        lifecycle: "warned",
        revision: { increment: 1 }
      });
      expect(recordUpdate.decisionJson).not.toMatchObject({
        status: "override_approved"
      });
    }
  );

  it("preserves an active same-head, same-policy override and publishes a passing check", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const baseline = evaluatePolicyForTest(pr, policyYaml);
    const overrideDecision: NonNullable<ChangeControlRecord["decision"]> = {
      status: "override_approved",
      decidedAt: "2026-06-01T01:00:00.000Z",
      decidedBy: "platform-admin",
      overrideBy: "platform-admin",
      overrideReason: "Approved time-bound production exception"
    };
    mockChangeControlRecordFindFirst.mockResolvedValue(
      existingRecordFor(pr, baseline, {
        lifecycle: "overridden",
        decisionJson: overrideDecision
      })
    );
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    const checksCreate = vi.fn().mockResolvedValue({ data: { id: 704 } });
    githubModuleMocks.createGithubClient.mockReturnValue({
      ...githubClientForPr(pr),
      checks: { create: checksCreate }
    });

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-preserve-override",
      envelope: webhookEnvelope(pr),
      policyYaml
    });

    expect(checksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        head_sha: pr.headSha,
        conclusion: "success",
        output: expect.objectContaining({
          title: "AgentForge Merge Guard: Pass"
        })
      })
    );
    expect(result).toMatchObject({
      status: "pass",
      lifecycle: "overridden",
      checkConclusion: "success",
      checkPublished: true
    });
    expect(mockChangeControlRecordUpdateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "record-existing", pullRequestId: "pr", revision: 0 },
      data: {
        checkStatus: "pass",
        lifecycle: "overridden",
        requiredEvidenceJson: [expect.objectContaining({ status: "missing" })],
        requiredReviewersJson: [expect.objectContaining({ approved: false })],
        decisionJson: overrideDecision,
        revision: { increment: 1 }
      }
    });
  });

  it("does not overwrite an existing Change Control Record createdAt", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const baseline = evaluatePolicyForTest(pr, policyYaml);
    const originalCreatedAt = new Date("2025-01-02T03:04:05.000Z");
    mockChangeControlRecordFindFirst.mockResolvedValue(
      existingRecordFor(pr, baseline, { createdAt: originalCreatedAt })
    );
    await processMergeGuardEvaluationJob({
      deliveryId: "delivery-created-at-stability",
      pr,
      envelope: webhookEnvelope(pr),
      policyYaml,
      githubCheckPublisher: async () => ({ id: 705, conclusion: "neutral" })
    });

    const update = mockChangeControlRecordUpdateMany.mock.calls[0]?.[0];
    expect(update.data).not.toHaveProperty("createdAt");
    expect(update).toMatchObject({
      where: { id: "record-existing", pullRequestId: "pr", revision: 0 },
      data: { revision: { increment: 1 } }
    });
    expect(mockChangeControlRecordCreate).not.toHaveBeenCalled();
    expect(originalCreatedAt.toISOString()).toBe("2025-01-02T03:04:05.000Z");
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

    // Hardens the mocked RLS org-binding call in persistWorkerEvaluationSnapshot's
    // transaction beyond "it did not throw": asserts $executeRaw was actually
    // invoked, with a SQL template referencing set_config/agentforge.current_org,
    // bound to this job's own organization id ("org", from the mocked
    // repository.findFirst response above) -- not undefined, and not some other
    // organization's id.
    expect(mockExecuteRawCalls).toHaveLength(1);
    const [{ strings: setConfigStrings, values: setConfigValues }] = mockExecuteRawCalls;
    expect(setConfigStrings.join("")).toContain("set_config");
    expect(setConfigStrings.join("")).toContain("agentforge.current_org");
    expect(setConfigValues).toEqual(["org"]);

    // Call ordering: set_config (the org GUC binding) must run BEFORE
    // evaluation.upsert -- the first model write inside the same interactive
    // transaction -- so the RLS policy is actually in effect for every query
    // that follows it, not applied after the fact.
    expect(mockCallOrder.indexOf("set_config")).toBe(0);
    expect(mockCallOrder.indexOf("evaluation.upsert")).toBeGreaterThan(
      mockCallOrder.indexOf("set_config")
    );
  });

  it("lets exactly one of two truly concurrent publish attempts for the same delivery win the claim", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const policyYaml = await loadPolicy("fintech.yaml");

    // Shared mutable row modeling one webhook delivery. Each updateMany callback
    // performs its predicate check and mutation synchronously, matching a single
    // atomic PostgreSQL compare-and-set statement.
    let row = {
      publishedCheckRunId: null as bigint | null,
      checkConclusion: null as string | null,
      checkPublishedAt: null as Date | null,
      checkPublicationState: "pending",
      checkPublicationClaimId: null as string | null,
      checkPublicationClaimedAt: null as Date | null,
      checkExternalId: null as string | null
    };
    const updateManyCallOrder: string[] = [];

    mockWebhookDeliveryFindUnique.mockImplementation(async () => ({ ...row }));
    mockWebhookDeliveryUpdateMany.mockImplementation(async (args) => {
      if (args.where.checkPublicationState === "pending") {
        if (row.checkPublicationState !== "pending") {
          updateManyCallOrder.push("lost-race");
          return { count: 0 };
        }
        row = { ...row, ...args.data };
        updateManyCallOrder.push("claimed");
        return { count: 1 };
      }
      if (args.where.checkPublicationState === "claimed") {
        if (
          row.checkPublicationState !== "claimed" ||
          row.checkPublicationClaimId !== args.where.checkPublicationClaimId
        ) {
          updateManyCallOrder.push("arm-no-match");
          return { count: 0 };
        }
        row = { ...row, ...args.data };
        updateManyCallOrder.push("armed");
        return { count: 1 };
      }
      if (args.where.checkPublicationState === "creating") {
        if (
          row.checkPublicationState !== "creating" ||
          row.checkPublicationClaimId !== args.where.checkPublicationClaimId
        ) {
          updateManyCallOrder.push("finalize-no-match");
          return { count: 0 };
        }
        row = { ...row, ...args.data };
        updateManyCallOrder.push("finalized");
        return { count: 1 };
      }
      updateManyCallOrder.push("unexpected");
      return { count: 0 };
    });

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

    // Both calls resolve only after the winner's durable check-run id is visible.
    // The loser performs one bounded delayed recheck rather than completing with
    // `checkPublished: false` while another worker still owns a fresh claim.
    expect(resultA.recordId).toBeDefined();
    expect(resultB.recordId).toBeDefined();
    expect(githubCheckPublisher).toHaveBeenCalledTimes(1);
    expect(publishedRunIds).toHaveLength(1);
    expect(resultA.checkPublished).toBe(true);
    expect(resultB.checkPublished).toBe(true);
    expect(resultA.publishedCheckRunId).toBe(publishedRunIds[0]);
    expect(resultB.publishedCheckRunId).toBe(publishedRunIds[0]);

    // Exactly one updateMany call actually claimed the row; confirms the WHERE
    // clause's mutual exclusivity was exercised by both racers, not skipped by one.
    expect(updateManyCallOrder.filter((entry) => entry === "claimed")).toHaveLength(1);
    expect(updateManyCallOrder.filter((entry) => entry === "lost-race")).toHaveLength(1);
  });

  it("does not re-attempt publish when retrying within the claim TTL after a crash between claim and GitHub call", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);

    // Simulates a worker that claimed the row (checkPublicationState "claimed"
    // with a fresh checkPublicationClaimedAt) and then crashed before the
    // GitHub API call completed, so publishedCheckRunId was never written. The
    // claim timestamp is well inside CHECK_PUBLICATION_CLAIM_TTL_MS (5 minutes),
    // so a retry landing now must treat the claim as still "in flight" rather
    // than reclaimable.
    mockWebhookDeliveryFindUnique.mockResolvedValue({
      publishedCheckRunId: null,
      checkConclusion: "neutral",
      checkPublishedAt: null,
      checkPublicationState: "claimed",
      checkPublicationClaimId: "claim-inflight",
      checkPublicationClaimedAt: new Date(Date.now() - 30_000),
      checkExternalId: "agentforge:inflight"
    });

    const published = vi.fn(async () => ({ id: 999, conclusion: "neutral" as const }));

    let claimError: unknown;
    try {
      await processMergeGuardEvaluationJob({
        deliveryId: envelope.deliveryId,
        envelope,
        policyYaml: await loadPolicy("fintech.yaml"),
        githubClient: githubClientForPr(pr),
        githubCheckPublisher: published
      });
    } catch (error) {
      claimError = error;
    }

    expect(claimError).toBeInstanceOf(CheckPublicationClaimPendingError);
    expect((claimError as CheckPublicationClaimPendingError).retryAfterMs).toBeGreaterThan(
      4 * 60 * 1000
    );
    expect((claimError as CheckPublicationClaimPendingError).retryAfterMs).toBeLessThanOrEqual(
      5 * 60 * 1000
    );

    // One bounded delayed recheck is allowed, but the job cannot complete until
    // a real id appears or the lease expires and can be reclaimed.
    expect(mockWebhookDeliveryFindUnique).toHaveBeenCalledTimes(2);
    expect(published).not.toHaveBeenCalled();
    expect(mockWebhookDeliveryUpdateMany).not.toHaveBeenCalled();
  });

  it("reclaims an expired check-publication lease and persists the real check-run id", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const expiredClaim = new Date(Date.now() - 5 * 60 * 1000 - 1);
    mockWebhookDeliveryFindUnique.mockResolvedValue({
      publishedCheckRunId: null,
      checkConclusion: "neutral",
      checkPublishedAt: null,
      checkPublicationState: "claimed",
      checkPublicationClaimId: "claim-expired",
      checkPublicationClaimedAt: expiredClaim,
      checkExternalId: "agentforge:expired"
    });
    const published = vi.fn(async () => ({ id: 1001, conclusion: "neutral" as const }));

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr),
      githubCheckPublisher: published
    });

    expect(published).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checkPublished: true, publishedCheckRunId: 1001 });
    expect(mockWebhookDeliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deliveryId: envelope.deliveryId,
          publishedCheckRunId: null,
          checkPublicationState: "claimed",
          checkPublicationClaimId: "claim-expired",
          checkPublicationClaimedAt: expiredClaim
        }
      })
    );
  });

  it("retries instead of completing when GitHub publication returns no check-run id", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const published = vi.fn(async () => ({ conclusion: "neutral" as const }));

    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: envelope.deliveryId,
        envelope,
        policyYaml: await loadPolicy("fintech.yaml"),
        githubClient: githubClientForPr(pr),
        githubCheckPublisher: published
      })
    ).rejects.toThrow("without a check-run id");

    expect(published).toHaveBeenCalledTimes(1);
    expect(mockWebhookDeliveryUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkPublicationState: "ambiguous" })
      })
    );
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

  it("runs the second freshness check immediately before any current-snapshot persistence", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    const oldPr = await loadPr("billing-path.json");
    const currentPr = { ...oldPr, headSha: "current-head-after-synchronize" };
    const request = {
      owner: "acme",
      repo: "payments",
      pull_number: oldPr.pullRequestNumber
    };
    const oldHeadResponse = await githubClientForPr(oldPr).pulls.get(request);
    const currentHeadResponse = await githubClientForPr(currentPr).pulls.get(request);
    const githubClient = githubClientForPr(oldPr);
    const pullsGet = vi
      .spyOn(githubClient.pulls, "get")
      .mockResolvedValueOnce(oldHeadResponse)
      .mockResolvedValueOnce(currentHeadResponse);
    const published = vi.fn();

    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-stale-before-persist",
      pr: oldPr,
      envelope: {
        ...webhookEnvelope(oldPr, { action: "synchronize" }),
        deliveryId: "delivery-stale-before-persist"
      },
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient,
      githubCheckPublisher: published
    });

    expect(result).toMatchObject({
      recordId: "superseded_head:delivery-stale-before-persist",
      checkPublished: false
    });
    expect(pullsGet).toHaveBeenCalledTimes(2);
    expect(mockChangeControlRecordFindFirst).toHaveBeenCalledTimes(1);
    expect(published).not.toHaveBeenCalled();
    expect(mockOrganizationUpsert).not.toHaveBeenCalled();
    expect(mockRepositoryUpsert).not.toHaveBeenCalled();
    expect(mockPullRequestUpsert).not.toHaveBeenCalled();
    expect(mockChangeControlRecordCreate).not.toHaveBeenCalled();
    expect(mockEvaluationUpsert).not.toHaveBeenCalled();
    expect(mockWebhookDeliveryUpdateMany).not.toHaveBeenCalled();
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

  it("wraps genuinely non-retryable queue failures in BullMQ UnrecoverableError", async () => {
    let thrown: unknown;
    try {
      await processMergeGuardEvaluationQueueJob({ deliveryId: "delivery-unrecoverable" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    const summary = classifyMergeGuardEvaluationFailure({
      error: thrown,
      deliveryId: "delivery-unrecoverable",
      attemptsMade: 1,
      maxAttempts: 3
    });
    expect(summary).toMatchObject({ retryable: false, terminalFailure: true });
  });

  it("preserves ordinary retry behavior for transient queue failures", async () => {
    const pr = await loadPr("billing-path.json");
    const transient = new Error("GitHub API timeout while fetching files");
    const githubClient = githubClientForPr(pr);
    vi.spyOn(githubClient.pulls, "get").mockRejectedValue(transient);

    await expect(
      processMergeGuardEvaluationQueueJob({
        deliveryId: "delivery-retryable-timeout",
        envelope: webhookEnvelope(pr),
        policyYaml: await loadPolicy("fintech.yaml"),
        githubClient
      })
    ).rejects.toBe(transient);
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
      where: {
        deliveryId: "delivery-record-failure",
        completedAt: null,
        deliveryStatus: { not: "completed" }
      },
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

  it("guards delayed active/failure writes and makes completion clear terminal failure state", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { webhookDelivery: { updateMany } } as never;
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error("terminal failure"),
      deliveryId: "delivery-completion-wins",
      attemptsMade: 3,
      maxAttempts: 3
    });

    await markWebhookDeliveryProcessing(prisma, "delivery-completion-wins");
    await recordMergeGuardEvaluationFailure({
      prisma,
      deliveryId: "delivery-completion-wins",
      summary
    });
    await markWebhookDeliveryCompleted(prisma, "delivery-completion-wins");

    expect(updateMany.mock.calls[0]?.[0].where).toEqual({
      deliveryId: "delivery-completion-wins",
      completedAt: null,
      deliveryStatus: { not: "completed" }
    });
    expect(updateMany.mock.calls[1]?.[0].where).toEqual({
      deliveryId: "delivery-completion-wins",
      completedAt: null,
      deliveryStatus: { not: "completed" }
    });
    expect(updateMany.mock.calls[2]?.[0]).toEqual({
      where: { deliveryId: "delivery-completion-wins" },
      data: {
        deliveryStatus: "completed",
        completedAt: expect.any(Date),
        evaluationTerminalFailure: false,
        lastFailureClass: null,
        lastFailureMessage: null,
        lastFailureCorrelationId: null,
        lastFailedAt: null
      }
    });
  });

  describe("publishTerminalFailureCheckRun", () => {
    it("publishes exactly one failure/neutral check-run for a job that has exhausted all retries (terminalFailure: true)", async () => {
      const pr = await loadPr("billing-path.json");
      const config = loadConfig();
      const publishedChecks: Array<{ result: PolicyResult }> = [];
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("GitHub API unreachable"),
        deliveryId: "delivery-terminal-check-run",
        attemptsMade: 3,
        maxAttempts: 3
      });
      expect(summary.terminalFailure).toBe(true);

      await publishTerminalFailureCheckRun({
        job: {
          data: {
            deliveryId: "delivery-terminal-check-run",
            pr,
            githubCheckPublisher: async (input) => {
              publishedChecks.push({ result: input.result });
              return { id: 77, conclusion: "failure" as const };
            }
          }
        },
        config,
        summary
      });

      expect(publishedChecks).toHaveLength(1);
      expect(publishedChecks[0]?.result.status).toBe("block");
      expect(publishedChecks[0]?.result.explanation.join(" ")).toContain(
        "could not evaluate this pull request after 3"
      );
    });

    it("publishes from the API envelope-only payload with a real installation client", async () => {
      const pr = await loadPr("billing-path.json");
      const envelope = webhookEnvelope(pr);
      const baseConfig = loadConfig();
      const config = {
        ...baseConfig,
        github: {
          ...baseConfig.github,
          appId: "123",
          privateKey: "test-private-key"
        }
      };
      const checksCreate = vi.fn().mockResolvedValue({ data: { id: 812 } });
      githubModuleMocks.createGithubClient.mockReturnValue({
        checks: { create: checksCreate }
      });
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("policy validation failed: invalid mode"),
        deliveryId: envelope.deliveryId,
        attemptsMade: 1,
        maxAttempts: 3
      });
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await publishTerminalFailureCheckRun({
        job: { data: { deliveryId: envelope.deliveryId, envelope } },
        config,
        prisma: {
          gitHubInstallation: { findUnique: mockGithubInstallationFindUnique },
          webhookDelivery: {
            findUnique: mockWebhookDeliveryFindUnique,
            updateMany: mockWebhookDeliveryUpdateMany
          }
        } as never,
        summary
      });

      expect(githubModuleMocks.createGithubInstallationToken).toHaveBeenCalledWith({
        appId: "123",
        privateKey: "test-private-key",
        installationId: envelope.installationId
      });
      expect(githubModuleMocks.createGithubClient).toHaveBeenCalledWith("installation-token");
      expect(checksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: envelope.repository?.owner,
          repo: envelope.repository?.name,
          head_sha: envelope.pullRequest?.headSha,
          conclusion: "failure"
        })
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Published Merge Guard terminal-failure check-run",
        expect.objectContaining({
          repositoryFullName: envelope.repository?.fullName,
          pullRequestNumber: envelope.pullRequest?.number,
          published: true
        })
      );
      consoleLogSpy.mockRestore();
    });

    it('is gated on terminalFailure in the worker.on("failed") handler, so a job with attemptsMade < maxAttempts (still eligible to retry) never reaches this publish path', async () => {
      // The actual call site (`if (job && summary.terminalFailure) { void
      // publishTerminalFailureCheckRun(...); ... }` inside worker.on("failed",
      // ...) in startWorker) is not independently invokable without a live
      // BullMQ Worker/Job pair. What IS directly testable, and is the exact
      // boolean condition that call site branches on, is
      // classifyMergeGuardEvaluationFailure's own terminalFailure computation
      // (`!retryable || attemptsMade >= maxAttempts`) -- asserting that a
      // still-retryable failure classifies as non-terminal is what proves the
      // gate would not have called publishTerminalFailureCheckRun at all for
      // this job, matching how computeBackoffDelay is unit tested directly
      // above rather than via a live Worker's backoffStrategy hook.
      const stillRetryingSummary = classifyMergeGuardEvaluationFailure({
        error: new Error("GitHub API timeout while fetching files"),
        deliveryId: "delivery-still-retrying",
        attemptsMade: 1,
        maxAttempts: 3
      });

      expect(stillRetryingSummary.terminalFailure).toBe(false);
    });

    it("publishes a check-run with a failure/neutral conclusion, never a passing one, for the terminal-failure case", async () => {
      const pr = await loadPr("billing-path.json");
      const config = loadConfig();
      const publishedConclusions: Array<CheckRunPayload["conclusion"] | undefined> = [];
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("policy validation failed: invalid mode"),
        deliveryId: "delivery-terminal-conclusion",
        attemptsMade: 1,
        maxAttempts: 3
      });
      expect(summary.terminalFailure).toBe(true);

      await publishTerminalFailureCheckRun({
        job: {
          data: {
            deliveryId: "delivery-terminal-conclusion",
            pr,
            githubCheckPublisher: async (input) => {
              publishedConclusions.push(input.result.status === "block" ? "failure" : "neutral");
              return { id: 79, conclusion: "failure" as const };
            }
          }
        },
        config,
        summary
      });

      expect(publishedConclusions).toEqual(["failure"]);
    });

    it("does not throw when the check-run publish itself fails (e.g. GitHub unreachable), logging instead of crashing the caller", async () => {
      const pr = await loadPr("billing-path.json");
      const config = loadConfig();
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("boom"),
        deliveryId: "delivery-publish-throws",
        attemptsMade: 3,
        maxAttempts: 3
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        publishTerminalFailureCheckRun({
          job: {
            data: {
              deliveryId: "delivery-publish-throws",
              pr,
              githubCheckPublisher: async () => {
                throw new Error("GitHub API unreachable");
              }
            }
          },
          config,
          summary
        })
      ).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to publish Merge Guard terminal-failure check-run",
        expect.objectContaining({ deliveryId: "delivery-publish-throws" })
      );
      consoleErrorSpy.mockRestore();
    });

    it("skips publication without throwing when the failed job has no pull request payload to publish against", async () => {
      const config = loadConfig();
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("requires a pull request payload"),
        deliveryId: "delivery-no-pr-payload",
        attemptsMade: 3,
        maxAttempts: 3
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        publishTerminalFailureCheckRun({
          job: { data: { deliveryId: "delivery-no-pr-payload" } },
          config,
          summary
        })
      ).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("no pull request payload"),
        expect.objectContaining({ deliveryId: "delivery-no-pr-payload" })
      );
      consoleErrorSpy.mockRestore();
    });
  });

  describe("postWorkerFailureAlert", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("POSTs the expected payload shape to AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL when it is set", async () => {
      process.env.AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL = "https://alerts.example.com/hooks/worker";
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const pr = await loadPr("billing-path.json");
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("GitHub API unreachable"),
        deliveryId: "delivery-alert-webhook",
        attemptsMade: 3,
        maxAttempts: 3,
        failedAt: "2026-05-19T00:00:00.000Z"
      });

      await postWorkerFailureAlert({
        job: { id: "job-42", data: { deliveryId: "delivery-alert-webhook", pr } },
        summary
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://alerts.example.com/hooks/worker");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        jobId: "job-42",
        deliveryId: "delivery-alert-webhook",
        repositoryFullName: pr.repositoryFullName,
        pullRequestNumber: pr.pullRequestNumber,
        errorClass: "Error",
        errorMessage: "GitHub API unreachable",
        attemptsMade: 3,
        maxAttempts: 3,
        failedAt: "2026-05-19T00:00:00.000Z"
      });
    });

    it("does not call fetch, and does not throw, when AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL is unset", async () => {
      delete process.env.AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const pr = await loadPr("billing-path.json");
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("boom"),
        deliveryId: "delivery-no-webhook-configured",
        attemptsMade: 3,
        maxAttempts: 3
      });

      await expect(
        postWorkerFailureAlert({
          job: { id: "job-43", data: { deliveryId: "delivery-no-webhook-configured", pr } },
          summary
        })
      ).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not propagate or crash the caller when the alerting POST itself rejects (e.g. network failure)", async () => {
      process.env.AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL = "https://alerts.example.com/hooks/worker";
      const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed: network unreachable"));
      vi.stubGlobal("fetch", fetchMock);
      const pr = await loadPr("billing-path.json");
      const summary = classifyMergeGuardEvaluationFailure({
        error: new Error("boom"),
        deliveryId: "delivery-alert-post-rejects",
        attemptsMade: 3,
        maxAttempts: 3
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        postWorkerFailureAlert({
          job: { id: "job-44", data: { deliveryId: "delivery-alert-post-rejects", pr } },
          summary
        })
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to POST Merge Guard worker failure alert webhook",
        expect.objectContaining({ deliveryId: "delivery-alert-post-rejects" })
      );
      consoleErrorSpy.mockRestore();
    });
  });

  it("generates AI pre-drafts and persists them inside requiredEvidenceJson when llmFeatures is enabled", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/db";
    process.env.NODE_ENV = "development";
    process.env.LLM_FEATURES = "true";

    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);


    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr)
    });

    expect(result.status).toBe("warn");
    expect(mockChangeControlRecordCreate).toHaveBeenCalled();

    const createData = mockChangeControlRecordCreate.mock.calls[0]?.[0].data;

    expect(createData).toMatchObject({ revision: 0 });
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

    it("uses the publication lease duration instead of exhausting generic retries early", () => {
      const delay = computeBackoffDelay(
        1,
        "exponentialWithJitter",
        new CheckPublicationClaimPendingError("delivery-lease-backoff", 271_234),
        { opts: { backoff: { delay: 30_000 } } }
      );

      expect(delay).toBe(271_234);
    });

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
