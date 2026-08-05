import { describe, expect, it, vi } from "vitest";

const requestCacheHarness = vi.hoisted(() => {
  let activeRequestCache: Map<symbol, unknown> | undefined;

  return {
    cache(fn: (...args: unknown[]) => unknown) {
      const functionKey = Symbol("request-cached-function");
      return (...args: unknown[]) => {
        if (!activeRequestCache) {
          return fn(...args);
        }
        if (!activeRequestCache.has(functionKey)) {
          activeRequestCache.set(functionKey, fn(...args));
        }
        return activeRequestCache.get(functionKey);
      };
    },
    async runInRequest<T>(work: () => Promise<T>): Promise<T> {
      const previousRequestCache = activeRequestCache;
      activeRequestCache = new Map();
      try {
        return await work();
      } finally {
        activeRequestCache = previousRequestCache;
      }
    }
  };
});

const dependencies = vi.hoisted(() => ({
  headers: vi.fn(() => Promise.resolve({ get: () => undefined })),
  resolveDashboardActorContext: vi.fn(() => Promise.resolve<unknown>(undefined)),
  dashboardActorErrorMessage: vi.fn(() => "dashboard actor required")
}));

vi.mock("react", () => ({ cache: requestCacheHarness.cache }));
vi.mock("next/headers", () => ({ headers: dependencies.headers }));
vi.mock("./actor-context", () => ({
  resolveDashboardActorContext: dependencies.resolveDashboardActorContext,
  dashboardActorErrorMessage: dependencies.dashboardActorErrorMessage
}));

import { resolveDashboardActor } from "./actor";

describe("resolveDashboardActor request cache", () => {
  it("shares one claim within a request but resolves again for replay checks on a later request", async () => {
    const actor = {
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a",
      source: "trusted_headers"
    };
    dependencies.resolveDashboardActorContext
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce(undefined);

    const parallelActors = await requestCacheHarness.runInRequest(() =>
      Promise.all([resolveDashboardActor(), resolveDashboardActor()])
    );

    expect(parallelActors).toEqual([actor, actor]);
    expect(dependencies.headers).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveDashboardActorContext).toHaveBeenCalledTimes(1);

    await expect(requestCacheHarness.runInRequest(() => resolveDashboardActor())).rejects.toThrow(
      "dashboard actor required"
    );
    expect(dependencies.headers).toHaveBeenCalledTimes(2);
    expect(dependencies.resolveDashboardActorContext).toHaveBeenCalledTimes(2);
  });
});
