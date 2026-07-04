import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { createApp, createInitialState } from "../src/index.js";

function policyYamlV1(tag: string): string {
  return `
version: 1
policy_pack_id: revert-test-${tag}
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
`;
}

function policyYamlV2(tag: string): string {
  return `
version: 1
policy_pack_id: revert-test-${tag}
policy_pack_version: 1.0.0
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "billing-owner"
`;
}

function actorHeaders(
  actor: string,
  role: string,
  organizationId = "org_local"
): Record<string, string> {
  return {
    "x-agentforge-actor": actor,
    "x-agentforge-role": role,
    "x-agentforge-organization": organizationId
  };
}

function sensitivePr(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    repositoryFullName: "acme/revert-fixture",
    pullRequestNumber: 1,
    title: "Fixture PR",
    authorLogin: "fixture-author",
    baseBranch: "main",
    headBranch: "feature/fixture",
    headSha: "sha-fixture",
    body: "",
    changedFiles: [
      {
        filename: "src/billing/checkout.ts",
        status: "modified",
        patch: "@@\n+const noop = true;",
        previousContent: "export const before = true;",
        currentContent: "export const after = true;"
      }
    ],
    ...overrides
  };
}

async function seedRepositoryWithTwoVersions(options: {
  state: ReturnType<typeof createInitialState>;
  repositoryFullName: string;
  organizationId?: string;
}) {
  const { state, repositoryFullName, organizationId = "org_local" } = options;
  const app = createApp(state);
  // Derive distinguishing YAML content per repository so deterministic
  // version strings/content hashes never collide across repositories in
  // these tests, which would otherwise mask cross-tenant lookup bugs.
  const tag = repositoryFullName.replace(/[^a-z0-9]/gi, "-");
  const yamlV1 = policyYamlV1(tag);
  const yamlV2 = policyYamlV2(tag);

  // Establish the repository (and its organization association) the same way
  // the rest of the security-hardening suite does: a persisted policy preview
  // creates a Change Control Record for this repository/org before any
  // policy-version endpoints can resolve repositoryOrganizationId for it.
  const preview = await app.inject({
    method: "POST",
    url: "/api/policies/preview",
    payload: JSON.stringify({
      contentYaml: yamlV1,
      pr: sensitivePr({ repositoryFullName }),
      persist: true
    }),
    headers: {
      "content-type": "application/json",
      ...actorHeaders("alex", "platform_admin", organizationId)
    }
  });
  expect(preview.statusCode).toBe(200);
  const repositoryId = state.records.find(
    (record) => record.repositoryFullName === repositoryFullName
  )?.repositoryId;
  if (!repositoryId) {
    throw new Error(`Expected a Change Control Record to be created for ${repositoryFullName}.`);
  }

  const v1 = await app.inject({
    method: "PUT",
    url: `/api/repositories/${repositoryId}/policy`,
    payload: JSON.stringify({ contentYaml: yamlV1 }),
    headers: {
      "content-type": "application/json",
      ...actorHeaders("alex", "platform_admin", organizationId)
    }
  });
  expect(v1.statusCode).toBe(200);
  const v1Version = v1.json().version as string;

  const v2 = await app.inject({
    method: "PUT",
    url: `/api/repositories/${repositoryId}/policy`,
    payload: JSON.stringify({ contentYaml: yamlV2 }),
    headers: {
      "content-type": "application/json",
      ...actorHeaders("alex", "platform_admin", organizationId)
    }
  });
  expect(v2.statusCode).toBe(200);
  const v2Version = v2.json().version as string;

  const versionsResponse = await app.inject({
    method: "GET",
    url: `/api/repositories/${repositoryId}/policy/versions`,
    headers: actorHeaders("alex", "platform_admin", organizationId)
  });
  expect(versionsResponse.statusCode).toBe(200);
  const versions = versionsResponse.json().versions as Array<{
    id: string;
    version: string;
    mode: string;
    createdAt: string;
    createdBy: string;
    contentHash: string;
  }>;
  const v1Entry = versions.find((entry) => entry.version === v1Version);
  const v2Entry = versions.find((entry) => entry.version === v2Version);
  if (!v1Entry || !v2Entry) {
    throw new Error("Expected both seeded policy versions to appear in version history.");
  }

  return { app, repositoryId, v1Entry, v2Entry, versions };
}

describe("policy version history and revert", () => {
  it("lists policy versions most-recent-first without exposing full contentYaml", async () => {
    const state = createInitialState();
    const { versions } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-history"
    });

    expect(versions).toHaveLength(2);
    expect(versions[0]!.createdAt >= versions[1]!.createdAt).toBe(true);
    for (const entry of versions) {
      expect(entry).not.toHaveProperty("contentYaml");
      expect(entry).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          version: expect.any(String),
          mode: expect.any(String),
          createdAt: expect.any(String),
          createdBy: expect.any(String),
          contentHash: expect.any(String)
        })
      );
    }
  });

  it("rejects unauthenticated and under-privileged requests to list versions", async () => {
    const state = createInitialState();
    const { app, repositoryId } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-history-auth"
    });

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/policy/versions`
    });
    expect(unauthenticated.statusCode).toBe(401);

    const crossTenant = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/policy/versions`,
      headers: actorHeaders("brenda", "auditor", "org-b")
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it("reverts to a prior version, creating a new immutable version with the old content and a policy_reverted audit event", async () => {
    const state = createInitialState();
    const { app, repositoryId, v1Entry, v2Entry } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-revert-success"
    });

    const activeBeforeRevert = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/policy`,
      headers: actorHeaders("alex", "platform_admin")
    });
    expect(activeBeforeRevert.json().version).toBe(v2Entry.version);
    expect(activeBeforeRevert.json().mode).toBe("enforce");

    const revert = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: v1Entry.id }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("alex", "platform_admin")
      }
    });
    expect(revert.statusCode).toBe(200);
    const revertBody = revert.json();
    expect(revertBody.revertedFromVersion).toBe(v1Entry.version);
    // The reverted version string is deterministically derived from content
    // (policyPackId@policyPackVersion+contentHash prefix), so reverting to
    // byte-identical content reproduces v1's version string -- this is
    // expected, not a bug. What matters for the append-only guarantee is
    // that a brand-new row was created (new id, new createdAt), which is
    // asserted below via the version-history length and audit event.
    expect(revertBody.version).toBe(v1Entry.version);

    const activeAfterRevert = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/policy`,
      headers: actorHeaders("alex", "platform_admin")
    });
    expect(activeAfterRevert.statusCode).toBe(200);
    // The reverted-to content (v1's mode) is now active again, under a new version id.
    expect(activeAfterRevert.json().mode).toBe("warn");
    expect(activeAfterRevert.json().version).toBe(revertBody.version);

    const versionsAfterRevert = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/policy/versions`,
      headers: actorHeaders("alex", "platform_admin")
    });
    const allVersions = versionsAfterRevert.json().versions as Array<{
      id: string;
      version: string;
    }>;
    // All three rows (v1, v2, and the new reverted row) must exist as
    // distinct history entries -- proving the revert appended a new row
    // rather than mutating or deleting existing history, even though the
    // reverted row's deterministic version *string* matches v1's.
    expect(allVersions).toHaveLength(3);
    const distinctIds = new Set(allVersions.map((entry) => entry.id));
    expect(distinctIds.size).toBe(3);
    expect(allVersions.filter((entry) => entry.version === v1Entry.version)).toHaveLength(2);

    expect(state.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "policy_reverted",
          organizationId: "org_local",
          repositoryId,
          actor: "alex",
          actorRole: "platform_admin",
          policyVersion: revertBody.version,
          metadataJson: expect.objectContaining({
            revertedFromVersion: v1Entry.version
          })
        })
      ])
    );
  });

  it("rejects reverting to a version that belongs to a different repository or organization (404, not leaked)", async () => {
    const state = createInitialState();
    const { v1Entry: repoAVersion } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-a",
      organizationId: "org-a"
    });
    const { app, repositoryId: repositoryBId } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-b",
      organizationId: "org-b"
    });

    // Same org as repo-a, but targeting repo-b: the actor is not a member of
    // repo-b's organization (org-b), so the organization-access check
    // rejects the request before the version lookup would even run.
    const crossRepository = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryBId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: repoAVersion.id }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("brenda", "platform_admin", "org-a")
      }
    });
    expect(crossRepository.statusCode).toBe(403);

    // An org-b actor targeting repo-b with a version id that only exists
    // under repo-a must not resolve, and must not leak repo-a's existence.
    const crossRepositorySameOrgActor = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryBId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: repoAVersion.id }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("bailey", "platform_admin", "org-b")
      }
    });
    expect(crossRepositorySameOrgActor.statusCode).toBe(404);
    expect(crossRepositorySameOrgActor.json().error).not.toContain(repoAVersion.version);
  });

  it("rejects reverting without sufficient role (403)", async () => {
    const state = createInitialState();
    const { app, repositoryId, v1Entry } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-revert-role"
    });

    const insufficientRole = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: v1Entry.id }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("sam", "developer")
      }
    });
    expect(insufficientRole.statusCode).toBe(403);

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: v1Entry.id }),
      headers: { "content-type": "application/json" }
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("rejects reverting to a non-existent version (404)", async () => {
    const state = createInitialState();
    const { app, repositoryId } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-revert-missing"
    });

    const missing = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: "does-not-exist" }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("alex", "platform_admin")
      }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a malformed revert request body (400)", async () => {
    const state = createInitialState();
    const { app, repositoryId } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-revert-bad-body"
    });

    const missingField = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/policy/revert`,
      payload: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("alex", "platform_admin")
      }
    });
    expect(missingField.statusCode).toBe(400);
  });

  it("rejects a revert whose stored content fails current schema re-validation (400) instead of silently applying it", async () => {
    const state = createInitialState();
    const { app, repositoryId, v1Entry } = await seedRepositoryWithTwoVersions({
      state,
      repositoryFullName: "acme/repo-revert-invalid"
    });

    // Simulate schema drift: the stored version's contentYaml no longer
    // passes validation against the current policy schema (e.g. an
    // unrecognized/invalid mode value that validatePolicyYaml will reject).
    const historyMap = state.repositoryPolicyHistory.get(repositoryId) ?? [];
    const corruptedEntry = historyMap.find((entry) => entry.version === v1Entry.version);
    if (!corruptedEntry) {
      throw new Error("Expected seeded v1 entry in in-memory policy history.");
    }
    corruptedEntry.contentYaml = corruptedEntry.contentYaml.replace(
      "mode: warn",
      "mode: not-a-real-mode"
    );

    const revert = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/policy/revert`,
      payload: JSON.stringify({ targetVersionId: v1Entry.id }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("alex", "platform_admin")
      }
    });
    expect(revert.statusCode).toBe(400);

    // The corrupted content must never have become the active policy.
    const active = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/policy`,
      headers: actorHeaders("alex", "platform_admin")
    });
    expect(active.json().mode).not.toBe("not-a-real-mode");
  });
});
