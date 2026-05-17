import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDashboardData, loadSettings } from "./data";

describe("dashboard API data loaders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats an empty dashboard API response as an actionable empty state", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.cache).toBe("no-store");
      expect(init?.headers).toEqual({ accept: "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ records: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await loadDashboardData();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/dashboard/records",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(data).toMatchObject({
      records: [],
      source: "empty"
    });
    expect(data.message).toContain("No evaluated PRs");
  });

  it("returns an unavailable dashboard state when the API responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503, statusText: "Unavailable" }))
    );

    const data = await loadDashboardData();

    expect(data).toMatchObject({
      records: [],
      source: "unavailable"
    });
    expect(data.message).toContain("503 Unavailable");
  });

  it("returns unavailable settings without throwing when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
      })
    );

    const data = await loadSettings();

    expect(data).toMatchObject({
      settings: undefined,
      source: "unavailable"
    });
    expect(data.message).toContain("Settings API unavailable");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
