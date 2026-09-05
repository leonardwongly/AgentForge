import { describe, expect, it, vi } from "vitest";
import {
  classifyMergeGuardEvaluationFailure,
  computeBackoffDelay,
  markWebhookDeliveryCompleted,
  markWebhookDeliveryProcessing,
  recordMergeGuardEvaluationFailure
} from "../src/index.js";

describe("worker adversarial boundary handling", () => {
  it("normalizes non-finite queue attempt metadata instead of returning invalid retry state", () => {
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error("transient network failure"),
      attemptsMade: Number.NaN,
      maxAttempts: Number.POSITIVE_INFINITY,
      failedAt: "not-a-date",
      deliveryId: "delivery-boundary"
    });

    expect(summary.attemptsMade).toBe(0);
    expect(summary.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(summary.failedAt))).toBe(false);
    expect(summary.correlationId).toBe("delivery-boundary");
  });

  it("keeps exponential backoff finite for malformed attempts and delay options", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      for (const attempts of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
        const delay = computeBackoffDelay(attempts, "exponentialWithJitter", new Error("retry"), {
          opts: { backoff: { delay: Number.NaN } }
        });
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(1000);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("bounds malformed GitHub retry-after values without emitting NaN", () => {
    const error = Object.assign(new Error("rate limited"), {
      response: { headers: { "retry-after": "NaN" } }
    });
    const delay = computeBackoffDelay(Number.NaN, "exponentialWithJitter", error, { opts: {} });
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(1000);
  });

  it("uses conditional updates for lifecycle transitions so late events cannot resurrect completion", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { webhookDelivery: { updateMany } } as never;

    await markWebhookDeliveryProcessing(prisma, "delivery-race");
    await markWebhookDeliveryCompleted(prisma, "delivery-race");

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ completedAt: null, deliveryStatus: { not: "completed" } })
      })
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { deliveryId: "delivery-race" }
      })
    );
  });

  it("does not overwrite a completed delivery when recording a late retry failure", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { webhookDelivery: { updateMany } } as never;
    await recordMergeGuardEvaluationFailure({
      prisma,
      deliveryId: "delivery-completed",
      summary: classifyMergeGuardEvaluationFailure({
        error: new Error("temporary outage"),
        attemptsMade: 1,
        maxAttempts: 3,
        deliveryId: "delivery-completed"
      })
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ completedAt: null, deliveryStatus: { not: "completed" } })
      })
    );
  });
});
