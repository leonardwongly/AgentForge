import { describe, expect, it } from "vitest";
import { deliverWebhook } from "./index.js";

function successfulResponse(status = 200): Response {
  return { ok: true, status } as Response;
}

describe("webhook delivery adversarial payloads", () => {
  it("rejects circular payloads before making a request or entering retries", async () => {
    let calls = 0;
    const payload: { value: string; self?: unknown } = { value: "safe" };
    payload.self = payload;

    const result = await deliverWebhook("https://hooks.example/events", payload, {
      retries: 8,
      fetchImpl: async () => {
        calls += 1;
        return successfulResponse();
      }
    });

    expect(result).toEqual({ ok: false, error: "invalid webhook payload" });
    expect(calls).toBe(0);
  });

  it("rejects oversized UTF-8 payloads before making a request", async () => {
    let calls = 0;
    const result = await deliverWebhook(
      "https://hooks.example/events",
      { text: "😀".repeat(600_000) },
      {
        fetchImpl: async () => {
          calls += 1;
          return successfulResponse();
        }
      }
    );

    expect(result).toEqual({ ok: false, error: "webhook payload too large" });
    expect(calls).toBe(0);
  });

  it("does not serialize undefined payloads as the literal JSON value", async () => {
    let calls = 0;
    const result = await deliverWebhook("https://hooks.example/events", undefined, {
      fetchImpl: async () => {
        calls += 1;
        return successfulResponse();
      }
    });

    expect(result).toEqual({ ok: false, error: "invalid webhook payload" });
    expect(calls).toBe(0);
  });
});
