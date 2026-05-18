import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createInitialState } from "../src/index.js";

const mutableEnvKeys = [
  "NODE_ENV",
  "GITHUB_WEBHOOK_SECRET",
  "ALLOW_UNSIGNED_GITHUB_WEBHOOKS"
] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);

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
});
