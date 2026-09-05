import { describe, expect, it } from "vitest";
import { MemoryCacheBackend, SignatureReplayGuard, getFileContentCacheKey } from "./cache.js";

describe("cache adversarial boundaries", () => {
  it("keeps case-sensitive git refs isolated in file-content keys", () => {
    expect(getFileContentCacheKey("owner", "repo", "Feature", "src/app.ts")).not.toBe(
      getFileContentCacheKey("owner", "repo", "feature", "src/app.ts")
    );
  });

  it("does not retain malformed or zero-TTL cache entries", async () => {
    const cache = new MemoryCacheBackend();

    await cache.set("zero", "value", 0);
    await cache.set("negative", "value", -1);
    await cache.set("nan", "value", Number.NaN);
    await cache.set("infinite", "value", Number.POSITIVE_INFINITY);

    await expect(cache.get("zero")).resolves.toBeNull();
    await expect(cache.get("negative")).resolves.toBeNull();
    await expect(cache.get("nan")).resolves.toBeNull();
    await expect(cache.get("infinite")).resolves.toBeNull();
  });

  it("does not permit a zero or non-finite replay TTL to become a reusable claim", async () => {
    const guard = new SignatureReplayGuard();

    await expect(guard.claim("zero", 0)).resolves.toBe(false);
    await expect(guard.claim("negative", -1)).resolves.toBe(false);
    await expect(guard.claim("nan", Number.NaN)).resolves.toBe(false);
    await expect(guard.claim("infinite", Number.POSITIVE_INFINITY)).resolves.toBe(false);
  });
});
