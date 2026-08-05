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

  it("removes token-shaped pull request bodies from persisted and BullMQ payloads", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const token = `ghp_${"7".repeat(36)}`;
    let persistedDelivery: Record<string, any> | undefined;
    const prisma = {
      repository: {
        findUnique: vi.fn(async () => ({ id: "repo-safe", organizationId: "org-safe" }))
      },
      webhookDelivery: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          persistedDelivery = data;
          return data;
        }),
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    };
    const queue = {
      add: vi.fn(async (_name: string, _payload: unknown, _options: unknown) => ({
        id: "delivery-safe-body"
      }))
    };
    const app = createApp(state, {
      prisma: prisma as never,
      evaluationQueue: queue as never
    });
    const payload = {
      action: "opened",
      repository: { id: 9876, full_name: "acme/payments", default_branch: "main" },
      pull_request: {
        id: 2,
        number: 3,
        title: "PR",
        body: `Deploy with ${token}`,
        state: "open",
        merged: false,
        user: { login: "sam" },
        base: { ref: "main" },
        head: { ref: "feature/demo", sha: "sha" }
      }
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-safe-body",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });

    expect(response.statusCode).toBe(202);
    expect(persistedDelivery).toMatchObject({
      organizationId: "org-safe",
      repositoryId: "repo-safe"
    });
    expect(persistedDelivery?.payloadJson.pullRequest).not.toHaveProperty("body");
    expect(JSON.stringify(persistedDelivery)).not.toContain(token);
    const queuedPayload = queue.add.mock.calls[0]?.[1] as
      { envelope?: { pullRequest?: Record<string, unknown> } } | undefined;
    expect(queuedPayload?.envelope?.pullRequest).not.toHaveProperty("body");
    expect(JSON.stringify(queuedPayload)).not.toContain(token);
    await app.close();
  });

  it("removes token-shaped pull request bodies from in-memory job payloads", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const app = createApp(state);
    const token = `github_pat_${"8".repeat(30)}`;
    const payload = {
      action: "opened",
      repository: { id: 4321, full_name: "acme/payments", default_branch: "main" },
      pull_request: {
        id: 2,
        number: 3,
        title: "PR",
        body: `Do not retain ${token}`,
        state: "open",
        merged: false,
        user: { login: "sam" },
        base: { ref: "main" },
        head: { ref: "feature/demo", sha: "sha" }
      }
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-safe-in-memory-body",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });

    expect(response.statusCode).toBe(202);
    expect(state.queuedEvaluations).toHaveLength(1);
    expect(state.queuedEvaluations[0]?.envelope.pullRequest).not.toHaveProperty("body");
    expect(JSON.stringify(state.queuedEvaluations)).not.toContain(token);
    await app.close();
  });

  it("records enqueue failures as recoverable and re-enqueues duplicate retries", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const rows = new Map<string, Record<string, any>>();
    const prisma = {
      repository: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null)
      },
      webhookDelivery: {
        findUnique: vi.fn(async ({ where }: { where: { deliveryId: string } }) => {
          return rows.get(where.deliveryId) ?? null;
        }),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          const row = { ...data, createdAt: new Date("2026-05-26T00:00:00.000Z") };
          rows.set(data.deliveryId, row);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { deliveryId: string }; data: any }) => {
          const row = rows.get(where.deliveryId);
          if (row) {
            rows.set(where.deliveryId, { ...row, ...data });
          }
          return { count: row ? 1 : 0 };
        })
      }
    };
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("redis unavailable"))
        .mockResolvedValueOnce({ id: "delivery-recoverable" })
    };
    const app = createApp(state, {
      prisma: prisma as never,
      evaluationQueue: queue as never
    });
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
    const request = {
      method: "POST" as const,
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-recoverable",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    };

    const failed = await app.inject(request);
    const retried = await app.inject(request);

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      enqueued: false,
      deliveryStatus: "enqueue_failed"
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      enqueued: true,
      deliveryStatus: "queued"
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ deliveryId: "delivery-recoverable" }),
      expect.objectContaining({ jobId: "delivery-recoverable" })
    );
    expect(rows.get("delivery-recoverable")).toMatchObject({
      deliveryStatus: "queued",
      enqueued: true,
      queueJobId: "delivery-recoverable",
      lastEnqueueFailureClass: null,
      lastEnqueueFailureMessage: null,
      lastEnqueueFailedAt: null
    });
    await app.close();
  });

  it("keeps completed persistence dominant when a worker finishes before markQueued", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const deliveryId = "delivery-fast-worker";
    let row: Record<string, any> = {
      deliveryId,
      deliveryStatus: "enqueue_failed",
      enqueued: false,
      queueJobId: null,
      queuedAt: null,
      completedAt: null,
      lastEnqueueFailureClass: "Error",
      lastEnqueueFailureMessage: "redis unavailable",
      lastEnqueueFailedAt: new Date("2026-05-26T00:00:00.000Z"),
      createdAt: new Date("2026-05-26T00:00:00.000Z")
    };
    const updateMany = vi.fn(
      async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const allowedStatuses = (where.deliveryStatus as { in?: string[] } | undefined)?.in;
        const matchesStatus =
          allowedStatuses === undefined || allowedStatuses.includes(String(row.deliveryStatus));
        const matchesCompletedAt =
          where.completedAt === undefined ||
          (where.completedAt === null && row.completedAt === null);
        if (where.deliveryId !== row.deliveryId || !matchesStatus || !matchesCompletedAt) {
          return { count: 0 };
        }
        row = { ...row, ...data };
        return { count: 1 };
      }
    );
    const prisma = {
      repository: {
        findUnique: vi.fn(async () => null)
      },
      webhookDelivery: {
        findUnique: vi.fn(async () => row),
        create: vi.fn(),
        updateMany
      }
    };
    let signalQueueStarted!: () => void;
    const queueStarted = new Promise<void>((resolve) => {
      signalQueueStarted = resolve;
    });
    let acceptQueuedJob!: (value: { id: string }) => void;
    const queuedJobAccepted = new Promise<{ id: string }>((resolve) => {
      acceptQueuedJob = resolve;
    });
    const queue = {
      add: vi.fn(() => {
        signalQueueStarted();
        return queuedJobAccepted;
      })
    };
    const app = createApp(state, {
      prisma: prisma as never,
      evaluationQueue: queue as never
    });
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

    const responsePromise = app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });

    await queueStarted;
    const completedRow = {
      ...row,
      deliveryStatus: "completed",
      enqueued: true,
      queueJobId: deliveryId,
      queuedAt: new Date("2026-05-26T00:00:01.000Z"),
      completedAt: new Date("2026-05-26T00:00:02.000Z"),
      lastEnqueueFailureClass: null,
      lastEnqueueFailureMessage: null,
      lastEnqueueFailedAt: null,
      lastFailureClass: null,
      lastFailureMessage: null,
      lastFailureCorrelationId: null,
      lastFailedAt: null
    };
    row = completedRow;
    acceptQueuedJob({ id: deliveryId });

    const response = await responsePromise;

    expect(response.statusCode).toBe(202);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deliveryId,
          completedAt: null,
          deliveryStatus: { in: ["received", "enqueue_failed"] }
        }
      })
    );
    expect(row).toEqual(completedRow);
    await app.close();
  });

  it("re-enqueues duplicate received rows left by interrupted requests", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const state = createInitialState();
    const row = {
      deliveryId: "delivery-received-duplicate",
      deliveryStatus: "received",
      enqueued: false,
      createdAt: new Date("2026-05-26T00:00:00.000Z")
    };
    const prisma = {
      repository: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null)
      },
      webhookDelivery: {
        findUnique: vi.fn(async () => row),
        create: vi.fn(),
        updateMany: vi.fn()
      }
    };
    const queue = {
      add: vi.fn(async () => ({ id: "delivery-received-duplicate" }))
    };
    const app = createApp(state, {
      prisma: prisma as never,
      evaluationQueue: queue as never
    });
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

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-received-duplicate",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      enqueued: true,
      deliveryStatus: "queued"
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deliveryId: "delivery-received-duplicate",
          completedAt: null,
          deliveryStatus: { in: ["received", "enqueue_failed"] }
        },
        data: expect.objectContaining({
          deliveryStatus: "queued",
          enqueued: true,
          queueJobId: "delivery-received-duplicate"
        })
      })
    );
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
