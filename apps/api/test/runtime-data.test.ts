import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { createApp, createInitialState } from "../src/index.js";

const policyYaml = `
version: 1
policy_pack_id: runtime-test
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
`;

const pullRequest: PullRequestInput = {
  repositoryFullName: "runtime/payments",
  pullRequestNumber: 7,
  title: "Update billing code",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "feature/billing-code",
  headSha: "sha-runtime",
  body: "",
  changedFiles: [
    {
      filename: "src/billing/checkout.ts",
      status: "modified",
      patch: "@@\n-export const limit = 10\n+export const limit = 20"
    }
  ]
};

describe("runtime data surfaces", () => {
  it("starts empty and only exposes repository policy after explicit runtime save", async () => {
    const state = createInitialState();
    const app = createApp(state);

    const emptyRepositories = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(emptyRepositories.statusCode).toBe(200);
    expect(emptyRepositories.json().repositories).toEqual([]);

    const emptyRecords = await app.inject({ method: "GET", url: "/api/dashboard/records" });
    expect(emptyRecords.statusCode).toBe(200);
    expect(emptyRecords.json().records).toEqual([]);

    const preview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: pullRequest }),
      headers: { "content-type": "application/json" }
    });
    expect(preview.statusCode).toBe(200);
    const record = preview.json().record;
    expect(record.repositoryFullName).toBe("runtime/payments");
    expect(record.repositoryId).toMatch(/^repo_[a-f0-9]{12}$/);

    const repositories = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(repositories.json().repositories).toEqual([
      expect.objectContaining({
        id: record.repositoryId,
        fullName: "runtime/payments",
        enabled: true
      })
    ]);

    const missingPolicy = await app.inject({
      method: "GET",
      url: `/api/repositories/${record.repositoryId}/policy`
    });
    expect(missingPolicy.statusCode).toBe(404);

    const savedPolicy = await app.inject({
      method: "PUT",
      url: `/api/repositories/${record.repositoryId}/policy`,
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    expect(savedPolicy.statusCode).toBe(200);

    const activePolicy = await app.inject({
      method: "GET",
      url: `/api/repositories/${record.repositoryId}/policy`
    });
    expect(activePolicy.statusCode).toBe(200);
    expect(activePolicy.json()).toEqual(
      expect.objectContaining({
        repositoryId: record.repositoryId,
        policy: policyYaml,
        policyPackId: "runtime-test",
        policyPackVersion: "1.0.0",
        mode: "warn"
      })
    );

    await app.close();
  });
});
