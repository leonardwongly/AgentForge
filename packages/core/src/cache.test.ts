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

import {
  MemoryCacheBackend,
  RedisCacheManager,
  getMembershipCacheKey,
  getFileContentCacheKey
} from "./cache.js";

describe("Caching Layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Key Helpers", () => {
    it("generates correct membership cache key", () => {
      const key = getMembershipCacheKey("OrgName", "Team-Slug", "User123");
      expect(key).toBe("agentforge:cache:membership:orgname:team-slug:user123");
    });

    it("generates correct file content cache key", () => {
      const key = getFileContentCacheKey("OwnerName", "Repo-Name", "SHA123", "src/dir/file.ts");
      expect(key).toBe("agentforge:cache:file-content:ownername:repo-name:sha123:src_dir_file.ts");
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
      const manager = new RedisCacheManager("redis://localhost:6379");

      await manager.set("fallbackKey", "fallbackVal", 10);
      expect(await manager.get("fallbackKey")).toBe("fallbackVal");
    });
  });
});
