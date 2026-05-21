import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisCacheManager } from "@agentforge/core";
import { createApp, createInitialState, mergeGuardEvaluationJobOptions } from "../src/index.js";

const mutableEnvKeys = [
  "NODE_ENV",
  "GITHUB_WEBHOOK_SECRET",
  "ALLOW_UNSIGNED_GITHUB_WEBHOOKS"
] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);

function actorHeaders(actor: string, role: string): Record<string, string> {
  return {
    "x-agentforge-actor": actor,
    "x-agentforge-role": role
  };
}

beforeEach(() => {
  for (const key of mutableEnvKeys) {
    process.env[key] = "";
  }
  process.env.NODE_ENV = "test";
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

describe("GitHub webhook API", () => {
  it("uses bounded retry options for queued evaluation jobs", () => {
    expect(mergeGuardEvaluationJobOptions("delivery-1")).toMatchObject({
      jobId: "delivery-1",
      attempts: 3,
      backoff: {
        type: "exponentialWithJitter",
        delay: 30_000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    });
  });

  it("accepts valid pull_request events and deduplicates delivery IDs", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const app = createApp(state);
    const payload = {
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
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    const first = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });

    expect(first.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ duplicate: true });
    expect(state.queuedEvaluations).toHaveLength(1);
    expect(state.deliveries).toEqual(new Set(["delivery-1"]));
    await app.close();
  });

  it("replays an accepted delivery through an authenticated idempotent queue path", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const app = createApp(state);
    const payload = {
      action: "synchronize",
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
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    const accepted = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-replay",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });
    expect(accepted.statusCode).toBe(202);

    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/queue/replay",
      payload: JSON.stringify({ deliveryId: "delivery-replay" }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("ops", "platform_admin")
      }
    });

    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(
      expect.objectContaining({
        replayed: true,
        deliveryId: "delivery-replay",
        backend: "in_memory",
        payloadIncluded: false
      })
    );
    expect(replay.body).not.toContain("pull_request");
    const replayByPr = await app.inject({
      method: "POST",
      url: "/api/admin/queue/replay",
      payload: JSON.stringify({ repositoryFullName: "acme/payments", pullRequestNumber: 3 }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("ops", "platform_admin")
      }
    });

    expect(replayByPr.statusCode).toBe(202);
    expect(replayByPr.json()).toEqual(
      expect.objectContaining({
        replayed: true,
        deliveryId: "delivery-replay",
        repositoryFullName: "acme/payments",
        pullRequestNumber: 3,
        payloadIncluded: false
      })
    );
    expect(state.deliveries).toEqual(new Set(["delivery-replay"]));
    expect(state.queuedEvaluations.map((item) => item.deliveryId)).toEqual([
      "delivery-replay",
      "delivery-replay",
      "delivery-replay"
    ]);
    expect(state.auditEvents.filter((event) => event.action === "webhook_replayed")).toHaveLength(
      2
    );
    expect(state.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "webhook_replayed",
          targetId: "delivery-replay",
          actor: "ops"
        })
      ])
    );
    await app.close();
  });

  it("rejects invalid signatures", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const app = createApp(createInitialState());
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify({ action: "opened" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-2",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=bad"
      }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unsigned webhooks unless explicit local unsigned mode is enabled", async () => {
    const rejected = createApp(createInitialState());
    const response = await rejected.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify({ action: "opened" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-no-secret",
        "x-github-event": "pull_request"
      }
    });
    expect(response.statusCode).toBe(401);
    await rejected.close();

    process.env.ALLOW_UNSIGNED_GITHUB_WEBHOOKS = "true";
    const allowed = createApp(createInitialState());
    const localOnly = await allowed.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify({ action: "opened" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-unsigned-local",
        "x-github-event": "pull_request"
      }
    });
    expect(localOnly.statusCode).toBe(202);
    await allowed.close();
  });

  it("intercepts membership webhook events and evicts the corresponding cache key", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const app = createApp(state);

    const spy = vi.spyOn(RedisCacheManager.prototype, "del");

    const payload = {
      action: "added",
      scope: "team",
      member: { login: "octocat" },
      team: { slug: "admins" },
      organization: { login: "github" }
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-membership-1",
        "x-github-event": "membership",
        "x-hub-signature-256": signature
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, enqueued: false });
    expect(spy).toHaveBeenCalledWith("agentforge:cache:membership:github:admins:octocat");

    await app.close();
  });
});
