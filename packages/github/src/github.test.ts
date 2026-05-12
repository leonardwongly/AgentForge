import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCheckRunPayload, normalizeGithubWebhook, verifyGithubSignature } from "./index.js";
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
});
