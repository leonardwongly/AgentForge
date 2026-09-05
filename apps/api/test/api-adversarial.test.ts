import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeControlRecord, PullRequestInput } from "@agentforge/core";
import { hashPolicy } from "@agentforge/policy";
import { createApp, createInitialState } from "../src/index.js";

const policyYaml = `
version: 1
policy_pack_id: api-adversarial
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
`;

const productionEnvKeys = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_PROXY_SECRET",
  "AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS",
  "AGENTFORGE_DASHBOARD_PROXY_SECRET",
  "AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS"
] as const;
const originalEnv = new Map<string, string | undefined>(
  productionEnvKeys.map((key) => [key, process.env[key]])
);

function actorHeaders(organizationId: string): Record<string, string> {
  return {
    "x-agentforge-actor": "api-adversary",
    "x-agentforge-role": "auditor",
    "x-agentforge-organization": organizationId
  };
}

function pullRequest(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    repositoryFullName: "acme/api-adversarial",
    pullRequestNumber: 7,
    title: "Adversarial fixture",
    authorLogin: "fixture-author",
    baseBranch: "main",
    headBranch: "feature/adversarial",
    headSha: "sha-adversarial",
    body: "",
    changedFiles: [
      {
        filename: "src/example.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1 +1 @@\n+export const changed = true;"
      }
    ],
    ...overrides
  };
}

function repositoryRecord(
  repositoryId: string,
  organizationId: string,
  repositoryFullName: string
): ChangeControlRecord {
  const now = new Date().toISOString();
  return {
    id: `${repositoryId}:record`,
    revision: 0,
    organizationId,
    repositoryId,
    repositoryFullName,
    pullRequestNumber: 1,
    headSha: "seed-sha",
    baseBranch: "main",
    mode: "warn",
    policyVersion: "api-adversarial@1.0.0",
    policyPackId: "api-adversarial",
    policyPackVersion: "1.0.0",
    verifiedFindings: [],
    requiredEvidence: [],
    requiredReviewers: [],
    checkStatus: "pass",
    lifecycle: "passed",
    createdAt: now,
    updatedAt: now
  };
}

function repositoryPolicy(repositoryId: string) {
  return {
    repositoryId,
    version: "api-adversarial@1.0.0",
    mode: "warn" as const,
    contentYaml: policyYaml,
    contentHash: hashPolicy(policyYaml),
    createdBy: "test",
    createdAt: new Date().toISOString(),
    policyPackId: "api-adversarial",
    policyPackVersion: "1.0.0"
  };
}

function setProductionRedisEnv() {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/agentforge";
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  process.env.GITHUB_WEBHOOK_SECRET = "production-secret-32-characters-long";
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "test",
    "-----END PRIVATE KEY-----"
  ].join("\n");
  process.env.GITHUB_APP_SLUG = "agentforge-test";
  process.env.GITHUB_CLIENT_ID = "Iv1.test";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
  process.env.SESSION_SECRET = "session-secret-32-characters-long";
  process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
  process.env.AGENTFORGE_API_PROXY_SECRET = "test-proxy-secret-32-characters-long";
  process.env.AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS = "true";
  process.env.AGENTFORGE_DASHBOARD_PROXY_SECRET = "test-dashboard-proxy-secret-123456";
  process.env.AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS = "true";
}

afterEach(() => {
  for (const key of productionEnvKeys) {
    const originalValue = originalEnv.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("API adversarial boundaries", () => {
  it.each([
    ["missing changedFiles", { ...pullRequest(), changedFiles: undefined }],
    ["null changedFiles", { ...pullRequest(), changedFiles: null }],
    ["null changed-file entry", { ...pullRequest(), changedFiles: [null] }],
    [
      "oversized patch",
      {
        ...pullRequest(),
        changedFiles: [{ ...pullRequest().changedFiles[0], patch: "x".repeat(200_001) }]
      }
    ]
  ])("rejects %s without evaluating or mutating state", async (_label, malformedPr) => {
    process.env.NODE_ENV = "test";
    const state = createInitialState();
    const app = createApp(state);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/policies/preview",
        payload: JSON.stringify({ contentYaml: policyYaml, pr: malformedPr }),
        headers: { "content-type": "application/json" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "Invalid policy preview input" });
      expect(state.records).toHaveLength(0);
      expect(state.auditEvents).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("resolves stored policy by both repository name and actor tenant", async () => {
    process.env.NODE_ENV = "test";
    const state = createInitialState();
    const fullName = "acme/shared-repository";
    state.records = [
      repositoryRecord("repository-a", "organization-a", fullName),
      repositoryRecord("repository-b", "organization-b", fullName)
    ];
    state.repositoryPolicies.set("repository-a", repositoryPolicy("repository-a"));
    state.repositoryPolicies.set("repository-b", repositoryPolicy("repository-b"));
    const app = createApp(state);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/policies/preview",
        payload: JSON.stringify({
          pr: pullRequest({ repositoryFullName: fullName }),
          persist: false
        }),
        headers: { "content-type": "application/json", ...actorHeaders("organization-b") }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        persisted: false,
        record: {
          organizationId: "organization-b",
          repositoryId: "repository-b"
        }
      });
      expect(state.auditEvents.at(-1)).toMatchObject({
        organizationId: "organization-b",
        repositoryId: "repository-b",
        action: "policy_previewed"
      });
    } finally {
      await app.close();
    }
  });

  it("settles an unreachable Redis queue before close without an unhandled rejection", async () => {
    setProductionRedisEnv();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.prependListener("unhandledRejection", onUnhandledRejection);
    const app = createApp(createInitialState(), { prisma: undefined });

    try {
      await app.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
  });
});
