import { describe, expect, it, vi, beforeEach } from "vitest";

// Use vi.hoisted to initialize the mock state before static imports and mocks are resolved
const { mockRedis } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      quit: vi.fn(),
      on: vi.fn()
    }
  };
});

vi.mock("ioredis", () => {
  return {
    Redis: vi.fn().mockImplementation(function () {
      return mockRedis;
    })
  };
});

import { createHash } from "node:crypto";
import {
  MemoryCacheBackend,
  RedisCacheManager,
  SignatureReplayGuard,
  getMembershipCacheKey,
  getFileContentCacheKey
} from "./cache.js";

describe("Caching Layer", () => {
  beforeEach(() => {
    // Reset implementations as well as call history. `clearAllMocks()` leaves
    // a previous test's rejected Redis command installed, making the fallback
    // cases pass or fail depending on test order.
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
    mockRedis.quit.mockReset();
    mockRedis.on.mockReset();
  });

  describe("Key Helpers", () => {
    it("generates correct membership cache key", () => {
      const key = getMembershipCacheKey("OrgName", "Team-Slug", "User123");
      expect(key).toBe("agentforge:cache:membership:orgname:team-slug:user123");
    });

    it("generates an injective file content cache key", () => {
      const key = getFileContentCacheKey("OwnerName", "Repo-Name", "SHA123", "src/dir/file.ts");
      const pathHash = createHash("sha256").update("src/dir/file.ts").digest("hex");
      // Repository names are case-insensitive, but git refs are not.
      expect(key).toBe(`agentforge:cache:file-content:ownername:repo-name:SHA123:${pathHash}`);
      // Paths that previously collided under lossy "/"->"_" sanitization now differ.
      expect(getFileContentCacheKey("o", "r", "s", "a/package.json")).not.toBe(
        getFileContentCacheKey("o", "r", "s", "a_package.json")
      );
    });
  });

  describe("MemoryCacheBackend", () => {
    it("stores, retrieves, and deletes values", async () => {
      const backend = new MemoryCacheBackend();
      await backend.set("key1", "value1", 10);
      expect(await backend.get("key1")).toBe("value1");

      await backend.del("key1");
      expect(await backend.get("key1")).toBeNull();
    });

    it("clears all values", async () => {
      const backend = new MemoryCacheBackend();
      await backend.set("key1", "value1", 10);
      await backend.set("key2", "value2", 10);

      backend.clear();

      expect(await backend.get("key1")).toBeNull();
      expect(await backend.get("key2")).toBeNull();
    });

    it("respects TTL expiration", async () => {
      const backend = new MemoryCacheBackend();

      // Use fake timers to verify TTL expiration
      vi.useFakeTimers();

      await backend.set("key1", "value1", 5); // 5 seconds TTL
      expect(await backend.get("key1")).toBe("value1");

      // Advance time by 6 seconds
      vi.advanceTimersByTime(6000);

      expect(await backend.get("key1")).toBeNull();

      vi.useRealTimers();
    });

    it("evicts the oldest entry when the entry cap is exceeded", async () => {
      const backend = new MemoryCacheBackend(3);

      await backend.set("key1", "value1", 60);
      await backend.set("key2", "value2", 60);
      await backend.set("key3", "value3", 60);
      expect(await backend.get("key1")).toBe("value1");

      // A 4th insert exceeds the cap of 3; the oldest (key1) is evicted.
      await backend.set("key4", "value4", 60);

      expect(await backend.get("key1")).toBeNull();
      expect(await backend.get("key2")).toBe("value2");
      expect(await backend.get("key3")).toBe("value3");
      expect(await backend.get("key4")).toBe("value4");
    });

    it("enforces the cap at exactly the configured boundary", async () => {
      const backend = new MemoryCacheBackend(5);

      for (let i = 1; i <= 5; i++) {
        await backend.set(`key${i}`, `value${i}`, 60);
      }
      // At the boundary: no eviction has happened yet.
      for (let i = 1; i <= 5; i++) {
        expect(await backend.get(`key${i}`)).toBe(`value${i}`);
      }

      // One more insert exceeds the boundary and evicts exactly one (oldest).
      await backend.set("key6", "value6", 60);
      expect(await backend.get("key1")).toBeNull();
      expect(await backend.get("key2")).toBe("value2");
      expect(await backend.get("key6")).toBe("value6");
    });

    it("re-setting an existing key does not evict a different entry at capacity", async () => {
      const backend = new MemoryCacheBackend(3);

      await backend.set("key1", "value1", 60);
      await backend.set("key2", "value2", 60);
      await backend.set("key3", "value3", 60);

      // Updating an already-present key at capacity should not evict key1.
      await backend.set("key3", "value3-updated", 60);

      expect(await backend.get("key1")).toBe("value1");
      expect(await backend.get("key2")).toBe("value2");
      expect(await backend.get("key3")).toBe("value3-updated");
    });

    it("sweeps expired entries once the sweep interval elapses, without a get() call", async () => {
      const backend = new MemoryCacheBackend(10);

      vi.useFakeTimers();

      await backend.set("expiring", "value", 5); // 5 seconds TTL

      // Advance past both the TTL and the 60s sweep interval, without calling
      // get() on "expiring" in between.
      vi.advanceTimersByTime(61_000);

      // Trigger the throttled sweep via a set() call, as the sweep runs on
      // the set() path rather than on a background timer.
      await backend.set("trigger-sweep", "value", 60);

      expect(await backend.get("expiring")).toBeNull();

      vi.useRealTimers();
    });

    it("sweeping expired entries frees capacity before the hard cap forces eviction", async () => {
      const backend = new MemoryCacheBackend(3);

      vi.useFakeTimers();

      // Fill the cache with short-lived entries that will all expire.
      await backend.set("short1", "v1", 5);
      await backend.set("short2", "v2", 5);
      await backend.set("short3", "v3", 5);

      // Advance past their TTL and the sweep interval.
      vi.advanceTimersByTime(61_000);

      // This set() should sweep all 3 expired entries first, so it does not
      // need to evict any of them via the oldest-entry cap logic, and all
      // 3 slots are free again.
      await backend.set("fresh1", "fv1", 60);
      await backend.set("fresh2", "fv2", 60);
      await backend.set("fresh3", "fv3", 60);

      expect(await backend.get("fresh1")).toBe("fv1");
      expect(await backend.get("fresh2")).toBe("fv2");
      expect(await backend.get("fresh3")).toBe("fv3");
      expect(await backend.get("short1")).toBeNull();
      expect(await backend.get("short2")).toBeNull();
      expect(await backend.get("short3")).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("RedisCacheManager", () => {
    it("uses MemoryCacheBackend when no redisUrl is provided", async () => {
      const manager = new RedisCacheManager();
      await manager.set("memKey", "memVal", 10);
      expect(await manager.get("memKey")).toBe("memVal");
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it("uses Redis when redisUrl is provided", async () => {
      mockRedis.get.mockResolvedValue("redisVal");
      const manager = new RedisCacheManager("redis://localhost:6379");

      const result = await manager.get("redisKey");
      expect(result).toBe("redisVal");
      expect(mockRedis.get).toHaveBeenCalledWith("redisKey");
    });

    it("falls back to memory if Redis set fails (fail-open)", async () => {
      mockRedis.set.mockRejectedValue(new Error("Redis connection failure"));
      mockRedis.get.mockRejectedValue(new Error("Redis connection failure"));
      const manager = new RedisCacheManager("redis://localhost:6379");

      await manager.set("fallbackKey", "fallbackVal", 10);
      expect(await manager.get("fallbackKey")).toBe("fallbackVal");
    });

    it("falls back to memory if Redis get fails (fail-open)", async () => {
      mockRedis.get.mockRejectedValue(new Error("Redis read error"));
      mockRedis.set.mockRejectedValue(new Error("Redis connection failure"));
      const manager = new RedisCacheManager("redis://localhost:6379");

      await manager.set("fallbackKey", "fallbackVal", 10);
      expect(await manager.get("fallbackKey")).toBe("fallbackVal");
    });

    it("latches Redis command failures to avoid retrying a known-down backend", async () => {
      mockRedis.set.mockRejectedValue(new Error("Redis connection failure"));
      mockRedis.get.mockResolvedValue("stale-redis-value");
      const manager = new RedisCacheManager("redis://localhost:6379");

      await manager.set("fallbackKey", "fallbackVal", 10);
      expect(await manager.get("fallbackKey")).toBe("fallbackVal");
      expect(mockRedis.get).not.toHaveBeenCalled();
    });
  });

  describe("SignatureReplayGuard", () => {
    it("claims a key for the first time, and rejects every subsequent claim within the window (in-memory fallback)", async () => {
      const guard = new SignatureReplayGuard();
      const now = Date.now();
      expect(await guard.claim("sig-1", 300, now)).toBe(true);
      expect(await guard.claim("sig-1", 300, now + 1_000)).toBe(false);
      expect(await guard.claim("sig-1", 300, now + 100_000)).toBe(false);
    });

    it("allows a claim again once the TTL has fully elapsed (in-memory fallback)", async () => {
      const guard = new SignatureReplayGuard();
      const now = Date.now();
      expect(await guard.claim("sig-1", 5, now)).toBe(true);
      // 6 seconds later, past the 5-second TTL.
      expect(await guard.claim("sig-1", 5, now + 6_000)).toBe(true);
    });

    it("treats distinct keys independently", async () => {
      const guard = new SignatureReplayGuard();
      const now = Date.now();
      expect(await guard.claim("sig-a", 300, now)).toBe(true);
      expect(await guard.claim("sig-b", 300, now)).toBe(true);
      expect(await guard.claim("sig-a", 300, now)).toBe(false);
      expect(await guard.claim("sig-b", 300, now)).toBe(false);
    });

    it("uses Redis's atomic SET NX EX when redisUrl is provided, claiming on the first call", async () => {
      mockRedis.set.mockResolvedValue("OK");
      const guard = new SignatureReplayGuard("redis://localhost:6379");

      const result = await guard.claim("sig-redis", 300, Date.now());
      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith("sig-redis", "1", "EX", 300, "NX");
    });

    it("rejects a replay when Redis's SET NX returns null (key already exists)", async () => {
      mockRedis.set.mockResolvedValue(null);
      const guard = new SignatureReplayGuard("redis://localhost:6379");

      const result = await guard.claim("sig-redis", 300, Date.now());
      expect(result).toBe(false);
    });

    it("falls back to the in-memory claim set if Redis errors (fail-open to single-instance protection, not to no protection)", async () => {
      mockRedis.set.mockRejectedValue(new Error("Redis connection failure"));
      const guard = new SignatureReplayGuard("redis://localhost:6379");
      const now = Date.now();

      expect(await guard.claim("sig-fallback", 300, now)).toBe(true);
      // The fallback claim set still rejects a replay even though Redis is down.
      expect(await guard.claim("sig-fallback", 300, now + 1_000)).toBe(false);
    });

    it("fails closed when strict replay protection loses Redis", async () => {
      mockRedis.set.mockRejectedValue(new Error("Redis connection failure"));
      const guard = new SignatureReplayGuard("redis://localhost:6379", undefined, true);
      const now = Date.now();

      expect(await guard.claim("sig-strict", 300, now)).toBe(false);
      expect(await guard.claim("sig-strict", 300, now + 1_000)).toBe(false);
    });

    it("bounds in-memory fallback growth and evicts the oldest claim once the cap is exceeded", async () => {
      // Injects a small cap (SignatureReplayGuard's second constructor
      // argument) so this test actually exercises the eviction branch
      // deterministically, rather than needing tens of thousands of claims
      // to exhaust the real 50,000-entry production default.
      const guard = new SignatureReplayGuard(undefined, 3);
      const now = Date.now();

      // Fill exactly to the cap of 3: no eviction has happened yet.
      expect(await guard.claim("key-1", 300, now)).toBe(true);
      expect(await guard.claim("key-2", 300, now)).toBe(true);
      expect(await guard.claim("key-3", 300, now)).toBe(true);

      // All three correctly reject a replay while still within their window
      // and before any eviction has occurred.
      expect(await guard.claim("key-1", 300, now + 1_000)).toBe(false);
      expect(await guard.claim("key-2", 300, now + 1_000)).toBe(false);
      expect(await guard.claim("key-3", 300, now + 1_000)).toBe(false);

      // A 4th distinct claim exceeds the cap of 3 and evicts the oldest
      // entry ("key-1") to make room. Direct proof of eviction, not just
      // independent-key behavior: "key-1" can now be claimed again even
      // though its original 300s TTL has not elapsed.
      expect(await guard.claim("key-4", 300, now + 2_000)).toBe(true);
      expect(await guard.claim("key-1", 300, now + 3_000)).toBe(true);

      // Re-claiming "key-1" is itself a new distinct entry at the cap, which
      // evicts whichever entry is now oldest ("key-2") in turn -- FIFO
      // eviction keeps evicting the current oldest at each insert once the
      // store is at capacity, not just once for the whole test. "key-2" can
      // now also be claimed again.
      expect(await guard.claim("key-2", 300, now + 3_000)).toBe(true);

      // Claiming "key-2" again evicted the new oldest ("key-3") in the same
      // way, so "key-3" can also be claimed again -- this chain of
      // insert-evicts-oldest is the correct, verified behavior of a
      // fixed-capacity FIFO cache, not a bug.
      expect(await guard.claim("key-3", 300, now + 3_000)).toBe(true);
    });
  });
});
