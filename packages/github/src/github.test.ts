import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCheckRunPayload,
  enrichPullRequestReviewsWithTeamMemberships,
  fetchPullRequestInputFromGithub,
  MERGE_GUARD_CHECK_NAME,
  normalizeGithubWebhook,
  pullRequestInputFromFixture,
  shouldEnqueueEvaluation,
  verifyGithubSignature,
  type GithubAdapterClient
} from "./index.js";
import type { PolicyResult } from "@agentforge/core";

describe("github integration", () => {
  it("validates webhook signatures", () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(
      verifyGithubSignature({ secret: "secret", rawBody: body, signatureHeader: signature })
    ).toBe(true);
    expect(
      verifyGithubSignature({ secret: "wrong", rawBody: body, signatureHeader: signature })
    ).toBe(false);
  });

  it("normalizes pull_request payloads", () => {
    const envelope = normalizeGithubWebhook({
      deliveryId: "delivery",
      event: "pull_request",
      payload: {
        action: "opened",
        repository: { id: 1, full_name: "acme/payments", default_branch: "main" },
        pull_request: {
          id: 2,
          number: 3,
          title: "PR",
          body: "",
          state: "open",
          merged: false,
          user: { login: "sam" },
          base: { ref: "main" },
          head: { ref: "feature/demo", sha: "sha" }
        }
      }
    });
    expect(envelope.repository?.fullName).toBe("acme/payments");
    expect(envelope.pullRequest?.number).toBe(3);
  });

  it("normalizes review, check_run, and installation payloads", () => {
    const reviewEnvelope = normalizeGithubWebhook({
      deliveryId: "delivery-review",
      event: "pull_request_review",
      payload: {
        action: "submitted",
        repository: { id: 1, full_name: "acme/payments", default_branch: "main" },
        pull_request: {
          id: 2,
          number: 3,
          title: "PR",
          state: "open",
          user: { login: "sam" },
          base: { ref: "main" },
          head: { ref: "feature/demo", sha: "sha" }
        },
        review: {
          state: "approved",
          submitted_at: "2026-05-13T00:00:00.000Z",
          user: { login: "billing-owner" }
        }
      }
    });
    const checkEnvelope = normalizeGithubWebhook({
      deliveryId: "delivery-check",
      event: "check_run",
      payload: {
        action: "completed",
        repository: { id: 1, full_name: "acme/payments", default_branch: "main" },
        check_run: {
          id: 42,
          name: "ci",
          status: "completed",
          conclusion: "success",
          head_sha: "sha",
          pull_requests: [{ number: 3, head_sha: "sha" }]
        }
      }
    });
    const installationEnvelope = normalizeGithubWebhook({
      deliveryId: "delivery-installation",
      event: "installation",
      payload: {
        action: "created",
        installation: { id: 99, account: { login: "acme", type: "Organization" } },
        repositories: [{ id: 1, full_name: "acme/payments" }]
      }
    });

    expect(reviewEnvelope.review).toMatchObject({ reviewer: "billing-owner", state: "APPROVED" });
    expect(shouldEnqueueEvaluation(reviewEnvelope)).toBe(true);
    expect(checkEnvelope.checkRun).toMatchObject({ id: 42, headSha: "sha" });
    expect(shouldEnqueueEvaluation(checkEnvelope)).toBe(true);
    expect(
      shouldEnqueueEvaluation({
        ...checkEnvelope,
        checkRun: { ...checkEnvelope.checkRun!, pullRequests: [] }
      })
    ).toBe(false);
    expect(
      shouldEnqueueEvaluation({
        ...checkEnvelope,
        checkRun: { ...checkEnvelope.checkRun!, name: MERGE_GUARD_CHECK_NAME }
      })
    ).toBe(false);
    expect(installationEnvelope.installation).toMatchObject({
      id: 99,
      accountLogin: "acme",
      repositoriesAdded: [{ id: 1, fullName: "acme/payments" }]
    });
    expect(shouldEnqueueEvaluation(installationEnvelope)).toBe(false);
  });

  it("maps fixtures and GitHub API responses into deterministic PR input", async () => {
    const currentPackage = Buffer.from(
      JSON.stringify({ dependencies: { "left-pad": "2.0.0" } })
    ).toString("base64");
    const previousPackage = Buffer.from(JSON.stringify({ dependencies: {} })).toString("base64");
    const client: GithubAdapterClient = {
      pulls: {
        get: async () => ({
          data: {
            number: 5,
            title: "Dependency change",
            body: "Dependency justification: required by payments adapter.",
            labels: [{ name: "ai-assisted" }],
            user: { login: "sam" },
            base: { ref: "main", sha: "base-sha" },
            head: { ref: "feature/deps", sha: "head-sha", repo: { full_name: "acme/payments" } }
          }
        }),
        listFiles: async () => ({
          data: [
            {
              filename: "package.json",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '+  "left-pad": "2.0.0"'
            }
          ]
        }),
        listReviews: async () => ({
          data: [
            {
              state: "APPROVED",
              submitted_at: "2026-05-13T00:00:00.000Z",
              user: { login: "security-team" }
            }
          ]
        }),
        listCommits: async () => ({
          data: [{ sha: "commit-sha", commit: { message: "generated by local tool" } }]
        })
      },
      repos: {
        getContent: async ({ ref }) => ({
          data: {
            encoding: "base64",
            content: ref === "base-sha" ? previousPackage : currentPackage
          }
        })
      }
    };

    const pr = await fetchPullRequestInputFromGithub({
      client,
      owner: "acme",
      repo: "payments",
      pullNumber: 5
    });
    const cloned = pullRequestInputFromFixture(pr);

    expect(pr.repositoryFullName).toBe("acme/payments");
    expect(pr.changedFiles[0]?.currentContent).toContain("left-pad");
    expect(pr.changedFiles[0]?.previousContent).toContain("dependencies");
    expect(pr.labels).toContain("ai-assisted");
    expect(pr.reviews?.[0]?.state).toBe("APPROVED");
    expect(cloned).toEqual(pr);
    expect(cloned).not.toBe(pr);
  });

  it("enriches approved user reviews with verified GitHub team memberships", async () => {
    const membershipChecks: Array<{ org: unknown; teamSlug: unknown; username: unknown }> = [];
    const client: GithubAdapterClient = {
      pulls: {
        get: async () => ({
          data: {
            number: 8,
            title: "Auth change",
            user: { login: "sam" },
            base: { ref: "main", sha: "base-sha", repo: { full_name: "acme/payments" } },
            head: { ref: "feature/auth", sha: "head-sha", repo: { full_name: "acme/payments" } }
          }
        }),
        listFiles: async () => ({ data: [] }),
        listReviews: async () => ({
          data: [
            {
              state: "APPROVED",
              submitted_at: "2026-05-14T00:00:00.000Z",
              user: { login: "alice" }
            }
          ]
        }),
        listCommits: async () => ({ data: [] })
      },
      teams: {
        getMembershipForUserInOrg: async ({ org, team_slug, username }) => {
          membershipChecks.push({ org, teamSlug: team_slug, username });
          if (team_slug === "security-team" && username === "alice") {
            return { data: { state: "active" } };
          }
          throw new Error("not found");
        }
      }
    };

    const pr = await fetchPullRequestInputFromGithub({
      client,
      owner: "acme",
      repo: "payments",
      pullNumber: 8,
      requiredReviewerTeams: ["security-team", "database-owner"]
    });

    expect(pr.reviews?.[0]).toMatchObject({
      reviewer: "alice",
      reviewerType: "user",
      state: "APPROVED",
      teamSlugs: ["security-team"]
    });
    expect(membershipChecks).toEqual([
      { org: "acme", teamSlug: "security-team", username: "alice" },
      { org: "acme", teamSlug: "database-owner", username: "alice" }
    ]);
  });

  it("fails closed when team membership cannot be verified", async () => {
    const reviews = await enrichPullRequestReviewsWithTeamMemberships({
      client: {
        pulls: {
          get: async () => ({ data: {} }),
          listFiles: async () => ({ data: [] }),
          listReviews: async () => ({ data: [] }),
          listCommits: async () => ({ data: [] })
        },
        teams: {
          getMembershipForUserInOrg: async () => {
            throw new Error("GitHub unavailable");
          }
        }
      },
      org: "acme",
      teamSlugs: ["security-team"],
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "APPROVED",
          submittedAt: "2026-05-14T00:00:00.000Z"
        }
      ]
    });

    expect(reviews[0]?.teamSlugs).toBeUndefined();
    expect(reviews[0]?.teamVerification).toMatchObject({
      status: "failed",
      checkedTeamSlugs: ["security-team"],
      reason: expect.stringContaining("membership verification failed")
    });
  });

  it("marks approved user reviews as unverifiable when Members read permission is unavailable", async () => {
    const reviews = await enrichPullRequestReviewsWithTeamMemberships({
      client: {
        pulls: {
          get: async () => ({ data: {} }),
          listFiles: async () => ({ data: [] }),
          listReviews: async () => ({ data: [] }),
          listCommits: async () => ({ data: [] })
        }
      },
      org: "acme",
      teamSlugs: ["security-team"],
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "APPROVED",
          submittedAt: "2026-05-14T00:00:00.000Z"
        }
      ]
    });

    expect(reviews[0]).toMatchObject({
      reviewer: "alice",
      teamSlugs: undefined,
      teamVerification: {
        status: "unavailable",
        checkedTeamSlugs: ["security-team"],
        reason: expect.stringContaining("Members: read")
      }
    });
  });

  it("caches team membership checks for duplicate approved reviews by the same user", async () => {
    let checks = 0;
    const reviews = await enrichPullRequestReviewsWithTeamMemberships({
      client: {
        pulls: {
          get: async () => ({ data: {} }),
          listFiles: async () => ({ data: [] }),
          listReviews: async () => ({ data: [] }),
          listCommits: async () => ({ data: [] })
        },
        teams: {
          getMembershipForUserInOrg: async () => {
            checks += 1;
            return { data: { state: "active" } };
          }
        }
      },
      org: "acme",
      teamSlugs: ["security-team", "platform-team"],
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "APPROVED",
          submittedAt: "2026-05-14T00:00:00.000Z"
        },
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "APPROVED",
          submittedAt: "2026-05-15T00:00:00.000Z"
        }
      ]
    });

    expect(checks).toBe(2);
    expect(reviews.every((review) => review.teamSlugs?.includes("security-team"))).toBe(true);
  });

  it("treats GitHub team membership 404 responses as verified non-membership", async () => {
    const notFound = new Error("Not Found") as Error & { status: number };
    notFound.status = 404;
    const reviews = await enrichPullRequestReviewsWithTeamMemberships({
      client: {
        pulls: {
          get: async () => ({ data: {} }),
          listFiles: async () => ({ data: [] }),
          listReviews: async () => ({ data: [] }),
          listCommits: async () => ({ data: [] })
        },
        teams: {
          getMembershipForUserInOrg: async () => {
            throw notFound;
          }
        }
      },
      org: "acme",
      teamSlugs: ["security-team"],
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "APPROVED",
          submittedAt: "2026-05-14T00:00:00.000Z"
        }
      ]
    });

    expect(reviews[0]?.teamSlugs).toBeUndefined();
    expect(reviews[0]?.teamVerification).toBeUndefined();
  });

  it("keeps PR extraction usable when manifest content fetch is unavailable", async () => {
    const client: GithubAdapterClient = {
      pulls: {
        get: async () => ({
          data: {
            number: 6,
            title: "Dependency change",
            user: { login: "sam" },
            base: { ref: "main", sha: "base-sha" },
            head: { ref: "feature/deps", sha: "head-sha", repo: { full_name: "acme/payments" } }
          }
        }),
        listFiles: async () => ({
          data: [{ filename: "package.json", status: "modified", patch: '+  "left-pad": "2.0.0"' }]
        }),
        listReviews: async () => ({ data: [] }),
        listCommits: async () => ({ data: [] })
      },
      repos: {
        getContent: async () => {
          throw new Error("not found");
        }
      }
    };

    const pr = await fetchPullRequestInputFromGithub({
      client,
      owner: "acme",
      repo: "payments",
      pullNumber: 6
    });

    expect(pr.changedFiles[0]).toMatchObject({
      filename: "package.json",
      currentContent: undefined,
      previousContent: undefined
    });
  });

  it("attributes fork pull requests to the governed base repository", async () => {
    const client: GithubAdapterClient = {
      pulls: {
        get: async () => ({
          data: {
            number: 7,
            title: "Forked change",
            user: { login: "outside-contributor" },
            base: {
              ref: "main",
              sha: "base-sha",
              repo: { full_name: "acme/payments" }
            },
            head: {
              ref: "feature/fork",
              sha: "head-sha",
              repo: { full_name: "contributor/payments-fork" }
            }
          }
        }),
        listFiles: async () => ({ data: [] }),
        listReviews: async () => ({ data: [] }),
        listCommits: async () => ({ data: [] })
      }
    };

    const pr = await fetchPullRequestInputFromGithub({
      client,
      owner: "acme",
      repo: "payments",
      pullNumber: 7
    });

    expect(pr.repositoryFullName).toBe("acme/payments");
    expect(pr.headBranch).toBe("feature/fork");
  });

  it("maps warn mode to neutral check conclusion", () => {
    const result: PolicyResult = {
      mode: "warn",
      status: "warn",
      policyVersion: "fintech@1.0.0",
      findings: [],
      requiredEvidence: [],
      requiredReviewers: [],
      explanation: [],
      evaluatedAt: "2026-05-12T00:00:00.000Z"
    };
    const payload = buildCheckRunPayload({ headSha: "sha" }, result);
    expect(payload.conclusion).toBe("neutral");
    expect(payload.output.text).toContain("Non-blocking warning");
  });

  it("keeps observe mode successful while surfacing open requirements", () => {
    const result: PolicyResult = {
      mode: "observe",
      status: "pass",
      policyVersion: "fintech@1.0.0",
      findings: [],
      requiredEvidence: [
        {
          id: "evidence-1",
          kind: "rollback_plan",
          status: "missing",
          requiredByFindingId: "finding-1"
        }
      ],
      requiredReviewers: [
        {
          id: "reviewer-1",
          reviewer: "security-team",
          reviewerType: "team",
          tier: "required",
          reason: "Security-owned path changed.",
          triggeredByFindingId: "finding-1",
          approved: false
        }
      ],
      explanation: [],
      evaluatedAt: "2026-05-12T00:00:00.000Z"
    };
    const payload = buildCheckRunPayload({ headSha: "sha" }, result);
    expect(payload.conclusion).toBe("success");
    expect(payload.output.summary).toContain("2 requirement(s) remain open");
    expect(payload.output.text).toContain("observe mode records them without blocking");
  });

  it("includes an explicit dashboard details URL when provided", () => {
    const result: PolicyResult = {
      mode: "warn",
      status: "warn",
      policyVersion: "fintech@1.0.0",
      findings: [],
      requiredEvidence: [],
      requiredReviewers: [],
      explanation: [],
      evaluatedAt: "2026-05-12T00:00:00.000Z"
    };
    const payload = buildCheckRunPayload({ headSha: "sha" }, result, {
      detailsUrl: "https://agentforge.example.com/records/record-1"
    });
    expect(payload.detailsUrl).toBe("https://agentforge.example.com/records/record-1");
  });

  it("keeps optimize mode blocking semantics in check conclusions", () => {
    const result: PolicyResult = {
      mode: "optimize",
      status: "block",
      policyVersion: "fintech@1.0.0",
      findings: [],
      requiredEvidence: [],
      requiredReviewers: [],
      explanation: [],
      evaluatedAt: "2026-05-12T00:00:00.000Z"
    };
    const payload = buildCheckRunPayload({ headSha: "sha" }, result);
    expect(payload.conclusion).toBe("failure");
    expect(payload.output.text).toContain("Optimize mode keeps enforce controls active");
  });
});
