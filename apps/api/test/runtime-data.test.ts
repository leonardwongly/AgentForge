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
  it("exposes a readiness endpoint for deployment smoke checks", async () => {
    const state = createInitialState();
    const app = createApp(state);

    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual(
      expect.objectContaining({
        status: "ready",
        runtimeStore: "in_memory",
        database: expect.stringMatching(/^(configured|not_configured)$/u),
        workerQueue: expect.stringMatching(/^(configured|in_memory)$/u),
        version: "0.1.0"
      })
    );

    await app.close();
  });

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
    expect(preview.json().persisted).toBe(false);
    const stillEmptyRecords = await app.inject({ method: "GET", url: "/api/dashboard/records" });
    expect(stillEmptyRecords.json().records).toEqual([]);

    const persistedPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: pullRequest, persist: true }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    expect(persistedPreview.statusCode).toBe(200);
    const record = persistedPreview.json().record;
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

  it("persists repository settings and configured owner mappings", async () => {
    const state = createInitialState();
    const app = createApp(state);
    const preview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: pullRequest, persist: true }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    const record = preview.json().record;

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

    const update = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${record.repositoryId}/settings`,
      payload: JSON.stringify({
        enabled: false,
        mode: "optimize",
        dataHandling: {
          fullDiffRetention: "7d",
          llmFeatures: false,
          auditRecordRetentionDays: 730
        },
        ownerMappings: [
          {
            ownerKey: "billing_owner",
            reviewer: "billing-owner",
            reviewerType: "team"
          },
          {
            ownerKey: "security_team",
            reviewer: "security-team",
            reviewerType: "team"
          }
        ]
      }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual(
      expect.objectContaining({
        repository: expect.objectContaining({
          enabled: false,
          mode: "optimize",
          dataHandling: expect.objectContaining({
            fullDiffRetention: "7d",
            auditRecordRetentionDays: 730
          })
        }),
        ownerMappings: expect.arrayContaining([
          expect.objectContaining({
            ownerKey: "billing_owner",
            reviewer: "billing-owner",
            reviewerType: "team"
          })
        ])
      })
    );

    const repositories = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(repositories.json().repositories[0]).toEqual(
      expect.objectContaining({
        id: record.repositoryId,
        enabled: false,
        mode: "optimize",
        dataHandling: expect.objectContaining({ fullDiffRetention: "7d" })
      })
    );

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().ownerMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKey: "security_team",
          reviewer: "security-team",
          sources: [record.repositoryId]
        })
      ])
    );

    const onboarding = await app.inject({ method: "GET", url: "/api/onboarding/status" });
    expect(onboarding.json().steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "map_owners",
          status: "complete"
        })
      ])
    );

    const activePolicyPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ pr: pullRequest }),
      headers: { "content-type": "application/json" }
    });
    expect(activePolicyPreview.statusCode).toBe(200);
    expect(activePolicyPreview.json().result).toEqual(
      expect.objectContaining({
        mode: "optimize",
        status: "block"
      })
    );

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    expect(audit.json().auditEvents.map((event: { action: string }) => event.action)).toEqual(
      expect.arrayContaining([
        "repository_settings_changed",
        "retention_changed",
        "owner_mapping_changed"
      ])
    );

    await app.close();
  });

  it("scopes repository PR Change Control Record lookup by repository id and PR number", async () => {
    const state = createInitialState();
    const app = createApp(state);
    const first = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: pullRequest, persist: true }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    const secondPr: PullRequestInput = {
      ...pullRequest,
      repositoryFullName: "runtime/ledger",
      title: "Update ledger billing code",
      headSha: "sha-runtime-ledger"
    };
    const second = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: secondPr, persist: true }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    const firstRecord = first.json().record;
    const secondRecord = second.json().record;

    const firstLookup = await app.inject({
      method: "GET",
      url: `/api/repositories/${firstRecord.repositoryId}/pull-requests/${pullRequest.pullRequestNumber}/change-control-record`
    });
    const secondLookup = await app.inject({
      method: "GET",
      url: `/api/repositories/${secondRecord.repositoryId}/pull-requests/${pullRequest.pullRequestNumber}/change-control-record`
    });

    expect(firstLookup.json().record.repositoryFullName).toBe("runtime/payments");
    expect(secondLookup.json().record.repositoryFullName).toBe("runtime/ledger");

    await app.close();
  });

  it("rejects malformed repository settings without mutating runtime state", async () => {
    const state = createInitialState();
    const app = createApp(state);
    const preview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: pullRequest, persist: true }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    const record = preview.json().record;

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${record.repositoryId}/settings`,
      payload: JSON.stringify({
        dataHandling: { fullDiffRetention: "forever" },
        ownerMappings: [{ ownerKey: "../billing", reviewer: "billing-owner", reviewerType: "team" }]
      }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "alex",
        "x-agentforge-role": "platform_admin"
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(state.ownerMappings).toEqual([]);

    await app.close();
  });
});
